import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS } from "../src/config.ts";
import type { PullRequest } from "../src/forge.ts";
import { compose, plainText, readMarker } from "../src/markers.ts";
import { clip, common, guidanceFor, modeText, render } from "../src/prompts.ts";
import {
  extractJson,
  SchemaError,
  validateAnswer,
  validateReview,
  validateVerification,
} from "../src/schemas.ts";

test("JSON is found whole, fenced, or wrapped in prose", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here:\n```json\n{"a":2}\n```\nDone.'), { a: 2 });
  assert.deepEqual(extractJson('I fixed it. {"a":{"b":3}} Hope that helps.'), { a: { b: 3 } });
  assert.throws(() => extractJson("nothing"), SchemaError);
});

test("reviews need well-formed findings", () => {
  const finding = { path: "a.ts", line: 3, severity: "minor", body: "x" };
  assert.deepEqual(validateReview({ summary: "ok", findings: [finding] }).findings[0], {
    ...finding,
    forAuthor: false,
  });
  assert.throws(
    () => validateReview({ summary: "ok", findings: [{ ...finding, line: 0 }] }),
    /findings\[0\]\.line/,
  );
  assert.throws(
    () => validateReview({ summary: "ok", findings: [{ ...finding, severity: "huge" }] }),
    /severity/,
  );
});

test("a fix needs a commit summary; replies don't keep one", () => {
  assert.throws(() => validateAnswer({ action: "fix", body: "done" }), /\$\.commit/);
  assert.deepEqual(validateAnswer({ action: "reply", body: "no", commit: "x" }), {
    action: "reply",
    body: "no",
  });
});

test("an answer may flag a decision, but a deferral can't", () => {
  const decision = { chose: "Widen the range to 0.001–1000.", alternative: "Clamp the size." };
  assert.deepEqual(
    validateAnswer({ action: "fix", body: "Widened.", commit: "Widen", decision }).decision,
    decision,
  );
  assert.equal(
    validateAnswer({ action: "reply", body: "Fine.", decision: null }).decision,
    undefined,
  );
  assert.equal(validateAnswer({ action: "defer", body: "Yours.", decision }).decision, undefined);
  assert.throws(
    () => validateAnswer({ action: "fix", body: "x", commit: "x", decision: { chose: "x" } }),
    /\$\.decision\.alternative/,
  );
});

test("verdicts may carry a decision, except deferrals", () => {
  const decision = { chose: "Keep the clamp.", alternative: "Widen the range." };
  const { threads } = validateVerification({
    threads: [
      { key: "a", verdict: "follow-up", body: "Do it my way.", decision },
      { key: "b", verdict: "defer", body: "Yours.", decision },
    ],
  });
  assert.deepEqual(threads[0].decision, decision);
  assert.equal("decision" in threads[1], false);
});

test("markers survive text that would close an HTML comment", () => {
  const decision = { chose: "Use a --> b } -->", alternative: "<!-- c -->" };
  const body = compose("x", "Text.", { role: "fixer", kind: "answer", decision });
  assert.equal((body.match(/-->/g) ?? []).length, 1);
  assert.deepEqual(readMarker(body)?.decision, decision);
  assert.equal(plainText(body), "Text.");
});

test("comments that open with an older notice line still read as their text", () => {
  const finding = compose("Finding", "Text.", { role: "reviewer", kind: "finding" });
  assert.equal(plainText(`🤖 Run by an operator's pilot.\n\n${finding}`), "Text.");
});

test("verifications default to no new findings", () => {
  const value = validateVerification({
    threads: [{ key: "a.ts:+3", verdict: "resolved", body: "Good." }],
  });
  assert.deepEqual(value.findings, []);
  assert.throws(
    () => validateVerification({ threads: [{ key: "k", verdict: "maybe", body: "?" }] }),
    /verdict/,
  );
});

