import type { Checkout } from "./git.ts";

/**
 * Whether a push of autoreview's own commit started this run. Only pushes count: a label
 * or ready-for-review event on the same head still deliberates.
 */
export async function ownPush(
  checkout: Checkout,
  head: string,
  event = process.env.AUTOREVIEW_EVENT,
): Promise<boolean> {
  return event === "synchronize" && (await checkout.isOwn(head));
}
