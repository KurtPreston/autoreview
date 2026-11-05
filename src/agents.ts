/** Agents backed by the Copilot CLI. */
import { fixerPermissions, reviewerPermissions, runAgent } from "./agent.ts";
import type { Agents, Deliberation } from "./loop.ts";
import {
  SchemaError,
  validateAnswer,
  validateReview,
  validateVerification,
  type Verification,
} from "./schemas.ts";

/** Agents backed by the Copilot CLI, working in the checkout. */
export function copilotAgents({
  config,
  checkout,
  usage,
  heavy,
}: Pick<Deliberation, "config" | "checkout" | "usage" | "heavy">): Agents {
  const base = { cwd: checkout.dir, timeoutMs: config.agentTimeoutMinutes * 60_000 };
  return {
    review: (task) =>
      runAgent(
        {
          ...base,
          name: "reviewer",
          role: config.reviewer,
          task,
          validate: validateReview,
          permissions: reviewerPermissions(),
        },
        usage,
      ),
    fix: (task) =>
      runAgent(
        {
          ...base,
          name: "fixer",
          role: config.fixer,
          task,
          validate: validateAnswer,
          permissions: fixerPermissions(config, heavy),
        },
        usage,
      ),
    verify: (task, keys) =>
      runAgent(
        {
          ...base,
          name: "verifier",
          role: config.reviewer,
          task,
          validate: (value) => covering(validateVerification(value), keys),
          permissions: reviewerPermissions(),
        },
        usage,
      ),
  };
}

/** Require a verdict for every thread, so a missing one is retried like any invalid answer. */
export function covering(verification: Verification, keys: string[]): Verification {
  const given = new Set(verification.threads.map((t) => t.key));
  const missing = keys.filter((key) => !given.has(key));
  if (missing.length > 0) {
    throw new SchemaError(`threads is missing verdicts for ${missing.join(", ")}`);
  }
  return { ...verification, threads: verification.threads.filter((t) => keys.includes(t.key)) };
}
