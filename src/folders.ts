/** Folders' own `.autoreview.json` files, for the code under them. */
import { CONFIG_FILE, ConfigError, parseFolderConfig, type FolderConfig } from "./config.ts";
import { foldersOf } from "./context.ts";
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
    const found: FolderConfig[] = [];
    for (const folder of foldersOf(paths)) {
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

  async #load(folder: string): Promise<FolderConfig | undefined> {
    // ls-tree prints nothing for a missing file, where show would fail
    const path = `${folder}/${CONFIG_FILE}`;
    if (!(await this.#checkout.git("ls-tree", "--name-only", this.#sha, "--", path)).trim()) {
      return undefined;
    }

    // Name the file when it isn't JSON, as for any other mistake in it
    const text = await this.#checkout.git("show", `${this.#sha}:${path}`);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError((error as Error).message, path);
    }
    return parseFolderConfig(raw, folder);
  }
}

/** The context the folder files add, leaving out paths already listed. */
export function folderContext(configs: FolderConfig[], listed: string[]): string[] {
  const seen = new Set(listed);
  const added: string[] = [];
  for (const path of configs.flatMap((config) => config.context)) {
    if (!seen.has(path)) {
      seen.add(path);
      added.push(path);
    }
  }
  return added;
}
