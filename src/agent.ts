import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, RoleConfig } from "./config.ts";
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
}

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

/** Git commands the implementer must leave to the loop, which commits and pushes. */
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

/** The implementer edits and runs anything but loop-owned git commands, and heavy checks unless enabled. */
export function implementerPermissions(config: Config, heavy: boolean): Permissions {
  const deny = LOOP_GIT.map(shell);
  if (!heavy) {
    deny.push(...config.heavyChecks.map(shell));
  }
  return { allowAll: true, allow: [], deny };
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
    const taskFile = join(runDir, `task-${attempt}.md`);
    await writeFile(taskFile, task);
    usage[call.role.model] = (usage[call.role.model] ?? 0) + 1;
    const output = await run(bin, copilotArgs(call, taskFile, runDir), call);
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
      task = retryTask(call.task, output, error.message);
    }
  }
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

/** Run the CLI, returning its output, or throwing on failure or timeout. */
function run(bin: string, args: string[], call: AgentCall<unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: call.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));

    // Stop a run that takes too long, forcefully if it ignores the request
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, call.timeoutMs);

    // Settle on exit
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new AgentError(`${call.name}: can't run ${bin}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
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
