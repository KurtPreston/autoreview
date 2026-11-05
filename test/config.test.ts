import "./scratch.ts";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ConfigError,
  DEFAULTS,
  loadConfig,
  loadConfigAt,
  loadConfigFile,
  parseConfig,
} from "../src/config.ts";
import { Checkout } from "../src/git.ts";
import { git, repository } from "./harness.ts";

test("an empty config is the defaults", () => {
  assert.deepEqual(parseConfig({}), DEFAULTS);
});

test("fields override defaults, and roles merge field by field", () => {
  const config = parseConfig({ checks: ["npm run lint"], reviewer: { model: "gpt-5.5" } });
  assert.deepEqual(config.checks, ["npm run lint"]);
  assert.deepEqual(config.reviewer, { model: "gpt-5.5", effort: "high" });
  assert.deepEqual(config.fixer, DEFAULTS.fixer);
});

test("bad values and unknown keys are rejected", () => {
  assert.throws(() => parseConfig({ checks: "npm test" }), ConfigError);
  assert.throws(() => parseConfig({ maxRounds: 0 }), ConfigError);
  assert.throws(() => parseConfig({ reviewer: { effort: "huge" } }), ConfigError);
  assert.throws(() => parseConfig({ chekcs: [] }), /unknown key "chekcs"/);
  assert.throws(() => parseConfig([]), ConfigError);
});

test("judgement calls are decided by default, or deferred in blocking mode", () => {
  assert.equal(DEFAULTS.defer, "best-effort");
  assert.equal(DEFAULTS.decisionLabel, "author-review");
  assert.equal(parseConfig({ defer: "blocking" }).defer, "blocking");
  assert.throws(
    () => parseConfig({ defer: "never" }),
    /defer must be one of "best-effort", "blocking"/,
  );
  assert.throws(() => parseConfig({ decisionLabel: "" }), ConfigError);
});

test("a repository without a config file gets the defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoreview-"));
  assert.deepEqual(await loadConfig(dir), DEFAULTS);

  // With a file, its values are read
  await writeFile(join(dir, ".autoreview.json"), JSON.stringify({ visual: true }));
  assert.equal((await loadConfig(dir)).visual, true);
});

test("a config read at a commit ignores later commits and the working tree", async () => {
  const { work } = repository();
  const checkout = new Checkout(work);
  const before = git(work, "rev-parse", "HEAD");

  // A commit adds the file, and the working tree then changes it
  await writeFile(join(work, ".autoreview.json"), JSON.stringify({ visual: true }));
  git(work, "add", ".autoreview.json");
  git(work, "commit", "--quiet", "-m", "Config");
  const after = git(work, "rev-parse", "HEAD");
  await writeFile(join(work, ".autoreview.json"), JSON.stringify({ visual: false }));

  assert.deepEqual(await loadConfigAt(checkout, before), DEFAULTS);
  assert.equal((await loadConfigAt(checkout, after)).visual, true);
});

test("an operator's config file names itself in errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoreview-"));
  const path = join(dir, "yolo.json");
  await writeFile(path, JSON.stringify({ checks: ["ruff check"] }));
  assert.deepEqual((await loadConfigFile(path)).checks, ["ruff check"]);

  await writeFile(path, JSON.stringify({ maxRounds: "two" }));
  await assert.rejects(loadConfigFile(path), (error: Error) => {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.message.startsWith(`${path}: `), error.message);
    return true;
  });
});

test("workflows to start after a fix are listed by file name", () => {
  assert.deepEqual(DEFAULTS.dispatch, []);
  assert.deepEqual(parseConfig({ dispatch: ["checks.yml"] }).dispatch, ["checks.yml"]);
  assert.throws(() => parseConfig({ dispatch: "checks.yml" }), ConfigError);
});
