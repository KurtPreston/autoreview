/**
 * Hidden state in comment bodies. Every comment autoreview posts ends with a
 * marker, so a run can rebuild where the deliberation stands from the forge alone.
 */

import type { Decision } from "./schemas.ts";

export type Role = "reviewer" | "fixer";

export interface Marker {
  role: Role;
  /** What the comment is. */
  kind: "finding" | "answer" | "verdict" | "review" | "summary" | "notes" | "notice";
  /** A finding's severity, an answer's action, or a verdict. */
  value?: string;
  /** Set when this comment hands the thread to the author. */
  deferred?: boolean;
  /** Set when this comment settles the thread with a judgement call for the author to review. */
  decision?: Decision;
  /** For reviews and summaries: the head commit they cover. */
  head?: string;
}

const PATTERN = /\n*<!-- autoreview (\{.*?\}) -->\s*$/s;

/** A comment body: a labelled header, the text, and the hidden marker. */
export function compose(header: string, text: string, marker: Marker): string {
  // Escape ">" so text in the marker can't close the HTML comment; JSON reads it back unchanged
  const json = JSON.stringify(marker).replaceAll(">", "\\u003e");
  return `🤖 ${header}\n\n${text.trim()}\n\n<!-- autoreview ${json} -->`;
}

/** The marker at the end of a comment, if autoreview posted it. */
export function readMarker(body: string): Marker | undefined {
  const match = PATTERN.exec(body);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[1]) as Marker;
  } catch {
    return undefined;
  }
}

/** A comment's text without its header line and marker, for agents to read. */
export function plainText(body: string): string {
  return body
    .replace(PATTERN, "")
    .replace(/^🤖 [^\n]*\n+/, "")
    .trim();
}
