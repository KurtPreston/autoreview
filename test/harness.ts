import "./scratch.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import { Checkout } from "../src/git.ts";
import { compose } from "../src/markers.ts";
import { deliberate, type Agents, type Outcome } from "../src/loop.ts";
import { MemoryForge, type Store } from "../src/memory.ts";
import type { Answer, Review, Verification } from "../src/schemas.ts";

export const FILE = ["export function grow(n) {", "  return n * 2;", "}", ""].join("\n");

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A bare origin, and a clone whose `ferns` branch adds `a.ts` over `main`. */
export function repository(): { origin: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "autoreview-loop-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, work]);
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");

  // main has a README; ferns adds the code under review
  writeFileSync(join(work, "README.md"), "hi\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "init");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  git(work, "checkout", "--quiet", "-b", "ferns");
  writeFileSync(join(work, "a.ts"), FILE);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "Add grow");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/ferns");
  git(work, "checkout", "--quiet", "--detach");
  return { origin, work };
}

/** Scripted answers, taken in order; each may act on the checkout first. */
export interface Script {
  review?: Review[];
  fix?: ((dir: string, task: string) => Answer)[];
  verify?: ((keys: string[], task: string) => Verification)[];
}

export interface Setup {
  store: Store;
  work: string;
  origin: string;
  calls: { review: number; fix: number; verify: number };
  /** Each review's task, as the reviewer saw it. */
  reviews: string[];
  /** The scripted agents, which a test may replace. */
  agents: Agents;
  run: () => Promise<Outcome>;
}

export function setup(
  script: Script,
  options: { config?: object; seed?: (store: Store) => void; signal?: AbortSignal } = {},
): Setup {
  const { origin, work } = repository();
  const store: Store = {
    pr: {
      number: 7,
      title: "Add grow",
      body: "",
      author: "kurt",
      draft: false,
      state: "open",
      labels: ["autoreview", "autofix"],
      headRef: "ferns",
      headBranch: "ferns",
      headSha: git(work, "rev-parse", "HEAD"),
      baseRef: "main",
      baseSha: git(work, "rev-parse", "main"),
    },
    diff: git(work, "diff", "main..ferns"),
    threads: [],
    comments: [],
    nextId: 1,
  };
  options.seed?.(store);

  // Agents play back the script, counting calls
  const calls = { review: 0, fix: 0, verify: 0 };
  const reviews: string[] = [];
  const agents: Agents = {
    review: async (task) => {
      reviews.push(task);
      return script.review?.[calls.review++] ?? { summary: "Looks fine.", findings: [] };
    },
    fix: async (task) => {
      const step = script.fix?.[calls.fix++];
      assert.ok(step, "unexpected fixer call");
      return step(work, task);
    },
    verify: async (task, keys) => {
      const step = script.verify?.[calls.verify++];
      assert.ok(step, "unexpected verifier call");
      return step(keys, task);
    },
  };

  const config: Config = parseConfig({ checks: ["true"], ...options.config });
  const run = () =>
    deliberate({
      number: 7,
      config,
      checkout: new Checkout(work),
      reviewer: new MemoryForge(store, "reviewer-bot"),
      fixer: new MemoryForge(store, "fixer-bot"),
      agents,
      usage: {},
      push: true,
      heavy: false,
      force: false,
      signal: options.signal,
      log: () => {},
    });
  return { store, work, origin, calls, reviews, agents, run };
}

export const finding = {
  path: "a.ts",
  line: 2,
  severity: "major" as const,
  body: "Doubling overflows.",
  forAuthor: false,
};
export const key = "a.ts:+2";

/** Edit a.ts in the checkout and answer with a fix. */
export function fix(text: string) {
  return (dir: string): Answer => {
    writeFileSync(join(dir, "a.ts"), FILE.replace("n * 2", text));
    return { action: "fix", body: "Guarded it.", commit: "Guard the doubling" };
  };
}
export const reply = (): Answer => ({ action: "reply", body: "It can't overflow here." });
export const verdict =
  (value: "resolved" | "follow-up" | "defer") =>
  (keys: string[]): Verification => ({
    threads: keys.map((k) => ({ key: k, verdict: value, body: `Verdict: ${value}.` })),
    findings: [],
  });

/** The author commits a new version of a.ts on the branch, and the pull request moves to it. */
export function authorCommits(setup: Setup, text: string): void {
  const { store, work } = setup;
  git(work, "checkout", "--quiet", "ferns");
  writeFileSync(join(work, "a.ts"), FILE.replace("n * 2", text));
  git(work, "commit", "--quiet", "-am", "Author's change");
  git(work, "checkout", "--quiet", "--detach");
  store.pr.headSha = git(work, "rev-parse", "HEAD");
  store.diff = git(work, "diff", "main...HEAD");
}

/** An open finding from an earlier review, on a.ts line 2. */
export function seedFinding(store: Store): void {
  store.threads.push({
    id: "2",
    key,
    path: "a.ts",
    line: 2,
    side: "new",
    resolved: false,
    comments: [
      {
        id: 2,
        author: "reviewer-bot",
        body: compose("x", "Overflow.", { role: "reviewer", kind: "finding" }),
        createdAt: "",
      },
    ],
  });
}
