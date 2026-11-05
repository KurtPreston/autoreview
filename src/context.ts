/** The per-folder convention files near a change, read on top of the configured ones. */
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * Each bare filename in the configured context (such as `AGENTS.md`) found in a folder the
 * pull request changes or any folder above one, short of the root. Entries with a path, and
 * files the context already lists, aren't repeated.
 */
export async function contextFor({
  dir,
  context,
  changed,
}: {
  dir: string;
  context: string[];
  changed: string[];
}): Promise<string[]> {
  // Every folder that holds a changed file, and each one above it, short of the root
  const folders = new Set<string>();
  for (const path of changed) {
    for (let folder = posix.dirname(path); folder !== "." && folder !== "/";) {
      folders.add(folder);
      folder = posix.dirname(folder);
    }
  }

  // Look for each bare name in each folder, keeping the ones that exist at the head
  const names = context.filter((entry) => !entry.includes("/"));
  const found: string[] = [];
  for (const folder of folders) {
    for (const name of names) {
      const path = `${folder}/${name}`;
      if (!context.includes(path) && (await isFile(join(dir, path)))) {
        found.push(path);
      }
    }
  }

  // Shallower folders first, so broader conventions come before narrower ones
  found.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  return found;
}

function depth(path: string): number {
  return path.split("/").length;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
