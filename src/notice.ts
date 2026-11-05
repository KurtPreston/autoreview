/** An operator's notice, put at the top of everything a forge posts. */
import type { Forge } from "./forge.ts";

/**
 * A forge whose reviews, inline comments, replies and comments open with a notice, such as who
 * runs autoreview and why, when it posts as a person rather than a bot. Reads are unchanged.
 */
export function withNotice(forge: Forge, notice: string): Forge {
  // One line opening with 🤖, which readers of a comment's text skip like its header
  const line = notice.replace(/\s*\n\s*/g, " ").trim();
  const opening = line.startsWith("🤖 ") ? line : `🤖 ${line}`;
  const mark = (body: string) => `${opening}\n\n${body}`;

  // Every write that carries a body gets the notice; markers sit at the end, so they still parse
  const writes: Partial<Forge> = {
    review: (number, review) =>
      forge.review(number, {
        ...review,
        body: mark(review.body),
        comments: review.comments.map((comment) => ({ ...comment, body: mark(comment.body) })),
      }),
    reply: (number, thread, body) => forge.reply(number, thread, mark(body)),
    comment: (number, body) => forge.comment(number, mark(body)),
  };

  // Everything else goes to the forge itself, bound so its private fields still work
  return new Proxy(forge, {
    get(target, property) {
      if (Object.hasOwn(writes, property)) {
        return writes[property as keyof Forge];
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
