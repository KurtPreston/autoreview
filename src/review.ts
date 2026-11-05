/** The reviewer's passes: rechecking deferrals against new commits, and reviewing them. */
import type { NewComment, PullRequest } from "./forge.ts";
import { changedFiles, diffLines } from "./git.ts";
import type { Deliberation } from "./loop.ts";
import { compose, readMarker, type Marker } from "./markers.ts";
import { clip, common, modeText, render } from "./prompts.ts";
import type { Finding } from "./schemas.ts";
import { status } from "./status.ts";
import { describe, DIFF_LIMIT, tidy } from "./threads.ts";

const MAX_FINDINGS = 10;

/** Changes since the last run, or the whole pull request on the first; undefined when none. */
export async function newChanges(
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
export async function recheckDeferred(
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
export async function reviewNew(
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
export async function postFindings(
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
