import { posix } from "node:path";
import type { Usage } from "./agent.ts";
import type { Config } from "./config.ts";
import { contextFor, type Convention } from "./context.ts";
import type { Forge, PullRequest } from "./forge.ts";
import { changedFiles, type Checkout } from "./git.ts";
import { fixRound } from "./fix.ts";
import { folderContext, FolderConfigs } from "./folders.ts";
import { Progress } from "./progress.ts";
import { newChanges, recheck, reviewNew } from "./review.ts";
import type { Answer, Review, Verification } from "./schemas.ts";
import { status, type Status } from "./status.ts";
import { summarise } from "./summary.ts";
import { notice } from "./threads.ts";
import { verifyRound } from "./verify.ts";

export { copilotAgents, covering } from "./agents.ts";
export { status, type Status } from "./status.ts";
export { describe } from "./threads.ts";

/** The three judgements a deliberation asks for, whoever makes them. */
export interface Agents {
  review(task: string): Promise<Review>;
  /** May edit files in the checkout, but not run the `deny` commands. */
  fix(task: string, deny?: string[]): Promise<Answer>;
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
  /** Deliberate even without a label (as both roles), or on a draft or closed pull request. */
  force: boolean;
  /**
   * The commit whose folder configs apply, such as the pull request's base, so the pull request
   * can't change the checks it's held to. The head the run starts at by default.
   */
  configSha?: string;
  /** Where to watch this run, linked from its commit status. */
  link?: string;
  /** Stops the run when aborted, as when the job is cancelled or times out. */
  signal?: AbortSignal;
  /**
   * Once cancelled, how long to wait for the work under way to stop before rejecting, so a push
   * that lands meanwhile still gets the run's ending. No wait by default.
   */
  stopGraceMs?: number;
  log: (message: string) => void;
}

/** Which roles a run plays: the reviewer for one label, the fixer for the other. */
export interface Roles {
  review: boolean;
  fix: boolean;
}

/** A deliberation under way, with the roles its labels ask for. */
export interface Run extends Deliberation {
  roles: Roles;
  /**
   * Convention files in the folders the pull request changes, beyond the configured context:
   * found by name, or listed in a folder's config, each with the folder whose code it's for.
   */
  conventions: Convention[];
  /** Folders' own configs, read from `configSha`, or the head the run started at. */
  folders: FolderConfigs;
  /** The run's commit status, on the pull request's latest commit. */
  progress: Progress;
}

export interface Outcome {
  /** Why the run did nothing, or stopped early. */
  skipped?: string;
  stopped?: string;
  resolved: number;
  /** Resolved threads settled by a judgement call the author hasn't looked at yet. */
  decided: number;
  deferred: number;
  /** Answered threads left open for whoever opened them to settle. */
  waiting: number;
  commits: string[];
}

/** Run the deliberation on a pull request until every thread is resolved or deferred. */
export async function deliberate(input: Deliberation): Promise<Outcome> {
  const { number, config } = input;
  const outcome: Outcome = {
    resolved: 0,
    decided: 0,
    deferred: 0,
    waiting: 0,
    commits: [],
  };
  const pr = await input.reviewer.pullRequest(number);

  // Only open pull requests that ask for a role, and not drafts
  if (!input.force && pr.state !== "open") {
    return { ...outcome, skipped: "the pull request is closed" };
  }
  if (!input.force && pr.draft) {
    return { ...outcome, skipped: "the pull request is a draft" };
  }
  const roles = rolesFor(pr, input);
  if (!roles.review && !roles.fix) {
    return {
      ...outcome,
      skipped: `the pull request isn't labelled ${config.reviewLabel} or ${config.fixLabel}`,
    };
  }

  // The fixer needs a branch to push to, and every role a clean checkout at the head
  if (roles.fix && input.push && !pr.headBranch) {
    return {
      ...outcome,
      skipped: "fixes can't be pushed: the head isn't a branch of this repository",
    };
  }

  // Show the run as pending on the head until it ends, however it ends
  const progress = new Progress({
    forge: roles.review ? input.reviewer : input.fixer,
    sha: pr.headSha,
    url: input.link,
    log: input.log,
  });

  // Cancellation can come at any point, so race it against setup as well as the rounds,
  // and stop the abandoned rounds at their next call to the forge, checkout or agents
  const { signal } = input;
  const run = {
    ...input,
    reviewer: until(input.reviewer, signal),
    fixer: until(input.fixer, signal),
    checkout: until(input.checkout, signal),
    agents: until(input.agents, signal),
    roles,
    progress,
  };
  const work = deliberateFrom(run, pr, outcome);
  try {
    const result = await Promise.race([work, aborted(signal)]);
    await progress.done(describeOutcome(result));
    return result;
  } catch (error) {
    const ending = signal?.aborted ? "Stopped" : "Failed";
    await progress.failed(`${ending}: ${(error as Error).message}`);
    if (signal?.aborted) {
      await settled(work, input.stopGraceMs ?? 0);
    }
    throw error;
  }
}

