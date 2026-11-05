/** Child processes stopped together with everything they start. */
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** How long a process group has to stop after SIGTERM before it's killed. */
export const KILL_AFTER_MS = 2000;

/**
 * Start a command in its own process group, with its output piped, so stopping it stops
 * whatever it started too.
 */
export function spawnGroup(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Ask a group started by spawnGroup to stop, and kill it if it hasn't by the time its output
 * closes or the grace period ends. The child's "close" event comes once the group has let go
 * of its output.
 */
export function stopGroup(child: ChildProcess): void {
  signalGroup(child, "SIGTERM");
  const timer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_AFTER_MS);
  child.once("close", () => {
    clearTimeout(timer);
    signalGroup(child, "SIGKILL");
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone
  }
}
