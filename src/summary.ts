import type { PullRequest } from "./forge.ts";
import type { Outcome, Run } from "./loop.ts";
import { compose, plainText, type Marker } from "./markers.ts";
import { openDecision, status } from "./status.ts";
import { forAuthor, involved, voice } from "./threads.ts";

/** Count where every thread ended, post the summary, and label what's left to the author. */
export async function summarise(run: Run, pr: PullRequest, outcome: Outcome): Promise<void> {
  const deferred: string[] = [];
  const decided: string[] = [];
  const waiting: string[] = [];
  for (const thread of await run.reviewer.threads(run.number)) {
    // Threads autoreview never took part in aren't its to report
    if (!involved(thread)) {
      continue;
    }
    const where = `\`${thread.path}:${thread.line}\``;
    const first = plainText(thread.comments[0].body).split("\n")[0];
    const state = status(thread);
    if (state === "resolved") {
      outcome.resolved++;
      const decision = openDecision(thread);
      if (decision) {
        outcome.decided++;
        decided.push(`- ${where}: ${decision.chose} Alternative: ${decision.alternative}`);
      }
    } else if (forAuthor(run, thread)) {
      outcome.deferred++;
      deferred.push(`- ${where}: ${first}`);
    } else if (state === "waiting" || (state === "verify" && !run.roles.review)) {
      // Answered, and left for whoever opened it to settle
      outcome.waiting++;
      waiting.push(`- ${where}: ${first}`);
    }
  }

  // The summary's text: counts, what's left, what was decided, commits, and the cost
  const ofThem = outcome.decided > 0 ? ` (${outcome.decided} decided for you to review)` : "";
  const sections = [`${outcome.resolved} resolved${ofThem}, ${outcome.deferred} for the author.`];
  if (deferred.length > 0) {
    sections.push(`For you to decide:\n\n${deferred.join("\n")}`);
  }
  if (decided.length > 0) {
    sections.push(`Decided for you, to review:\n\n${decided.join("\n")}`);
  }
  if (waiting.length > 0) {
    sections.push(`Answered, and left open for the commenter:\n\n${waiting.join("\n")}`);
  }
  if (outcome.commits.length > 0) {
    sections.push(`Commits this run: ${outcome.commits.map((sha) => sha.slice(0, 7)).join(", ")}`);
  }
  const calls = Object.entries(run.usage).map(([model, count]) => `${model} × ${count}`);
  sections.push(`Agent calls: ${calls.join(", ") || "none"}`);

  // Record the head reviewed, so the next run looks only at newer commits
  const head = await run.checkout.head();
  const { forge, role } = voice(run);
  const marker: Marker = { role, kind: "summary", head: run.push ? head : pr.headSha };
  await forge.comment(
    run.number,
    compose("**Autoreview** · summary", sections.join("\n\n"), marker),
  );

  // Label the pull request while anything waits on the author, or is left for them to review
  await label(run, pr, { name: run.config.deferLabel, on: outcome.deferred > 0 });
  await label(run, pr, { name: run.config.decisionLabel, on: outcome.decided > 0 });
}

/** Add or remove a label so it matches what the threads say. */
async function label(
  run: Run,
  pr: PullRequest,
  { name, on }: { name: string; on: boolean },
): Promise<void> {
  const { forge } = voice(run);
  if (on && !pr.labels.includes(name)) {
    await forge.addLabel(run.number, name);
  } else if (!on && pr.labels.includes(name)) {
    await forge.removeLabel(run.number, name);
  }
}
