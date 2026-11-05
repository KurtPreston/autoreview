import "./scratch.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Checkout, diffLines } from "../src/git.ts";
import { compose, plainText, readMarker } from "../src/markers.ts";
import { ownPush } from "../src/trigger.ts";

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

test("autoreview's commits carry its trailer, and only its pushes skip a run", async () => {
  // A repository with one commit by a person
  const dir = mkdtempSync(join(tmpdir(), "autoreview-git-"));
  execFileSync("git", ["init", "--quiet", dir]);
  const checkout = new Checkout(dir);
  await checkout.git("config", "user.name", "Test");
  await checkout.git("config", "user.email", "test@example.com");
  writeFileSync(join(dir, "a.txt"), "one\n");
  await checkout.git("add", "-A");
  await checkout.git("commit", "--quiet", "-m", "By a person");
  const person = await checkout.head();

  // A fix commit made through the checkout, by the same identity
  writeFileSync(join(dir, "a.txt"), "two\n");
  const own = await checkout.commitAll("branch: Fix it");
  assert.ok(own);
  assert.equal(await checkout.isOwn(own), true);
  assert.equal(await checkout.isOwn(person), false);
  assert.equal(await checkout.git("log", "-1", "--format=%s"), "branch: Fix it\n");

  // Only a push of autoreview's own commit is skipped
  assert.equal(await ownPush(checkout, own, { action: "synchronize" }), true);
  assert.equal(await ownPush(checkout, own, { action: "labeled" }), false);
  assert.equal(await ownPush(checkout, own, {}), false);
  assert.equal(await ownPush(checkout, person, { action: "synchronize" }), false);

  // Rerunning a person's push after autoreview pushed a fix onto it still deliberates
  assert.equal(await ownPush(checkout, own, { action: "synchronize", sha: person }), false);
  const gone = "0".repeat(40);
  assert.equal(await ownPush(checkout, own, { action: "synchronize", sha: gone }), false);
});
