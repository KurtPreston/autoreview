import { readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import type { PullRequest } from "./forge.ts";

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

/**
 * The shared preamble: the deliberation's rules, the project, and the pull request. The
 * configured context applies to the whole repository, and each of `conventions`, found in a
 * folder the pull request changes, to the code under its folder.
 */
export function common(pr: PullRequest, config: Config, conventions: string[] = []): string {
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
      ? ` Then read these, from the folders the pull request changes: ${quoted(conventions)}. Each applies to the code under its folder, on top of those above it.`
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
