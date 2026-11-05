import "./scratch.ts";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULTS, loadConfig, parseConfig } from "../src/config.ts";

test("an empty config is the defaults", () => {
  assert.deepEqual(parseConfig({}), DEFAULTS);
});

test("fields override defaults, and roles merge field by field", () => {
  const config = parseConfig({ checks: ["npm run lint"], reviewer: { model: "gpt-5.5" } });
  assert.deepEqual(config.checks, ["npm run lint"]);
  assert.deepEqual(config.reviewer, { model: "gpt-5.5", effort: "high" });
  assert.deepEqual(config.implementer, DEFAULTS.implementer);
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
