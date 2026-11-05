import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Git and shell commands in one checkout. */
export class Checkout {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async git(...args: string[]): Promise<string> {
    const { stdout } = await exec("git", ["-C", this.dir, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  async head(): Promise<string> {
    return (await this.git("rev-parse", "HEAD")).trim();
  }

  /** Whether anything is changed or untracked. */
  async dirty(): Promise<boolean> {
    return (await this.git("status", "--porcelain")).trim() !== "";
  }

  /** Throw away uncommitted changes and untracked files. Only for checkouts autoreview owns. */
  async discard(): Promise<void> {
    await this.git("reset", "--hard", "--quiet");
    await this.git("clean", "-fd", "--quiet");
  }

  /** Commit everything, returning the new commit, or undefined when nothing changed. */
  async commitAll(message: string): Promise<string | undefined> {
    if (!(await this.dirty())) {
      return undefined;
    }
    await this.git("add", "-A");
    await this.git("commit", "--quiet", "--no-verify", "-m", message);
    return this.head();
  }

  /** Push the checkout's head to a branch, never forcing. Returns false when the branch moved. */
  async push(branch: string): Promise<boolean> {
    try {
      await this.git("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
      return true;
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr ?? error);
      if (/rejected|non-fast-forward|fetch first/.test(message)) {
        return false;
      }
      throw error;
    }
  }

  /** The diff between two commits, optionally only in some paths. */
  async diff(from: string, to: string, paths?: string[]): Promise<string> {
    return this.git("diff", "--no-color", `${from}..${to}`, ...(paths ? ["--", ...paths] : []));
  }

  /** Lines around one line of a file, numbered, or a note when the file is gone. */
  async excerpt(path: string, line: number, radius = 20): Promise<string> {
    let text: string;
    try {
      text = await readFile(join(this.dir, path), "utf8");
    } catch {
      return `(${path} doesn't exist at the head)`;
    }
    const lines = text.split("\n");
    const start = Math.max(1, line - radius);
    const end = Math.min(lines.length, line + radius);
    const width = String(end).length;
    return lines
      .slice(start - 1, end)
      .map((content, index) => `${String(start + index).padStart(width)}  ${content}`)
      .join("\n");
  }

  /** Run a shell command, returning whether it passed and the tail of its output. */
  async check(command: string): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec("sh", ["-c", command], {
        cwd: this.dir,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { ok: true, output: tail(stdout + stderr) };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; message: string };
      return {
        ok: false,
        output: tail(`${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message),
      };
    }
  }
}

function tail(text: string, limit = 4000): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/** Every path a unified diff touches, on either side. */
export function changedFiles(diff: string): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm)) {
    paths.add(match[1]);
  }
  return [...paths];
}

/**
 * The lines of each file's new side that a unified diff shows: added lines,
 * and with `context` also unchanged lines inside hunks. Reviews can only
 * anchor comments to these.
 */
export function diffLines(diff: string, context = true): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  let next = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of diff.split("\n")) {
    // Inside a hunk, count new-side lines: added and context lines advance, removed ones don't
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("+")) {
        lines?.add(next);
        next++;
        newLeft--;
      } else if (text.startsWith("-")) {
        oldLeft--;
      } else if (text.startsWith(" ") || text === "") {
        if (context) {
          lines?.add(next);
        }
        next++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    // A file's new path starts its section; deleted files have none
    if (text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/^b\//, "");
      lines = path === "/dev/null" ? undefined : new Set();
      if (lines) {
        files.set(path, lines);
      }
      continue;
    }

    // A hunk header gives the new side's first line and both sides' lengths
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      next = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
    }
  }
  return files;
}
