/** Shows where a run stands as a commit status on the pull request's latest commit. */
import type { CommitStatus, Forge } from "./forge.ts";

/**
 * Follows the commit the pull request is at, moving to each one the run pushes. Setting a
 * status is best effort: a token without the permission is logged, not fatal.
 */
export class Progress {
  readonly #forge: Forge;
  readonly #url: string | undefined;
  readonly #log: (message: string) => void;
  #sha: string;

  constructor(options: {
    forge: Forge;
    sha: string;
    url?: string;
    log: (message: string) => void;
  }) {
    this.#forge = options.forge;
    this.#sha = options.sha;
    this.#url = options.url;
    this.#log = options.log;
  }

  /** The run is still going; with a sha, the pull request has moved to that commit. */
  async working(description: string, sha?: string): Promise<void> {
    if (sha) {
      this.#sha = sha;
    }
    await this.#set("pending", description);
  }

  /** The run is over: finished, or stopped by something it couldn't handle. */
  async done(description: string): Promise<void> {
    await this.#set("success", description);
  }

  async failed(description: string): Promise<void> {
    await this.#set("error", description);
  }

  async #set(state: CommitStatus["state"], description: string): Promise<void> {
    try {
      await this.#forge.setStatus(this.#sha, {
        state,
        description,
        url: this.#url,
      });
    } catch (error) {
      this.#log(`couldn't set the commit status: ${(error as Error).message}`);
    }
  }
}
