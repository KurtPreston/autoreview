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
    const patterns = globs(meta.applyTo ?? "");
    if (patterns.some((pattern) => changed.some((file) => matchesGlob(file, pattern)))) {
      const excludes = EXCLUDED[(meta.excludeAgent ?? "").trim()];
      found.push({
        path,
        applyTo: patterns.join(","),
        ...(excludes && { excludes }),
      });
    }
  }
  return found;
}

/** The globs in a comma-separated list, keeping the commas inside braces and brackets. */
export function globs(list: string): string[] {
  const patterns: string[] = [];
  // `opened` is where the open character class starts in `current`, or -1 outside one
  let [current, braces, opened] = ["", 0, -1];
  for (let index = 0; index < list.length; index++) {
    const char = list[index];
    if (char === "\\" && index + 1 < list.length) {
      current += char + list[++index];
      continue;
    }
    if (opened >= 0) {
      // A `]` right after the opening `[`, `[!` or `[^` is a member, not the end
      if (char === "]" && !/^\[[!^]?$/.test(current.slice(opened))) {
        opened = -1;
      }
    } else if (char === "[") {
      opened = list.includes("]", index + 2) ? current.length : -1;
    } else if (char === "{") {
      braces++;
    } else if (char === "}" && braces > 0) {
      braces--;
    } else if (char === "," && braces === 0) {
      patterns.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  patterns.push(current);
  return patterns.map((pattern) => pattern.trim()).filter(Boolean);
}

/** The instruction files a role reads: all but those excluded from it. */
export function instructionsForRole(instructions: Instruction[], role: Role): Instruction[] {
  return instructions.filter((instruction) => instruction.excludes !== role);
}

/** The top-level `key: value` pairs of a Markdown file's front matter, as YAML strings. */
export function frontmatter(text: string): Record<string, string> {
  // The block between an opening `---` line and the next one
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {};
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const block = end < 0 ? [] : lines.slice(1, end);

  // Each unindented key, with the indented or blank lines that continue its value
  const meta: Record<string, string> = {};
  for (let index = 0; index < block.length; index++) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(block[index]);
    if (!match) {
      continue;
    }
    let next = index + 1;
    while (next < block.length && (block[next].trim() === "" || /^\s/.test(block[next]))) {
      next++;
    }
    meta[match[1]] = scalar(match[2], block.slice(index + 1, next));
    index = next - 1;
  }
  return meta;
}

/** A YAML scalar's value from the text after its key and its continuation lines. */
function scalar(first: string, rest: string[]): string {
  // Blank and comment-only lines before the value aren't part of it
  const lines = [first, ...rest];
  while (lines.length > 0 && /^\s*(?:#.*)?$/.test(lines[0])) {
    lines.shift();
  }
  if (lines.length === 0) {
    return "";
  }
  const header = /^([|>])([+-]?)(\d?)([+-]?)\s*(?:#.*)?$/.exec(lines[0].trim());
  if (header) {
    return blockScalar(header, lines.slice(1));
  }
  const text = lines.join("\n").trimStart();
  return text.startsWith('"') || text.startsWith("'") ? quoted(text) : plain(lines);
}

/** A literal (`|`) or folded (`>`) block scalar, chomped by `-`, `+` or neither. */
function blockScalar(header: RegExpExecArray, rest: string[]): string {
  const [folded, chomp, indicator] = [header[1] === ">", header[2] || header[4], Number(header[3])];
  const content = rest.findIndex((line) => line.trim() !== "");
  if (content < 0) {
    return chomp === "+" ? "\n".repeat(rest.length) : "";
  }
  const indent = indicator || /^ */.exec(rest[content])![0].length;
  const lines = rest.map((line) => (line.trim() === "" ? "" : line.slice(indent)));
  let trailing = 0;
  while (lines.at(-1) === "") {
    lines.pop();
    trailing++;
  }
  let body = lines[0];
  for (let index = 1; index < lines.length; index++) {
    const [prev, line] = [lines[index - 1], lines[index]];
    const normal = (text: string) => text !== "" && !/^\s/.test(text);
    if (!folded) {
      body += "\n";
    } else if (normal(prev) && normal(line)) {
      body += " ";
    } else if (!(normal(prev) && line === "")) {
      body += "\n";
    }
    body += line;
  }
  return chomp === "-" ? body : chomp === "+" ? `${body}\n${"\n".repeat(trailing)}` : `${body}\n`;
}

/** A single- or double-quoted scalar, its line breaks folded and its escapes applied. */
function quoted(text: string): string {
  const quote = text[0];
  let value = "";
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (char === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        value += "'";
        index++;
        continue;
      }
      return value;
    }
    if (char === "\n") {
      // A line break folds to a space, and each blank line after it to a newline
      const run = /^[ \t\n]*/.exec(text.slice(index))![0];
      const breaks = run.split("\n").length - 1;
      value = value.replace(/[ \t]+$/, "") + (breaks > 1 ? "\n".repeat(breaks - 1) : " ");
      index += run.length - 1;
      continue;
    }
    if (quote === '"' && char === "\\") {
      const escape = text[++index];
      if (escape === "\n") {
        index += /^[ \t\n]*/.exec(text.slice(index + 1))![0].length;
        continue;
      }
      const hex = { x: 2, u: 4, U: 8 }[escape ?? ""];
      if (hex) {
        value += String.fromCodePoint(parseInt(text.slice(index + 1, index + 1 + hex), 16));
        index += hex;
        continue;
      }
      value += ESCAPES[escape ?? ""] ?? escape ?? "";
      continue;
    }
    value += char;
  }
  return value;
}

/** The characters a double-quoted scalar's single-letter escapes stand for. */
const ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

/** A plain scalar: its lines folded, up to the first comment. */
function plain(lines: string[]): string {
  const kept: string[] = [];
  for (const line of lines) {
    const comment = /(^|\s)#/.exec(line);
    kept.push((comment ? line.slice(0, comment.index) : line).trim());
    if (comment) {
      break;
    }
  }
  while (kept.length > 0 && kept.at(-1) === "") {
    kept.pop();
  }
  return kept.reduce((value, line, index) => {
    if (index === 0) {
      return line;
    }
    return line === ""
      ? `${value}\n`
      : value.endsWith("\n") || value === ""
        ? value + line
        : `${value} ${line}`;
  }, "");
}
