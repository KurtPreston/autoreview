import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "../src/git.ts";
import { compose, plainText, readMarker } from "../src/markers.ts";

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+2",
  "+++ looks like a header",
  " three",
  "diff --git a/gone.ts b/gone.ts",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/new.ts b/new.ts",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n");

test("diff lines cover added and context lines on the new side", () => {
  const lines = diffLines(DIFF);
  assert.deepEqual([...(lines.get("a.ts") ?? [])], [1, 2, 3, 4]);
  assert.deepEqual([...(lines.get("new.ts") ?? [])], [1]);
  assert.equal(lines.has("gone.ts"), false);
  assert.equal(lines.has("looks like a header"), false);

  // Without context, only added lines
  assert.deepEqual([...(diffLines(DIFF, false).get("a.ts") ?? [])], [2, 3]);
});

test("markers survive a round trip and hide from agents", () => {
  const body = compose("**Reviewer** · m · major", "Text with <!-- a comment -->.", {
    role: "reviewer",
    kind: "finding",
    value: "major",
  });
  assert.deepEqual(readMarker(body), { role: "reviewer", kind: "finding", value: "major" });
  assert.equal(plainText(body), "Text with <!-- a comment -->.");
  assert.equal(readMarker("A person's comment."), undefined);
});
