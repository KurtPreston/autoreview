import { readFile } from "node:fs/promises";
import type { Comment, Forge, NewComment, PullRequest, Thread } from "./forge.ts";
import { threadKey } from "./forge.ts";

/** Where a repository lives on GitHub, and who is asking. */
export interface GitHubOptions {
  /** REST root, such as `https://api.github.com` or `https://host/api/v3`. */
  api: string;
  /** GraphQL endpoint, such as `https://api.github.com/graphql`. */
  graphql: string;
  owner: string;
  repo: string;
  token: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** The login the workflow's built-in token posts as; it can't read `/user` itself. */
export const ACTIONS_BOT = "github-actions[bot]";

/** The fields of GitHub's JSON responses we read. */
interface User {
  login: string;
}
interface RawPull {
  number: number;
  title: string;
  body: string | null;
  user: User;
  draft?: boolean;
  state: "open" | "closed";
  labels: { name: string }[];
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; repo: { full_name: string } };
}
interface RawComment {
  id: number;
  body: string;
  user: User | null;
  created_at: string;
}
interface RawThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  comments: {
    nodes: { databaseId: number; body: string; createdAt: string; author: User | null }[];
  };
}
interface ThreadPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawThread[];
      };
    };
  };
}

const PAGE = 100;
const QUERIES = new URL("./queries/", import.meta.url);

export class GitHub implements Forge {
  readonly options: GitHubOptions;
  readonly #fetch: typeof fetch;
  readonly #labels = new Set<string>();

