import { implementerPermissions, reviewerPermissions, runAgent, type Usage } from "./agent.ts";
import type { Config } from "./config.ts";
import type { Forge, NewComment, PullRequest, Thread } from "./forge.ts";
import { changedFiles, diffLines, type Checkout } from "./git.ts";
import { compose, plainText, readMarker, type Marker } from "./markers.ts";
import { clip, common, modeText, render } from "./prompts.ts";
import { status } from "./status.ts";
import { summarise } from "./summary.ts";
import { dispatchAfterPush } from "./trigger.ts";
import {
  SchemaError,
  validateAnswer,
  validateReview,
  validateVerification,
  type Answer,
  type Decision,
  type Finding,
  type Review,
  type Verification,
} from "./schemas.ts";

export { status, type Status } from "./status.ts";

/** The three judgements a deliberation asks for, whoever makes them. */
export interface Agents {
  review(task: string): Promise<Review>;
  /** May edit files in the checkout. */
  implement(task: string): Promise<Answer>;
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
  implementer: Forge;
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

const MAX_FINDINGS = 10;
const DIFF_LIMIT = 150_000;

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
    const waiting = threads.filter((t) => ["implement", "verify"].includes(status(t)));
    if (waiting.length === 0) {
      break;
    }
    run.log(`round ${round}: ${waiting.length} open threads`);
    rounds++;