/** Check the checkout and gather conventions, then deliberate in rounds. */
async function deliberateFrom(
  setUp: Omit<Run, "conventions" | "folders">,
  pr: PullRequest,
  outcome: Outcome,
): Promise<Outcome> {
  const { number, config, checkout, roles, progress } = setUp;
  await progress.working(roles.review ? "Reviewing" : "Answering threads");
  if ((await checkout.head()) !== pr.headSha || (await checkout.dirty())) {
    throw new Error(`the checkout must be clean at the pull request's head ${pr.headSha}`);
  }

  // Add convention files found in, or listed by, the folders the pull request changes
  const changed = changedFiles(await setUp.reviewer.diff(number));
  const folders = new FolderConfigs(checkout, setUp.configSha ?? pr.headSha);
  const found = await contextFor({ dir: checkout.dir, context: config.context, changed });
  const conventions = folderContext(
    await folders.for(changed),
    config.context,
    found.map((path) => ({ path, folder: posix.dirname(path) })),
  );
  return deliberateRounds({ ...setUp, conventions, folders }, pr, outcome);
}

/** Rejects with the signal's reason once it's aborted; never settles without a signal. */
function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
    }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Wait for work to finish, however it ends, but no longer than a time limit. */
async function settled(work: Promise<unknown>, limitMs: number): Promise<void> {
  if (limitMs <= 0) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => (timer = setTimeout(resolve, limitMs)));
  await Promise.race([work.then(nothing, nothing), limit]);
  clearTimeout(timer);
}

function nothing(): void {}

/**
 * The same object, but its methods throw the signal's reason once it's aborted, so work
 * abandoned on cancellation makes no further calls. A call already under way finishes.
 */
function until<T extends object>(target: T, signal: AbortSignal | undefined): T {
  if (!signal) {
    return target;
  }
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        signal.throwIfAborted();
        return value.apply(object, args);
      };
    },
  });
}

/** Review, then fix and verify in rounds, then summarise. */
async function deliberateRounds(run: Run, pr: PullRequest, outcome: Outcome): Promise<Outcome> {
  const { number, config, checkout, roles } = run;

  // Recheck what the author's new commits settle, and review them
  const changes = roles.review ? await newChanges(run, pr) : undefined;
  if (changes?.last) {
    await recheck(run, pr, { last: changes.last, diff: changes.diff });
  }
  const reviewed = changes ? await reviewNew(run, pr, changes) : false;

  // Deliberate in rounds while a role has a move to make
  let rounds = 0;
  for (let round = 1; round <= config.maxRounds; round++) {
    const threads = await run.reviewer.threads(number);
    const waiting = threads.filter((t) => hasMove(run, status(t)));
    if (waiting.length === 0) {
      break;
    }
    run.log(`round ${round}: ${waiting.length} open threads`);
    const open = `${waiting.length} open thread${waiting.length === 1 ? "" : "s"}`;
    await run.progress.working(`Round ${round}: ${open}`);
    rounds++;

    // The fixer answers, then the reviewer judges the answers
    const start = await checkout.head();
    if (roles.fix) {
      const stopped = await fixRound(run, pr, outcome);
      if (stopped) {
        return { ...outcome, stopped };
      }
    }
    if (roles.review) {
      await verifyRound(run, pr, start);
    }
  }

  // A run with nothing to do posts nothing, so unrelated events stay quiet
  if (!reviewed && rounds === 0) {
    return { ...outcome, skipped: "nothing new to review, and no open threads" };
  }

  // Threads still open at the round cap go to the author
  for (const thread of await run.reviewer.threads(number)) {
    if (hasMove(run, status(thread))) {
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

/** One line on how a run ended, for its commit status. */
function describeOutcome(outcome: Outcome): string {
  if (outcome.stopped) {
    return `Stopped: ${outcome.stopped}`;
  }
  if (outcome.skipped) {
    return "Nothing new to review, and no open threads";
  }
  const decided = outcome.decided > 0 ? ` (${outcome.decided} decided for you to review)` : "";
  return `Done: ${outcome.resolved} resolved${decided}, ${outcome.deferred} for the author`;
}

/** The roles a pull request's labels ask for; forcing one with neither plays both. */
function rolesFor(pr: PullRequest, { config, force }: Deliberation): Roles {
  const roles = {
    review: pr.labels.includes(config.reviewLabel),
    fix: pr.labels.includes(config.fixLabel),
  };
  if (force && !roles.review && !roles.fix) {
    return { review: true, fix: true };
  }
  return roles;
}

/** Whether a role this run plays has a move to make in a thread. */
function hasMove(run: Run, state: Status): boolean {
  return (run.roles.fix && state === "fix") || (run.roles.review && state === "verify");
}
