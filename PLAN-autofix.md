# Plan: autofix

## Goal

Split autoreview into two labels. `autoreview` runs the reviewer and `autofix` runs the
fixer, and both together give today's duet. People asked for an automated reviewer whose
minor findings get settled for them, and for a fixer that also answers other bots' and
people's review comments.

## Scope

In:

- Split `src/loop.ts` by responsibility first, moving code only.
- Rename "implementer" to "fixer" everywhere, with no compatibility shim.
- Config: `label` becomes `reviewLabel` (default `autoreview`), plus `fixLabel` (default
  `autofix`).
- `autoreview` alone: the reviewer reviews new commits. On new commits, it rechecks every
  open finding, not just deferred ones, and resolves what the author settled. Open findings
  count as for the author (`needs-author`).
- `autofix` alone: the fixer answers every open thread whose latest comment is a person's,
  another bot's, or our reviewer's. It answers fix, reply (dismiss with a reason) or defer.
  It replies without verification, citing any commit, and leaves the thread open. The
  fixer's identity posts the summary.
- Both: today's duet. Threads others opened ("foreign" threads) go through the same rounds.
  Our reviewer verifies them. It resolves those a bot opened, and leaves those a person opened
  open with its verdict.
- A thread whose latest comment is from a person or another bot becomes the fixer's turn
  when `autofix` is on, including deferred threads the author answers. With `autofix` off,
  it's left as it is.
- A fixer deferral in a foreign thread @-mentions the latest person commenter, never a bot.
  A fix that would materially change structure or behaviour is a deferral. `Comment` gains
  a `bot` flag. GitHub sets it from GraphQL `__typename`/REST `type` or a `[bot]` login.
  Gitea has none, so everyone except autoreview's own identities counts as a person.
- Only summaries from runs where the reviewer was on set the next review's starting
  point.
- Templates trigger on either label, and on `pull_request_review: [submitted]`. `add.sh`
  creates the `autofix` label on both forges. `add.sh --fixer` defaults to
  `autoreview-fixer`, and the secret is `AUTOREVIEW_FIXER_TOKEN`.
- Default models stay: reviewer `gpt-6-astra`, fixer `claude-opus-5.5`.

Out:

- Top-level (non-thread) comments from others.
- Pull requests from forks.
- Compatibility with in-flight implementer markers; those pull requests restart.

## Execution rules

- All work happens on the `autofix` branch. One plan, one branch, one commit per phase.
- Prefix every commit message with `autofix: `.
- For each phase: implement only its scope, run validation, fix failures, commit.
- Work around small obstacles and log them under Obstacles. Stop only if a
  fundamental assumption is wrong or a finding reshapes the effort.
- Log existing bugs found along the way under Found bugs. Fold in fixes that
  belong to this effort, save small unrelated fixes for their own branches,
  and leave nuanced ones unfixed for discussion.
- After the last phase: update docs and commit, delete this file and commit,
  open a pull request (the repository is public: show the user the exact title and
  body and ask first), fix each small unrelated bug on its own branch from the base
  branch with its own pull request, then report results with every obstacle and
  workaround, every bug found and how it was handled, and how the user can try the
  changes.
- Code style: at most 3 parameters, braces always, a section comment every 3–10 lines,
  no embedded languages, files under about 600 lines.

## Validation

`/tmp/v.sh`, which clears the injected `GIT_CONFIG_*` variables, then runs:

```sh
npm run typecheck && npm run lint && npm run format:check && npm test
```

## User steps

After the pull request lands:

- Gitea: rename the secret `AUTOREVIEW_IMPLEMENTER_TOKEN` to `AUTOREVIEW_FIXER_TOKEN` on your
  account. The `autoreview-implementer` user can stay as it is, or be renamed
  `autoreview-fixer` in Site Administration.
- Gitea, in each repository: change the workflow's `implementer-token` input to
  `fixer-token: ${{ secrets.AUTOREVIEW_FIXER_TOKEN }}`, and add the `autofix` label to the
  `if:` and the `pull_request_review` trigger. Or delete the workflow and rerun `add.sh`.
  Create the `autofix` label (rerunning `add.sh` does it).
- Work organization (GitHub): allow `KurtPreston/autoreview` or use `add.sh --vendor`, enable
  "Allow use of Copilot CLI billed to the organization", and allow both models.

## Phases

### Phase 1: Split src/loop.ts

Pure move. `loop.ts` keeps `deliberate` and the types, and re-exports its current names.
New modules: `review.ts` (newChanges, recheck, reviewNew, postFindings), `fix.ts`
(implementRound, checked, checks, answerThread), `verify.ts`, `threads.ts` (exchanges,
ruled, finalNote, decisionText, describe, notice, tidy) and `agents.ts` (copilotAgents,
covering). Done when the tests pass unchanged.

### Phase 2: Rename implementer to fixer

Config key, marker role, `Agents.implement` becoming `fix`, `prompts/implement.md`
becoming `fix.md`, prompt wording, comment headers, schemas, the commit trailer
(`Autoreview: fixer`), the action input `fixer-token`, the env var
`AUTOREVIEW_FIXER_TOKEN`, `add.sh --fixer` (default `autoreview-fixer`), the templates,
the tests and the README. Done when `grep -ri implement` finds nothing but unrelated words.

### Phase 3: Two labels

Config gets `reviewLabel` and `fixLabel`. `deliberate` works out which roles are on, and
skips when neither label is set, unless forced. Review-only rechecks every open finding
on new commits, and counts open findings toward `needs-author`. Fix-only runs one fixer
round with no verification. The summary comes from whichever role is on, and its marker
records whether the reviewer ran. Templates trigger on either label, and `add.sh` creates
`autofix`. Tests for each mode.

### Phase 4: Foreign threads and people

Rework `status` around who spoke last and which roles are on. Add `Comment.bot` on both
forges and in memory. A fix prompt variant explains foreign threads: dismissing, and
deferring material changes. Mention the latest person on a foreign deferral. Have the
reviewer verify foreign threads in a duet, resolving bots' and leaving people's open. Add
the `pull_request_review` trigger to the templates. Tests: a foreign bot thread and a
foreign person thread, each alone and in a duet, and a person replying in our thread.

### Phase 5: Docs

README (How it works, the labels, Setup, Configuration, Not yet), AGENTS.md if needed,
`action.yml` descriptions, `add.sh --help`.

## Obstacles

## Found bugs
