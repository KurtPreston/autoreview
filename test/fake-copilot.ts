#!/usr/bin/env node
// A stand-in for the Copilot CLI in tests.
// Plays back answers from the JSON list in $FAKE_COPILOT (one per call, counted in a
// state file beside it), and appends each call's arguments and cwd to $FAKE_COPILOT.log.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface Step {
  stdout?: string;
  exit?: number;
  sleepMs?: number;
}

// Find this call's step
const script = process.env.FAKE_COPILOT ?? "";
const steps = JSON.parse(readFileSync(script, "utf8")) as Step[];
const counter = `${script}.count`;
const index = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(index + 1));
appendFileSync(
  `${script}.log`,
  `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), task: taskText() })}\n`,
);

/** The task file the prompt points at, read before the runner deletes it. */
function taskText(): string {
  const path = /Your task is in (\S+)\./.exec(process.argv[3] ?? "")?.[1];
  return path ? readFileSync(path, "utf8") : "";
}

// Answer, after an optional pause
const step = steps[Math.min(index, steps.length - 1)];
setTimeout(() => {
  process.stdout.write(step.stdout ?? "");
  process.exit(step.exit ?? 0);
}, step.sleepMs ?? 0);
