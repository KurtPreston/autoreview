/** Folders' own `.autoreview.json` files, for the code under them. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
 * held to. A folder that has since taken another's file word for word, that folder having lost
 * it, was moved there, and answers to that file. Each file is read once.
 */
export class FolderConfigs {
  readonly #checkout: Checkout;
  readonly #sha: string;
  readonly #texts = new Map<string, Promise<string | undefined>>();
  readonly #parsed = new Map<string, Promise<FolderSet>>();
  #listing?: Promise<string[]>;

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
    const found: FolderSet[] = [];
    for (const folder of folders) {
      const source = await this.#source(folder);
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

  /** The folders with a file in the starting commit, shallowest first. */
  async #folders(): Promise<string[]> {
    this.#listing ??= this.#checkout
      .git("ls-tree", "-r", "-z", "--name-only", this.#sha)
      .then((listing) => {
        const suffix = `/${CONFIG_FILE}`;
        const folders = listing
          .split("\0")
          .filter((path) => path.endsWith(suffix))
          .map((path) => path.slice(0, -suffix.length));
        return folders.sort(
          (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
        );
      });
    return this.#listing;
  }

  /**
   * The folder whose starting file applies to a folder: its own, or else that of the one
   * folder that has since lost its file and whose file this folder now has word for word, in
   * the working tree or as committed during the run. Undefined when there's neither.
   */
  async #source(folder: string): Promise<string | undefined> {
    if ((await this.#text(folder)) !== undefined) {
      return folder;
    }
    const lost = (await this.#folders()).filter(
      (other) => !existsSync(join(this.#checkout.dir, other, CONFIG_FILE)),
    );
    if (lost.length === 0) {
      return undefined;
    }
    const path = `${folder}/${CONFIG_FILE}`;
    const current = await readFile(join(this.#checkout.dir, path), "utf8").catch(() => undefined);
    const now = [current, await this.#show("HEAD", path)].filter((text) => text !== undefined);
    const sources: string[] = [];
    for (const other of lost) {
      if (now.includes((await this.#text(other))!)) {
        sources.push(other);
      }
    }
    return sources.length === 1 ? sources[0] : undefined;
  }

  /** A folder's file as the starting commit has it, or undefined when it has none. */
  async #text(folder: string): Promise<string | undefined> {
    if (!this.#texts.has(folder)) {
      this.#texts.set(folder, this.#show(this.#sha, `${folder}/${CONFIG_FILE}`));
    }
    return this.#texts.get(folder);
  }

  /** A file as a commit has it, or undefined when it has none. */
  async #show(commit: string, path: string): Promise<string | undefined> {
    // ls-tree prints nothing for a missing file, where show would fail
    if (!(await this.#checkout.git("ls-tree", "--name-only", commit, "--", path)).trim()) {
      return undefined;
    }
    return this.#checkout.git("show", `${commit}:${path}`);
  }

  /** The starting file of `source`, applied to `folder`. */
  async #load(source: string, folder: string): Promise<FolderSet> {
    const text = (await this.#text(source))!;

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
