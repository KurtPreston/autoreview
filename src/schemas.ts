/** The JSON verdicts each agent returns, and validators that check them. */

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A problem the reviewer found, anchored to a line on the new side of the diff. */
export interface Finding {
  path: string;
  line: number;
  severity: Severity;
  body: string;
  /** True when the reviewer judges it the author's call from the start. */
  forAuthor: boolean;
}

/** The reviewer's first pass over the pull request. */
export interface Review {
  summary: string;
  findings: Finding[];
}

/** A judgement call an agent made for the author, who reviews it later. */
export interface Decision {
  /** What was chosen, in a sentence. */
  chose: string;
  /** The main alternative the author might prefer, in a sentence. */
  alternative: string;
}

export const ACTIONS = ["fix", "reply", "defer"] as const;
export type Action = (typeof ACTIONS)[number];

/** The fixer's answer to one thread. */
export interface Answer {
  action: Action;
  /** The reply to post: what was changed, why not, or why it's the author's call. */
  body: string;
  /** A one-line commit summary, when the action is a fix. */
  commit?: string;
  /** Set when settling the thread took a judgement call; never on a deferral. */
  decision?: Decision;
}

export const VERDICTS = ["resolved", "follow-up", "defer"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The reviewer's judgement of the fixer's answers. */
export interface Verification {
  /** A decision on `resolved` keeps the fixer's side; on `follow-up`, it rules the reviewer's way. */
  threads: { key: string; verdict: Verdict; body: string; decision?: Decision }[];
  /** New problems, only on lines the fixer changed. */
  findings: Finding[];
}

/** Checks a value, returning it typed, or throwing with the path of the first problem. */
export type Validator<T> = (value: unknown) => T;

export class SchemaError extends Error {}

export const validateReview: Validator<Review> = (value) => {
  const raw = object(value, "$");
  return {
    summary: string(raw.summary, "$.summary"),
    findings: list(raw.findings, "$.findings", finding),
  };
};

export const validateAnswer: Validator<Answer> = (value) => {
  const raw = object(value, "$");
  const action = oneOf(raw.action, ACTIONS, "$.action");

  // A fix needs a commit summary; the others never commit
  const answer: Answer = { action, body: string(raw.body, "$.body") };
  if (action === "fix") {
    answer.commit = string(raw.commit, "$.commit");
  }

  // Only an answer that settles the thread can be a decision
  const made = decision(raw.decision, "$.decision");
  if (made && action !== "defer") {
    answer.decision = made;
  }
  return answer;
};

export const validateVerification: Validator<Verification> = (value) => {
  const raw = object(value, "$");
  return {
    threads: list(raw.threads, "$.threads", (item, path) => {
      const thread = object(item, path);
      const verdict = oneOf(thread.verdict, VERDICTS, `${path}.verdict`);
      const made = decision(thread.decision, `${path}.decision`);
      return {
        key: string(thread.key, `${path}.key`),
        verdict,
        body: string(thread.body, `${path}.body`),
        ...(made && verdict !== "defer" ? { decision: made } : {}),
      };
    }),
    findings: raw.findings === undefined ? [] : list(raw.findings, "$.findings", finding),
  };
};

function finding(value: unknown, path: string): Finding {
  const raw = object(value, path);
  const line = raw.line;
  if (!Number.isInteger(line) || (line as number) < 1) {
    throw new SchemaError(`${path}.line must be a positive integer`);
  }
  return {
    path: string(raw.path, `${path}.path`),
    line: line as number,
    severity: oneOf(raw.severity, SEVERITIES, `${path}.severity`),
    body: string(raw.body, `${path}.body`),
    forAuthor: raw.forAuthor === true,
  };
}

/** An optional decision; null or absent means none. */
function decision(value: unknown, path: string): Decision | undefined {
  if (value === undefined || value === null || value === false) {
    return undefined;
  }
  const raw = object(value, path);
  return {
    chose: string(raw.chose, `${path}.chose`),
    alternative: string(raw.alternative, `${path}.alternative`),
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SchemaError(`${path} must be a non-empty string`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (!options.includes(value as T)) {
    throw new SchemaError(`${path} must be one of ${options.join(", ")}`);
  }
  return value as T;
}

function list<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) {
    throw new SchemaError(`${path} must be a list`);
  }
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

/**
 * Find the JSON object in an agent's final answer: the whole text, a fenced
 * block, or the outermost braces around prose.
 */
export function extractJson(text: string): unknown {
  // The whole answer, or the last fenced block
  const trimmed = text.trim();
  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  const candidates = [trimmed, ...fences.reverse().map((match) => match[1])];

  // Then each opening brace through the last closing one
  const end = trimmed.lastIndexOf("}");
  for (
    let start = trimmed.indexOf("{");
    start !== -1 && start < end;
    start = trimmed.indexOf("{", start + 1)
  ) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate
    }
  }
  throw new SchemaError("the answer contains no JSON object");
}
