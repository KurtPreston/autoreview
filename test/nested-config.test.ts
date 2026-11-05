import "./scratch.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, parseFolderConfig } from "../src/config.ts";
import { folderContext, FolderConfigs } from "../src/folders.ts";
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

test("folder context keeps each folder's scope unless a broader one covers it", () => {
  const folder = (name: string, context: string[]) => ({
    folder: name,
    checks: [],
    heavyChecks: [],
    context,
  });

  // Two packages sharing a file each keep their own scope
  assert.deepEqual(
    folderContext(
      [folder("packages/api", ["docs/shared.md"]), folder("packages/web", ["docs/shared.md"])],
      [],
      [],
    ),
    [
      { path: "docs/shared.md", folder: "packages/api" },
      { path: "docs/shared.md", folder: "packages/web" },
    ],
  );

  // A file found by name in a subfolder gives way to a folder file listing it for the folder above
  assert.deepEqual(
    folderContext(
      [folder("packages/api", ["packages/api/docs/AGENTS.md"])],
      [],
      [{ path: "packages/api/docs/AGENTS.md", folder: "packages/api/docs" }],
    ),
    [{ path: "packages/api/docs/AGENTS.md", folder: "packages/api" }],
  );

  // A broader scope covers narrower ones and repeats, and the root's context covers everything
  assert.deepEqual(
    folderContext(
      [
        folder("pkg", ["docs/a.md", "docs/root.md"]),
        folder("pkg/sub", ["docs/a.md"]),
        folder("pkg/sub", ["docs/a.md"]),
      ],
      ["docs/root.md"],
      [],
    ),
    [{ path: "docs/a.md", folder: "pkg" }],
  );
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
  options: { trustBase?: boolean } = {},
): Setup {
  const nested = setup({ fix: fixes, verify: [verdict("resolved")] }, { seed, ...options });
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

  // The agents read the folder's context for its folder's code, and the fixer sees its checks
  // with their folders
  assert.match(nested.reviews[0], /`pkg\/docs\/style\.md` for `pkg\/`/);
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

/** Run a pull request whose own commit drops pkg/foo's checks, reading configs from its base or not. */
async function loosenedByPullRequest(trustBase: boolean) {
  const tasks: string[] = [];
  const nested = monorepo([fixB(tasks), fixB(tasks)], seedThread, { trustBase });
  const { store, work } = nested;
  write(work, { "pkg/foo/.autoreview.json": "{}" });
  git(work, "commit", "--quiet", "-am", "Drop the checks");
  store.pr.headSha = git(work, "rev-parse", "HEAD");
  store.pr.baseSha = git(work, "rev-parse", "main");
  store.diff = git(work, "diff", "main...HEAD");
  return nested.run();
}

test("with configs from the base, a pull request can't drop the checks its fixes answer to", async () => {
  // Read from the head, the pull request's own file lets a fix without ok.txt through
  const fromHead = await loosenedByPullRequest(false);
  assert.equal(fromHead.commits.length, 1);

  // Read from the base, the fix still answers to the check, fails it twice, and is deferred
  const fromBase = await loosenedByPullRequest(true);
  assert.deepEqual(fromBase.commits, []);
  assert.equal(fromBase.deferred, 1);
});

/**
 * Run a pull request that moves pkg/foo, a.ts its only file on main, to lib/foo without its
 * file, reading configs from its base or not. Its fixes write `files` and lib/foo/ok.txt.
 */
async function movedByPullRequest(
  trustBase: boolean,
  files: Record<string, string> = { "lib/foo/b.ts": "export const bee = 1;\n" },
) {
  const tasks: string[] = [];
  const fix = (dir: string, task: string): Answer => {
    tasks.push(task);
    write(dir, { ...files, "lib/foo/ok.txt": "" });
    return { action: "fix", body: "Renamed it.", commit: "Rename b" };
  };
  const seed = (store: Store) => {
    seedThread(store);
    Object.assign(store.threads[0], { key: "lib/foo/b.ts:+1", path: "lib/foo/b.ts" });
  };
  const nested = monorepo([fix, fix], seed, { trustBase });
  const { store, work } = nested;

  // main has code in pkg/foo, which the pull request moves while dropping its file
  git(work, "checkout", "--quiet", "main");
  write(work, { "pkg/foo/a.ts": "export const a = 'a fairly long line of code';\n" });
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "Add a");
  git(work, "checkout", "--quiet", "ferns");
  git(work, "merge", "--quiet", "main");
  mkdirSync(join(work, "lib"));
  git(work, "mv", "pkg/foo", "lib/foo");
  git(work, "rm", "--quiet", "-f", "lib/foo/.autoreview.json");
  git(work, "commit", "--quiet", "-m", "Move foo and drop its checks");
  git(work, "checkout", "--quiet", "--detach");
  store.pr.headSha = git(work, "rev-parse", "HEAD");
  store.pr.baseSha = git(work, "rev-parse", "main");
  store.diff = git(work, "diff", "main...HEAD");
  return { outcome: await nested.run(), tasks };
}

test("with configs from the base, a pull request can't drop checks by moving their folder", async () => {
  // Read from the head, the moved folder has no checks, so the fix goes through
  const fromHead = await movedByPullRequest(false);
  assert.equal(fromHead.outcome.commits.length, 1);

  // Read from the base, the fix to the moved code fails pkg/foo's checks, and is deferred
  const fromBase = await movedByPullRequest(true);
  assert.match(fromBase.tasks[1], /pkg\/foo is gone[^]*\(test -f ok\.txt\)/);
  assert.deepEqual(fromBase.outcome.commits, []);
  assert.equal(fromBase.outcome.deferred, 1);
});

test("with configs from the base, a fix can't hide a folder's move by rewriting its moved code", async () => {
  // The fix rewrites a.ts, the only file that shows pkg/foo moved to lib/foo
  const rewrite = { "lib/foo/a.ts": "export const z = 2;\n" };
  const fromHead = await movedByPullRequest(false, rewrite);
  assert.equal(fromHead.outcome.commits.length, 1);

  const fromBase = await movedByPullRequest(true, rewrite);
  assert.match(fromBase.tasks[1], /pkg\/foo is gone[^]*\(test -f ok\.txt\)/);
  assert.deepEqual(fromBase.outcome.commits, []);
  assert.equal(fromBase.outcome.deferred, 1);
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

test("a folder moved earlier in the run still answers to its checks where it went", async () => {
  const tasks: string[] = [];

  // The second thread's fix, after the first moved pkg/foo, breaks its check and loosens its file
  const breakFoo = (dir: string, task: string): Answer => {
    tasks.push(task);
    rmSync(join(dir, "lib/foo/ok.txt"), { force: true });
    write(dir, {
      "lib/foo/b.ts": "export const b2 = 1;\n",
      "lib/foo/.autoreview.json": "{}",
    });
    return { action: "fix", body: "Renamed it.", commit: "Rename b again" };
  };
  const nested = monorepo(
    [moveFoo(tasks, { "lib/foo/ok.txt": "" }), breakFoo, breakFoo],
    (store) => {
      seedThread(store);
      seedThread(store);
      Object.assign(store.threads[1], {
        id: "3",
        key: "pkg/foo/b.ts:+2",
        line: 2,
      });
      store.threads[1].comments[0].id = 3;
    },
  );
  const outcome = await nested.run();
  assert.match(tasks[2], /\$ \(in lib\/foo\) test -f ok\.txt/);
  assert.equal(outcome.commits.length, 1);
  assert.equal(outcome.deferred, 1);
});

test("a moved folder keeps its checks after a later fix edits its file", async () => {
  const tasks: string[] = [];

  // After the move, one fix empties lib/foo's file, which passes, and the next breaks its check
  const emptyFile = (dir: string, task: string): Answer => {
    tasks.push(task);
    write(dir, { "lib/foo/.autoreview.json": "{}" });
    return { action: "fix", body: "Emptied it.", commit: "Empty foo's config" };
  };
  const breakFoo = (dir: string, task: string): Answer => {
    tasks.push(task);
    rmSync(join(dir, "lib/foo/ok.txt"), { force: true });
    return { action: "fix", body: "Removed it.", commit: "Remove ok.txt" };
  };
  const nested = monorepo(
    [moveFoo(tasks, { "lib/foo/ok.txt": "" }), emptyFile, breakFoo, breakFoo],
    (store) => {
      for (const id of [2, 3, 4]) {
        seedThread(store);
        Object.assign(store.threads[id - 2], {
          id: String(id),
          key: `pkg/foo/b.ts:+${id}`,
        });
        store.threads[id - 2].comments[0].id = id;
      }
    },
  );
  const outcome = await nested.run();
  assert.match(tasks[3], /\$ \(in lib\/foo\) test -f ok\.txt/);
  assert.equal(outcome.commits.length, 2);
  assert.equal(outcome.deferred, 1);
});
