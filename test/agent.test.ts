import "./scratch.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentError,
  implementerPermissions,
  reviewerPermissions,
  runAgent,
  type AgentCall,
} from "../src/agent.ts";
import { DEFAULTS, parseConfig } from "../src/config.ts";
import { validateAnswer, type Answer } from "../src/schemas.ts";

const FAKE = new URL("./fake-copilot.ts", import.meta.url).pathname;

/** Point the runner at the fake CLI, playing back these steps. */
async function fake(
  steps: object[],
): Promise<{ log: () => Promise<{ args: string[]; cwd: string; task: string }[]> }> {
  const dir = await mkdtemp(join(tmpdir(), "autoreview-fake-"));
  const script = join(dir, "steps.json");
  await writeFile(script, JSON.stringify(steps));
  process.env.AUTOREVIEW_COPILOT = FAKE;
  process.env.FAKE_COPILOT = script;
  return {
    log: async () =>
      (await readFile(`${script}.log`, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

function call(overrides: Partial<AgentCall<Answer>> = {}): AgentCall<Answer> {
  return {
    name: "implementer",
    role: DEFAULTS.implementer,
    cwd: tmpdir(),
    task: "Do the thing.",
    validate: validateAnswer,
    permissions: implementerPermissions(DEFAULTS, false),
    timeoutMs: 10_000,
    ...overrides,
  };
}

const answer = { action: "reply", body: "It's fine as is." };

test("a valid answer comes back typed, and the call is counted", async () => {
  const { log } = await fake([
    { stdout: `Done.\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\n` },
  ]);
  const usage = {};
  assert.deepEqual(await runAgent(call(), usage), answer);
  assert.deepEqual(usage, { "claude-opus-5.5": 1 });

  // The prompt points at a task file holding the instructions
  const [{ args, task }] = await log();
  assert.match(args[1], /Your task is in \S+task-1\.md\./);
  assert.equal(task, "Do the thing.");
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4), [
    "--model",
    "claude-opus-5.5",
    "--reasoning-effort",
    "high",
  ]);
});

test("an invalid answer is retried once with the problem, then accepted", async () => {
  const { log } = await fake([
    { stdout: '{"action":"maybe"}' },
    { stdout: JSON.stringify(answer) },
  ]);
  assert.deepEqual(await runAgent(call(), {}), answer);
  const calls = await log();
  assert.match(calls[1].task, /\$\.action must be one of fix, reply, defer/);
});

test("two invalid answers, a failed run, or a timeout throw", async () => {
  await fake([{ stdout: "no json here" }]);
  await assert.rejects(
    runAgent(call(), {}),
    /invalid answer \(the answer contains no JSON object\)/,
  );
  await fake([{ stdout: "Authentication failed", exit: 1 }]);
  await assert.rejects(runAgent(call(), {}), /exited 1: Authentication failed/);
  await fake([{ stdout: JSON.stringify(answer), sleepMs: 2000 }]);
  await assert.rejects(runAgent(call({ timeoutMs: 200 }), {}), AgentError);
});

test("the reviewer can't write; the implementer can't push or run heavy checks", async () => {
  assert.deepEqual(reviewerPermissions().deny, ["write"]);
  assert.equal(reviewerPermissions().allowAll, false);

  // Heavy checks are denied unless the runner can afford them
  const config = parseConfig({ heavyChecks: ["npm test"] });
  assert.ok(implementerPermissions(config, false).deny.includes("shell(git push)"));
  assert.ok(implementerPermissions(config, false).deny.includes("shell(npm test)"));
  assert.ok(!implementerPermissions(config, true).deny.includes("shell(npm test)"));
});
