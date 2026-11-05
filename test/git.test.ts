import "./scratch.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedFiles, Checkout, diffLines } from "../src/git.ts";
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

test("changed files include those only git's extended headers name, and quoted paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoreview-git-"));
  execFileSync("git", ["init", "--quiet", dir]);
  const checkout = new Checkout(dir);
  await checkout.git("config", "user.name", "Test");
  await checkout.git("config", "user.email", "test@example.com");
  await checkout.git("config", "core.quotePath", "true");
  writeFileSync(join(dir, "moved.txt"), "moved\n");
  writeFileSync(join(dir, "mode.sh"), "echo\n");
  writeFileSync(join(dir, "edited.ts"), "one\n-- a/fake.ts\n");
  writeFileSync(join(dir, "gone.bin"), Buffer.from([0, 1, 2]));
  await checkout.git("add", "-A");
  await checkout.git("commit", "--quiet", "-m", "Base");
  const base = await checkout.head();

  // A rename, a mode change, an empty file, binary files, paths git quotes, and hunk lines
  // that look like headers
  mkdirSync(join(dir, "pkg"));
  await checkout.git("mv", "moved.txt", "pkg/moved.txt");
  chmodSync(join(dir, "mode.sh"), 0o755);
  writeFileSync(join(dir, "empty.txt"), "");
  writeFileSync(join(dir, "new.bin"), Buffer.from([0, 3, 4]));
  writeFileSync(join(dir, "gone.bin"), Buffer.from([0, 5, 6]));
  writeFileSync(join(dir, "café.ts"), "x\n");
  writeFileSync(join(dir, "with space.ts"), "y\n");
  writeFileSync(join(dir, 'quote".ts'), "z\n");
  writeFileSync(join(dir, "edited.ts"), "one\n++ b/fake.ts\n");
  await checkout.git("add", "-A");
  await checkout.git("commit", "--quiet", "-m", "Change");
  const diff = await checkout.diff(base, await checkout.head());

  assert.deepEqual(changedFiles(diff).sort(), [
    "café.ts",
    "edited.ts",
    "empty.txt",
    "gone.bin",
    "mode.sh",
    "moved.txt",
    "new.bin",
    "pkg/moved.txt",
    'quote".ts',
    "with space.ts",
  ]);
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
  assert.equal(await ownPush(checkout, own, "synchronize"), true);
  assert.equal(await ownPush(checkout, own, "labeled"), false);
  assert.equal(await ownPush(checkout, own, undefined), false);
  assert.equal(await ownPush(checkout, person, "synchronize"), false);
});

test("uncommitted changes list every path, both sides of a rename, and checks run in a folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoreview-git-"));
  execFileSync("git", ["init", "--quiet", dir]);
  mkdirSync(join(dir, "pkg"));
  writeFileSync(join(dir, "pkg", "old name.ts"), "x\n");
  writeFileSync(join(dir, "kept.ts"), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@e",
    "commit",
    "-qm",
    "init",
  ]);

  // A staged rename, an edit, and an untracked file in a new folder
  const checkout = new Checkout(dir);
  await checkout.git("mv", "pkg/old name.ts", "pkg/new name.ts");
  writeFileSync(join(dir, "kept.ts"), "y\n");
  mkdirSync(join(dir, "fresh"));
  writeFileSync(join(dir, "fresh", "a.ts"), "x\n");
  assert.deepEqual((await checkout.changed()).sort(), [
    "fresh/a.ts",
    "kept.ts",
    "pkg/new name.ts",
    "pkg/old name.ts",
  ]);
  assert.equal(
    (await checkout.check("pwd", { cwd: "pkg" })).output.trim().split("/").at(-1),
    "pkg",
  );
});
