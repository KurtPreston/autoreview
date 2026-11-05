/** What the deliberation needs from a code host, independent of which one. */

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  draft: boolean;
  state: "open" | "closed";
  labels: string[];
  /** The head's name, for display and commit prefixes. */
  headRef: string;
  /** The branch to push fixes to; undefined when the head isn't a branch of this repository (deleted, or from a fork). */
  headBranch: string | undefined;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

export interface Comment {
  id: number;
  author: string;
  /** Set when the author is an app or bot account, where the forge says so. */
  bot?: boolean;
  body: string;
  createdAt: string;
}

/** A conversation anchored to one line of one file. */
export interface Thread {
  /** The forge's handle for the conversation, used to reply to and resolve it. */
  id: string;
  /** Stable identity: the path and line, which is how hosts group a conversation. */
  key: string;
  path: string;
  line: number;
  /** Which side of the diff the line is on. */
  side: "new" | "old";
  resolved: boolean;
  /** Oldest first; the first opened the thread. */
  comments: Comment[];
}

/** An inline comment to post, on a line of the pull request's new side. */
export interface NewComment {
  path: string;
  line: number;
  body: string;
}

/** Where a run stands, shown with the pull request's checks on one commit. */
export interface CommitStatus {
  state: "pending" | "success" | "failure" | "error";
  description: string;
  /** Where to watch the run, when known. */
  url?: string;
}

/** The name autoreview's commit status goes by. */
export const STATUS_CONTEXT = "autoreview/deliberation";

export interface Forge {
  /** The login this forge posts as. */
  login(): Promise<string>;
  pullRequest(number: number): Promise<PullRequest>;
  /** The pull request's unified diff against its base. */
  diff(number: number): Promise<string>;
  /** Review threads, oldest first. */
  threads(number: number): Promise<Thread[]>;
  /** Top-level conversation comments, oldest first. */
  comments(number: number): Promise<Comment[]>;
  /** Post a review as one batch: a summary and inline comments. */
  review(
    number: number,
    review: { body: string; commit: string; comments: NewComment[] },
  ): Promise<void>;
  reply(number: number, thread: Thread, body: string): Promise<void>;
  resolve(thread: Thread): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  addLabel(number: number, name: string): Promise<void>;
  removeLabel(number: number, name: string): Promise<void>;
  /** Set autoreview's status on a commit, replacing the one it set before. */
  setStatus(sha: string, status: CommitStatus): Promise<void>;
  /** Start a workflow by file name on a branch, where the forge can. */
  dispatch?(workflow: string, ref: string): Promise<void>;
}

/** Build a thread key from where a conversation sits. */
export function threadKey(path: string, line: number, side: "new" | "old"): string {
  return `${path}:${side === "new" ? "+" : "-"}${line}`;
}
