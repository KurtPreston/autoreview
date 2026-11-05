/** Folders' own `.autoreview.json` files, for the code under them. */
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { CONFIG_FILE, ConfigError, parseFolderConfig, type FolderConfig } from "./config.ts";
import { foldersOf, type Convention } from "./context.ts";
import type { Checkout } from "./git.ts";

/** A folder's file as it applies to the folder's code. */
export interface FolderSet extends FolderConfig {
  /**
   * The folder whose file it is in the starting commit: the folder itself, or the one it was
   * moved from.
   */
  source: string;
}

/**
 * Folder files read from the commit a run started at, so a fix can't change the checks it's
 * held to. A folder that took another's file word for word, that folder having lost it, was
 * moved there, and answers to that file for the rest of the run, whatever later fixes do to its
 * copy. Each file is read once.
 */
export class FolderConfigs {
  readonly #checkout: Checkout;
  readonly #sha: string;
  readonly #parsed = new Map<string, Promise<FolderSet>>();
  readonly #trees = new Map<string, Promise<Map<string, string>>>();

  constructor(checkout: Checkout, sha: string) {
    this.#checkout = checkout;
    this.#sha = sha;
  }

  /** The files that apply to some paths: in their folders and those above, shallowest first. */
  async for(paths: string[]): Promise<FolderSet[]> {
    return this.#configs(foldersOf(paths));
  }

  /** Every folder's file in the starting commit, shallowest first. */
  async all(): Promise<FolderSet[]> {
    return this.#configs(await this.#folders());
  }

  async #configs(folders: string[]): Promise<FolderSet[]> {
    const starting = await this.#tree(this.#sha);
    const moves = await this.#moves();
    const found: FolderSet[] = [];
    for (const folder of folders) {
      const source = starting.has(folder) ? folder : moves.get(folder);
      if (source === undefined) {
        continue;
      }
      const key = `${source}\0${folder}`;
      if (!this.#parsed.has(key)) {
        this.#parsed.set(key, this.#load(source, folder));
      }
      found.push(await this.#parsed.get(key)!);
    }
    return found;
  }

