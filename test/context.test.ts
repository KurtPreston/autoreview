import "./scratch.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contextFor } from "../src/context.ts";

/** A checkout holding the given files, each with placeholder text. */
async function checkout(files: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "autoreview-context-"));
  for (const file of files) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), "x\n");
  }
  return dir;
}

test("bare names are found in changed folders and the folders above them", async () => {
  const dir = await checkout([
    "AGENTS.md",
    "packages/AGENTS.md",
    "packages/foo/AGENTS.md",
    "packages/foo/src/AGENTS.md",
    "packages/bar/AGENTS.md",
  ]);
  const context = await contextFor({
    dir,
    context: ["AGENTS.md"],
    changed: ["packages/foo/src/a.ts", "packages/foo/README.md"],
  });
  assert.deepEqual(context, [
    "AGENTS.md",
    "packages/AGENTS.md",
    "packages/foo/AGENTS.md",
    "packages/foo/src/AGENTS.md",
  ]);
});

test("entries with a path stay root-only, and listed files aren't repeated", async () => {
  const dir = await checkout(["docs/style.md", "pkg/docs/style.md", "pkg/CLAUDE.md"]);
  const context = await contextFor({
    dir,
    context: ["docs/style.md", "CLAUDE.md", "pkg/CLAUDE.md"],
    changed: ["pkg/docs/x.ts"],
  });
  assert.deepEqual(context, ["docs/style.md", "CLAUDE.md", "pkg/CLAUDE.md"]);
});

test("a change at the root adds nothing", async () => {
  const dir = await checkout(["AGENTS.md", "pkg/AGENTS.md"]);
  const context = await contextFor({ dir, context: ["AGENTS.md"], changed: ["a.ts"] });
  assert.deepEqual(context, ["AGENTS.md"]);
});