    // The implementer answers, then the reviewer judges the answers
    const start = await checkout.head();
    const stopped = await implementRound(run, pr, outcome);
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
    if (["implement", "verify"].includes(status(thread))) {
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

/** How many answers the implementer has given in a thread. */
function exchanges(thread: Thread): number {
  return thread.comments.filter((c) => readMarker(c.body)?.kind === "answer").length;
}

/** Whether the reviewer's latest comment is a ruling the implementer hasn't carried out yet. */
function ruled(thread: Thread): boolean {
  const last = readMarker(thread.comments.at(-1)?.body ?? "");
  return last?.role === "reviewer" && last.value === "ruling";
}

/** In best-effort mode, tells the reviewer a thread can't go back for more discussion. */
function finalNote(run: Deliberation, thread: Thread): string {
  if (run.config.defer !== "best-effort" || exchanges(thread) < run.config.maxExchanges) {
    return "";
  }
  return "**Final:** this thread has used up its exchanges. If you still disagree, decide it.\n\n";
}

/** How a decision reads in a thread. */
function decisionText(decision: Decision): string {
  return `**Decision, for the author to review:** ${decision.chose}\n\n**Alternative:** ${decision.alternative}`;
}

/** Changes since the last run, or the whole pull request on the first; undefined when none. */
async function newChanges(
  run: Deliberation,
  pr: PullRequest,
): Promise<{ last?: string; diff: string } | undefined> {
  const markers = (await run.reviewer.comments(run.number)).map((c) => readMarker(c.body));
  const last = markers.filter((m) => m?.kind === "review" || m?.kind === "summary").at(-1)?.head;
  if (last === pr.headSha) {
    run.log("no new commits to review");
    return undefined;
  }

  // Since the last run, only the new commits, in files the pull request changes (so a merge
  // from the base isn't reviewed as its own); everything if history was rewritten
  const whole = await run.reviewer.diff(run.number);
  let diff: string | undefined;
  if (last) {
    const files = changedFiles(whole);
    diff =
      files.length === 0
        ? ""
        : await run.checkout.diff(last, pr.headSha, files).catch(() => undefined);
  }
  diff ??= whole;
  return diff.trim() === "" ? undefined : { last, diff };
}

/**
 * Ask the reviewer whether the author's new commits settle any deferred thread, and resolve
 * those. Agents never reopen a deferral; only the author's changes can settle one.
 */
async function recheckDeferred(
  run: Deliberation,
  pr: PullRequest,
  { last, diff }: { last: string; diff: string },
): Promise<void> {
  const deferred = (await run.reviewer.threads(run.number)).filter((t) => status(t) === "deferred");
  if (deferred.length === 0) {
    return;
  }
  run.log(`rechecking ${deferred.length} deferred threads`);

  // Ask for a verdict on each, with the new commits
  const task = render("recheck", {
    common: common(pr, run.config),
    threads: deferred.map((thread) => `### ${thread.key}\n\n${describe(thread)}`).join("\n\n"),
    baseSha: last,
    changes: clip(diff, DIFF_LIMIT, `run git diff ${last}..HEAD for the rest`),
  });
  const verification = await run.agents.verify(
    task,
    deferred.map((t) => t.key),
  );
  await tidy(run);

  // Resolve what's settled; anything else stays with the author, unremarked
  for (const { key, verdict, body } of verification.threads) {
    const thread = deferred.find((t) => t.key === key);
    if (!thread || verdict !== "resolved") {
      continue;
    }
    const marker: Marker = { role: "reviewer", kind: "verdict", value: "resolved" };
    await run.reviewer.reply(
      run.number,
      thread,
      compose(`**Reviewer** · ${run.config.reviewer.model} · resolved`, body, marker),
    );
    await run.reviewer.resolve(thread);
  }
}

/** Review the changes since the last run, or the whole pull request on the first. */
async function reviewNew(
  run: Deliberation,
  pr: PullRequest,
  { last, diff }: { last?: string; diff: string },
): Promise<boolean> {
  run.log(last ? `reviewing commits since ${last.slice(0, 7)}` : "reviewing the pull request");

  // Ask the reviewer, then discard anything it changed by mistake
  const task = render("review", {
    ...modeText(run.config),
    common: common(pr, run.config),
    baseSha: last ?? pr.baseSha,
    maxFindings: MAX_FINDINGS,
    diff: clip(diff, DIFF_LIMIT, `run git diff ${last ?? pr.baseSha}...HEAD for the rest`),
  });
  const review = await run.agents.review(task);
  await tidy(run);

  // Post findings as threads, then the summary that records what was reviewed
  const notes = await postFindings(run, pr, {
    findings: review.findings.slice(0, MAX_FINDINGS),
    anchors: diffLines(diff),
  });
  const text = [
    review.summary,
    ...(notes.length ? ["Outside the diff, for the author:", ...notes] : []),
  ].join("\n\n");
  await run.reviewer.comment(
    run.number,
    compose(`**Reviewer** · ${run.config.reviewer.model}`, text, {
      role: "reviewer",
      kind: "review",
      head: pr.headSha,
    }),
  );
  return true;
}

/**
 * Post findings that sit on lines the diff shows as one review. Returns notes for
 * the rest, which can't be anchored, or would land in an existing conversation.
 */
async function postFindings(
  run: Deliberation,
  pr: PullRequest,
  { findings, anchors }: { findings: Finding[]; anchors: Map<string, Set<number>> },
): Promise<string[]> {
  const taken = new Set((await run.reviewer.threads(run.number)).map((t) => t.key));
  const comments: NewComment[] = [];
  const notes: string[] = [];
  for (const finding of findings) {
    // Anchor on a shown line that has no conversation yet
    const key = `${finding.path}:+${finding.line}`;
    if (!anchors.get(finding.path)?.has(finding.line) || taken.has(key)) {
      notes.push(`- \`${finding.path}:${finding.line}\` (${finding.severity}): ${finding.body}`);
      continue;
    }
    taken.add(key);

    // In blocking mode, findings for the author are deferred from the start
    const forAuthor = finding.forAuthor && run.config.defer === "blocking";
    const marker: Marker = { role: "reviewer", kind: "finding", value: finding.severity };
    if (forAuthor) {
      marker.deferred = true;
    }
    const label = forAuthor ? `${finding.severity} · for the author` : finding.severity;
    const header = `**Reviewer** · ${run.config.reviewer.model} · ${label}`;
    comments.push({
      path: finding.path,
      line: finding.line,
      body: compose(header, finding.body, marker),
    });
  }
  if (comments.length > 0) {
    await run.reviewer.review(run.number, {
      body: "🤖 Review comments",
      commit: pr.headSha,
      comments,
    });
  }
  return notes;
}

/** The implementer answers each waiting thread; fixes are checked, committed and pushed together. */
async function implementRound(
  run: Deliberation,
  pr: PullRequest,
  outcome: Outcome,
): Promise<string | undefined> {
  const threads = await run.reviewer.threads(run.number);
  const replies: { thread: Thread; answer: Answer; commit?: string }[] = [];
  for (const thread of threads.filter((t) => status(t) === "implement")) {
    // A thread that keeps going back and forth goes to the author, unless the reviewer ruled
    if (exchanges(thread) >= run.config.maxExchanges && !ruled(thread)) {
      await notice(
        run,
        thread,
        "The agents still disagree after several exchanges, so this is yours to decide.",
      );
      continue;
    }

    // Ask for an answer, holding any fix to the checks
    const task = render("implement", {
      ...modeText(run.config),
      common: common(pr, run.config),
      path: thread.path,
      line: thread.line,
      checks: checksList(run),
      thread: describe(thread),
      excerpt: await run.checkout.excerpt(thread.path, thread.line),
    });
    let answer = await run.agents.implement(task);
    if (answer.action === "fix") {
      answer = await checked(run, task, answer);
    } else {
      await run.checkout.discard();
    }

    // Commit a fix; one that changed nothing is a reply
    let commit: string | undefined;
    if (answer.action === "fix") {
      commit = await run.checkout.commitAll(`${pr.headRef}: ${answer.commit}`);
      if (commit) {
        outcome.commits.push(commit);
      } else {
        answer = { action: "reply", body: answer.body };
      }
    }
    replies.push({ thread, answer, commit });
  }

  // Push before replying, so the commits the replies cite exist
  if (run.push && replies.some((r) => r.commit)) {
    if (!(await run.checkout.push(pr.headBranch ?? pr.headRef))) {
      return `${pr.headRef} moved during the run; a newer run will continue`;
    }

    // Pushes with a workflow's own token start no checks, so start the configured ones now,
    // before anything later in the run can fail and leave the fixes unchecked
    await dispatchAfterPush({
      forge: run.implementer,
      workflows: run.config.dispatch,
      branch: pr.headBranch,
      log: run.log,
    });
  }
  for (const reply of replies) {
    await answerThread(run, reply);
  }
  return undefined;
}

/** Run the checks on a fix; a failing fix gets one more try, then is dropped and deferred. */
async function checked(run: Deliberation, task: string, answer: Answer): Promise<Answer> {
  let failure = await failingCheck(run);
  if (!failure) {
    return answer;
  }

  // Retry with the failure in hand
  run.log("a fix failed the checks; retrying");
  const retry = await run.agents.implement(
    `${task}\n\n## Your fix failed the checks\n\nYour changes are still in place. Fix what the checks report, or answer \`defer\`.\n\n\`\`\`\n${failure}\n\`\`\``,
  );
  if (retry.action === "fix") {
    failure = await failingCheck(run);
    if (!failure) {
      return retry;
    }
  }

  // Give up on the fix, keeping the evidence for the author
  await run.checkout.discard();
  if (retry.action !== "fix") {
    return retry;
  }
  return {
    action: "defer",
    body: `I couldn't make a fix that passes the checks, so I've left the code as it was.\n\n\`\`\`\n${failure}\n\`\`\``,
  };
}

/** The first check that fails, with its output, or undefined when all pass. */
async function failingCheck(run: Deliberation): Promise<string | undefined> {
  if (!(await run.checkout.dirty())) {
    return undefined;
  }
  for (const command of checks(run)) {
    const result = await run.checkout.check(command);
    if (!result.ok) {
      return `$ ${command}\n${result.output}`;
    }
  }
  return undefined;
}

function checks(run: Deliberation): string[] {
  return [...run.config.checks, ...(run.heavy ? run.config.heavyChecks : [])];
}

function checksList(run: Deliberation): string {
  const list = checks(run);
  return list.length > 0 ? list.map((command) => `\`${command}\``).join(", ") : "(none configured)";
}

/** Post the implementer's answer in its thread. */
async function answerThread(
  run: Deliberation,
  { thread, answer, commit }: { thread: Thread; answer: Answer; commit?: string },
): Promise<void> {
  const label = { fix: `fixed in ${commit?.slice(0, 7)}`, reply: "reply", defer: "for the author" }[
    answer.action
  ];
  const marker: Marker = { role: "implementer", kind: "answer", value: answer.action };
  if (answer.action === "defer") {
    marker.deferred = true;
  }
  let text = answer.body;
  if (answer.decision) {
    marker.decision = answer.decision;
    text = `${text}\n\n${decisionText(answer.decision)}`;
  }
  const header = `**Implementer** · ${run.config.implementer.model} · ${label}${answer.decision ? " · decision" : ""}`;
  await run.implementer.reply(run.number, thread, compose(header, text, marker));
}

/** The reviewer judges every answered thread at once, and checks this round's changes. */
async function verifyRound(run: Deliberation, pr: PullRequest, start: string): Promise<void> {
  const waiting = (await run.reviewer.threads(run.number)).filter((t) => status(t) === "verify");
  if (waiting.length === 0) {
    return;
  }

  // Ask for verdicts, with the round's changes
  const end = await run.checkout.head();
  const changes = start === end ? "" : await run.checkout.diff(start, end);
  const task = render("verify", {
    ...modeText(run.config),
    common: common(pr, run.config),
    threads: waiting
      .map((thread) => `### ${thread.key}\n\n${finalNote(run, thread)}${describe(thread)}`)
      .join("\n\n"),
    changes:
      clip(changes, DIFF_LIMIT, `run git diff ${start}..HEAD for the rest`) || "(no changes)",
  });
  const verification = await run.agents.verify(
    task,
    waiting.map((t) => t.key),
  );
  await tidy(run);

  // Post each verdict, resolving what's settled; a follow-up with a decision is a ruling
  for (const { key, verdict, body, decision } of verification.threads) {
    const thread = waiting.find((t) => t.key === key);
    if (!thread) {
      continue;
    }
    const value = verdict === "follow-up" && decision ? "ruling" : verdict;
    const marker: Marker = { role: "reviewer", kind: "verdict", value };
    if (verdict === "defer") {
      marker.deferred = true;
    }
    let text = body;
    if (decision) {
      marker.decision = decision;
      text = `${text}\n\n${decisionText(decision)}`;
    }
    const label = value === "defer" ? "for the author" : value;
    const header = `**Reviewer** · ${run.config.reviewer.model} · ${label}${decision && value === "resolved" ? " · decision" : ""}`;
    await run.reviewer.reply(run.number, thread, compose(header, text, marker));
    if (verdict === "resolved") {
      await run.reviewer.resolve(thread);
    }
  }

  // New findings may only sit on lines this round added
  const notes = await postFindings(run, pr, {
    findings: verification.findings,
    anchors: diffLines(changes, false),
  });
  if (notes.length > 0) {
    run.log(`dropped ${notes.length} findings outside this round's changes`);
  }
}

/** A deferral the loop makes itself, posted as the reviewer. */
async function notice(run: Deliberation, thread: Thread, text: string): Promise<void> {
  const marker: Marker = { role: "reviewer", kind: "verdict", value: "defer", deferred: true };
  await run.reviewer.reply(
    run.number,
    thread,
    compose("**Autoreview** · for the author", text, marker),
  );
}

/** A thread's history as agents read it: who said what, in order. */
export function describe(thread: Thread): string {
  return thread.comments
    .map((comment) => {
      const marker = readMarker(comment.body);
      const who = marker
        ? `${marker.role === "reviewer" ? "Reviewer" : "Implementer"} (${marker.kind}${marker.value ? `, ${marker.value}` : ""})`
        : `${comment.author} (a person)`;
      return `**${who}:**\n\n${plainText(comment.body)}`;
    })
    .join("\n\n");
}

/** Throw away anything a read-only agent changed. */
async function tidy(run: Deliberation): Promise<void> {
  if (await run.checkout.dirty()) {
    run.log("discarding changes a reviewer made");
    await run.checkout.discard();
  }
}

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
    implement: (task) =>
      runAgent(
        {
          ...base,
          name: "implementer",
          role: config.implementer,
          task,
          validate: validateAnswer,
          permissions: implementerPermissions(config, heavy),
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
