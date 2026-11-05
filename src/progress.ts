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
  /** How the run ended, once it has. */
  #ending: { state: CommitStatus["state"]; description: string } | undefined;
  /** Writes not yet answered, which could land after a later one. */
  readonly #inFlight = new Set<Promise<void>>();

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

  /**
   * The run is still going; with a sha, the pull request has moved to that commit. A push that
   * lands after the run ended, as when it was cancelled mid-push, gets the ending instead.
   */
  async working(description: string, sha?: string): Promise<void> {
    const moved = sha !== undefined && sha !== this.#sha;
    if (sha) {
      this.#sha = sha;
    }
    if (!this.#ending) {
      await this.#set("pending", description);
    } else if (moved) {
      await this.#set(this.#ending.state, this.#ending.description);
    }
  }

  /**
   * The run is over: finished, or stopped by something it couldn't handle or a cancellation.
   * The first ending stands, and later updates are ignored.
   */
  async done(description: string): Promise<void> {
    await this.#end("success", description);
  }

  async failed(description: string): Promise<void> {
    await this.#end("error", description);
  }

  async #end(state: CommitStatus["state"], description: string): Promise<void> {
    if (this.#ending) {
      return;
    }
    this.#ending = { state, description };
    const earlier = [...this.#inFlight];
    await this.#set(state, description);

    // An earlier write answered after this one could have replaced it, so set the ending again
    if (earlier.length > 0) {
      await Promise.all(earlier);
      await this.#set(state, description);
    }
  }

  async #set(state: CommitStatus["state"], description: string): Promise<void> {
    const write = this.#write(state, description);
    this.#inFlight.add(write);
    try {
      await write;
    } finally {
      this.#inFlight.delete(write);
    }
  }

  async #write(state: CommitStatus["state"], description: string): Promise<void> {
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
