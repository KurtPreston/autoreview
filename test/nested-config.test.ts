import "./scratch.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, parseFolderConfig } from "../src/config.ts";
import { FolderConfigs } from "../src/folders.ts";
import { Checkout } from "../src/git.ts";
import { compose } from "../src/markers.ts";
import type { Store } from "../src/memory.ts";
import type { Answer } from "../src/schemas.ts";
import { git, repository, setup, verdict, type Setup } from "./harness.ts";

/** Write files into the checkout, creating their folders. */
function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

test("a folder's file sets only checks and context, relative to its folder", () => {
  assert.deepEqual(
    parseFolderConfig({ checks: ["npm test"], context: ["docs/style.md", "../AGENTS.md"] }, "a/b"),
    {
      folder: "a/b",
      checks: ["npm test"],
      heavyChecks: [],
      context: ["a/b/docs/style.md", "a/AGENTS.md"],
    },
  );

  // Settings for the whole run, unknown keys and escaping paths name the folder's file
  assert.throws(
    () => parseFolderConfig({ maxRounds: 2 }, "a/b"),
    /^Error: a\/b\/\.autoreview\.json: "maxRounds" can only be set in the root \.autoreview\.json$/,
  );
  assert.throws(
    () => parseFolderConfig({ toString: [] }, "a"),
    /a\/\.autoreview\.json: unknown key/,
  );
  assert.throws(() => parseFolderConfig({ context: ["../../x"] }, "a"), /outside the repository/);
  assert.throws(() => parseFolderConfig({ checks: "npm test" }, "a"), ConfigError);
});

test("folder files are read from the starting commit, shallowest first, for the paths' folders", async () => {
  const { work } = repository();
  write(work, {
    "pkg/.autoreview.json": '{"checks":["lint"]}',
    "pkg/foo/.autoreview.json": '{"heavyChecks":["test"]}',
    "other/.autoreview.json": '{"checks":["other"]}',
    "bad/.autoreview.json": "{",
  });
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "Folder configs");
  const checkout = new Checkout(work);
  const folders = new FolderConfigs(checkout, await checkout.head());

  // A later edit in the working tree doesn't change what applies
  writeFileSync(join(work, "pkg/.autoreview.json"), "{}");
  const found = await folders.for(["pkg/foo/src/a.ts"]);
  assert.deepEqual(
    found.map((config) => [config.folder, config.checks, config.heavyChecks]),
    [
      ["pkg", ["lint"], []],
      ["pkg/foo", [], ["test"]],
    ],
  );
  await assert.rejects(folders.for(["bad/x.ts"]), /^Error: bad\/\.autoreview\.json: /);
  await assert.rejects(folders.all(), /^Error: bad\/\.autoreview\.json: /);
  writeFileSync(join(work, "bad/.autoreview.json"), "{}");
  git(work, "commit", "--quiet", "-am", "Fix bad");
  const all = await new FolderConfigs(checkout, await checkout.head()).all();
  assert.deepEqual(
    all.map((config) => config.folder),
    ["bad", "other", "pkg", "pkg/foo"],
  );
});

/**
 * A pull request changing `pkg/foo/b.ts`, in a repository whose folders have their own
 * configs, with a finding open on that file.
 */
function monorepo(
  fixes: ((dir: string, task: string) => Answer)[],
  seed: (store: Store) => void = seedThread,
): Setup {
  const nested = setup({ fix: fixes, verify: [verdict("resolved")] }, { seed });
  const { store, work } = nested;

  // main gains the folder configs; other/ fails every check, but nothing touches it
  git(work, "checkout", "--quiet", "main");
  write(work, {
    "other/.autoreview.json": '{"checks":["false"],"heavyChecks":["make e2e"]}',
    "pkg/.autoreview.json": '{"checks":["test -f marker"],"context":["docs/style.md"]}',
    "pkg/marker": "",
    "pkg/docs/style.md": "Style.\n",
    "pkg/foo/.autoreview.json": '{"checks":["test -f ok.txt"],"heavyChecks":["npm test"]}',
  });
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "Folder configs");

  // The branch changes a file in pkg/foo
  git(work, "checkout", "--quiet", "ferns");
  git(work, "merge", "--quiet", "main");
  write(work, { "pkg/foo/b.ts": "export const b = 1;\n" });
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "Add b");
  git(work, "checkout", "--quiet", "--detach");
  store.pr.headSha = git(work, "rev-parse", "HEAD");
  store.diff = git(work, "diff", "main...HEAD");
  return nested;
}

/** An open finding on pkg/foo/b.ts line 1. */
function seedThread(store: Store): void {
  store.threads.push({
    id: "2",
    key: "pkg/foo/b.ts:+1",
    path: "pkg/foo/b.ts",
    line: 1,
    side: "new",
    resolved: false,
    comments: [
      {
        id: 2,
        author: "reviewer-bot",
        body: compose("x", "Name it.", { role: "reviewer", kind: "finding" }),
        createdAt: "",
      },
    ],
  });
}

