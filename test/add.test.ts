import "./scratch.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACTION, add, guessConfig } from "../src/add.ts";

/** A repository whose origin is on a stub server, and the API calls the stub saw. */
function project(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "autoreview-add-"));
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://g.example/o/r.git"]);
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(repo, path), text);
  }

  // The stub knows one bot, and records every request
  const calls: string[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname.replace("/api/v1", "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/users/missing-bot") {
      return new Response("", { status: 404 });
    }
    if (path === "/repos/o/r/labels" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify([{ id: 1, name: "autoreview" }]));
    }
    return new Response(JSON.stringify({ id: 2 }));
  };
  return { repo, calls, fetch: fake as typeof fetch };
}

const scripts = { scripts: { lint: "oxlint", build: "vite build", test: "vitest", dev: "vite" } };

test("enabling a repository writes its workflow and config, labels, and collaborators", async () => {
  const { repo, calls, fetch } = project({
    "package.json": JSON.stringify(scripts),
    "package-lock.json": "{}",
  });
  process.env.GITEA_TOKEN = "t";
  const log: string[] = [];
  await add({
    repo,
    ref: "autoreview",
    setupActions: ["https://example.com/o/instructions@main"],
    runsOn: "ubuntu-latest",
    reviewer: "reviewer-bot",
    implementer: "missing-bot",
    secrets: { COPILOT_GITHUB_TOKEN: "c" },
    log: (message) => log.push(message),
    fetch,
  });

  // The workflow pins the ref, and sets up npm and the setup actions before deliberating
  const workflow = readFileSync(join(repo, ".gitea/workflows/autoreview.yml"), "utf8");
  assert.ok(workflow.includes(`uses: ${ACTION}@autoreview\n`));
  assert.match(
    workflow,
    /fetch-depth: 0\n\n {6}# The project's tools[\s\S]*- run: npm ci\n\n {6}# The agents' standing instructions and settings\n {6}- uses: https:\/\/example\.com\/o\/instructions@main\n\n {6}# Deliberate/,
  );
  assert.doesNotMatch(workflow, /\{\{\w+\}\}/);

  // Quick checks always, tests only on a capable runner
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".autoreview.json"), "utf8")), {
    checks: ["npm run lint", "npm run build"],
    heavyChecks: ["npm run test"],
    visual: false,
  });

  // The missing label is created, the existing bot added, and the secret stored
  assert.ok(calls.includes("POST /repos/o/r/labels"));
  assert.ok(calls.includes("PUT /repos/o/r/collaborators/reviewer-bot"));
  assert.ok(!calls.includes("PUT /repos/o/r/collaborators/missing-bot"));
  assert.ok(calls.includes("PUT /user/actions/secrets/COPILOT_GITHUB_TOKEN"));
  assert.ok(log.some((line) => /missing-bot doesn't exist yet/.test(line)));
});

test("existing files are kept, and non-npm projects get no setup or checks", async () => {
  const { repo, fetch } = project({ ".autoreview.json": '{"checks":["make check"]}\n' });
  process.env.GITEA_TOKEN = "t";
  await add({
    repo,
    ref: "main",
    runsOn: "self-hosted",
    reviewer: "reviewer-bot",
    implementer: "reviewer-bot",
    secrets: {},
    log: () => {},
    fetch,
  });
  assert.equal(readFileSync(join(repo, ".autoreview.json"), "utf8"), '{"checks":["make check"]}\n');
  const workflow = readFileSync(join(repo, ".gitea/workflows/autoreview.yml"), "utf8");
  assert.match(workflow, /runs-on: self-hosted/);
  assert.doesNotMatch(workflow, /npm ci|standing instructions/);
  assert.match(workflow, /fetch-depth: 0\n\n {6}# Deliberate/);
  assert.deepEqual(await guessConfig(repo), { checks: [], heavyChecks: [], visual: false });
});

test("a token without the user scope gets advice instead of a crash", async () => {
  const { repo, fetch } = project({});
  const scoped = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.includes("/actions/secrets/")
      ? new Response('{"message":"required=[write:user]"}', { status: 403 })
      : fetch(input, init)) as typeof fetch;
  process.env.GITEA_TOKEN = "t";
  const log: string[] = [];
  await add({
    repo,
    ref: "main",
    runsOn: "ubuntu-latest",
    reviewer: "reviewer-bot",
    implementer: "reviewer-bot",
    secrets: { COPILOT_GITHUB_TOKEN: "c" },
    log: (message) => log.push(message),
    fetch: scoped,
  });
  assert.match(log.at(-1) ?? "", /needs the write:user scope/);
});
