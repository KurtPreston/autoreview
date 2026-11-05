/** A count with its noun, pluralised: "1 thread", "3 threads". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count > 1 ? "s" : ""}`;
}

/** The share of a whole that a part makes up, from 0 to 1. An empty whole has no share. */
export function ratio(part: number, whole: number): number {
  if (whole === 0) {
    throw new RangeError("ratio of an empty whole");
  }
  return part / whole;
}
