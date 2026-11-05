import "./scratch.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig, type Config } from "../src/config.ts";
import { Checkout } from "../src/git.ts";
import { compose, readMarker } from "../src/markers.ts";
import { deliberate, status, type Agents, type Outcome } from "../src/loop.ts";
import { MemoryForge, type Store } from "../src/memory.ts";
import type { Answer, Review, Verification } from "../src/schemas.ts";

const FILE = ["export function grow(n) {", "  return n * 2;", "}", ""].join("\n");

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A bare origin, and a clone whose `ferns` branch adds `a.ts` over `main`. */
function repository(): { origin: string; work: string } {
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
interface Script {
  review?: Review[];
  fix?: ((dir: string, task: string) => Answer)[];
  verify?: ((keys: string[], task: string) => Verification)[];
}

interface Setup {
  store: Store;
  work: string;
  origin: string;
  calls: { review: number; fix: number; verify: number };
  /** Each review's task, as the reviewer saw it. */
  reviews: string[];
  run: () => Promise<Outcome>;
}

function setup(
  script: Script,
  options: { config?: object; seed?: (store: Store) => void } = {},
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
      log: () => {},
    });
  return { store, work, origin, calls, reviews, run };
}

const finding = {
  path: "a.ts",
  line: 2,
  severity: "major" as const,
  body: "Doubling overflows.",
  forAuthor: false,
};
const key = "a.ts:+2";

/** Edit a.ts in the checkout and answer with a fix. */
function fix(text: string) {
  return (dir: string): Answer => {
    writeFileSync(join(dir, "a.ts"), FILE.replace("n * 2", text));
    return { action: "fix", body: "Guarded it.", commit: "Guard the doubling" };
  };
}
const reply = (): Answer => ({ action: "reply", body: "It can't overflow here." });
const verdict =
  (value: "resolved" | "follow-up" | "defer") =>
  (keys: string[]): Verification => ({
    threads: keys.map((k) => ({ key: k, verdict: value, body: `Verdict: ${value}.` })),
    findings: [],
  });

test("a clear finding is fixed, pushed, verified and resolved", async () => {
  const { store, work, origin, run } = setup({
    review: [{ summary: "One problem.", findings: [finding] }],
    fix: [fix("Math.min(n * 2, MAX)")],
    verify: [verdict("resolved")],
  });
  const outcome = await run();
  assert.equal(outcome.resolved, 1);
  assert.equal(outcome.commits.length, 1);

  // The fix is on the branch, with the branch's prefix, and the thread is resolved
  assert.equal(git(origin, "rev-parse", "ferns"), git(work, "rev-parse", "HEAD"));
  assert.equal(git(work, "log", "-1", "--format=%s"), "ferns: Guard the doubling");
  const [thread] = store.threads;
  assert.equal(thread.resolved, true);
  assert.deepEqual(
    thread.comments.map((c) => [c.author, readMarker(c.body)?.kind]),
    [
      ["reviewer-bot", "finding"],
      ["fixer-bot", "answer"],
      ["reviewer-bot", "verdict"],
    ],
  );
  assert.match(
    thread.comments[1].body,
    /^🤖 \*\*Fixer\*\* · claude-opus-5\.5 · fixed in [0-9a-f]{7}/,
  );

  // The summary records the new head, so the next run reviews nothing old
  const summary = readMarker(store.comments.at(-1)?.body ?? "");
  assert.equal(summary?.kind, "summary");
  assert.equal(summary?.head, git(work, "rev-parse", "HEAD"));
  assert.ok(!store.pr.labels.includes("needs-author"));
});

test("a disagreement defers after the exchange cap, and labels the pull request", async () => {
  const { store, calls, run } = setup({
    review: [{ summary: "One problem.", findings: [finding] }],
    fix: [reply, reply],
    verify: [verdict("follow-up"), verdict("follow-up")],
  });
  const outcome = await run();
  assert.equal(calls.fix, 2);
  assert.equal(outcome.deferred, 1);
  assert.match(store.threads[0].comments.at(-1)?.body ?? "", /still disagree/);
  assert.ok(store.pr.labels.includes("needs-author"));
});

