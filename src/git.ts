import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Marks autoreview's own commits, whichever identity pushed them. */
export const TRAILER = { key: "Autoreview", value: "fixer" };

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

  /**
   * Commit everything with autoreview's trailer, returning the new commit, or undefined
   * when nothing changed.
   */
  async commitAll(message: string): Promise<string | undefined> {
    if (!(await this.dirty())) {
      return undefined;
    }
    await this.git("add", "-A");
    const trailer = `${TRAILER.key}: ${TRAILER.value}`;
    await this.git("commit", "--quiet", "--no-verify", "-m", message, "--trailer", trailer);
    return this.head();
  }

  /** Whether a commit is one of autoreview's own, by its trailer. */
  async isOwn(commit: string): Promise<boolean> {
    const format = `--format=%(trailers:key=${TRAILER.key},valueonly)`;
    const values = await this.git("log", "-1", format, commit);
    return values.split("\n").some((value) => value.trim() === TRAILER.value);
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

/**
 * Every path a unified diff touches, on either side, including renames, copies, and binary,
 * mode-only or empty changes, which only git's extended headers name.
 */
export function changedFiles(diff: string): string[] {
  const paths = new Set<string>();
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of diff.split("\n")) {
    // Skip hunk bodies, whose lines can look like headers
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("+")) {
        newLeft--;
      } else if (text.startsWith("-")) {
        oldLeft--;
      } else if (text.startsWith(" ") || text === "") {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      continue;
    }

    // `diff --git a/x b/x` names files that have no `---` and `+++` lines
    if (text.startsWith("diff --git ")) {
      for (const path of gitHeaderPaths(text.slice("diff --git ".length))) {
        paths.add(path);
      }
      continue;
    }
    const side = /^(?:---|\+\+\+) (.+?)\t?$/.exec(text);
    if (side) {
      const path = unquote(side[1]);
      if (/^[ab]\//.test(path)) {
        paths.add(path.slice(2));
      }
      continue;
    }
    const moved = /^(?:rename|copy) (?:from|to) (.+)$/.exec(text);
    if (moved) {
      paths.add(unquote(moved[1]));
    }
  }
  return [...paths];
}

/** The paths in a `diff --git` header, when they can be told apart. */
function gitHeaderPaths(rest: string): string[] {
  // Quoted paths are unambiguous
  if (rest.startsWith('"') || rest.endsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
    return match
      ? [match[1], match[2]]
          .map(unquote)
          .filter((path) => /^[ab]\//.test(path))
          .map((path) => path.slice(2))
      : [];
  }

  // Unquoted paths may hold spaces, so only the same path on both sides is certain; renames
  // and copies name theirs again in their own headers
  const half = (rest.length - 1) / 2;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  return a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2) ? [a.slice(2)] : [];
}

/** A path as git writes it, decoding a C-style quoted one. */
function unquote(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) {
    return path;
  }
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes: number[] = [];
  const chars = Array.from(path.slice(1, -1));
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") {
      bytes.push(...Buffer.from(chars[i], "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(chars.slice(i + 1, i + 4).join(""));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      const next = chars[++i] ?? "";
      bytes.push(...(next in escapes ? [escapes[next]] : Buffer.from(next, "utf8")));
    }
  }
  return Buffer.from(bytes).toString("utf8");
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
