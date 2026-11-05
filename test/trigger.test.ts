import assert from "node:assert/strict";
import { test } from "node:test";
import type { Forge } from "../src/forge.ts";
import { dispatchAfterPush } from "../src/trigger.ts";

/** A forge that only records dispatches, failing for one workflow. */
function recorder(): { forge: Forge; started: string[] } {
  const started: string[] = [];
  const dispatch = async (workflow: string, ref: string) => {
    if (workflow === "broken.yml") {
      throw new Error("404 not found");
    }
    started.push(`${workflow}@${ref}`);
  };
  return { forge: { dispatch } as unknown as Forge, started };
}

test("each configured workflow starts on the head branch, past failures", async () => {
  const { forge, started } = recorder();
  const logs: string[] = [];
  await dispatchAfterPush({
    forge,
    workflows: ["broken.yml", "checks.yml"],
    branch: "ferns",
    log: (message) => logs.push(message),
  });
  assert.deepEqual(started, ["checks.yml@ferns"]);
  assert.match(logs[0], /couldn't start broken.yml: 404 not found/);
});

test("nothing starts without workflows, a branch, or forge support", async () => {
  const { forge, started } = recorder();
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  await dispatchAfterPush({ forge, workflows: [], branch: "ferns", log });
  await dispatchAfterPush({ forge, workflows: ["checks.yml"], branch: undefined, log });
  assert.deepEqual(started, []);
  await dispatchAfterPush({ forge: {} as Forge, workflows: ["checks.yml"], branch: "b", log });
  assert.match(logs.join("\n"), /can't start workflows/);
});
