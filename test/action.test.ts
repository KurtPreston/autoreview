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
const cli = readFileSync(join(HERE, "src", "autoreview.ts"), "utf8");

test("the action passes every variable the tool reads", () => {
  // Each AUTOREVIEW_* or token variable the CLI reads is set by the action
  const read = new Set([...cli.matchAll(/\b(AUTOREVIEW_[A-Z_]+|GITEA_TOKEN)\b/g)].map((m) => m[1]));
  for (const name of read) {
    assert.match(action, new RegExp(`^\\s+${name}:`, "m"), `action.yml doesn't set ${name}`);
  }
  assert.match(action, /COPILOT_GITHUB_TOKEN: \$\{\{ inputs\.copilot-token \}\}/);
});

test("the files the action runs exist", () => {
  for (const path of ["setup-git.sh", "src/autoreview.ts"]) {
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
