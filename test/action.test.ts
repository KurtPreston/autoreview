import "./scratch.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const HERE = new URL("..", import.meta.url).pathname;
const action = readFileSync(join(HERE, "action.yml"), "utf8");
const cli = ["autoreview.ts", "forges.ts"]
  .map((file) => readFileSync(join(HERE, "src", file), "utf8"))
  .join("\n");
/** Overrides for local runs, which the action has no reason to set. */
const LOCAL_ONLY = new Set(["AUTOREVIEW_FORGE"]);

test("the action passes every variable the tool reads", () => {
  // Each AUTOREVIEW_* or token variable the CLI reads is set by the action
  const read = new Set(
    [...cli.matchAll(/\b(AUTOREVIEW_[A-Z_]+|GITEA_TOKEN|GITHUB_TOKEN)\b/g)].map((m) => m[1]),
  );
  for (const name of read) {
    if (LOCAL_ONLY.has(name)) {
      continue;
    }
    assert.match(action, new RegExp(`^\\s+${name}:`, "m"), `action.yml doesn't set ${name}`);
  }
  assert.match(action, /COPILOT_GITHUB_TOKEN: \$\{\{ inputs\.copilot-token \}\}/);
});

test("the files the action runs exist", () => {
  for (const path of [
    "setup-git.sh",
    "src/autoreview.ts",
    "src/whoami.ts",
    "prompts",
    "package.json",
  ]) {
    assert.ok(existsSync(join(HERE, path)), path);
  }
});

test("setup-git points origin at the token's user and names commits after it", async () => {
  // A stub server answers who the token belongs to
  const server = createServer((request, response) => {
    const ok = request.url === "/api/v1/user" && request.headers.authorization === "token secret";
    response.writeHead(ok ? 200 : 401).end(ok ? JSON.stringify({ login: "implementer-bot" }) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A checkout as actions/checkout leaves it, with its auth header
  const work = mkdtempSync(join(tmpdir(), "autoreview-action-"));
  execFileSync("git", ["init", "--quiet", work]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", `${url}/o/r.git`]);
  execFileSync("git", ["-C", work, "config", `http.${url}/.extraheader`, "AUTHORIZATION: basic x"]);
  const env = {
    ...process.env,
    GITEA_ACTIONS: "true",
    PUSH_TOKEN: "secret",
    GITHUB_SERVER_URL: url,
    GITHUB_REPOSITORY: "o/r",
    GITHUB_WORKSPACE: work,
  };
  try {
    await promisify(execFile)(join(HERE, "setup-git.sh"), { env });
  } finally {
    server.close();
  }

  // The header is gone, and origin and the commit identity use the bot
  const config = (key: string) =>
    execFileSync("git", ["-C", work, "config", "--get", key], { encoding: "utf8" }).trim();
  assert.equal(
    config("remote.origin.url"),
    `http://implementer-bot:secret@127.0.0.1:${new URL(url).port}/o/r.git`,
  );
  assert.equal(config("user.name"), "implementer-bot");
  assert.throws(() => config(`http.${url}/.extraheader`));
});

/** Run setup-git.sh in a fresh checkout as GitHub Actions would, against a stub /user. */
async function setupOnGitHub(user: object | undefined): Promise<(key: string) => string> {
  const server = createServer((request, response) => {
    const ok = user && request.url === "/user" && request.headers.authorization === "Bearer t";
    response.writeHead(ok ? 200 : 403).end(ok ? JSON.stringify(user) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A checkout of github.com/o/r, as actions/checkout leaves it
  const work = mkdtempSync(join(tmpdir(), "autoreview-action-"));
  execFileSync("git", ["init", "--quiet", work]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", "https://github.com/o/r"]);
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GITEA_ACTIONS: "",
    GITHUB_API_URL: api,
    GITHUB_GRAPHQL_URL: `${api}/graphql`,
    PUSH_TOKEN: "t",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_WORKSPACE: work,
  };
  try {
    await promisify(execFile)(join(HERE, "setup-git.sh"), { env });
  } finally {
    server.close();
  }
  return (key) =>
    execFileSync("git", ["-C", work, "config", "--get", key], { encoding: "utf8" }).trim();
}

test("on GitHub, the workflow's token pushes and commits as the Actions bot", async () => {
  const config = await setupOnGitHub(undefined);
  assert.equal(config("remote.origin.url"), "https://x-access-token:t@github.com/o/r.git");
  assert.equal(config("user.name"), "github-actions[bot]");
  assert.equal(config("user.email"), "41898282+github-actions[bot]@users.noreply.github.com");
});

test("on GitHub, a personal token commits as its user", async () => {
  const config = await setupOnGitHub({ login: "kurt", id: 7 });
  assert.equal(config("user.name"), "kurt");
  assert.equal(config("user.email"), "7+kurt@users.noreply.github.com");
});
