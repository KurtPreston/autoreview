/** The fixer's round: answering threads, checking and committing fixes. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, type FolderConfig } from "./config.ts";
import type { PullRequest, Thread } from "./forge.ts";
import type { Outcome, Run } from "./loop.ts";
import { compose, type Marker } from "./markers.ts";
import { common, modeText, render } from "./prompts.ts";
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
  let deny: string[] | undefined;
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

    // Ask for an answer, holding any fix to the checks for the thread's folders
    deny ??= await heavyDeny(run);
    const sets = await checkSets(run, [thread.path]);
    const task = render("fix", {
      ...modeText(run.config),
      common: common(pr, run.config, run.conventions),
      path: thread.path,
      line: thread.line,
      checks: checksList(runnable(run, sets)),
      thread: describe(thread),
      excerpt: await run.checkout.excerpt(thread.path, thread.line),
    });
    let answer = await run.agents.fix(task, deny);
    if (answer.action === "fix") {
      answer = await checked(run, { task, answer, deny });
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

/**
 * Run the checks on a fix; a failing fix gets one more try, then is dropped and deferred. The
 * retry may not run the `deny` commands either.
 */
export async function checked(
  run: Run,
  { task, answer, deny }: { task: string; answer: Answer; deny: string[] },
): Promise<Answer> {
  let failure = await failingCheck(run);
  if (!failure) {
    return answer;
  }

  // Retry with the failure in hand
  run.log("a fix failed the checks; retrying");
  const retry = await run.agents.fix(
    `${task}\n\n## Your fix failed the checks\n\nYour changes are still in place. Fix what the checks report, or answer \`defer\`.\n\n\`\`\`\n${failure}\n\`\`\``,
    deny,
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

/** A command to run in a folder: `.` for the root's checks. */
export interface Check {
  folder: string;
  command: string;
}

/**
 * One config's checks, from the root (`.`) or a folder's file; `source` is the folder whose file
 * it is in the starting commit.
 */
export type CheckSet = Pick<FolderConfig, "folder" | "checks" | "heavyChecks"> & {
  source?: string;
};

/** The checks some paths answer to: the root's, then each folder file's, shallowest first. */
export async function checkSets(run: Run, paths: string[]): Promise<CheckSet[]> {
  const { checks, heavyChecks } = run.config;
  return [{ folder: ".", checks, heavyChecks }, ...(await run.folders.for(paths))];
}

/**
 * The heavy checks the fixer may not run when the runner can't afford them: the root's and
 * every folder's, since a fix may reach any package, not just the thread's.
 */
export async function heavyDeny(run: Run): Promise<string[]> {
  if (run.heavy) {
    return [];
  }
  const sets = [run.config, ...(await run.folders.all())];
  return [...new Set(sets.flatMap((set) => set.heavyChecks))];
}

/** The checks to run from some sets, with heavy ones only when the runner can afford them. */
export function runnable(run: Run, sets: CheckSet[]): Check[] {
  return sets.flatMap(({ folder, checks, heavyChecks }) =>
    [...checks, ...(run.heavy ? heavyChecks : [])].map((command) => ({
      folder,
      command,
    })),
  );
}

/**
 * The first check that fails, with its output, or undefined when all pass. Only the root's
 * checks and those of the folders the fix changed run, each in its own folder. A folder the
 * fix moved is checked where it went; one whose new place can't be found fails.
 */
export async function failingCheck(run: Run): Promise<string | undefined> {
  const changed = await run.checkout.changed();
  if (changed.length === 0) {
    return undefined;
  }
  const sets = await checkSets(run, changed);
  for (const set of sets) {
    const checks = runnable(run, [set]);
    const { folder, source } = set;
    if (checks.length > 0 && !existsSync(join(run.checkout.dir, folder))) {
      // A folder that took its file whole is a set of its own, checked there
      const moved = sets.some(
        (other) =>
          other !== set &&
          other.source === source &&
          existsSync(join(run.checkout.dir, other.folder)),
      );
      if (moved) {
        continue;
      }
      const commands = checks.map((check) => check.command).join(", ");
      return `${folder} is gone, and no folder took its ${CONFIG_FILE} unchanged, so its checks (${commands}) couldn't run. Keep the folder, or move it whole with its ${CONFIG_FILE} unchanged.`;
    }
    for (const { command } of checks) {
      const result = await run.checkout.check(command, { cwd: folder, signal: run.signal });
      if (!result.ok) {
        const where = folder === "." ? "" : `(in ${folder}) `;
        return `$ ${where}${command}\n${result.output}`;
      }
    }
  }
  return undefined;
}

/** Checks as the fixer's prompt lists them, each with its folder unless it runs at the root. */
export function checksList(list: Check[]): string {
  if (list.length === 0) {
    return "(none configured)";
  }
  return list
    .map(({ folder, command }) =>
      folder === "." ? `\`${command}\`` : `\`${command}\` (in \`${folder}\`)`,
    )
    .join(", ");
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
  const marker: Marker = {
    role: "fixer",
    kind: "answer",
    value: answer.action,
  };
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
