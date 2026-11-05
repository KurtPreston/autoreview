import "./scratch.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentError,
  elapsed,
  fixerPermissions,
  reviewerPermissions,
  runAgent,
  type AgentCall,
  agentEnv,
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
    name: "fixer",
    role: DEFAULTS.fixer,
    cwd: tmpdir(),
    task: "Do the thing.",
    validate: validateAnswer,
    permissions: fixerPermissions(DEFAULTS, false),
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

test("each call logs when it starts, retries, and how it ended", async () => {
  // A retried call logs both attempts and the reason
  await fake([{ stdout: '{"action":"maybe"}' }, { stdout: JSON.stringify(answer) }]);
  const lines: string[] = [];
  await runAgent(call({ log: (line) => lines.push(line) }), {});
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "fixer (claude-opus-5.5, high) started");
  assert.match(lines[1], /^fixer \(claude-opus-5\.5, high\) answered in \d+s$/);
  assert.match(lines[2], /^fixer: invalid answer \(.*\); retrying$/);
  assert.equal(lines[3], "fixer (claude-opus-5.5, high) started, retry");

  // A failed run says so
  await fake([{ stdout: "Authentication failed", exit: 1 }]);
  lines.length = 0;
  await assert.rejects(runAgent(call({ log: (line) => lines.push(line) }), {}));
  assert.match(lines[1], /^fixer \(claude-opus-5\.5, high\) failed after \d+s$/);
});

test("elapsed time reads as seconds, then minutes and seconds", () => {
  assert.equal(elapsed(0, 42_000), "42s");
  assert.equal(elapsed(0, 65_000), "1m 05s");
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

test("cancelling a call stops the CLI and throws the reason", async () => {
  await fake([{ stdout: JSON.stringify(answer), sleepMs: 10_000 }]);
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(new Error("cancelled by SIGTERM")), 200);
  await assert.rejects(runAgent(call({ signal: stop.signal }), {}), /cancelled by SIGTERM/);
  assert.ok(Date.now() - started < 5000, "the CLI kept running after the cancellation");

  // A call cancelled before it starts doesn't run the CLI
  const { log } = await fake([{ stdout: JSON.stringify(answer) }]);
  await assert.rejects(runAgent(call({ signal: stop.signal }), {}), /cancelled by SIGTERM/);
  await assert.rejects(log(), /ENOENT/);
});

test("the reviewer can't write; the fixer can't push or run heavy checks", async () => {
  assert.deepEqual(reviewerPermissions().deny, ["write"]);
  assert.equal(reviewerPermissions().allowAll, false);

  // Heavy checks are denied unless the runner can afford them
  const config = parseConfig({ heavyChecks: ["npm test"] });
  assert.ok(fixerPermissions(config, false).deny.includes("shell(git push)"));
  assert.ok(fixerPermissions(config, false).deny.includes("shell(npm test)"));
  assert.ok(!fixerPermissions(config, true).deny.includes("shell(npm test)"));
});

test("agents run without the tokens the loop posts with, but Copilot keeps its own", () => {
  // In a workflow: the Copilot token is kept, and the forge tokens dropped
  const env = agentEnv({
    PATH: "/bin",
    COPILOT_GITHUB_TOKEN: "copilot",
    GITHUB_TOKEN: "workflow",
    GITEA_TOKEN: "gitea",
    AUTOREVIEW_FIXER_TOKEN: "bot",
  });
  assert.deepEqual(env, { PATH: "/bin", COPILOT_GITHUB_TOKEN: "copilot" });

  // Locally, a GitHub token the CLI would have signed in with is handed over
  assert.deepEqual(agentEnv({ GH_TOKEN: "mine" }), { COPILOT_GITHUB_TOKEN: "mine" });
  assert.deepEqual(agentEnv({ HOME: "/h" }), { HOME: "/h" });
});