test("prompts fill every slot, and leave braces in filled text alone", () => {
  const pr: PullRequest = {
    number: 7,
    title: "Grow ferns",
    body: "Uses {{title}} literally.",
    author: "kurt",
    draft: false,
    state: "open",
    labels: [],
    headRef: "ferns",
    headBranch: "ferns",
    headSha: "abc",
    baseRef: "main",
    baseSha: "def",
  };
  const text = common(pr, DEFAULTS);
  assert.match(text, /#7: Grow ferns/);
  assert.match(text, /Uses \{\{title\}\} literally/);
  assert.match(text, /visual checks aren't available/);
  assert.throws(() => render("common", {}), /needs \{\{deferral\}\}/);
});

test("only the conventions found in changed folders are scoped to their folders", () => {
  const pr = { number: 7, title: "t", body: "", author: "kurt", headRef: "h", baseRef: "b" };
  const config = { ...DEFAULTS, context: ["AGENTS.md", "docs/style.md"] };
  const plain = common(pr as PullRequest, config);
  assert.match(plain, /conventions: `AGENTS\.md`, `docs\/style\.md`\. Follow/);
  assert.doesNotMatch(plain, /folder named with it/);

  // A folder config's context is for its folder's code, not the code beside the file
  const text = common(pr as PullRequest, config, {
    conventions: [
      { path: "pkg/AGENTS.md", folder: "pkg" },
      { path: "packages/api/docs/api.md", folder: "packages/api" },
    ],
  });
  assert.match(
    text,
    /conventions: `AGENTS\.md`, `docs\/style\.md`\. Then read these, from the folders the pull request changes, each for the code under the folder named with it[^:]*: `pkg\/AGENTS\.md` for `pkg\/`, `packages\/api\/docs\/api\.md` for `packages\/api\/`\./,
  );
});

test("instruction files are listed with their patterns, without those excluded from the role", () => {
  const pr = { number: 7, title: "t", body: "", author: "kurt", headRef: "h", baseRef: "b" };
  const run = {
    conventions: [],
    instructions: [
      { path: ".github/instructions/ts.instructions.md", applyTo: "**/*.ts,**/*.tsx" },
      {
        path: ".github/instructions/review.instructions.md",
        applyTo: "**",
        excludes: "fixer" as const,
      },
    ],
  };
  assert.doesNotMatch(common(pr as PullRequest, DEFAULTS), /instruction files/);

  // The reviewer reads both, the fixer only the one not kept from it
  const reviewer = common(pr as PullRequest, DEFAULTS, guidanceFor(run, "reviewer"));
  assert.match(
    reviewer,
    /`AGENTS\.md`\. Then read these instruction files, each for the files its `applyTo` pattern matches: `\.github\/instructions\/ts\.instructions\.md` for `\*\*\/\*\.ts,\*\*\/\*\.tsx`, `\.github\/instructions\/review\.instructions\.md` for `\*\*`\. Follow/,
  );
  const fixer = common(pr as PullRequest, DEFAULTS, guidanceFor(run, "fixer"));
  assert.match(fixer, /ts\.instructions\.md/);
  assert.doesNotMatch(fixer, /review\.instructions\.md/);
});

test("each deferral mode fills the prompts with its own criteria", () => {
  const pr = { number: 7, title: "t", body: "", author: "kurt", headRef: "h", baseRef: "b" };
  const text = (defer: "best-effort" | "blocking", visual = false) => {
    const config = { ...DEFAULTS, defer, visual };
    const slots = { path: "a.ts", line: 1, checks: "", thread: "", excerpt: "", baseSha: "b" };
    const vars = {
      ...slots,
      ...modeText(config),
      common: common(pr as PullRequest, config),
      maxFindings: 3,
      diff: "",
      threads: "",
      changes: "",
    };
    return ["fix", "review", "verify"].map((name) => render(name, vars)).join("\n");
  };
  const bestEffort = text("best-effort");
  assert.match(bestEffort, /only when the agents truly can't settle it/);
  assert.match(bestEffort, /Leave `forAuthor` false/);
  assert.match(bestEffort, /\*\*Final\*\*/);
  assert.match(bestEffort, /visual checks aren't available here\./);
  assert.doesNotMatch(text("best-effort", true), /only be judged by looking/);
  const blocking = text("blocking");
  assert.match(blocking, /reasonable people would choose differently/);
  assert.match(blocking, /Set `forAuthor` to true/);
  for (const prompt of [bestEffort, blocking]) {
    assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
  }
});

test("long text is clipped with a pointer to the rest", () => {
  assert.equal(clip("short", 10, "run git diff"), "short");
  assert.match(
    clip("x".repeat(20), 10, "run git diff"),
    /^x{10}\n… \(cut at 10 characters; run git diff\)$/,
  );
});
