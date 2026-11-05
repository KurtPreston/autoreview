/** A count with its noun, pluralised: "1 thread", "3 threads". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count > 1 ? "s" : ""}`;
}

/** The share of a whole that a part makes up, from 0 to 1. */
export function ratio(part: number, whole: number): number {
  return part / whole;
}
