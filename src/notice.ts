/** An operator's notice, posted once on a pull request. */
import type { Forge } from "./forge.ts";
import { readMarker } from "./markers.ts";

/**
 * Post the notice, such as who runs autoreview and why, as one comment on the pull request,
 * unless an earlier run already posted one. Returns whether it posted.
 */
export async function postNotice(forge: Forge, number: number, notice: string): Promise<boolean> {
  // Any earlier notice counts, even with different text, so a changed notice doesn't repeat
  const comments = await forge.comments(number);
  if (comments.some((comment) => readMarker(comment.body)?.kind === "notice")) {
    return false;
  }
  const json = JSON.stringify({ role: "reviewer", kind: "notice" });
  await forge.comment(number, `${notice.trim()}\n\n<!-- autoreview ${json} -->`);
  return true;
}
