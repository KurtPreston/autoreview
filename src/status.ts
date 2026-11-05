import type { Comment, Thread } from "./forge.ts";
import { readMarker } from "./markers.ts";
import type { Decision } from "./schemas.ts";

/**
 * Where a thread stands, read from who spoke last:
 *
 * - `fix`: the fixer's turn, after our reviewer, a person or another bot.
 * - `verify`: the reviewer's turn, after the fixer answered.
 * - `deferred`: left to the author since anyone else last spoke.
 * - `waiting`: our reviewer accepted an answer in a thread a person opened, for them to resolve.
 */
export type Status = "resolved" | "deferred" | "fix" | "verify" | "waiting";

/** Classify a thread by its markers. */
export function status(thread: Thread): Status {
  if (thread.resolved) {
    return "resolved";
  }

  // Anyone else speaking last asks the fixer for an answer, even after a deferral
  const markers = thread.comments.map((comment) => readMarker(comment.body));
  const last = markers.at(-1);
  if (!last) {
    return "fix";
  }

  // Since the last outside comment, a deferral is final
  const since = markers.slice(markers.findLastIndex((marker) => marker === undefined) + 1);
  if (since.some((marker) => marker?.deferred)) {
    return "deferred";
  }
  if (last.role === "reviewer" && last.kind === "verdict" && last.value === "resolved") {
    return "waiting";
  }
  return last.role === "reviewer" ? "fix" : "verify";
}

/** Who opened a thread: our reviewer, another bot, or a person. */
export function opener(thread: Thread): "ours" | "bot" | "person" {
  const [first] = thread.comments;
  if (readMarker(first.body)?.role === "reviewer") {
    return "ours";
  }
  return first.bot ? "bot" : "person";
}

/** The latest comment from a person, not a bot nor autoreview, if any. */
export function latestPerson(thread: Thread): Comment | undefined {
  return thread.comments.findLast((comment) => !comment.bot && !readMarker(comment.body));
}

/**
 * The judgement call that settled a resolved thread, unless a person has replied since,
 * which marks it reviewed.
 */
export function openDecision(thread: Thread): Decision | undefined {
  const markers = thread.comments.map((comment) => readMarker(comment.body));
  const index = markers.findLastIndex((marker) => marker?.decision);
  if (index === -1 || markers.slice(index + 1).some((marker) => marker === undefined)) {
    return undefined;
  }
  return markers[index]?.decision;
}
