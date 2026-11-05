/** The reviewer's judgement of the fixer's answers. */
import type { PullRequest } from "./forge.ts";
import { diffLines } from "./git.ts";
import type { Run } from "./loop.ts";
import { compose, type Marker } from "./markers.ts";
import { clip, common, guidanceFor, modeText, render } from "./prompts.ts";
import { postFindings } from "./review.ts";
import { opener, status } from "./status.ts";
import { decisionText, describe, DIFF_LIMIT, finalNote, tidy } from "./threads.ts";

/** The reviewer judges every answered thread at once, and checks this round's changes. */
export async function verifyRound(run: Run, pr: PullRequest, start: string): Promise<void> {
  const waiting = (await run.reviewer.threads(run.number)).filter((t) => status(t) === "verify");
  if (waiting.length === 0) {
    return;
  }

  // Ask for verdicts, with the round's changes
  const end = await run.checkout.head();
  const changes = start === end ? "" : await run.checkout.diff(start, end);
  const task = render("verify", {
    ...modeText(run.config),
    common: common(pr, run.config, guidanceFor(run, "reviewer")),
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
    // A person who opened a thread resolves it themselves
    if (verdict === "resolved" && opener(thread) !== "person") {
      await run.reviewer.resolve(thread);
    }
  }

  // New findings may only sit on lines this round added; those the pull request's own diff
  // doesn't show, such as a line a fix restored to the base's, become notes for the author
  const { notes, unshown } = await postFindings(run, pr, {
    findings: verification.findings,
    anchors: diffLines(changes, false),
  });
  if (unshown.length > 0) {
    await run.reviewer.comment(
      run.number,
      compose(
        `**Reviewer** · ${run.config.reviewer.model}`,
        ["Outside the diff, for the author:", ...unshown].join("\n\n"),
        { role: "reviewer", kind: "notes" },
      ),
    );
  }
  if (notes.length > unshown.length) {
    run.log(`dropped ${notes.length - unshown.length} findings outside this round's changes`);
  }
}