  /**
   * The starting files of folders that are gone, no folder having taken their file word for
   * word, whose code moved to where some of the paths lie. Which checks that code answers to
   * can't be told, so a fix there is held to the lost folder's.
   */
  async stranded(paths: string[]): Promise<FolderSet[]> {
    const taken = new Set((await this.#moves()).values());
    const lost = (await this.#folders()).filter(
      (folder) => !taken.has(folder) && !existsSync(join(this.#checkout.dir, folder)),
    );
    if (lost.length === 0) {
      return [];
    }

    // Find where each lost folder's files went, from the starting commit to the working tree
    const fields = (
      await this.#checkout.git("diff", "-M", "--name-status", "-z", this.#sha, "--")
    ).split("\0");
    const stranded = new Set<string>();
    for (let i = 0; i < fields.length; i++) {
      const status = fields[i];
      if (!/^[RC]/.test(status)) {
        i++;
        continue;
      }
      const [from, to] = [fields[i + 1], fields[i + 2]];
      i += 2;
      if (status.startsWith("C")) {
        continue;
      }
      for (const folder of lost.filter((folder) => from.startsWith(`${folder}/`))) {
        const rest = from.slice(folder.length);
        const where = to.endsWith(rest) ? to.slice(0, -rest.length) : posix.dirname(to);
        if (paths.some((path) => where === "." || path.startsWith(`${where}/`))) {
          stranded.add(folder);
        }
      }
    }
    return this.#configs(lost.filter((folder) => stranded.has(folder)));
  }

  /** The folders with a file in the starting commit, shallowest first. */
  async #folders(): Promise<string[]> {
    const folders = [...(await this.#tree(this.#sha)).keys()];
    return folders.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  }

  /**
   * The folders moved during the run, each with the folder whose starting file it took. They're
   * replayed from the run's commits, then the working tree: a folder without a starting file is
   * moved from another once it has that folder's starting file word for word, that folder has
   * lost it, and no other folder that lost an identical file could be its source. A move, once
   * made, stays.
   */
  async #moves(): Promise<Map<string, string>> {
    const starting = await this.#tree(this.#sha);
    const commits = (
      await this.#checkout.git("rev-list", "--reverse", "--topo-order", `${this.#sha}..HEAD`)
    )
      .split("\n")
      .filter(Boolean);
    const states = [...commits.map((commit) => this.#tree(commit)), this.#workingTree()];
    const moves = new Map<string, string>();
    for (const state of states) {
      const present = await state;
      const lost = [...starting.keys()].filter((folder) => !present.has(folder));
      for (const [folder, blob] of present) {
        if (starting.has(folder) || moves.has(folder)) {
          continue;
        }
        const sources = lost.filter((source) => starting.get(source) === blob);
        if (sources.length === 1) {
          moves.set(folder, sources[0]);
        }
      }
    }
    return moves;
  }

  /** Each folder with a file in a commit, with the file's blob. A commit's is read once. */
  async #tree(commit: string): Promise<Map<string, string>> {
    if (!this.#trees.has(commit)) {
      this.#trees.set(
        commit,
        this.#checkout.git("ls-tree", "-r", "-z", commit).then((listing) => {
          const blobs = new Map<string, string>();
          for (const entry of listing.split("\0").filter(Boolean)) {
            const tab = entry.indexOf("\t");
            const folder = configFolder(entry.slice(tab + 1));
            if (folder !== undefined) {
              blobs.set(folder, entry.slice(0, tab).split(" ")[2]);
            }
          }
          return blobs;
        }),
      );
    }
    return this.#trees.get(commit)!;
  }

  /** Each folder with a file in the working tree, with the blob the file would commit as. */
  async #workingTree(): Promise<Map<string, string>> {
    const listing = await this.#checkout.git(
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    );
    const paths = [
      ...new Set(
        listing
          .split("\0")
          .filter((path) => configFolder(path) !== undefined)
          .filter((path) => existsSync(join(this.#checkout.dir, path))),
      ),
    ];
    if (paths.length === 0) {
      return new Map();
    }
    const blobs = (await this.#checkout.git("hash-object", "--", ...paths)).trim().split("\n");
    return new Map(paths.map((path, index) => [configFolder(path)!, blobs[index]]));
  }

  /** The starting file of `source`, applied to `folder`. */
  async #load(source: string, folder: string): Promise<FolderSet> {
    const text = await this.#checkout.git("show", `${this.#sha}:${source}/${CONFIG_FILE}`);

    // Name the file when it isn't JSON, as for any other mistake in it
    const path = `${folder}/${CONFIG_FILE}`;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError((error as Error).message, path);
    }
    return { ...parseFolderConfig(raw, folder), source };
  }
}

/** The folder a path is a folder's file in, or undefined when it isn't one. */
function configFolder(path: string): string | undefined {
  const suffix = `/${CONFIG_FILE}`;
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : undefined;
}

/**
 * The convention files to read: those `found` by name, then the context the folder files add,
 * each for the code under the folder whose file lists it. An entry is left out when the root's
 * `listed` context, which covers the whole repository, or another entry for the same file over
 * the same folder or one above it already covers it.
 */
export function folderContext(
  configs: FolderConfig[],
  listed: string[],
  found: Convention[],
): Convention[] {
  const all = [
    ...found,
    ...configs.flatMap(({ folder, context }) => context.map((path) => ({ path, folder }))),
  ];
  return all.filter(
    ({ path, folder }, index) =>
      !listed.includes(path) &&
      !all.some(
        (other, at) =>
          other.path === path &&
          (other.folder === folder ? at < index : folder.startsWith(`${other.folder}/`)),
      ),
  );
}
