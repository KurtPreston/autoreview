// Enable autoreview on a Gitea repository: write its workflow and config, create its
// labels, add the bot accounts as collaborators, and optionally store the user-level secrets.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, DEFAULTS } from "../config.ts";
import { Gitea } from "../gitea.ts";
import { findToken, parseRemote } from "../remote.ts";
import { fill, guessConfig, setupSteps, template, writeNew } from "./files.ts";
import { ACTION, type AddOptions } from "./options.ts";

const WORKFLOW = ".gitea/workflows/autoreview.yml";

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
