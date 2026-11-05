// What `add.sh` takes: where the action lives, the secrets it may store, and the options.

/** Where workflows fetch this action from. */
export const ACTION = "https://github.com/KurtPreston/autoreview";
export const SECRETS = [
  "COPILOT_GITHUB_TOKEN",
  "AUTOREVIEW_REVIEWER_TOKEN",
  "AUTOREVIEW_IMPLEMENTER_TOKEN",
] as const;

/** What to enable, and where. */
export interface AddOptions {
  repo: string;
  /** The autoreview ref the workflow pins. */
  ref: string;
  /** Actions to run before deliberating, such as one installing standing instructions. */
  setupActions?: string[];
  runsOn: string;
  reviewer: string;
  implementer: string;
  /** Secret values to store on the user's account, by name. */
  secrets: Partial<Record<(typeof SECRETS)[number], string>>;
  log: (message: string) => void;
  /** Injected for tests. */
  fetch?: typeof fetch;
}