test("a fix that keeps failing the checks is dropped and deferred with the output", async () => {
  const { store, work, calls, run } = setup(
    {
      review: [{ summary: "One problem.", findings: [finding] }],
      fix: [fix("broken("), fix("still broken(")],
    },
    { config: { checks: ["grep -q broken a.ts && echo 'syntax error' && exit 1 || true"] } },
  );
  const outcome = await run();
  assert.equal(calls.fix, 2);
  assert.equal(outcome.commits.length, 0);
  assert.equal(readFileSync(join(work, "a.ts"), "utf8"), FILE);
  assert.equal(status(store.threads[0]), "deferred");
  assert.match(
    store.threads[0].comments[1].body,
    /couldn't make a fix that passes[\s\S]*syntax error/,
  );
});

test("in blocking mode, findings for the author, or outside the diff, never reach the fixer", async () => {
  const { store, calls, run } = setup(
    {
      review: [
        {
          summary: "Two concerns.",
          findings: [
            { ...finding, forAuthor: true },
            { ...finding, path: "README.md", line: 1 },
          ],
        },
      ],
    },
    { config: { defer: "blocking" } },
  );
  const outcome = await run();
  assert.equal(calls.fix, 0);
  assert.equal(outcome.deferred, 1);
  assert.match(store.comments[0].body, /Outside the diff, for the author:[\s\S]*README\.md:1/);
});

test("a rerun resumes: it verifies an answered thread and reviews nothing old", async () => {
  const { store, calls, run } = setup(
    { verify: [verdict("resolved")] },
    {
      seed: (store) => {
        // A previous run reviewed the head, and the fixer answered before it stopped
        const reviewed = {
          role: "reviewer" as const,
          kind: "review" as const,
          head: store.pr.headSha,
        };
        store.comments.push({
          id: 1,
          author: "reviewer-bot",
          body: compose("x", "Reviewed.", reviewed),
          createdAt: "",
        });
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
            {
              id: 3,
              author: "fixer-bot",
              body: compose("x", "No.", { role: "fixer", kind: "answer" }),
              createdAt: "",
            },
          ],
        });
      },
    },
  );
  const outcome = await run();
  assert.equal(calls.review, 0);
  assert.equal(calls.verify, 1);
  assert.equal(outcome.resolved, 1);
  assert.equal(store.threads[0].resolved, true);
});

test("a thread a person has joined is left to them", async () => {
  const { store, calls, run } = setup(
    {},
    {
      seed: (store) => {
        // A finding from an earlier review that a person has answered
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
            { id: 3, author: "kurt", body: "Leave this one, I'll think about it.", createdAt: "" },
          ],
        });
      },
    },
  );
  const outcome = await run();
  assert.equal(calls.fix, 0);
  assert.equal(outcome.human, 1);
  assert.match(store.comments.at(-1)?.body ?? "", /a person has joined:[\s\S]*a\.ts:2/);
});

test("threads open at the round cap go to the author", async () => {
  const { store, run } = setup(
    {
      review: [{ summary: "One problem.", findings: [finding] }],
      fix: [reply],
      verify: [verdict("follow-up")],
    },
    { config: { maxRounds: 1 } },
  );
  const outcome = await run();
  assert.equal(outcome.deferred, 1);
  assert.match(store.threads[0].comments.at(-1)?.body ?? "", /after 1 rounds/);
});

test("the run stops without replying when the branch moved", async () => {
  const { store, origin, run } = setup({
    review: [{ summary: "One problem.", findings: [finding] }],
    fix: [
      (dir) => {
        // Someone pushes to the branch while the fixer works
        const other = join(dir, "..", "other");
        execFileSync("git", ["clone", "--quiet", "-b", "ferns", origin, other]);
        git(
          other,
          "-c",
          "user.name=X",
          "-c",
          "user.email=x@x",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "Theirs",
        );
        git(other, "push", "--quiet", "origin", "ferns");
        return fix("Math.min(n * 2, MAX)")(dir);
      },
    ],
  });
  const outcome = await run();
  assert.match(outcome.stopped ?? "", /ferns moved/);
  assert.equal(store.threads[0].comments.length, 1);
  assert.equal(git(origin, "log", "-1", "--format=%s", "ferns"), "Theirs");
});

