#!/usr/bin/env -S node --use-system-ca
// Enable autoreview on a Gitea repository: see `add.sh --help`. The work happens in src/add/.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { add as addGitea } from "./add/gitea.ts";
import { askSecrets } from "./add/secrets.ts";
import { SECRETS } from "./add/options.ts";

export { guessConfig } from "./add/files.ts";
export { add } from "./add/gitea.ts";
export { ACTION, type AddOptions, SECRETS } from "./add/options.ts";
export { askHidden } from "./add/secrets.ts";

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
  await addGitea({
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
