import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Checkout } from "./git.ts";

/** Reasoning effort levels the Copilot CLI accepts. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** How readily threads go to the author: only when they truly can't be settled, or on any judgement call. */
export const DEFER_MODES = ["best-effort", "blocking"] as const;
export type DeferMode = (typeof DEFER_MODES)[number];

/** Which model plays a role, and how hard it thinks. */
export interface RoleConfig {
  model: string;
  effort: Effort;
}

/**
 * A repository's root `.autoreview.json`, with defaults filled in. The file is optional: without
 * it, every field keeps its default. Folders may add their own; see `FolderConfig`.
 */
export interface Config {
  reviewer: RoleConfig;
  fixer: RoleConfig;
  /** Commands that must pass before a fix is pushed, run at the repository's root. */
  checks: string[];
  /** Slow checks (tests, renders), run only on a runner that can afford them. */
  heavyChecks: string[];
  /** Whether the fixer may render pictures to verify visual changes. */
  visual: boolean;
  /** Whether judgement calls are decided and flagged, or deferred to the author. */
  defer: DeferMode;
  /** Fix-and-verify rounds after the first review. */
  maxRounds: number;
  /** Replies a thread may trade before it is deferred as a disagreement. */
  maxExchanges: number;
  /** Files and directories the agents should read for the project's conventions. */
  context: string[];
  /**
   * The labels that ask for the reviewer and the fixer, the one marking threads left to the
   * author, and the one marking decisions made for the author to look over.
   */
  reviewLabel: string;
  fixLabel: string;
  deferLabel: string;
  decisionLabel: string;
  /** How long one agent call may run. */
  agentTimeoutMinutes: number;
  /**
   * Workflow files to start on the head branch after a run pushes fixes, since pushes
   * made with a workflow's own token start no workflows.
   */
  dispatch: string[];
}

export const CONFIG_FILE = ".autoreview.json";

export const DEFAULTS: Config = {
  reviewer: { model: "gpt-6-astra", effort: "high" },
  fixer: { model: "claude-opus-5.5", effort: "high" },
  checks: [],
  heavyChecks: [],
  visual: false,
  defer: "best-effort",
  maxRounds: 3,
  maxExchanges: 2,
  context: ["AGENTS.md"],
  reviewLabel: "autoreview",
  fixLabel: "autofix",
  deferLabel: "needs-author",
  decisionLabel: "author-review",
  agentTimeoutMinutes: 20,
  dispatch: [],
};

/** Read a repository's config, or the defaults when it has none. */
export async function loadConfig(repoDir: string): Promise<Config> {
  // A missing file means defaults; any other read error is real
  let text: string;
  try {
    text = await readFile(join(repoDir, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(DEFAULTS);
    }
    throw error;
  }
  return parseConfig(JSON.parse(text));
}

/** Read the root config as it is at a commit, or the defaults when it has none there. */
export async function loadConfigAt(checkout: Checkout, sha: string): Promise<Config> {
  // A commit without the file means defaults
  const tree = await checkout.git("ls-tree", "--name-only", sha, "--", CONFIG_FILE);
  if (tree === "") {
    return structuredClone(DEFAULTS);
  }
  return parseConfig(JSON.parse(await checkout.git("show", `${sha}:${CONFIG_FILE}`)));
}

/** Read a config from a file outside the repository, such as one its operator supplies. */
export async function loadConfigFile(path: string): Promise<Config> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    // Name the operator's file rather than the repository's
    if (error instanceof ConfigError) {
      throw new ConfigError(error.detail, path);
    }
    throw error;
  }
}

/** Validate raw config against the schema, filling in defaults. */
export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) {
    throw new ConfigError("config must be an object");
  }

  // Reject keys we don't know, so a typo doesn't silently do nothing
  const known = new Set([...Object.keys(DEFAULTS), "$schema"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new ConfigError(`unknown key "${key}"`);
    }
  }

  // Merge each field over its default, checking its type
  return {
    reviewer: role(raw.reviewer, DEFAULTS.reviewer, "reviewer"),
    fixer: role(raw.fixer, DEFAULTS.fixer, "fixer"),
    checks: strings(raw.checks, DEFAULTS.checks, "checks"),
    heavyChecks: strings(raw.heavyChecks, DEFAULTS.heavyChecks, "heavyChecks"),
    visual: boolean(raw.visual, DEFAULTS.visual, "visual"),
    defer: oneOf(raw.defer, DEFAULTS.defer, { key: "defer", options: DEFER_MODES }),
    maxRounds: count(raw.maxRounds, DEFAULTS.maxRounds, "maxRounds"),
    maxExchanges: count(raw.maxExchanges, DEFAULTS.maxExchanges, "maxExchanges"),
    context: strings(raw.context, DEFAULTS.context, "context"),
    reviewLabel: text(raw.reviewLabel, DEFAULTS.reviewLabel, "reviewLabel"),
    fixLabel: text(raw.fixLabel, DEFAULTS.fixLabel, "fixLabel"),
    deferLabel: text(raw.deferLabel, DEFAULTS.deferLabel, "deferLabel"),
    decisionLabel: text(raw.decisionLabel, DEFAULTS.decisionLabel, "decisionLabel"),
    agentTimeoutMinutes: count(
      raw.agentTimeoutMinutes,
      DEFAULTS.agentTimeoutMinutes,
      "agentTimeoutMinutes",
    ),
    dispatch: strings(raw.dispatch, DEFAULTS.dispatch, "dispatch"),
  };
}