  constructor(options: GitHubOptions) {
    this.options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async login(): Promise<string> {
    // The workflow's token belongs to an app installation, which has no user
    const response = await this.#send("GET", "/user");
    if (response.status === 401 || response.status === 403) {
      return ACTIONS_BOT;
    }
    return ((await (await this.#check("GET", "/user", response)).json()) as User).login;
  }

  async pullRequest(number: number): Promise<PullRequest> {
    const raw = await this.#json<RawPull>("GET", `${this.#repo}/pulls/${number}`);

    // Fixes can only be pushed to a branch of this repository
    const own = raw.head.repo?.full_name === raw.base.repo.full_name;
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      author: raw.user.login,
      draft: raw.draft === true,
      state: raw.state,
      labels: raw.labels.map((label) => label.name),
      headRef: raw.head.ref,
      headBranch: own ? raw.head.ref : undefined,
      headSha: raw.head.sha,
      baseRef: raw.base.ref,
      baseSha: raw.base.sha,
    };
  }

  async diff(number: number): Promise<string> {
    const path = `${this.#repo}/pulls/${number}`;
    const response = await this.#send("GET", path, { accept: "application/vnd.github.diff" });
    return (await this.#check("GET", path, response)).text();
  }

  async threads(number: number): Promise<Thread[]> {
    // Page through the threads; each carries its comments
    const query = await readFile(new URL("threads.graphql", QUERIES), "utf8");
    const raw: RawThread[] = [];
    let cursor: string | null = null;
    do {
      const page: ThreadPage = await this.#graphql<ThreadPage>(query, {
        owner: this.options.owner,
        repo: this.options.repo,
        number,
        cursor,
      });
      const { pageInfo, nodes } = page.repository.pullRequest.reviewThreads;
      raw.push(...nodes);
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor);

    // GitHub can hold several threads on one line, so later ones get a numbered key
    const seen = new Map<string, number>();
    const threads = raw
      .filter((t) => t.comments.nodes.length > 0)
      .map((t) => toThread(t, seen))
      .sort((a, b) => a.comments[0].createdAt.localeCompare(b.comments[0].createdAt));
    return threads;
  }

  async comments(number: number): Promise<Comment[]> {
    const raw = await this.#pages<RawComment>(`${this.#repo}/issues/${number}/comments`);
    return raw.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "ghost",
      body: c.body,
      createdAt: c.created_at,
    }));
  }

  async review(
    number: number,
    review: { body: string; commit: string; comments: NewComment[] },
  ): Promise<void> {
    await this.#request("POST", `${this.#repo}/pulls/${number}/reviews`, {
      body: review.body,
      event: "COMMENT",
      commit_id: review.commit,
      comments: review.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: "RIGHT",
        body: c.body,
      })),
    });
  }

  async reply(number: number, thread: Thread, body: string): Promise<void> {
    // Replies hang off the thread's first comment
    const first = thread.comments[0].id;
    await this.#request("POST", `${this.#repo}/pulls/${number}/comments/${first}/replies`, {
      body,
    });
  }

  async resolve(thread: Thread): Promise<void> {
    const query = await readFile(new URL("resolve.graphql", QUERIES), "utf8");
    await this.#graphql(query, { thread: thread.id });
  }

  async comment(number: number, body: string): Promise<void> {
    await this.#request("POST", `${this.#repo}/issues/${number}/comments`, { body });
  }

  async addLabel(number: number, name: string): Promise<void> {
    await this.ensureLabel(name);
    await this.#request("POST", `${this.#repo}/issues/${number}/labels`, { labels: [name] });
  }

  async removeLabel(number: number, name: string): Promise<void> {
    // A label that's already gone is fine
    const path = `${this.#repo}/issues/${number}/labels/${encodeURIComponent(name)}`;
    const response = await this.#send("DELETE", path);
    if (response.status !== 404) {
      await this.#check("DELETE", path, response);
    }
  }

  async dispatch(workflow: string, ref: string): Promise<void> {
    const path = `${this.#repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
    await this.#request("POST", path, { ref });
  }

  /** Create a repository label unless it exists. */
  async ensureLabel(name: string): Promise<void> {
    if (this.#labels.has(name)) {
      return;
    }
    const path = `${this.#repo}/labels/${encodeURIComponent(name)}`;
    const response = await this.#send("GET", path);
    if (response.status === 404) {
      await this.#request("POST", `${this.#repo}/labels`, { name, color: "c5def5" });
    } else {
      await this.#check("GET", path, response);
    }
    this.#labels.add(name);
  }

  get #repo(): string {
    return `/repos/${this.options.owner}/${this.options.repo}`;
  }

  /** Fetch every page of a list endpoint. */
  async #pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.#json<T[]>("GET", `${path}?per_page=${PAGE}&page=${page}`);
      all.push(...batch);
      if (batch.length < PAGE) {
        return all;
      }
    }
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.#request(method, path, body)).json() as Promise<T>;
  }

  /** Run a GraphQL query, throwing on its errors as well as on HTTP failures. */
  async #graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.#fetch(this.options.graphql, {
      method: "POST",
      headers: this.#headers("application/json", true),
      body: JSON.stringify({ query, variables }),
    });
    const result = (await (await this.#check("POST", "graphql", response)).json()) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (result.errors?.length || !result.data) {
      const messages = (result.errors ?? []).map((e) => e.message).join("; ");
      throw new Error(`GitHub graphql: ${messages || "no data"}`);
    }
    return result.data;
  }

  /** Call the REST API, throwing with the server's message on failure. */
  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    return this.#check(method, path, await this.#send(method, path, { body }));
  }

  async #send(
    method: string,
    path: string,
    { body, accept }: { body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    return this.#fetch(`${this.options.api}${path}`, {
      method,
      headers: this.#headers(accept ?? "application/vnd.github+json", body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  #headers(accept: string, json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`,
      Accept: accept,
      "User-Agent": "autoreview",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async #check(method: string, path: string, response: Response): Promise<Response> {
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return response;
  }
}

/** A GraphQL thread as the forge's thread. Outdated threads keep their original line. */
function toThread(raw: RawThread, seen: Map<string, number>): Thread {
  const side = raw.diffSide === "LEFT" ? "old" : "new";
  const line = raw.line ?? raw.originalLine ?? 0;

  // Number repeats of a key so each thread's key stays unique
  const base = threadKey(raw.path, line, side);
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return {
    id: raw.id,
    key: count === 1 ? base : `${base}#${count}`,
    path: raw.path,
    line,
    side,
    resolved: raw.isResolved,
    comments: raw.comments.nodes.map((c) => ({
      id: c.databaseId,
      author: c.author?.login ?? "ghost",
      body: c.body,
      createdAt: c.createdAt,
    })),
  };
}
