/** The fixer's round: answering threads, checking and committing fixes. */
import type { PullRequest, Thread } from "./forge.ts";
import type { Outcome, Run } from "./loop.ts";
import { compose, type Marker } from "./markers.ts";
import { common, guidanceFor, modeText, render } from "./prompts.ts";
import type { Answer } from "./schemas.ts";
import { latestPerson, status } from "./status.ts";
import { decisionText, describe, exchanges, notice, ruled } from "./threads.ts";

/** The fixer answers each waiting thread; fixes are checked, committed and pushed together. */
export async function fixRound(
  run: Run,
  pr: PullRequest,
  outcome: Outcome,
): Promise<string | undefined> {
  const threads = await run.reviewer.threads(run.number);
  const replies: { thread: Thread; answer: Answer; commit?: string }[] = [];
  for (const thread of threads.filter((t) => status(t) === "fix")) {
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
    const task = render("fix", {
      ...modeText(run.config),
      common: common(pr, run.config, guidanceFor(run, "fixer")),
      path: thread.path,
      line: thread.line,
      checks: checksList(run),
      thread: describe(thread),
      excerpt: await run.checkout.excerpt(thread.path, thread.line),
    });
    let answer = await run.agents.fix(task);
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
    const head = await run.checkout.head();
    if (!(await run.checkout.push(pr.headBranch ?? pr.headRef))) {
      return `${pr.headRef} moved during the run; a newer run will continue`;
    }
    await run.progress.working("Pushed fixes; verifying them", head);
  }
  for (const reply of replies) {
    await answerThread(run, reply);
  }
  return undefined;
}

/** Run the checks on a fix; a failing fix gets one more try, then is dropped and deferred. */
export async function checked(run: Run, task: string, answer: Answer): Promise<Answer> {
  let failure = await failingCheck(run);
  if (!failure) {
    return answer;
  }

  // Retry with the failure in hand
  run.log("a fix failed the checks; retrying");
  const retry = await run.agents.fix(
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
export async function failingCheck(run: Run): Promise<string | undefined> {
  if (!(await run.checkout.dirty())) {
    return undefined;
  }
  for (const command of checks(run)) {
    const result = await run.checkout.check(command, run.signal);
    if (!result.ok) {
      return `$ ${command}\n${result.output}`;
    }
  }
  return undefined;
}

export function checks(run: Run): string[] {
  return [...run.config.checks, ...(run.heavy ? run.config.heavyChecks : [])];
}

export function checksList(run: Run): string {
  const list = checks(run);
  return list.length > 0 ? list.map((command) => `\`${command}\``).join(", ") : "(none configured)";
}

/** Post the fixer's answer in its thread. */
export async function answerThread(
  run: Run,
  { thread, answer, commit }: { thread: Thread; answer: Answer; commit?: string },
): Promise<void> {
  // A deferral goes to the person who last spoke in the thread, if any, by name
  const person = answer.action === "defer" ? latestPerson(thread) : undefined;
  const label = {
    fix: `fixed in ${commit?.slice(0, 7)}`,
    reply: "reply",
    defer: person ? `for @${person.author}` : "for the author",
  }[answer.action];
  const marker: Marker = { role: "fixer", kind: "answer", value: answer.action };
  if (answer.action === "defer") {
    marker.deferred = true;
  }
  let text = person ? `@${person.author} ${answer.body}` : answer.body;
  if (answer.decision) {
    marker.decision = answer.decision;
    text = `${text}\n\n${decisionText(answer.decision)}`;
  }
  const header = `**Fixer** · ${run.config.fixer.model} · ${label}${answer.decision ? " · decision" : ""}`;
  await run.fixer.reply(run.number, thread, compose(header, text, marker));
}
