/** Folders' own `.autoreview.json` files, for the code under them. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, ConfigError, parseFolderConfig, type FolderConfig } from "./config.ts";
import { foldersOf, type Convention } from "./context.ts";
import type { Checkout } from "./git.ts";

/**
 * Folder files read from the commit a run started at, so a fix can't change the checks it's
 * held to. Each folder is read once.
 */
export class FolderConfigs {
  readonly #checkout: Checkout;
  readonly #sha: string;
  readonly #read = new Map<string, Promise<FolderConfig | undefined>>();

  constructor(checkout: Checkout, sha: string) {
    this.#checkout = checkout;
    this.#sha = sha;
  }

  /** The files that apply to some paths: in their folders and those above, shallowest first. */
  async for(paths: string[]): Promise<FolderConfig[]> {
    return this.#configs(foldersOf(paths));
  }

  /** Every folder's file in the starting commit, shallowest first. */
  async all(): Promise<FolderConfig[]> {
    const listing = await this.#checkout.git("ls-tree", "-r", "-z", "--name-only", this.#sha);
    const suffix = `/${CONFIG_FILE}`;
    const folders = listing
      .split("\0")
      .filter((path) => path.endsWith(suffix))
      .map((path) => path.slice(0, -suffix.length));
    folders.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    return this.#configs(folders);
  }

  async #configs(folders: string[]): Promise<FolderConfig[]> {
    const found: FolderConfig[] = [];
    for (const folder of folders) {
      if (!this.#read.has(folder)) {
        this.#read.set(folder, this.#load(folder));
      }
      const config = await this.#read.get(folder);
      if (config) {
        found.push(config);
      }
    }
    return found;
  }

  /**
   * Where a folder the fix removed went: the one folder among the changed paths that gained
   * its file unchanged, or undefined when there's no such single folder.
   */
  async movedTo(folder: string, changed: string[]): Promise<string | undefined> {
    const original = await this.#text(folder);
    if (original === undefined) {
      return undefined;
    }
    const found = new Set<string>();
    for (const path of changed) {
      const name = path.split("/").pop();
      const destination = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
      if (name !== CONFIG_FILE || destination === folder) {
        continue;
      }
      const text = await readFile(join(this.#checkout.dir, path), "utf8").catch(() => undefined);
      if (text === original && (await this.#text(destination)) === undefined) {
        found.add(destination);
      }
    }
    return found.size === 1 ? [...found][0] : undefined;
  }

  /** A folder's file as the starting commit has it, or undefined when it has none. */
  async #text(folder: string): Promise<string | undefined> {
    // ls-tree prints nothing for a missing file, where show would fail
    const path = `${folder}/${CONFIG_FILE}`;
    if (!(await this.#checkout.git("ls-tree", "--name-only", this.#sha, "--", path)).trim()) {
      return undefined;
    }
    return this.#checkout.git("show", `${this.#sha}:${path}`);
  }

  async #load(folder: string): Promise<FolderConfig | undefined> {
    const text = await this.#text(folder);
    if (text === undefined) {
      return undefined;
    }

    // Name the file when it isn't JSON, as for any other mistake in it
    const path = `${folder}/${CONFIG_FILE}`;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError((error as Error).message, path);
    }
    return parseFolderConfig(raw, folder);
  }
}

/**
 * The context the folder files add, each for the code under the folder whose file lists it,
 * leaving out paths already listed.
 */
export function folderContext(configs: FolderConfig[], listed: string[]): Convention[] {
  const seen = new Set(listed);
  const added: Convention[] = [];
  for (const { folder, context } of configs) {
    for (const path of context) {
      if (!seen.has(path)) {
        seen.add(path);
        added.push({ path, folder });
      }
    }
  }
  return added;
}
