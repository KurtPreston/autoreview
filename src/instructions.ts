/** The repository's path-specific Copilot instructions that apply to a pull request's changes. */
import { readdir, readFile } from "node:fs/promises";
import { join, matchesGlob, posix } from "node:path";
import type { Role } from "./markers.ts";

/** Where path-specific instruction files live, relative to the repository root. */
export const INSTRUCTIONS_DIR = ".github/instructions";

/** An instruction file, the glob it applies to, and the role it's kept from, if any. */
export interface Instruction {
  path: string;
  applyTo: string;
  excludes?: Role;
}

/** The roles each `excludeAgent` value keeps an instruction file from. */
const EXCLUDED: Record<string, Role> = {
  "code-review": "reviewer",
  "cloud-agent": "fixer",
  "coding-agent": "fixer",
};

/**
 * Each `*.instructions.md` under `.github/instructions` whose `applyTo` matches a changed file,
 * in path order. A file without `applyTo` applies to nothing, as on GitHub.
 */
export async function instructionsFor({
  dir,
  changed,
}: {
  dir: string;
  changed: string[];
}): Promise<Instruction[]> {
  // List the instruction files at the head, if there are any
  let entries: string[];
  try {
    entries = await readdir(join(dir, INSTRUCTIONS_DIR), { recursive: true });
  } catch {
    return [];
  }
  const paths = entries
    .map((entry) => posix.join(INSTRUCTIONS_DIR, entry.split("\\").join("/")))
    .filter((path) => path.endsWith(".instructions.md"))
    .sort();

  // Keep those whose patterns match a changed file
  const found: Instruction[] = [];
  for (const path of paths) {
    const meta = frontmatter(await readFile(join(dir, path), "utf8"));
    const patterns = (meta.applyTo ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (patterns.some((pattern) => changed.some((file) => matchesGlob(file, pattern)))) {
      const excludes = EXCLUDED[meta.excludeAgent ?? ""];
      found.push({
        path,
        applyTo: patterns.join(","),
        ...(excludes && { excludes }),
      });
    }
  }
  return found;
}

/** The instruction files a role reads: all but those excluded from it. */
export function instructionsForRole(instructions: Instruction[], role: Role): Instruction[] {
  return instructions.filter((instruction) => instruction.excludes !== role);
}

/** The top-level `key: value` pairs of a Markdown file's front matter, unquoted. */
export function frontmatter(text: string): Record<string, string> {
  // The block between an opening `---` line and the next one
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {};
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const block = end < 0 ? [] : lines.slice(1, end);

  // Each unindented key, with surrounding quotes removed from its value
  const meta: Record<string, string> = {};
  for (const line of block) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match) {
      meta[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return meta;
}
