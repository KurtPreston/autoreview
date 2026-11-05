// Enable autoreview on a GitHub repository: write its workflow and config, and create its
// labels. Both roles post as the workflow's own token, so there are no bots or secrets.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, DEFAULTS } from "../config.ts";
import { ghAuthToken, githubApi, githubToken } from "../forges.ts";
import { GitHub } from "../github.ts";
import type { Remote } from "../remote.ts";
import { fill, guessConfig, setupSteps, template, writeNew } from "./files.ts";
import { ACTION, type AddOptions } from "./options.ts";
import { vendor } from "./vendor.ts";

const WORKFLOWS = ".github/workflows";
const WORKFLOW = `${WORKFLOWS}/autoreview.yml`;
const VENDORED = ".github/actions/autoreview";

/** Enable autoreview on a GitHub repository. Files that already exist are left alone. */
export async function addGitHub(remote: Remote, options: AddOptions): Promise<void> {
  const { repo, log } = options;
  const token = githubToken(remote, { env: process.env, ghToken: ghAuthToken });
  if (!token) {
    throw new Error(`no token for ${remote.url}: set GITHUB_TOKEN or log in with gh`);
  }
  const github = new GitHub({
    ...githubApi(remote, {}),
    owner: remote.owner,
    repo: remote.repo,
    token,
    fetch: options.fetch,
  });

  // The action: this repository's, or a copy inside the project
  const uses = options.vendor
    ? await vendor(repo, VENDORED)
    : `${new URL(ACTION).pathname.slice(1)}@${options.ref}`;
  if (options.vendor) {
    log(`copied the action to ${VENDORED}; rerun with --vendor to update it`);
  }

  // The workflow, with the project's setup when it uses npm
  const npm = existsSync(join(repo, "package-lock.json"));
  await writeNew(
    join(repo, WORKFLOW),
    fill(await template("github.yml"), {
      runsOn: options.runsOn,
      uses,
      setup: npm ? await template("npm-setup.yml") : "",
      setupActions: setupSteps(options.setupActions ?? []),
    }),
    log,
  );

  // The config, with checks guessed from the scripts, and the checks to start after a fix
  const dispatch = await guessDispatch(repo, log);
  const config = { ...(await guessConfig(repo)), ...(dispatch.length > 0 ? { dispatch } : {}) };
  await writeNew(join(repo, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, log);

  // Labels; the workflow's token posts, so there are no bots or secrets to set up
  const labels = [DEFAULTS.label, DEFAULTS.deferLabel, DEFAULTS.decisionLabel];
  for (const label of labels) {
    await github.ensureLabel(label);
  }
  log(`labels ${labels.join(", ")} are ready`);
  if (Object.values(options.secrets).some(Boolean)) {
    log("GitHub needs no secrets: the workflow's own token posts, pushes and runs Copilot");
  }
}

/**
 * Pull request workflows that can be started by hand, so autoreview can start them after
 * a fix (its pushes start none). Says which can't, since they won't see fixes.
 */
export async function guessDispatch(repo: string, log: AddOptions["log"]): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(join(repo, WORKFLOWS));
  } catch {
    return [];
  }

  // Sort the project's pull request workflows by whether they take workflow_dispatch
  const dispatch: string[] = [];
  const missing: string[] = [];
  for (const file of files.filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const text = await readFile(join(repo, WORKFLOWS, file), "utf8");
    const events = workflowEvents(text);
    if (file === "autoreview.yml" || !events.includes("pull_request")) {
      continue;
    }
    (events.includes("workflow_dispatch") ? dispatch : missing).push(file);
  }
  if (missing.length > 0) {
    log(
      `${missing.join(", ")} won't run on autoreview's fixes: add a workflow_dispatch trigger ` +
        `and list them in ${CONFIG_FILE}'s dispatch`,
    );
  }
  return dispatch;
}

/**
 * The events a workflow's top-level `on` names, in any of its forms (a name, a list or a
 * map), read without a YAML parser. Comments and the rest of the workflow are ignored.
 */
export function workflowEvents(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/(^|\s)#.*$/, "").trimEnd());
  const key = /^(?:on|"on"|'on')\s*:(?:\s+|$)/;
  const start = lines.findIndex((line) => key.test(line));
  if (start < 0) {
    return [];
  }

  // On the key's line: a name, [a, b] or {a: ..., b}, which may run over several lines
  let inline = lines[start].replace(key, "");
  if (inline) {
    const close = inline.startsWith("[") ? "]" : inline.startsWith("{") ? "}" : "";
    for (let next = start + 1; close && !inline.includes(close) && next < lines.length; next++) {
      inline += ` ${lines[next]}`;
    }
    return inline
      .replace(/^[[{]|[\]}]$/g, "")
      .split(",")
      .map((part) => unquote(part.split(":")[0]))
      .filter(Boolean);
  }

  // Below the key: the entries of its block, at the block's own indentation
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      continue;
    }
    if (!/^(\s|-\s|-$)/.test(line)) {
      break;
    }
    block.push(line);
  }
  const indent = Math.min(...block.map((line) => /^\s*/.exec(line)![0].length));
  return block
    .filter((line) => /^\s*/.exec(line)![0].length === indent)
    .map((line) => unquote(line.trim().replace(/^-\s*/, "").split(":")[0]))
    .filter(Boolean);
}

function unquote(name: string): string {
  return name.trim().replace(/^(["'])(.*)\1$/, "$2");
}
