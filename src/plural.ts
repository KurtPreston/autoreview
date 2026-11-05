/** A count with its noun, pluralised: "1 thread", "3 threads". */
export function plural(count: number, noun: string): string {
  return count + " " + noun + (count > 1 ? "s" : "");
}
