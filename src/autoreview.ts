#!/usr/bin/env -S node --use-system-ca
// Command line for autoreview: two agents deliberate a pull request.
// `run` deliberates one pull request; `threads` lists its review threads (read-only).
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { Checkout } from "./git.ts";
import { forgeKind, forges } from "./forges.ts";
import { copilotAgents, deliberate } from "./loop.ts";
import { followCheckout, MemoryForge, snapshot, type Store } from "./memory.ts";
import { parseRemote, type Remote } from "./remote.ts";
import { dispatchAfterPush, ownPush } from "./trigger.ts";

const USAGE = `usage:
  autoreview run --pr <n> [--repo <dir>] [--checkout <dir>] [--dry-run] [--heavy] [--force]
  autoreview threads --pr <n> [--repo <dir>]

  --repo      a clone of the repository (default: .), whose origin names the server
  --checkout  deliberate in this checkout (CI); otherwise a temporary worktree of --repo
  --dry-run   print what would be posted, and push nothing
  --heavy     also run heavyChecks: the machine can afford them
  --force     deliberate even without a label (as both roles), or on a draft or closed pull request

Tokens: AUTOREVIEW_REVIEWER_TOKEN and AUTOREVIEW_FIXER_TOKEN post as two
identities. Otherwise one identity posts as both: on GitHub, GITHUB_TOKEN, GH_TOKEN
or gh's login; on Gitea, GITEA_TOKEN or tea's login. AUTOREVIEW_FORGE=github|gitea
overrides which forge the origin is taken to be.`;

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
  const { reviewer, fixer } = await forges(remote);

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

  // A dry run plays the deliberation against a copy of the pull request in memory
  const dryRun = values["dry-run"];
  let roles = { reviewer, fixer };
  let store: Store | undefined;
  if (dryRun) {
    store = await snapshot(reviewer, pr);
    store.onWrite = (author, action, detail) => console.log(`\n── ${author}: ${action}\n${detail}`);
    roles = {
      reviewer: new MemoryForge(store, await reviewer.login()),
      fixer: new MemoryForge(store, await fixer.login()),
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
  // A dry run's fixes are committed but never pushed, so its diff follows the checkout
  if (store) {
    followCheckout(store, checkout);
  }
  try {
    // A run started by autoreview's own push has nothing to do
    if (await ownPush(checkout, head.headSha)) {
      console.error("autoreview: skipped, since autoreview's own push started this run");
      return;
    }
    const config = await loadConfig(checkout.dir);
    const usage = {};
    const log = (message: string) => console.error(`autoreview: ${message}`);
    const outcome = await untilStopped((signal) =>
      deliberate({
        number: pr,
        config,
        checkout,
        ...roles,
        agents: copilotAgents({ config, checkout, usage, heavy: values.heavy, log, signal }),
        usage,
        push: !dryRun,
        heavy: values.heavy,
        force: values.force,
        link: runLink(remote),
        signal,
        stopGraceMs: STOP_GRACE_MS - 1000,
        log,
      }),
    );
    console.error(`autoreview: ${JSON.stringify(outcome)}`);

    // Pushes with a workflow's own token start no checks, so start the configured ones
    if (!dryRun && outcome.commits.length > 0) {
      await dispatchAfterPush({
        forge: roles.fixer,
        workflows: config.dispatch,
        branch: head.headBranch,
        log: (message) => console.error(`autoreview: ${message}`),
      });
    }
  } finally {
    await cleanup();
  }
}

/** How long a cancelled run has to wind down before the process exits. */
const STOP_GRACE_MS = 5000;

/**
 * Run work that stops when the job is cancelled or times out: the runner sends SIGINT, then
 * SIGTERM. The work gets a moment to stop what it started and mark its commit status, then
 * the process exits.
 */
async function untilStopped<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  const handlers = (["SIGINT", "SIGTERM"] as const).map((name) => {
    const handler = () => {
      stop.abort(new Error(`cancelled by ${name}`));
      setTimeout(() => process.exit(name === "SIGINT" ? 130 : 143), STOP_GRACE_MS).unref();
    };
    process.once(name, handler);
    return [name, handler] as const;
  });
  try {
    return await work(stop.signal);
  } finally {
    for (const [name, handler] of handlers) {
      process.off(name, handler);
    }
  }
}

/** The GitHub Actions run this is, for the commit status to link to. */
function runLink(remote: Remote): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: name, GITHUB_RUN_ID: id } = process.env;
  if (forgeKind(remote) !== "github" || !server || !name || !id) {
    return undefined;
  }
  return `${server.replace(/\/$/, "")}/${name}/actions/runs/${id}`;
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
