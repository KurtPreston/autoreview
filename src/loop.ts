import type { Usage } from "./agent.ts";
import type { Config } from "./config.ts";
import type { Forge } from "./forge.ts";
import type { Checkout } from "./git.ts";
import { fixRound } from "./fix.ts";
import { newChanges, recheckDeferred, reviewNew } from "./review.ts";
import type { Answer, Review, Verification } from "./schemas.ts";
import { status } from "./status.ts";
import { summarise } from "./summary.ts";
import { notice } from "./threads.ts";
import { verifyRound } from "./verify.ts";

export { copilotAgents, covering } from "./agents.ts";
export { status, type Status } from "./status.ts";
export { describe } from "./threads.ts";

/** The three judgements a deliberation asks for, whoever makes them. */
export interface Agents {
  review(task: string): Promise<Review>;
  /** May edit files in the checkout. */
  fix(task: string): Promise<Answer>;
  /** Must give a verdict for every key. */
  verify(task: string, keys: string[]): Promise<Verification>;
}

/** Everything one run needs. */
export interface Deliberation {
  number: number;
  config: Config;
  /** A checkout autoreview owns, at the pull request's head. */
  checkout: Checkout;
  /** The identities each role posts as; the same forge when there's one identity. */
  reviewer: Forge;
  fixer: Forge;
  agents: Agents;
  /** Agent calls per model, for the summary. */
  usage: Usage;
  /** Push fixes to the branch; off for dry runs. */
  push: boolean;
  /** Run heavy checks too: the runner can afford them. */
  heavy: boolean;
  /** Review even without the label, or on a draft or closed pull request. */
  force: boolean;
  log: (message: string) => void;
}

export interface Outcome {
  /** Why the run did nothing, or stopped early. */
  skipped?: string;
  stopped?: string;
  resolved: number;
  /** Resolved threads settled by a judgement call the author hasn't looked at yet. */
  decided: number;
  deferred: number;
  /** Threads a person has joined, left to them. */
  human: number;
  commits: string[];
}

/** Run the deliberation on a pull request until every thread is resolved or deferred. */
export async function deliberate(run: Deliberation): Promise<Outcome> {
  const { number, config, checkout } = run;
  const outcome: Outcome = { resolved: 0, decided: 0, deferred: 0, human: 0, commits: [] };
  const pr = await run.reviewer.pullRequest(number);

  // Only open pull requests that ask for it, and not drafts
  if (!run.force && pr.state !== "open") {
    return { ...outcome, skipped: "the pull request is closed" };
  }
  if (!run.force && pr.draft) {
    return { ...outcome, skipped: "the pull request is a draft" };
  }
  if (!run.force && !pr.labels.includes(config.label)) {
    return { ...outcome, skipped: `the pull request isn't labelled ${config.label}` };
  }
  if (run.push && !pr.headBranch) {
    return {
      ...outcome,
      skipped: "fixes can't be pushed: the head isn't a branch of this repository",
    };
  }
  if ((await checkout.head()) !== pr.headSha || (await checkout.dirty())) {
    throw new Error(`the checkout must be clean at the pull request's head ${pr.headSha}`);
  }

  // Recheck what the author's new commits settle, review them, then deliberate in rounds
  const changes = await newChanges(run, pr);
  if (changes?.last) {
    await recheckDeferred(run, pr, { last: changes.last, diff: changes.diff });
  }
  const reviewed = changes ? await reviewNew(run, pr, changes) : false;
  let rounds = 0;
  for (let round = 1; round <= config.maxRounds; round++) {
    const threads = await run.reviewer.threads(number);
    const waiting = threads.filter((t) => ["fix", "verify"].includes(status(t)));
    if (waiting.length === 0) {
      break;
    }
    run.log(`round ${round}: ${waiting.length} open threads`);
    rounds++;

    // The fixer answers, then the reviewer judges the answers
    const start = await checkout.head();
    const stopped = await fixRound(run, pr, outcome);
    if (stopped) {
      return { ...outcome, stopped };
    }
    await verifyRound(run, pr, start);
  }

  // A run with nothing to do posts nothing, so unrelated events stay quiet
  if (!reviewed && rounds === 0) {
    return { ...outcome, skipped: "nothing new to review, and no open threads" };
  }

  // Threads still open at the round cap go to the author
  for (const thread of await run.reviewer.threads(number)) {
    if (["fix", "verify"].includes(status(thread))) {
      await notice(
        run,
        thread,
        `Still unsettled after ${config.maxRounds} rounds, so this is yours to decide.`,
      );
    }
  }
  await summarise(run, pr, outcome);
  return outcome;
}
