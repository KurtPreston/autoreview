import "./scratch.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACTION, add, guessConfig, workflowEvents } from "../src/add.ts";

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

/** A repository whose origin is on GitHub, with a stub API that knows one label. */
function githubProject(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "autoreview-add-"));
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:o/r.git"]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const calls: string[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const call = `${init?.method ?? "GET"} ${url.host}${url.pathname}`;
    calls.push(call);
    const known = call === "GET api.github.com/repos/o/r/labels/autoreview";
    return new Response("{}", { status: known || call.startsWith("POST") ? 200 : 404 });
  };
  process.env.GITHUB_TOKEN = "t";
  return { repo, calls, fetch: fake as typeof fetch };
}

const githubOptions = {
  ref: "v1",
  runsOn: "ubuntu-latest",
  reviewer: "",
  implementer: "",
  secrets: {},
};

test("on GitHub, the workflow uses the workflow's token, and checks are started after fixes", async () => {
  const { repo, calls, fetch } = githubProject({
    "package.json": JSON.stringify(scripts),
    ".github/workflows/ci.yml": "on:\n  pull_request:\n  workflow_dispatch:\n",
    ".github/workflows/lint.yml": "on: [pull_request]\n",
    ".github/workflows/release.yml": "on:\n  workflow_dispatch:\n",
    ".github/workflows/deploy.yml":
      "on: [push, workflow_dispatch]\njobs:\n  d:\n    if: github.event_name != 'pull_request'\n",
  });
  const log: string[] = [];
  await add({ ...githubOptions, repo, log: (message) => log.push(message), fetch });

  // The workflow names the action by owner/repo, and grants what the built-in token needs
  const workflow = readFileSync(join(repo, ".github/workflows/autoreview.yml"), "utf8");
  assert.ok(workflow.includes(`uses: ${new URL(ACTION).pathname.slice(1)}@v1\n`));
  assert.match(workflow, /copilot-requests: write/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(workflow, /\{\{\w+\}\}/);
  assert.match(
    workflow,
    /copilot-token: \$\{\{ secrets\.COPILOT_GITHUB_TOKEN \|\| github\.token \}\}/,
  );

  // Pull request checks that can be started by hand are, and the others are named
  const config = JSON.parse(readFileSync(join(repo, ".autoreview.json"), "utf8"));
  assert.deepEqual(config.dispatch, ["ci.yml"]);
  assert.ok(log.some((line) => line.startsWith("lint.yml won't run on autoreview's fixes")));

  // Only the missing labels are created, and no bots or secrets
  assert.deepEqual(
    calls.filter((call) => call.startsWith("POST")),
    ["POST api.github.com/repos/o/r/labels", "POST api.github.com/repos/o/r/labels"],
  );
});

test("--vendor copies the action into the repository and uses the copy", async () => {
  const { repo, fetch } = githubProject({
    ".github/actions/autoreview/stale.txt": "from an older copy",
  });
  await add({ ...githubOptions, repo, vendor: true, log: () => {}, fetch });
  const workflow = readFileSync(join(repo, ".github/workflows/autoreview.yml"), "utf8");
  assert.match(workflow, /uses: \.\/\.github\/actions\/autoreview\n/);
  for (const part of ["action.yml", "setup-git.sh", "src/autoreview.ts", "prompts"]) {
    assert.ok(existsSync(join(repo, ".github/actions/autoreview", part)), part);
  }
  assert.ok(!existsSync(join(repo, ".github/actions/autoreview/stale.txt")));
});

test("a workflow's events are read from its top-level on, not its jobs or comments", () => {
  assert.deepEqual(workflowEvents("on: push\n"), ["push"]);
  assert.deepEqual(workflowEvents("on: [pull_request, 'workflow_dispatch']\n"), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflowEvents('"on": { push: { branches: [main] }, pull_request }\n'), [
    "push",
    "pull_request",
  ]);
  assert.deepEqual(
    workflowEvents(
      "on: {push: {branches: [main, pull_request, release]}, workflow_dispatch: {}}\n",
    ),
    ["push", "workflow_dispatch"],
  );
  assert.deepEqual(
    workflowEvents(
      [
        "on: {",
        "  push: {branches: [main], paths: ['a, pull_request: b']},",
        "  workflow_dispatch: {inputs: {x: {type: string}}},",
        "  pull_request: {}",
        "}",
        "jobs: {}",
        "",
      ].join("\n"),
    ),
    ["push", "workflow_dispatch", "pull_request"],
  );
  assert.deepEqual(
    workflowEvents(
      'on: {push: {paths: ["a\\"b", "c\\\\"]}, workflow_dispatch: {}, pull_request: {}}\n',
    ),
    ["push", "workflow_dispatch", "pull_request"],
  );
  assert.deepEqual(
    workflowEvents(
      [
        "on: {",
        "  workflow_dispatch: {inputs: {x: {description: What's needed?}}},",
        "  push: {paths: ['it''s, pull_request: b']},",
        "  pull_request: {}",
        "}",
        "",
      ].join("\n"),
    ),
    ["workflow_dispatch", "push", "pull_request"],
  );
  assert.deepEqual(workflowEvents("on:\n- push\n- pull_request\njobs: {}\n"), [
    "push",
    "pull_request",
  ]);
  assert.deepEqual(
    workflowEvents(
      [
        "name: deploy # not on pull_request",
        "on:",
        "  push:",
        "    branches: [main]",
        "    paths: [pull_request]",
        "  # pull_request:",
        "  workflow_dispatch:",
        "jobs:",
        "  deploy:",
        "    if: github.event_name != 'pull_request'",
        "",
      ].join("\n"),
    ),
    ["push", "workflow_dispatch"],
  );
  assert.deepEqual(workflowEvents("jobs:\n  on: pull_request\n"), []);
});
