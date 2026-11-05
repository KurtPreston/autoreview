import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleConfig } from "./config.ts";
import { spawnGroup, stopGroup } from "./processes.ts";
import { extractJson, SchemaError, type Validator } from "./schemas.ts";

/** Which tools an agent may use, in the Copilot CLI's permission syntax. */
export interface Permissions {
  /** Allow every tool except those denied. */
  allowAll: boolean;
  allow: string[];
  deny: string[];
}

/** One agent call: who, where, what to do, and what it must answer. */
export interface AgentCall<T> {
  /** For logs and errors. */
  name: string;
  role: RoleConfig;
  /** The checkout the agent works in. */
  cwd: string;
  /** Full instructions, written to a file the agent reads. */
  task: string;
  validate: Validator<T>;
  permissions: Permissions;
  timeoutMs: number;
  /** Progress lines, such as for the Actions log. */
  log?: (message: string) => void;
  /** Stops the CLI when aborted, as when the job is cancelled. */
  signal?: AbortSignal;
}

/** How often a running call says it's still working. */
const HEARTBEAT_MS = 30_000;

/** Calls made per model, for the summary. */
export type Usage = Record<string, number>;

export class AgentError extends Error {}

/** Commands that only read, which the reviewer may run. */
const READ_ONLY = [
  "git diff",
  "git log",
  "git show",
  "git blame",
  "git grep",
  "rg",
  "grep",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
];

/** Git commands the fixer must leave to the loop, which commits and pushes. */
const LOOP_GIT = [
  "git push",
  "git commit",
  "git reset",
  "git checkout",
  "git switch",
  "git rebase",
  "git merge",
  "git stash",
  "git tag",
  "git branch",
  "git remote",
  "git config",
];

/** The reviewer reads and runs read-only commands, and writes nothing. */
export function reviewerPermissions(): Permissions {
  return { allowAll: false, allow: READ_ONLY.map(shell), deny: ["write"] };
}

/**
 * The fixer edits and runs anything but loop-owned git commands and the commands the loop
 * denies it, such as heavy checks on a runner that can't afford them.
 */
export function fixerPermissions(denied: string[] = []): Permissions {
  return { allowAll: true, allow: [], deny: [...LOOP_GIT, ...denied].map(shell) };
}

function shell(command: string): string {
  return `shell(${command})`;
}

/** The Copilot CLI's arguments for a call whose task sits in `taskFile`. */
export function copilotArgs(call: AgentCall<unknown>, taskFile: string, runDir: string): string[] {
  const prompt =
    `Your task is in ${taskFile}. Read the whole file first and follow it. ` +
    `Finish by answering with only the JSON object it asks for, and nothing else.`;

  // Non-interactive, final answer only, without built-in GitHub servers
  const args = ["-p", prompt, "-s", "--no-ask-user", "--disable-builtin-mcps", "--no-color"];
  args.push(
    "--model",
    call.role.model,
    "--reasoning-effort",
    call.role.effort,
    "--add-dir",
    runDir,
  );

  // Tool permissions: denials win over allowances
  if (call.permissions.allowAll) {
    args.push("--allow-all-tools");
  }
  for (const tool of call.permissions.allow) {
    args.push("--allow-tool", tool);
  }
  for (const tool of call.permissions.deny) {
    args.push("--deny-tool", tool);
  }
  return args;
}

/**
 * Run an agent and return its validated answer. An invalid answer gets one
 * retry, told what was wrong; a failed or timed-out run throws.
 */
