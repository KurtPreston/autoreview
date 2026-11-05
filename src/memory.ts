import type { Comment, Forge, NewComment, PullRequest, Thread } from "./forge.ts";
import { threadKey } from "./forge.ts";

/** A pull request's state, held in memory. */
export interface Store {
  pr: PullRequest;
  diff: string;
  threads: Thread[];
  comments: Comment[];
  nextId: number;
  /** Called with a description of every write, for dry runs. */
  onWrite?: (author: string, action: string, detail: string) => void;
}

/** Seed a store from a real forge's current state. */
export async function snapshot(forge: Forge, number: number): Promise<Store> {
  return {
    pr: await forge.pullRequest(number),
    diff: await forge.diff(number),
    threads: await forge.threads(number),
    comments: await forge.comments(number),
    nextId: 1_000_000_000,
  };
}

/**
 * A forge that keeps everything in memory, for tests and dry runs. Several can
 * share one store, each posting as its own login, like the two bot accounts.
 */
export class MemoryForge implements Forge {
  readonly store: Store;
  readonly user: string;

  constructor(store: Store, user: string) {
    this.store = store;
    this.user = user;
  }

  async login(): Promise<string> {
    return this.user;
  }

  async pullRequest(): Promise<PullRequest> {
    return structuredClone(this.store.pr);
  }

  async diff(): Promise<string> {
    return this.store.diff;
  }

  async threads(): Promise<Thread[]> {
    return structuredClone(this.store.threads);
  }

  async comments(): Promise<Comment[]> {
    return structuredClone(this.store.comments);
  }

  async review(
    _: number,
    review: { body: string; commit: string; comments: NewComment[] },
  ): Promise<void> {
    // Like Gitea, a comment on a line that already has a conversation joins it
    for (const comment of review.comments) {
      const key = threadKey(comment.path, comment.line, "new");
      let thread = this.store.threads.find((t) => t.key === key);
      if (!thread) {
        thread = {
          key,
          path: comment.path,
          line: comment.line,
          side: "new",
          resolved: false,
          comments: [],
        };
        this.store.threads.push(thread);
      }
      thread.comments.push(this.#comment(comment.body));
    }
    // Also like Gitea, the review's own body isn't a conversation comment
    this.#log(
      "review",
      `${review.comments.length} comments at ${review.commit.slice(0, 7)}\n${review.body}`,
    );
    for (const comment of review.comments) {
      this.#log(`comment ${comment.path}:${comment.line}`, comment.body);
    }
  }

  async reply(_: number, thread: Thread, body: string): Promise<void> {
    this.#thread(thread).comments.push(this.#comment(body));
    this.#log(`reply ${thread.key}`, body);
  }

  async resolve(thread: Thread): Promise<void> {
    this.#thread(thread).resolved = true;
    this.#log(`resolve ${thread.key}`, "");
  }

  async comment(_: number, body: string): Promise<void> {
    this.store.comments.push(this.#comment(body));
    this.#log("comment", body);
  }

  async addLabel(_: number, name: string): Promise<void> {
    if (!this.store.pr.labels.includes(name)) {
      this.store.pr.labels.push(name);
    }
    this.#log("label", `+${name}`);
  }

  async removeLabel(_: number, name: string): Promise<void> {
    this.store.pr.labels = this.store.pr.labels.filter((label) => label !== name);
    this.#log("label", `-${name}`);
  }

  #thread(thread: Thread): Thread {
    const found = this.store.threads.find((t) => t.key === thread.key);
    if (!found) {
      throw new Error(`no thread ${thread.key}`);
    }
    return found;
  }

  #comment(body: string): Comment {
    const createdAt = new Date(
      Date.UTC(2026, 0, 1, 0, 0, this.store.nextId % 100_000),
    ).toISOString();
    return { id: this.store.nextId++, author: this.user, body, createdAt };
  }

  #log(action: string, detail: string): void {
    this.store.onWrite?.(this.user, action, detail);
  }
}
