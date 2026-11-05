// Shared by every forge's setup: templates, and files written only when missing.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_FILE } from "../config.ts";

const TEMPLATES = new URL("../../templates/", import.meta.url);

/**
 * Checks from the project's npm scripts: quick ones always, tests only on a capable runner.
 * Only fields with something in them are returned, so the rest keep their defaults.
 */
export async function guessConfig(repo: string): Promise<Record<string, string[]>> {
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).scripts ?? {};
  } catch {
    // Not an npm project; leave checks for the user to fill in
  }
  const run = (names: string[]) =>
    names.filter((name) => name in scripts).map((name) => `npm run ${name}`);
  return nonEmpty({
    checks: run(["typecheck", "lint", "format:check", "build"]),
    heavyChecks: run(["test"]),
  });
}

/** The fields of a guessed config that hold anything. */
export function nonEmpty(fields: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(fields).filter(([, list]) => list.length > 0));
}

/**
 * Write the root config when it has something other than defaults to say. Without one,
 * every field keeps its default, so there's no file to commit.
 */
export async function writeConfig(
  repo: string,
  config: Record<string, unknown>,
  log: (message: string) => void,
): Promise<void> {
  if (Object.keys(config).length === 0) {
    log(`no ${CONFIG_FILE} needed: nothing to set beyond the defaults`);
    return;
  }
  await writeNew(join(repo, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, log);
}

/** Workflow steps for the setup actions, or nothing without any. */
export function setupSteps(actions: string[]): string {
  if (actions.length === 0) {
    return "";
  }
  const steps = actions.map((action) => `      - uses: ${action}\n`).join("");
  return `\n      # The agents' standing instructions and settings\n${steps}`;
}

export async function template(name: string): Promise<string> {
  return readFile(new URL(name, TEMPLATES), "utf8");
}

/** Fill `{{name}}` slots. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

/** Write a file unless it exists, saying which. */
export async function writeNew(
  path: string,
  text: string,
  log: (message: string) => void,
): Promise<void> {
  if (existsSync(path)) {
    log(`kept the existing ${path}`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  log(`wrote ${path}`);
}
