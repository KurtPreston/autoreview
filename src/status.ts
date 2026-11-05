import type { Thread } from "./forge.ts";
import { readMarker } from "./markers.ts";
import type { Decision } from "./schemas.ts";

/** Where a thread stands, read from its comments' markers. */
export type Status = "foreign" | "resolved" | "human" | "deferred" | "fix" | "verify";

/** Classify a thread by its markers. Threads autoreview didn't open are foreign. */
export function status(thread: Thread): Status {
  const markers = thread.comments.map((comment) => readMarker(comment.body));
  if (markers[0]?.role !== "reviewer") {
    return "foreign";
  }
  if (thread.resolved) {
    return "resolved";
  }

  // A person joining takes it over; a deferral is final
  if (markers.some((marker) => marker === undefined)) {
    return "human";
  }
  if (markers.some((marker) => marker?.deferred)) {
    return "deferred";
  }
  return markers.at(-1)?.role === "reviewer" ? "fix" : "verify";
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