/** An open finding on the root's a.ts line 2. */
function seedRoot(store: Store): void {
  seedThread(store);
  Object.assign(store.threads[0], { key: "a.ts:+2", path: "a.ts", line: 2 });
}

/** Edit b.ts, and write any other files, then answer with a fix, keeping the task. */
function fixB(tasks: string[], files: Record<string, string> = {}) {
  return (dir: string, task: string): Answer => {
    tasks.push(task);
    write(dir, { "pkg/foo/b.ts": "export const bee = 1;\n", ...files });
    return { action: "fix", body: "Renamed it.", commit: "Rename b" };
  };
}

test("a fix answers to the checks of its folders and those above, each run in its folder", async () => {
  const tasks: string[] = [];
  const nested = monorepo([fixB(tasks), fixB(tasks, { "pkg/foo/ok.txt": "" })]);
  const outcome = await nested.run();

  // The agents read the folder's context, and the fixer sees its checks with their folders
  assert.match(nested.reviews[0], /`pkg\/docs\/style\.md`/);
  assert.match(
    tasks[0],
    /fix what they report: `true`, `test -f marker` \(in `pkg`\), `test -f ok\.txt` \(in `pkg\/foo`\)\./,
  );
  assert.deepEqual(nested.denied, [
    ["make e2e", "npm test"],
    ["make e2e", "npm test"],
  ]);

  // The first fix lacked pkg/foo/ok.txt, so it failed there; the retry passed, and other/'s
  // failing check never ran
  assert.match(tasks[1], /## Your fix failed the checks[\s\S]*\$ \(in pkg\/foo\) test -f ok\.txt/);
  assert.equal(outcome.commits.length, 1);
  assert.equal(outcome.resolved, 1);
});

test("a fix to a root file may not run any folder's heavy checks, nor may its retry", async () => {
  const tasks: string[] = [];
  const nested = monorepo([fixB(tasks), fixB(tasks, { "pkg/foo/ok.txt": "" })], seedRoot);
  const outcome = await nested.run();
  assert.match(tasks[0], /fix what they report: `true`\./);
  assert.match(tasks[1], /\$ \(in pkg\/foo\) test -f ok\.txt/);
  assert.deepEqual(nested.denied, [
    ["make e2e", "npm test"],
    ["make e2e", "npm test"],
  ]);
  assert.equal(outcome.commits.length, 1);
});

test("a fix can't loosen its own folder's checks", async () => {
  const tasks: string[] = [];
  const loosen = { "pkg/foo/.autoreview.json": "{}" };
  const nested = monorepo([fixB(tasks, loosen), fixB(tasks, loosen)]);
  const outcome = await nested.run();
  assert.equal(nested.calls.fix, 2);
  assert.deepEqual(outcome.commits, []);
  assert.equal(outcome.deferred, 1);
});

/** Move pkg/foo, its file included, to lib/foo, editing b.ts there, and write any other files. */
function moveFoo(tasks: string[], files: Record<string, string> = {}) {
  return (dir: string, task: string): Answer => {
    tasks.push(task);
    // A retry finds the first try's move still in place
    if (existsSync(join(dir, "pkg/foo"))) {
      mkdirSync(join(dir, "lib"), { recursive: true });
      renameSync(join(dir, "pkg/foo"), join(dir, "lib/foo"));
    }
    write(dir, { "lib/foo/b.ts": "export const bee = 1;\n", ...files });
    return { action: "fix", body: "Moved it.", commit: "Move foo" };
  };
}

test("a moved folder answers to its checks where it went", async () => {
  const tasks: string[] = [];
  const nested = monorepo([moveFoo(tasks), moveFoo(tasks)]);
  const outcome = await nested.run();
  assert.match(tasks[1], /\$ \(in lib\/foo\) test -f ok\.txt/);
  assert.deepEqual(outcome.commits, []);
  assert.equal(outcome.deferred, 1);

  const passing = monorepo([moveFoo([], { "lib/foo/ok.txt": "" })]);
  const passed = await passing.run();
  assert.equal(passing.calls.fix, 1);
  assert.equal(passed.commits.length, 1);
});

test("a folder that's gone without its file landing whole elsewhere fails its checks", async () => {
  const tasks: string[] = [];
  const edited = { "lib/foo/.autoreview.json": "{}", "lib/foo/ok.txt": "" };
  const nested = monorepo([moveFoo(tasks, edited), moveFoo(tasks, edited)]);
  const outcome = await nested.run();
  assert.match(tasks[1], /pkg\/foo is gone[^]*\(test -f ok\.txt\)/);
  assert.deepEqual(outcome.commits, []);
  assert.equal(outcome.deferred, 1);
});
