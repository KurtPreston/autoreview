import "./scratch.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { frontmatter, globs, instructionsFor, instructionsForRole } from "../src/instructions.ts";

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

test("front matter values are read as YAML scalars", () => {
  // Comments end a value, but not a quoted one
  assert.deepEqual(
    frontmatter(
      '---\n# Settings\napplyTo: "**/*.ts" # TypeScript\nexcludeAgent: code-review # fixer only\n' +
        "name: 'a # b' # c\nnote: a#b\n---\n",
    ),
    { applyTo: "**/*.ts", excludeAgent: "code-review", name: "a # b", note: "a#b" },
  );

  // Block scalars, literal or folded, with their chomping
  assert.deepEqual(
    frontmatter(
      "---\nfolded: >-\n  **/*.ts,\n  **/*.tsx\n\nkept: |+ # c\n  a\n  b\n\nclipped: >\n  a\n\n  b\n" +
        "excludeAgent: >\n  cloud-agent\n---\n",
    ),
    {
      folded: "**/*.ts, **/*.tsx",
      kept: "a\nb\n\n",
      clipped: "a\nb\n",
      excludeAgent: "cloud-agent\n",
    },
  );

  // Plain and quoted values that continue on indented lines
  assert.deepEqual(
    frontmatter(
      "---\nplain: a,\n  b # c\n  d\nsingle: 'it''s\n  here'\ndouble:\n  \"a\\tb\\\n  c\\u0021\"\n---\n",
    ),
    { plain: "a, b", single: "it's here", double: "a\tbc!" },
  );
});

test("commented and multiline values still match and exclude", async () => {
  const dir = await checkout({
    [`${DIR}/ts.instructions.md`]:
      '---\napplyTo: "**/*.ts" # TypeScript\nexcludeAgent: "code-review" # fixer only\n---\n',
    [`${DIR}/web.instructions.md`]:
      "---\napplyTo: >-\n  **/*.css,\n  **/*.html\nexcludeAgent: >\n  cloud-agent\n---\n",
  });
  assert.deepEqual(await instructionsFor({ dir, changed: ["src/a.ts", "web/b.html"] }), [
    { path: `${DIR}/ts.instructions.md`, applyTo: "**/*.ts", excludes: "reviewer" },
    { path: `${DIR}/web.instructions.md`, applyTo: "**/*.css,**/*.html", excludes: "fixer" },
  ]);
});

test("applyTo splits at commas outside braces and brackets", async () => {
  assert.deepEqual(globs("**/*.{ts,tsx}, docs/**"), ["**/*.{ts,tsx}", "docs/**"]);
  assert.deepEqual(globs("a/{b,{c,d}}/*.md,[,x]*,[],]y,\\,z"), [
    "a/{b,{c,d}}/*.md",
    "[,x]*",
    "[],]y",
    "\\,z",
  ]);
  assert.deepEqual(globs("a[b, c"), ["a[b", "c"]);

  const dir = await checkout({
    [`${DIR}/ts.instructions.md`]: '---\napplyTo: "**/*.{ts,tsx}, docs/**"\n---\n',
  });
  for (const file of ["src/a.ts", "src/b.tsx", "docs/c.md"]) {
    assert.deepEqual(await instructionsFor({ dir, changed: [file] }), [
      { path: `${DIR}/ts.instructions.md`, applyTo: "**/*.{ts,tsx},docs/**" },
    ]);
  }
});
