import "./scratch.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, setup, type Setup } from "./harness.ts";

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);

/** Commit README.md with one line changed on a branch, then detach. */
function readme(work: string, branch: string, change: (lines: string[]) => void): void {
  git(work, "checkout", "--quiet", branch);
  const lines = [...LINES];
  if (branch === "ferns") {
    lines[11] = "line 12, from ferns";
  }
  change(lines);
  writeFileSync(join(work, "README.md"), `${lines.join("\n")}\n`);
  git(work, "commit", "--quiet", "-am", `README on ${branch}`);
}

/** Merge main into ferns, and point the pull request at the result. */
function mergeMain(s: Setup): void {
  git(s.work, "checkout", "--quiet", "ferns");
  git(s.work, "merge", "--quiet", "--no-edit", "main");
  git(s.work, "checkout", "--quiet", "--detach");
  s.store.pr.headSha = git(s.work, "rev-parse", "HEAD");
  s.store.diff = git(s.work, "diff", "main...HEAD");
}

test("a finding on a line only a merge from the base changed isn't posted inline", async () => {
  const s = setup({
    review: [
      { summary: "Looks fine.", findings: [] },
      {
        summary: "One concern.",
        findings: [
          { path: "README.md", line: 1, severity: "major", body: "Odd line.", forAuthor: true },
        ],
      },
    ],
  });

  // main grows the README, and the pull request changes its last line
  readme(s.work, "main", () => {});
  mergeMain(s);
  readme(s.work, "ferns", () => {});
  mergeMain(s);
  await s.run();

  // main then changes the README's first line, and the branch merges it
  readme(s.work, "main", (lines) => (lines[0] = "line 1, from main"));
  mergeMain(s);
  await s.run();

  // The finding on main's line has no thread; it's a note in the review instead
  assert.equal(s.calls.review, 2);
  assert.equal(
    s.store.threads.find((t) => t.path === "README.md"),
    undefined,
  );
  const review = s.store.comments.filter((c) => c.body.includes('"kind":"review"')).at(-1);
  assert.match(review?.body ?? "", /Outside the diff[\s\S]*`README\.md:1`/);
});