/**
 * A folder's own `.autoreview.json`, for the code under that folder. Its checks run in the
 * folder, on top of those of the root and of the folders between, and its context paths are
 * relative to it. Settings for the whole run belong in the root file only.
 */
export interface FolderConfig {
  /** The folder, relative to the repository's root, such as `packages/foo`. */
  folder: string;
  checks: string[];
  heavyChecks: string[];
  /** Paths relative to the repository's root. */
  context: string[];
}

/** The fields a folder's file may set. */
export const FOLDER_FIELDS = ["checks", "heavyChecks", "context"] as const;

/** Validate a folder's file, read from `<folder>/.autoreview.json`. */
export function parseFolderConfig(raw: unknown, folder: string): FolderConfig {
  const file = `${folder}/${CONFIG_FILE}`;
  try {
    if (!isRecord(raw)) {
      throw new ConfigError("config must be an object");
    }

    // Settings for the whole run, and unknown keys, are mistakes here
    for (const key of Object.keys(raw)) {
      if (Object.hasOwn(DEFAULTS, key) && !(FOLDER_FIELDS as readonly string[]).includes(key)) {
        throw new ConfigError(`"${key}" can only be set in the root ${CONFIG_FILE}`);
      }
      if (key !== "$schema" && !Object.hasOwn(DEFAULTS, key)) {
        throw new ConfigError(`unknown key "${key}"`);
      }
    }

    // Context paths are the folder's, and stay inside the repository
    const context = strings(raw.context, [], "context").map((entry) => {
      const path = posix.normalize(posix.join(folder, entry));
      if (posix.isAbsolute(entry) || path === ".." || path.startsWith("../")) {
        throw new ConfigError(`context entry "${entry}" is outside the repository`);
      }
      return path;
    });
    return {
      folder,
      checks: strings(raw.checks, [], "checks"),
      heavyChecks: strings(raw.heavyChecks, [], "heavyChecks"),
      context,
    };
  } catch (error) {
    // Name the folder's file rather than the root's
    if (error instanceof ConfigError) {
      throw new ConfigError(error.detail, file);
    }
    throw error;
  }
}

export class ConfigError extends Error {
  /** The problem, without the file's name. */
  readonly detail: string;

  constructor(message: string, file: string = CONFIG_FILE) {
    super(`${file}: ${message}`);
    this.detail = message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function role(value: unknown, fallback: RoleConfig, key: string): RoleConfig {
  if (value === undefined) {
    return { ...fallback };
  }
  if (!isRecord(value)) {
    throw new ConfigError(`${key} must be an object`);
  }

  // Effort must be one the CLI accepts
  const effort = value.effort ?? fallback.effort;
  if (!EFFORTS.includes(effort as Effort)) {
    throw new ConfigError(`${key}.effort must be one of ${EFFORTS.join(", ")}`);
  }
  return { model: text(value.model, fallback.model, `${key}.model`), effort: effort as Effort };
}

function strings(value: unknown, fallback: string[], key: string): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ConfigError(`${key} must be a list of strings`);
  }
  return value;
}

function text(value: unknown, fallback: string, key: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value === "") {
    throw new ConfigError(`${key} must be a non-empty string`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  fallback: T,
  { key, options }: { key: string; options: readonly T[] },
): T {
  if (value === undefined) {
    return fallback;
  }
  if (!options.includes(value as T)) {
    throw new ConfigError(`${key} must be one of ${options.map((o) => `"${o}"`).join(", ")}`);
  }
  return value as T;
}

function boolean(value: unknown, fallback: boolean, key: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(`${key} must be true or false`);
  }
  return value;
}

function count(value: unknown, fallback: number, key: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ConfigError(`${key} must be a positive integer`);
  }
  return value as number;
}
