#!/usr/bin/env -S node --use-system-ca
// Enable autoreview on a GitHub or Gitea repository: see `add.sh --help`. The work happens
// in src/add/, one file per forge.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { addGitea } from "./add/gitea.ts";
import { addGitHub } from "./add/github.ts";
import { type AddOptions, SECRETS } from "./add/options.ts";
import { askSecrets } from "./add/secrets.ts";
import { forgeKind } from "./forges.ts";
import { parseRemote } from "./remote.ts";

export { guessConfig } from "./add/files.ts";
export { guessDispatch } from "./add/github.ts";
export { ACTION, type AddOptions, SECRETS } from "./add/options.ts";
export { askHidden } from "./add/secrets.ts";

/** Enable autoreview on a repository, on whichever forge its origin is. */
export async function add(options: AddOptions): Promise<void> {
  const origin = execFileSync("git", ["-C", options.repo, "remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  const remote = parseRemote(origin);

  // Decide by the origin alone: add.sh may itself run inside some CI
  const kind = forgeKind(remote, { AUTOREVIEW_FORGE: process.env.AUTOREVIEW_FORGE });
  await (kind === "github" ? addGitHub(remote, options) : addGitea(remote, options));
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      secrets: { type: "boolean", default: false },
      vendor: { type: "boolean", default: false },
      ref: { type: "string", default: "main" },
      "setup-action": { type: "string", multiple: true, default: [] },
      "runs-on": { type: "string", default: "ubuntu-latest" },
      reviewer: { type: "string", default: "autoreview-reviewer" },
      implementer: { type: "string", default: "autoreview-implementer" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length > 1) {
    console.log(`usage: add.sh [<repo>] [--vendor] [--ref <autoreview ref>] [--runs-on <label>]
                  [--setup-action <uses>]... [--secrets] [--reviewer <bot>] [--implementer <bot>]

Enables autoreview on a GitHub or Gitea repository (default: the current directory),
chosen by its origin.
--vendor copies the action into the repository, for organizations that only allow their
own actions; rerun it to update the copy.
--setup-action adds a step that runs before the deliberation, such as one installing
the agents' standing instructions; repeat it for more.

On GitHub, both roles post as the workflow's own token, so there's nothing else to set up.
On Gitea, --reviewer and --implementer name the bot accounts to add as collaborators, and
--secrets stores ${SECRETS.join(", ")} on your account,
taking each from the environment or asking for it.`);
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
    vendor: values.vendor,
    log: (message) => console.log(`autoreview: ${message}`),
  });
}

// Run when called as a script, not when imported by tests
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