test("pull requests without the label, or drafts, are skipped", async () => {
  const unlabelled = setup({}, { seed: (store) => (store.pr.labels = []) });
  assert.match((await unlabelled.run()).skipped ?? "", /isn't labelled autoreview/);
  const draft = setup({}, { seed: (store) => (store.pr.draft = true) });
  assert.match((await draft.run()).skipped ?? "", /draft/);
  assert.equal(draft.store.comments.length, 0);
});

test("a rerun with nothing new posts nothing", async () => {
  const first = setup({ review: [{ summary: "Fine.", findings: [] }] });
  await first.run();
  const posted = first.store.comments.length;

  // The same pull request again, as when another label is added
  const outcome = await first.run();
  assert.match(outcome.skipped ?? "", /nothing new/);
  assert.equal(first.store.comments.length, posted);
});

test("a later run reviews the pull request's new commits, not a merge from the base", async () => {
  const { store, work, reviews, run } = setup({});
  await run();

  // main moves on in a file the pull request doesn't touch
  git(work, "checkout", "--quiet", "main");
  writeFileSync(join(work, "README.md"), "hi\nfrom main\n");
  git(work, "commit", "--quiet", "-am", "Main moves on");

  // The branch merges main, then changes its own file
  git(work, "checkout", "--quiet", "ferns");
  git(work, "merge", "--quiet", "--no-edit", "main");
  writeFileSync(join(work, "a.ts"), FILE.replace("n * 2", "n * 3"));
  git(work, "commit", "--quiet", "-am", "Triple instead");
  git(work, "checkout", "--quiet", "--detach");
  store.pr.headSha = git(work, "rev-parse", "HEAD");
  store.diff = git(work, "diff", "main...HEAD");
  await run();

  // The second review saw the new change, and nothing of main's
  assert.equal(reviews.length, 2);
  assert.match(reviews[1], /\+  return n \* 3;/);
  assert.doesNotMatch(reviews[1], /from main/);
});

/** The author commits a new version of a.ts on the branch, and the pull request moves to it. */
function authorCommits(setup: Setup, text: string): void {
  const { store, work } = setup;
  git(work, "checkout", "--quiet", "ferns");
  writeFileSync(join(work, "a.ts"), FILE.replace("n * 2", text));
  git(work, "commit", "--quiet", "-am", "Author's change");
  git(work, "checkout", "--quiet", "--detach");
  store.pr.headSha = git(work, "rev-parse", "HEAD");
  store.diff = git(work, "diff", "main...HEAD");
}

test("a later run resolves a deferred thread the author's commits settle", async () => {
  const forAuthor = { summary: "For you.", findings: [{ ...finding, forAuthor: true }] };
  const tasks: string[] = [];
  const settled = (keys: string[], task: string) => (tasks.push(task), verdict("resolved")(keys));
  const first = setup(
    { review: [forAuthor], verify: [settled] },
    { config: { defer: "blocking" } },
  );
  assert.equal((await first.run()).deferred, 1);
  assert.ok(first.store.pr.labels.includes("needs-author"));

  // The author guards the doubling; the reviewer rechecks the thread against that commit
  authorCommits(first, "Math.min(n * 2, LIMIT)");
  const outcome = await first.run();
  assert.equal(first.calls.verify, 1);
  assert.match(tasks[0], /rechecking deferred threads[\s\S]*Math\.min\(n \* 2, LIMIT\)/);
  assert.equal(status(first.store.threads[0]), "resolved");
  assert.match(first.store.threads[0].comments.at(-1)?.body ?? "", /Verdict: resolved/);
  assert.equal(outcome.deferred, 0);
  assert.ok(!first.store.pr.labels.includes("needs-author"));
});

test("a deferred thread the new commits don't settle stays with the author, unremarked", async () => {
  const forAuthor = { summary: "For you.", findings: [{ ...finding, forAuthor: true }] };
  const first = setup(
    { review: [forAuthor], verify: [verdict("defer")] },
    { config: { defer: "blocking" } },
  );
  await first.run();
  const before = first.store.threads[0].comments.length;

  authorCommits(first, "n * 3");
  const outcome = await first.run();
  assert.equal(first.calls.verify, 1);
  assert.equal(status(first.store.threads[0]), "deferred");
  assert.equal(first.store.threads[0].comments.length, before);
  assert.equal(outcome.deferred, 1);
});

const decision = { chose: "Clamp to MAX.", alternative: "Widen the accepted range." };

/** Edit a.ts and answer with a fix that flags a judgement call. */
function decide(text: string) {
  return (dir: string): Answer => ({ ...fix(text)(dir), decision });
}

test("in best-effort mode, a finding for the author goes to the fixer", async () => {
  const { store, calls, run } = setup({
    review: [{ summary: "One concern.", findings: [{ ...finding, forAuthor: true }] }],
    fix: [fix("Math.min(n * 2, MAX)")],
    verify: [verdict("resolved")],
  });
  const outcome = await run();
  assert.equal(calls.fix, 1);
  assert.equal(outcome.deferred, 0);
  assert.equal(status(store.threads[0]), "resolved");
  assert.doesNotMatch(store.threads[0].comments[0].body, /for the author/);
});

test("a judgement call is resolved, flagged, listed for review and labelled", async () => {
  const { store, run } = setup({
    review: [{ summary: "One problem.", findings: [finding] }],
    fix: [decide("Math.min(n * 2, MAX)")],
    verify: [verdict("resolved")],
  });
  const outcome = await run();
  assert.deepEqual([outcome.resolved, outcome.decided, outcome.deferred], [1, 1, 0]);

  // The answer shows the decision, and its marker carries it
  const answer = store.threads[0].comments[1].body;
  assert.match(answer, /fixed in [0-9a-f]{7} · decision/);
  assert.match(answer, /Decision, for the author to review:\*\* Clamp to MAX\.[\s\S]*Alternative/);
  assert.deepEqual(readMarker(answer)?.decision, decision);

  // The summary lists it apart from deferrals, and only the review label is added
  const summary = store.comments.at(-1)?.body ?? "";
  assert.match(summary, /1 resolved \(1 decided for you to review\), 0 for the author\./);
  assert.match(
    summary,
    /Decided for you, to review:\n\n- `a\.ts:2`: Clamp to MAX\. Alternative: Widen the accepted range\./,
  );
  assert.doesNotMatch(summary, /For you to decide/);
  assert.ok(store.pr.labels.includes("author-review"));
  assert.ok(!store.pr.labels.includes("needs-author"));
});

test("a lasting disagreement is ruled on by the reviewer and flagged, not deferred", async () => {
  const tasks: string[] = [];
  const rule = (keys: string[], task: string): Verification => (
    tasks.push(task),
    {
      threads: keys.map((k) => ({ key: k, verdict: "follow-up", body: "Clamp it.", decision })),
      findings: [],
    }
  );
  const { store, calls, run } = setup({
    review: [{ summary: "One problem.", findings: [finding] }],
    fix: [reply, reply, fix("Math.min(n * 2, MAX)")],
    verify: [verdict("follow-up"), rule, verdict("resolved")],
  });
  const outcome = await run();
  assert.equal(calls.fix, 3);

  // The reviewer saw the thread was final, ruled, and the fixer carried it out
  assert.match(tasks[0], /\*\*Final:\*\*/);
  const thread = store.threads[0];
  assert.match(thread.comments[4].body, /· ruling/);
  assert.equal(readMarker(thread.comments[4].body)?.value, "ruling");
  assert.equal(status(thread), "resolved");
  assert.deepEqual([outcome.decided, outcome.deferred], [1, 0]);
  assert.ok(store.pr.labels.includes("author-review"));
});

test("in best-effort mode, a ruling that's still disputed is deferred", async () => {
  const rule = (keys: string[]): Verification => ({
    threads: keys.map((k) => ({ key: k, verdict: "follow-up", body: "Clamp it.", decision })),
    findings: [],
  });
  const { store, run } = setup(
    {
      review: [{ summary: "One problem.", findings: [finding] }],
      fix: [reply, reply, reply],
      verify: [verdict("follow-up"), rule, verdict("follow-up")],
    },
    { config: { maxRounds: 4 } },
  );
  const outcome = await run();
  assert.equal(outcome.deferred, 1);
  assert.match(store.threads[0].comments.at(-1)?.body ?? "", /still disagree/);
  assert.ok(store.pr.labels.includes("needs-author"));
  assert.ok(!store.pr.labels.includes("author-review"));
});

test("both labels clear once the deferral is settled and the decision answered", async () => {
  const second = { ...finding, line: 1, body: "Rename it." };
  const both = setup({
    review: [{ summary: "Two problems.", findings: [finding, second] }],
    fix: [
      decide("Math.min(n * 2, MAX)"),
      () => ({ action: "defer", body: "Renaming drops a public export." }),
    ],
    verify: [verdict("resolved"), verdict("resolved")],
  });
  const first = await both.run();
  assert.deepEqual([first.decided, first.deferred], [1, 1]);
  const summary = both.store.comments.at(-1)?.body ?? "";
  assert.match(
    summary,
    /For you to decide:[\s\S]*a\.ts:1[\s\S]*Decided for you, to review:[\s\S]*a\.ts:2/,
  );
  assert.ok(both.store.pr.labels.includes("needs-author"));
  assert.ok(both.store.pr.labels.includes("author-review"));

  // The author answers the decision, and commits what settles the deferral
  const decided = both.store.threads.find((t) => t.line === 2);
  decided?.comments.push({ id: 99, author: "kurt", body: "Fine by me.", createdAt: "" });
  authorCommits(both, "Math.min(n * 2, LIMIT)");
  const later = await both.run();
  assert.deepEqual([later.decided, later.deferred], [0, 0]);
  assert.ok(!both.store.pr.labels.includes("needs-author"));
  assert.ok(!both.store.pr.labels.includes("author-review"));
});

/** An open finding from an earlier review, on a.ts line 2. */
function seedFinding(store: Store): void {
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

test("with only autoreview, findings wait for the author until their commits settle them", async () => {
  const reviewOnly = setup(
    { review: [{ summary: "One problem.", findings: [finding] }], verify: [verdict("resolved")] },
    { seed: (store) => (store.pr.labels = ["autoreview"]) },
  );
  const first = await reviewOnly.run();
  assert.equal(reviewOnly.calls.fix, 0);
  assert.equal(first.deferred, 1);
  assert.match(reviewOnly.store.comments.at(-1)?.body ?? "", /For you to decide:[\s\S]*a\.ts:2/);
  assert.ok(reviewOnly.store.pr.labels.includes("needs-author"));

  // The author's commit settles the finding, and the reviewer resolves it
  authorCommits(reviewOnly, "Math.min(n * 2, LIMIT)");
  const later = await reviewOnly.run();
  assert.equal(reviewOnly.calls.verify, 1);
  assert.equal(status(reviewOnly.store.threads[0]), "resolved");
  assert.equal(later.deferred, 0);
  assert.ok(!reviewOnly.store.pr.labels.includes("needs-author"));
});

test("with only autofix, the fixer answers open threads, unverified, and reviews nothing", async () => {
  const fixOnly = setup(
    { fix: [fix("Math.min(n * 2, MAX)")], verify: [verdict("resolved")] },
    {
      seed: (store) => {
        store.pr.labels = ["autofix"];
        seedFinding(store);
      },
    },
  );
  const outcome = await fixOnly.run();
  assert.deepEqual([fixOnly.reviews.length, fixOnly.calls.fix, fixOnly.calls.verify], [0, 1, 0]);
  assert.equal(outcome.commits.length, 1);
  assert.equal(outcome.waiting, 1);

  // The answer stands in the open thread, and the fixer posts the summary
  const [thread] = fixOnly.store.threads;
  assert.equal(thread.resolved, false);
  assert.equal(status(thread), "verify");
  const summary = fixOnly.store.comments.at(-1);
  assert.equal(summary?.author, "fixer-bot");
  assert.equal(readMarker(summary?.body ?? "")?.role, "fixer");
  assert.match(summary?.body ?? "", /left open for the commenter:[\s\S]*a\.ts:2/);

  // Adding autoreview later reviews the whole pull request, since the fixer's summary isn't a
  // review, and verifies the fixer's answer
  fixOnly.store.pr.labels.push("autoreview");
  fixOnly.store.pr.headSha = git(fixOnly.work, "rev-parse", "HEAD");
  fixOnly.store.diff = git(fixOnly.work, "diff", "main...HEAD");
  const later = await fixOnly.run();
  assert.equal(fixOnly.reviews.length, 1);
  assert.match(fixOnly.reviews[0], /\+export function grow[\s\S]*Math\.min/);
  assert.equal(later.resolved, 1);
});
