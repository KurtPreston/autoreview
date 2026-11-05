#!/usr/bin/env -S node --use-system-ca
// Command line for autoreview: two agents deliberate a pull request.
// `run` deliberates one pull request; `threads` lists its review threads (read-only).
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import type { Forge } from "./forge.ts";
import { Checkout } from "./git.ts";
import { Gitea } from "./gitea.ts";
import { copilotAgents, deliberate } from "./loop.ts";
import { MemoryForge, snapshot } from "./memory.ts";
import { findToken, parseRemote, type Remote } from "./remote.ts";

const USAGE = `usage:
  autoreview run --pr <n> [--repo <dir>] [--checkout <dir>] [--dry-run] [--heavy] [--force]
  autoreview threads --pr <n> [--repo <dir>]

  --repo      a clone of the repository (default: .), whose origin names the server
  --checkout  deliberate in this checkout (CI); otherwise a temporary worktree of --repo
  --dry-run   print what would be posted, and push nothing
  --heavy     also run heavyChecks: the machine can afford them
  --force     review even without the label, or on a draft or closed pull request

Tokens: AUTOREVIEW_REVIEWER_TOKEN and AUTOREVIEW_IMPLEMENTER_TOKEN post as two
identities; otherwise GITEA_TOKEN, or tea's login, posts as one.`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      pr: { type: "string" },
      repo: { type: "string", default: "." },
      checkout: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      heavy: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });

  // Every command works on one pull request
  const [command] = positionals;
  const pr = Number(values.pr);
  if (!["run", "threads"].includes(command) || !Number.isInteger(pr)) {
    console.error(USAGE);
    process.exit(2);
  }
  const remote = findRemote(values.repo);
  const { reviewer, implementer } = await forges(remote);

  // Listing threads only reads
  if (command === "threads") {
    for (const thread of await reviewer.threads(pr)) {
      console.log(`${thread.key}${thread.resolved ? " (resolved)" : ""}`);
      for (const comment of thread.comments) {
        console.log(`  ${comment.author}: ${comment.body.split("\n")[0]}`);
      }
    }
    return;
  }

  // A run started by the implementer's own push has nothing to do
  const sender = process.env.AUTOREVIEW_SENDER;
  if (sender && sender === (await implementer.login().catch(() => undefined))) {
    console.error(`autoreview: skipped, since ${sender}'s own push started this run`);
    return;
  }

  // A dry run plays the deliberation against a copy of the pull request in memory
  const dryRun = values["dry-run"];
  let roles = { reviewer, implementer };
  if (dryRun) {
    const store = await snapshot(reviewer, pr);
    store.onWrite = (author, action, detail) => console.log(`\n── ${author}: ${action}\n${detail}`);
    roles = {
      reviewer: new MemoryForge(store, await reviewer.login()),
      implementer: new MemoryForge(store, await implementer.login()),
    };
  }

  // Deliberate in a checkout at the pull request's head
  const head = await roles.reviewer.pullRequest(pr);
  const { checkout, cleanup } = await prepare({
    repo: values.repo,
    dir: values.checkout,
    number: pr,
    sha: head.headSha,
  });
  try {
    const config = await loadConfig(checkout.dir);
    const usage = {};
    const outcome = await deliberate({
      number: pr,
      config,
      checkout,
      ...roles,
      agents: copilotAgents({ config, checkout, usage, heavy: values.heavy }),
      usage,
      push: !dryRun,
      heavy: values.heavy,
      force: values.force,
      log: (message) => console.error(`autoreview: ${message}`),
    });
    console.error(`autoreview: ${JSON.stringify(outcome)}`);
  } finally {
    await cleanup();
  }
}

/** The repository's server and name: from the CI environment, or the clone's origin. */
function findRemote(repo: string): Remote {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: name } = process.env;
  if (server && name) {
    const [owner, repoName] = name.split("/");
    return { url: server.replace(/\/$/, ""), owner, repo: repoName };
  }
  const origin = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  return parseRemote(origin);
}

/** One forge per role when both bot tokens are set, otherwise one shared identity. */
async function forges(remote: Remote): Promise<{ reviewer: Forge; implementer: Forge }> {
  const { AUTOREVIEW_REVIEWER_TOKEN: reviewer, AUTOREVIEW_IMPLEMENTER_TOKEN: implementer } =
    process.env;
  if (reviewer && implementer) {
    return {
      reviewer: new Gitea({ ...remote, token: reviewer }),
      implementer: new Gitea({ ...remote, token: implementer }),
    };
  }
  const token = await findToken(remote.url);
  if (!token) {
    throw new Error(
      `no token for ${remote.url}: set the AUTOREVIEW_* tokens or GITEA_TOKEN, or log in with tea`,
    );
  }
  const shared = new Gitea({ ...remote, token });
  return { reviewer: shared, implementer: shared };
}

/**
 * A clean checkout at the head: the given one (CI), moved to the head, or a
 * temporary worktree of the clone, removed afterwards.
 */
async function prepare(options: {
  repo: string;
  dir?: string;
  number: number;
  sha: string;
}): Promise<{ checkout: Checkout; cleanup: () => Promise<void> }> {
  // Fetch the head through its pull ref, which exists even if the branch is gone
  const { repo, dir, number, sha } = options;
  const source = new Checkout(dir ?? repo);
  await source.git(
    "fetch",
    "--quiet",
    "origin",
    `+refs/pull/${number}/head:refs/remotes/origin/pull/${number}`,
  );
  if (dir) {
    await source.git("checkout", "--quiet", "--detach", sha);
    return { checkout: source, cleanup: async () => {} };
  }

  // Locally, never touch the user's own checkout
  const worktree = join(await mkdtemp(join(tmpdir(), "autoreview-checkout-")), "repo");
  await source.git("worktree", "add", "--quiet", "--detach", worktree, sha);
  return {
    checkout: new Checkout(worktree),
    cleanup: async () => {
      await source.git("worktree", "remove", "--force", worktree);
    },
  };
}

await main();
