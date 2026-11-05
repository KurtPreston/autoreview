import "./scratch.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FILE, git, repository } from "./harness.ts";

const CLI = new URL("../src/autoreview.ts", import.meta.url).pathname;
const FAKE = new URL("./fake-copilot.ts", import.meta.url).pathname;

const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

interface Write {
  method: string;
  path: string;
  body: { state?: string; description?: string } | undefined;
}

/**
 * A repository whose pull request #7 has the fixer's label and a person's open thread on
 * a.ts, served by a stub Gitea that records every write.
 */
async function pullRequest(config: object): Promise<{
  url: string;
  origin: string;
  work: string;
  writes: Write[];
}> {
  const { origin, work } = repository();
  writeFileSync(join(work, ".autoreview.json"), JSON.stringify(config));
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "Configure autoreview");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/ferns");
  const head = git(work, "rev-parse", "HEAD");
  execFileSync("git", ["--git-dir", origin, "update-ref", "refs/pull/7/head", head]);

  // The stub answers reads from what's above, and accepts every write
  const routes: Record<string, unknown> = {
    "/user": { login: "fixer-bot" },
    "/repos/o/r/pulls/7": {
      number: 7,
      title: "Add grow",
      body: "",
      user: { login: "kurt" },
      state: "open",
      labels: [{ name: "autofix" }],
      head: { ref: "ferns", sha: head, label: "ferns", repo_id: 1 },
      base: { ref: "main", sha: git(work, "rev-parse", "main"), repo_id: 1 },
    },
    "/repos/o/r/pulls/7.diff": git(work, "diff", "main..ferns"),
    "/repos/o/r/pulls/7/reviews": [{ id: 1, state: "COMMENT" }],
    "/repos/o/r/pulls/7/reviews/1/comments": [
      {
        id: 10,
        body: "Doubling overflows.",
        user: { login: "kurt" },
        path: "a.ts",
        position: 2,
        original_position: 2,
        resolver: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    "/repos/o/r/issues/7/comments": [],
  };
  const writes: Write[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) {
      text += chunk;
    }
    const path = new URL(request.url ?? "/", "http://stub").pathname.replace("/api/v1", "");
    if (request.method !== "GET") {
      writes.push({
        method: request.method ?? "",
        path,
        body: text ? JSON.parse(text) : undefined,
      });
      response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    } else if (path in routes) {
      const value = routes[path];
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(typeof value === "string" ? value : JSON.stringify(value));
    } else {
      response.writeHead(404).end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, origin, work, writes };
}

/** Start the CLI on pull request #7, with the fake Copilot CLI playing back these steps. */
function start(url: string, work: string, steps: object[]) {
  const script = join(work, "..", "steps.json");
  writeFileSync(script, JSON.stringify(steps));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(AUTOREVIEW_|GITHUB_|GITEA_|GH_)/.test(name)) {
      env[name] = value;
    }
  }
  Object.assign(env, {
    GITHUB_SERVER_URL: url,
    GITHUB_REPOSITORY: "o/r",
    AUTOREVIEW_FORGE: "gitea",
    GITEA_TOKEN: "secret",
    AUTOREVIEW_COPILOT: FAKE,
    FAKE_COPILOT: script,
  });
  const child = spawn(
    process.execPath,
    [CLI, "run", "--pr", "7", "--repo", work, "--checkout", work],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  child.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, exited, log: () => log };
}

const fixed = {
  write: { "a.ts": FILE.replace("n * 2", "Math.min(n * 2, 100)") },
  stdout: JSON.stringify({ action: "fix", body: "Capped it.", commit: "Cap growth" }),
};

/** Wait for a condition, failing with what was awaited and the run's log. */
async function until(
  done: () => boolean,
  waiting: { what: string; log: () => string; ms?: number },
): Promise<void> {
  const deadline = Date.now() + (waiting.ms ?? 20_000);
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${waiting.what}:\n${waiting.log()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Where the pull request's branch is in the origin. */
function branch(origin: string): string {
  return execFileSync("git", ["--git-dir", origin, "rev-parse", "ferns"], {
    encoding: "utf8",
  }).trim();
}

/** Whether a process is still running, rather than gone or a zombie waiting to be reaped. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

test("a CLI run cancelled during a slow push marks the pushed commit stopped before exiting", async () => {
  const { url, origin, work, writes } = await pullRequest({});

  // The push takes a moment after it starts
  const pushing = join(work, "..", "pushing");
  const hook = join(origin, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\ntouch "${pushing}"\nsleep 1\n`, { mode: 0o755 });

  // The job is cancelled while the fix is being pushed
  const first = branch(origin);
  const run = start(url, work, [fixed]);
  await until(() => existsSync(pushing), { what: "the push", log: run.log });
  run.child.kill("SIGTERM");
  const code = await within(run.exited, 6000, "stopping");
  assert.notEqual(code, 0);

  // The push landed, and its commit got the run's ending before the process exited
  await until(() => branch(origin) !== first, { what: "the push to land", log: run.log });
  const pushed = branch(origin);
  const statuses = writes.filter((write) => write.path === `/repos/o/r/statuses/${pushed}`);
  assert.deepEqual(
    [statuses.at(-1)?.body?.state, statuses.at(-1)?.body?.description],
    ["error", "Stopped: cancelled by SIGTERM"],
    run.log(),
  );

  // The abandoned round replies to nothing
  assert.ok(!writes.some((write) => write.path.endsWith("/replies")), run.log());
});

test("a CLI run cancelled during a check stops the check's own child processes", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "autoreview-cli-")), "sleep.pid");
  const { url, origin, work, writes } = await pullRequest({
    checks: [`sleep 30 & echo $! > "${pidFile}"; wait`],
  });
  const head = branch(origin);

  // The job is cancelled while a check's child process runs
  const run = start(url, work, [fixed]);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", {
    what: "the check",
    log: run.log,
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(running(pid));
  run.child.kill("SIGTERM");
  await within(run.exited, 6000, "stopping");

  // Nothing the check started outlives the run, and nothing was pushed
  await until(() => !running(pid), { what: "the check's child to stop", log: run.log, ms: 1000 });
  const statuses = writes.filter((write) => write.path === `/repos/o/r/statuses/${head}`);
  assert.equal(statuses.at(-1)?.body?.description, "Stopped: cancelled by SIGTERM", run.log());
  assert.equal(branch(origin), head);
});
