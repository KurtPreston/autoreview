/** Helpers for reading and posting in threads, shared by the deliberation's steps. */
import type { Deliberation } from "./loop.ts";
import type { Thread } from "./forge.ts";
import { compose, plainText, readMarker, type Marker } from "./markers.ts";
import type { Decision } from "./schemas.ts";

/** How much diff an agent's task carries before it is cut. */
export const DIFF_LIMIT = 150_000;

/** How many answers the implementer has given in a thread. */
export function exchanges(thread: Thread): number {
  return thread.comments.filter((c) => readMarker(c.body)?.kind === "answer").length;
}

/** Whether the reviewer's latest comment is a ruling the implementer hasn't carried out yet. */
export function ruled(thread: Thread): boolean {
  const last = readMarker(thread.comments.at(-1)?.body ?? "");
  return last?.role === "reviewer" && last.value === "ruling";
}

/** In best-effort mode, tells the reviewer a thread can't go back for more discussion. */
export function finalNote(run: Deliberation, thread: Thread): string {
  if (run.config.defer !== "best-effort" || exchanges(thread) < run.config.maxExchanges) {
    return "";
  }
  return "**Final:** this thread has used up its exchanges. If you still disagree, decide it.\n\n";
}

/** How a decision reads in a thread. */
export function decisionText(decision: Decision): string {
  return `**Decision, for the author to review:** ${decision.chose}\n\n**Alternative:** ${decision.alternative}`;
}

/** A deferral the loop makes itself, posted as the reviewer. */
export async function notice(run: Deliberation, thread: Thread, text: string): Promise<void> {
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
export async function tidy(run: Deliberation): Promise<void> {
  if (await run.checkout.dirty()) {
    run.log("discarding changes a reviewer made");
    await run.checkout.discard();
  }
}