export async function runAgent<T>(call: AgentCall<T>, usage: Usage): Promise<T> {
  const bin = process.env.AUTOREVIEW_COPILOT ?? "copilot";
  const runDir = await mkdtemp(join(tmpdir(), `autoreview-${call.name}-`));

  // First attempt, then one retry quoting the problem
  let task = call.task;
  for (let attempt = 1; ; attempt++) {
    call.signal?.throwIfAborted();
    const taskFile = join(runDir, `task-${attempt}.md`);
    await writeFile(taskFile, task);
    usage[call.role.model] = (usage[call.role.model] ?? 0) + 1;
    const output = await logged(call, attempt, () =>
      run(bin, copilotArgs(call, taskFile, runDir), call),
    );
    await writeFile(join(runDir, `answer-${attempt}.txt`), output);
    try {
      const value = call.validate(extractJson(output));
      await rm(runDir, { recursive: true, force: true });
      return value;
    } catch (error) {
      if (!(error instanceof SchemaError) || attempt === 2) {
        throw new AgentError(
          `${call.name}: invalid answer (${(error as Error).message}); see ${runDir}`,
        );
      }
      call.log?.(`${call.name}: invalid answer (${error.message}); retrying`);
      task = retryTask(call.task, output, error.message);
    }
  }
}

/** Run one CLI call, logging when it starts, while it works, and how it ended. */
async function logged(
  call: AgentCall<unknown>,
  attempt: number,
  work: () => Promise<string>,
): Promise<string> {
  // Say who started, then keep saying it's still going
  const who = `${call.name} (${call.role.model}, ${call.role.effort})`;
  const started = Date.now();
  const retry = attempt > 1 ? ", retry" : "";
  call.log?.(`${who} started${retry}`);
  const heartbeat = setInterval(
    () => call.log?.(`${who} still working, ${elapsed(started)}`),
    HEARTBEAT_MS,
  );
  heartbeat.unref();

  // Report how the call ended
  try {
    const output = await work();
    call.log?.(`${who} answered in ${elapsed(started)}`);
    return output;
  } catch (error) {
    call.log?.(`${who} failed after ${elapsed(started)}`);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

/** Time since a start, as `1m 05s` or `42s`. */
export function elapsed(since: number, now = Date.now()): string {
  const seconds = Math.round((now - since) / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(minutes > 0 ? 2 : 1, "0");
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/** The task again, with the rejected answer and why it was rejected. */
function retryTask(task: string, answer: string, problem: string): string {
  return [
    task,
    "## Your previous answer was rejected",
    `Problem: ${problem}`,
    "Any file changes you made are still in place; don't redo them. Answer again with only the JSON object.",
    "Previous answer:",
    "```",
    answer.slice(-4000),
    "```",
  ].join("\n\n");
}

/** Run the CLI, returning its output, or throwing on failure, timeout or cancellation. */
function run(bin: string, args: string[], call: AgentCall<unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const { signal } = call;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawnGroup(bin, args, { cwd: call.cwd, env: agentEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));

    // Stop a run that takes too long or is cancelled, with the commands it started, forcefully
    // if they ignore the request
    const stop = () => stopGroup(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, call.timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const settled = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };

    // Settle on exit
    child.on("error", (error) => {
      settled();
      reject(new AgentError(`${call.name}: can't run ${bin}: ${error.message}`));
    });
    child.on("close", (code) => {
      settled();
      if (signal?.aborted) {
        reject(signal.reason);
      } else if (timedOut) {
        reject(
          new AgentError(`${call.name}: timed out after ${Math.round(call.timeoutMs / 1000)}s`),
        );
      } else if (code !== 0) {
        reject(
          new AgentError(
            `${call.name}: ${bin} exited ${code}: ${(stderr || stdout).trim().slice(-2000)}`,
          ),
        );
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Tokens the loop posts and pushes with, which agents must not hold. */
const FORGE_TOKENS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITEA_TOKEN",
  "AUTOREVIEW_REVIEWER_TOKEN",
  "AUTOREVIEW_FIXER_TOKEN",
];

/**
 * The environment an agent runs in: without the forge tokens, so the Copilot CLI signs in
 * with COPILOT_GITHUB_TOKEN rather than the workflow's token, and only the loop can act.
 * Without COPILOT_GITHUB_TOKEN, a GitHub token the CLI would have used is handed over as it.
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  clean.COPILOT_GITHUB_TOKEN ||= env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
  if (!clean.COPILOT_GITHUB_TOKEN) {
    delete clean.COPILOT_GITHUB_TOKEN;
  }
  for (const name of FORGE_TOKENS) {
    delete clean[name];
  }
  return clean;
}
