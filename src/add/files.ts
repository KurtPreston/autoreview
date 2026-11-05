// Shared by every forge's setup: templates, and files written only when missing.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TEMPLATES = new URL("../../templates/", import.meta.url);

/** Checks from the project's npm scripts: quick ones always, tests only on a capable runner. */
export async function guessConfig(repo: string): Promise<object> {
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).scripts ?? {};
  } catch {
    // Not an npm project; leave checks for the user to fill in
  }
  const run = (names: string[]) =>
    names.filter((name) => name in scripts).map((name) => `npm run ${name}`);
  return {
    checks: run(["typecheck", "lint", "format:check", "build"]),
    heavyChecks: run(["test"]),
    visual: false,
  };
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
