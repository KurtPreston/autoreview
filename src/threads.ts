/** Helpers for reading and posting in threads, shared by the deliberation's steps. */
import type { Run } from "./loop.ts";
import type { Forge, Thread } from "./forge.ts";
import { compose, plainText, readMarker, type Marker, type Role } from "./markers.ts";
import { opener, status } from "./status.ts";
import type { Decision } from "./schemas.ts";

/** How much diff an agent's task carries before it is cut. */
export const DIFF_LIMIT = 150_000;

/** How many answers the fixer has given since anyone else last spoke in a thread. */
export function exchanges(thread: Thread): number {
  const markers = thread.comments.map((c) => readMarker(c.body));
  const since = markers.slice(markers.findLastIndex((marker) => marker === undefined) + 1);
  return since.filter((marker) => marker?.kind === "answer").length;
}

/** Whether the reviewer's latest comment is a ruling the fixer hasn't carried out yet. */
export function ruled(thread: Thread): boolean {
  const last = readMarker(thread.comments.at(-1)?.body ?? "");
  return last?.role === "reviewer" && last.value === "ruling";
}

/** In best-effort mode, tells the reviewer a thread can't go back for more discussion. */
export function finalNote(run: Run, thread: Thread): string {
  if (run.config.defer !== "best-effort" || exchanges(thread) < run.config.maxExchanges) {
    return "";
  }
  return "**Final:** this thread has used up its exchanges. If you still disagree, decide it.\n\n";
}

/** How a decision reads in a thread. */
export function decisionText(decision: Decision): string {
  return `**Decision, for the author to review:** ${decision.chose}\n\n**Alternative:** ${decision.alternative}`;
}

/** Who speaks for autoreview itself: the reviewer when it's on, otherwise the fixer. */
export function voice(run: Run): { forge: Forge; role: Role } {
  return run.roles.review
    ? { forge: run.reviewer, role: "reviewer" }
    : { forge: run.fixer, role: "fixer" };
}

/** Whether a thread waits on the author: deferred, or, with no fixer, any open finding of ours. */
export function forAuthor(run: Run, thread: Thread): boolean {
  const state = status(thread);
  return state === "deferred" || (!run.roles.fix && state === "fix" && opener(thread) === "ours");
}

/**
 * Whether, with no fixer of ours, someone else resolved a thread our reviewer opened before
 * the reviewer agreed, as an outside fixer does. A deferral stays the author's call.
 */
export function closedEarly(run: Run, thread: Thread): boolean {
  if (run.roles.fix || !thread.resolved || opener(thread) !== "ours") {
    return false;
  }
  const markers = thread.comments.map((comment) => readMarker(comment.body));
  if (markers.some((marker) => marker?.deferred)) {
    return false;
  }
  const verdict = markers.findLast((marker) => marker?.role === "reviewer");
  return !(verdict?.kind === "verdict" && verdict.value === "resolved");
}

/** Whether autoreview has a part in a thread: it opened it, or one of its roles spoke there. */
export function involved(thread: Thread): boolean {
  return thread.comments.some((comment) => readMarker(comment.body) !== undefined);
}

/** A deferral the loop makes itself, posted in autoreview's own voice. */
export async function notice(run: Run, thread: Thread, text: string): Promise<void> {
  const { forge, role } = voice(run);
  const marker: Marker = { role, kind: "verdict", value: "defer", deferred: true };
  await forge.reply(run.number, thread, compose("**Autoreview** · for the author", text, marker));
}

/** A thread's history as agents read it: who said what, in order. */
export function describe(thread: Thread): string {
  return thread.comments
    .map((comment) => {
      const marker = readMarker(comment.body);
      const who = marker
        ? `${marker.role === "reviewer" ? "Reviewer" : "Fixer"} (${marker.kind}${marker.value ? `, ${marker.value}` : ""})`
        : `${comment.author} (${comment.bot ? "a bot" : "a person"})`;
      return `**${who}:**\n\n${plainText(comment.body)}`;
    })
    .join("\n\n");
}

/** Throw away anything a read-only agent changed. */
export async function tidy(run: Run): Promise<void> {
  if (await run.checkout.dirty()) {
    run.log("discarding changes a reviewer made");
    await run.checkout.discard();
  }
}
