import "./scratch.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { frontmatter, instructionsFor, instructionsForRole } from "../src/instructions.ts";

/** A checkout holding the given files and their text. */
async function checkout(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "autoreview-instructions-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), text);
  }
  return dir;
}

const DIR = ".github/instructions";

test("instruction files apply when a pattern matches a changed file", async () => {
  const dir = await checkout({
    [`${DIR}/ts.instructions.md`]: '---\napplyTo: "**/*.ts, **/*.tsx"\n---\nUse strict types.\n',
    [`${DIR}/web/css.instructions.md`]: "---\napplyTo: 'web/**/*.css'\n---\nNo !important.\n",
    [`${DIR}/all.instructions.md`]: "---\napplyTo: '**'\nexcludeAgent: \"code-review\"\n---\n",
    [`${DIR}/none.instructions.md`]: "No front matter, so it applies to nothing.\n",
    [`${DIR}/notes.md`]: "---\napplyTo: '**'\n---\nNot an instruction file.\n",
  });
  const found = await instructionsFor({
    dir,
    changed: ["src/a.ts", "README.md"],
  });
  assert.deepEqual(found, [
    { path: `${DIR}/all.instructions.md`, applyTo: "**", excludes: "reviewer" },
    { path: `${DIR}/ts.instructions.md`, applyTo: "**/*.ts,**/*.tsx" },
  ]);

  // A nested file is found too, and the role filter drops what's excluded
  const nested = await instructionsFor({ dir, changed: ["web/app/site.css"] });
  assert.deepEqual(
    instructionsForRole(nested, "reviewer").map((i) => i.path),
    [`${DIR}/web/css.instructions.md`],
  );
  assert.equal(instructionsForRole(nested, "fixer").length, 2);
});

test("a checkout without instruction files has none", async () => {
  const dir = await checkout({ "a.ts": "x\n" });
  assert.deepEqual(await instructionsFor({ dir, changed: ["a.ts"] }), []);
});

test("front matter is read only from a leading block", () => {
  assert.deepEqual(frontmatter('---\r\napplyTo: "**"\r\nexcludeAgent: cloud-agent\r\n---\r\nx'), {
    applyTo: "**",
    excludeAgent: "cloud-agent",
  });
  assert.deepEqual(frontmatter("text\n---\napplyTo: '**'\n---\n"), {});
  assert.deepEqual(frontmatter("---\napplyTo: '**'\n"), {});
});
