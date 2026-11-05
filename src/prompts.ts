import { readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import type { Convention } from "./context.ts";
import type { PullRequest } from "./forge.ts";
import { instructionsForRole, type Instruction } from "./instructions.ts";
import type { Role } from "./markers.ts";

const PROMPTS = new URL("../prompts/", import.meta.url);

/** Fill a prompt template's `{{name}}` slots in one pass, so filled text is never re-read. */
export function render(name: string, vars: Record<string, string | number>): string {
  const template = readFileSync(new URL(`${name}.md`, PROMPTS), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`prompt ${name} needs {{${key}}}`);
    }
    return String(vars[key]);
  });
}

/** What the agents read beyond the configured context, found for the pull request's changes. */
export interface Guidance {
  /** Convention files in, or listed by, the folders the pull request changes. */
  conventions?: Convention[];
  /** Path-specific instruction files whose `applyTo` matches a changed file. */
  instructions?: Instruction[];
}

/** A run's guidance for one role, without the instruction files excluded from it. */
export function guidanceFor(
  run: { conventions: Convention[]; instructions: Instruction[] },
  role: Role,
): Guidance {
  return {
    conventions: run.conventions,
    instructions: instructionsForRole(run.instructions, role),
  };
}

/**
 * The shared preamble: the deliberation's rules, the project, and the pull request. The
 * configured context applies to the whole repository, each of `conventions`, found in or
 * listed by a folder the pull request changes, to the code under that folder, and each of
 * `instructions` to the files its `applyTo` matches.
 */
export function common(
  pr: PullRequest,
  config: Config,
  { conventions = [], instructions = [] }: Guidance = {},
): string {
  const visual =
    "It can only be judged by looking at the result (a rendering, a layout, an animation)";
  return render("common", {
    deferral: snippet(config, "deferral", {
      visualNote: config.visual ? "" : ", since visual checks aren't available here",
      visualDeferral: config.visual
        ? ""
        : `\n- ${visual}, since visual checks aren't available here.`,
    }),
    context: quoted(config.context),
    conventions: conventions.length
      ? ` Then read these, from the folders the pull request changes, each for the code under the folder named with it, on top of those above it: ${conventions.map(({ path, folder }) => `\`${path}\` for \`${folder}/\``).join(", ")}.`
      : "",
    instructions: instructions.length
      ? ` Then read these instruction files, each for the files its \`applyTo\` pattern matches: ${instructions.map(({ path, applyTo }) => `\`${path}\` for \`${applyTo}\``).join(", ")}.`
      : "",
    number: pr.number,
    title: pr.title,
    author: pr.author,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    body: pr.body.trim() || "(no description)",
  });
}

function quoted(paths: string[]): string {
  return paths.map((path) => `\`${path}\``).join(", ");
}

/** The text that differs by deferral mode in the fix, review and verify prompts. */
export function modeText(config: Config): Record<string, string> {
  return {
    deferAction: snippet(config, "fix"),
    forAuthor: snippet(config, "review"),
    deferVerdict: snippet(config, "verify"),
  };
}

/** One prompt part for the config's deferral mode, from `prompts/<mode>/`. */
function snippet(config: Config, name: string, vars: Record<string, string> = {}): string {
  return render(`${config.defer}/${name}`, vars).trim();
}

/** Cut text that would crowd an agent's context, saying how to read the rest. */
export function clip(text: string, limit: number, rest: string): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… (cut at ${limit} characters; ${rest})`;
}
