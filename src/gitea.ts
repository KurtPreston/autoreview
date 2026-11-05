import type { Comment, Forge, NewComment, PullRequest, Thread } from "./forge.ts";
import { threadKey } from "./forge.ts";

/** Where a repository lives on a Gitea server, and who is asking. */
export interface GiteaOptions {
  /** Server root, such as `https://gitea.example`. */
  url: string;
  owner: string;
  repo: string;
  token: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** The fields of Gitea's JSON responses we read. */
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
  labels: { name: string }[] | null;
  head: { ref: string; sha: string; label: string; repo_id: number };
  base: { ref: string; sha: string; repo_id: number };
}
interface RawReview {
  id: number;
  state: string;
}
interface RawReviewComment {
  id: number;
  body: string;
  user: User;
  path: string;
  position: number;
  original_position: number;
  resolver: User | null;
  created_at: string;
}
interface RawComment {
  id: number;
  body: string;
  user: User;
  created_at: string;
}
interface RawLabel {
  id: number;
  name: string;
}

const PAGE = 50;

export class Gitea implements Forge {
  readonly options: GiteaOptions;
  readonly #fetch: typeof fetch;
  #labels: Map<string, number> | undefined;

  constructor(options: GiteaOptions) {
    this.options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async login(): Promise<string> {
    return (await this.#json<User>("GET", "/user")).login;
  }

  async pullRequest(number: number): Promise<PullRequest> {
    const raw = await this.#json<RawPull>("GET", `${this.#repo}/pulls/${number}`);

    // Gitea also treats a "WIP:" title prefix as a draft
    // A deleted head branch is reported by its pull ref
    const deleted = raw.head.ref.startsWith("refs/");
    const draft = raw.draft === true || /^\s*(\[wip\]|wip:)/i.test(raw.title);
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      author: raw.user.login,
      draft,
      state: raw.state,
      labels: (raw.labels ?? []).map((label) => label.name),
      headRef: deleted ? raw.head.label.replace(/^.*:/, "") : raw.head.ref,
      headBranch: deleted || raw.head.repo_id !== raw.base.repo_id ? undefined : raw.head.ref,
      headSha: raw.head.sha,
      baseRef: raw.base.ref,
      baseSha: raw.base.sha,
    };
  }

  async diff(number: number): Promise<string> {
    const response = await this.#request("GET", `${this.#repo}/pulls/${number}.diff`);
    return response.text();
  }

  async threads(number: number): Promise<Thread[]> {
    // Collect every submitted review's inline comments
    const reviews = await this.#pages<RawReview>(`${this.#repo}/pulls/${number}/reviews`);
    const comments: RawReviewComment[] = [];
    for (const review of reviews.filter((r) => r.state !== "PENDING")) {
      comments.push(
        ...(await this.#json<RawReviewComment[]>(
          "GET",
          `${this.#repo}/pulls/${number}/reviews/${review.id}/comments`,
        )),
      );
    }
    comments.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);

    // Group them into conversations the way Gitea does: by path and line
    const threads = new Map<string, Thread>();
    for (const raw of comments) {
      const side = raw.position > 0 ? "new" : "old";
      const line = side === "new" ? raw.position : raw.original_position;
      const key = threadKey(raw.path, line, side);
      let thread = threads.get(key);
      if (!thread) {
        // A conversation's resolution is recorded on its first comment
        thread = { key, path: raw.path, line, side, resolved: raw.resolver !== null, comments: [] };
        threads.set(key, thread);
      }
      thread.comments.push({
        id: raw.id,
        author: raw.user.login,
        body: raw.body,
        createdAt: raw.created_at,
      });
    }
    return [...threads.values()];
  }

  async comments(number: number): Promise<Comment[]> {
    const raw = await this.#pages<RawComment>(`${this.#repo}/issues/${number}/comments`);
    return raw.map((c) => ({
      id: c.id,
      author: c.user.login,
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
      comments: review.comments.map((c) => ({ path: c.path, new_position: c.line, body: c.body })),
    });
  }

  async reply(number: number, thread: Thread, body: string): Promise<void> {
    await this.#request(
      "POST",
      `${this.#repo}/pulls/${number}/comments/${thread.comments[0].id}/replies`,
      { body },
    );
  }

  async resolve(thread: Thread): Promise<void> {
    await this.#request("POST", `${this.#repo}/pulls/comments/${thread.comments[0].id}/resolve`);
  }

  async comment(number: number, body: string): Promise<void> {
    await this.#request("POST", `${this.#repo}/issues/${number}/comments`, { body });
  }

  async addLabel(number: number, name: string): Promise<void> {
    await this.#request("POST", `${this.#repo}/issues/${number}/labels`, {
      labels: [await this.#labelId(name)],
    });
  }

  async removeLabel(number: number, name: string): Promise<void> {
    await this.#request(
      "DELETE",
      `${this.#repo}/issues/${number}/labels/${await this.#labelId(name)}`,
    );
  }

  /** Create a repository label unless it exists. Used when enabling a repository. */
  async ensureLabel(name: string): Promise<void> {
    await this.#labelId(name);
  }

  /** Whether a user exists on the server. */
  async userExists(login: string): Promise<boolean> {
    const response = await this.#fetch(`${this.options.url}/api/v1/users/${login}`, {
      headers: { Authorization: `token ${this.options.token}` },
    });
    return response.ok;
  }

  /** Give a user write access to the repository, without an invitation to accept. */
  async addCollaborator(login: string): Promise<void> {
    await this.#request("PUT", `${this.#repo}/collaborators/${login}`, { permission: "write" });
  }

  /** Store an Actions secret on the token's own account, readable by all its repositories. */
  async setUserSecret(name: string, value: string): Promise<void> {
    await this.#request("PUT", `/user/actions/secrets/${name}`, { data: value });
  }

  get #repo(): string {
    return `/repos/${this.options.owner}/${this.options.repo}`;
  }

  /** Look up a repository label's id by name, creating the label if it's missing. */
  async #labelId(name: string): Promise<number> {
    this.#labels ??= new Map(
      (await this.#pages<RawLabel>(`${this.#repo}/labels`)).map((label) => [label.name, label.id]),
    );
    let id = this.#labels.get(name);
    if (id === undefined) {
      id = (await this.#json<RawLabel>("POST", `${this.#repo}/labels`, { name, color: "#c5def5" }))
        .id;
      this.#labels.set(name, id);
    }
    return id;
  }

  /** Fetch every page of a list endpoint. */
  async #pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.#json<T[]>("GET", `${path}?page=${page}&limit=${PAGE}`);
      all.push(...batch);
      if (batch.length < PAGE) {
        return all;
      }
    }
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.#request(method, path, body)).json() as Promise<T>;
  }

  /** Call the API, throwing with the server's message on failure. */
  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.#fetch(`${this.options.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `token ${this.options.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Gitea ${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return response;
  }
}
