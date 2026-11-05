#!/usr/bin/env -S node --use-system-ca
// Enable autoreview on a Gitea repository: write its workflow and config, create its
// labels, add the bot accounts as collaborators, and optionally store the user-level secrets.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONFIG_FILE, DEFAULTS } from "./config.ts";
import { Gitea } from "./gitea.ts";
import { findToken, parseRemote } from "./remote.ts";

const TEMPLATES = new URL("../templates/", import.meta.url);
const WORKFLOW = ".gitea/workflows/autoreview.yml";
/** Where workflows fetch this action from. */
export const ACTION = "https://github.com/KurtPreston/autoreview";
export const SECRETS = [
  "COPILOT_GITHUB_TOKEN",
  "AUTOREVIEW_REVIEWER_TOKEN",
  "AUTOREVIEW_IMPLEMENTER_TOKEN",
] as const;

/** What to enable, and where. */
export interface AddOptions {
  repo: string;
  /** The autoreview ref the workflow pins. */
  ref: string;
  /** Actions to run before deliberating, such as one installing standing instructions. */
  setupActions?: string[];
  runsOn: string;
  reviewer: string;
  implementer: string;
  /** Secret values to store on the user's account, by name. */
  secrets: Partial<Record<(typeof SECRETS)[number], string>>;
  log: (message: string) => void;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** Enable autoreview on a repository. Files that already exist are left alone. */
export async function add(options: AddOptions): Promise<void> {
  const { repo, log } = options;
  const origin = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  const remote = parseRemote(origin);
  const token = await findToken(remote.url);
  if (!token) {
    throw new Error(`no token for ${remote.url}: set GITEA_TOKEN or log in with tea`);
  }
  const gitea = new Gitea({ ...remote, token, fetch: options.fetch });

  // The workflow, with the project's setup when it uses npm
  const npm = existsSync(join(repo, "package-lock.json"));
  const setup = npm ? await template("npm-setup.yml") : "";
  await writeNew(
    join(repo, WORKFLOW),
    fill(await template("gitea.yml"), {
      runsOn: options.runsOn,
      action: ACTION,
      ref: options.ref,
      setup,
      setupActions: setupSteps(options.setupActions ?? []),
    }),
    log,
  );

  // The config, with checks guessed from the project's scripts
  await writeNew(
    join(repo, CONFIG_FILE),
    `${JSON.stringify(await guessConfig(repo), null, 2)}\n`,
    log,
  );

  // Labels, and the bots as collaborators (Gitea adds them without an invitation)
  const labels = [DEFAULTS.label, DEFAULTS.deferLabel, DEFAULTS.decisionLabel];
  for (const label of labels) {
    await gitea.ensureLabel(label);
  }
  log(`labels ${labels.join(", ")} are ready`);
  for (const bot of [options.reviewer, options.implementer]) {
    if (await gitea.userExists(bot)) {
      await gitea.addCollaborator(bot);
      log(`${bot} can write to ${remote.owner}/${remote.repo}`);
    } else {
      log(
        `${bot} doesn't exist yet: create it, then run this again (both roles post as one identity until then)`,
      );
    }
  }

  // Secrets live on the user's account, so every repository of theirs can read them
  for (const [name, value] of Object.entries(options.secrets)) {
    if (!value) {
      continue;
    }
    try {
      await gitea.setUserSecret(name, value);
      log(`stored ${name} on your account`);
    } catch (error) {
      // A token without the user scope can do everything else, so explain rather than crash
      if (!/required=\[write:user\]/.test(String(error))) {
        throw error;
      }
      log(
        "your token can't store account secrets (it needs the write:user scope): " +
          "rerun with GITEA_TOKEN set to a token that has it, or add the secrets in Settings → Actions → Secrets",
      );
      return;
    }
  }
}

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
function setupSteps(actions: string[]): string {
  if (actions.length === 0) {
    return "";
  }
  const steps = actions.map((action) => `      - uses: ${action}\n`).join("");
  return `\n      # The agents' standing instructions and settings\n${steps}`;
}

async function template(name: string): Promise<string> {
  return readFile(new URL(name, TEMPLATES), "utf8");
}

/** Fill `{{name}}` slots. */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

/** Write a file unless it exists, saying which. */
async function writeNew(path: string, text: string, log: (message: string) => void): Promise<void> {
  if (existsSync(path)) {
    log(`kept the existing ${path}`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  log(`wrote ${path}`);
}

/** Ask for each secret without echoing it, or take it from the environment. */
async function askSecrets(): Promise<AddOptions["secrets"]> {
  if (!stdin.isTTY) {
    throw new Error(`--secrets asks in a terminal; otherwise set ${SECRETS.join(", ")}`);
  }
  const secrets: AddOptions["secrets"] = {};
  for (const name of SECRETS) {
    secrets[name] = process.env[name] || (await askHidden(`${name} (empty to skip): `)).trim();
  }
  return secrets;
}

/** Read one line from the terminal without showing what's typed. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Raw mode hands over each keypress, unechoed
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };

    // Enter ends the line, Ctrl-C cancels, backspace deletes; bracketed-paste markers are dropped
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value.replace(/\[20[01]~/g, ""));
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      secrets: { type: "boolean", default: false },
      ref: { type: "string", default: "main" },
      "setup-action": { type: "string", multiple: true, default: [] },
      "runs-on": { type: "string", default: "ubuntu-latest" },
      reviewer: { type: "string", default: "autoreview-reviewer" },
      implementer: { type: "string", default: "autoreview-implementer" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length > 1) {
    console.log(`usage: add.sh [<repo>] [--secrets] [--ref <autoreview ref>] [--runs-on <label>]
                  [--setup-action <uses>]... [--reviewer <bot>] [--implementer <bot>]

Enables autoreview on a Gitea repository (default: the current directory).
--secrets stores ${SECRETS.join(", ")} on your account,
taking each from the environment or asking for it.
--setup-action adds a step that runs before the deliberation, such as one installing
the agents' standing instructions; repeat it for more.`);
    return;
  }
  await add({
    repo: resolve(positionals[0] ?? "."),
    ref: values.ref,
    setupActions: values["setup-action"],
    runsOn: values["runs-on"],
    reviewer: values.reviewer,
    implementer: values.implementer,
    secrets: values.secrets ? await askSecrets() : {},
    log: (message) => console.log(`autoreview: ${message}`),
  });
}

// Run when called as a script, not when imported by tests
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
