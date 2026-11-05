# autoreview

Two agents deliberate a pull request on a GitHub or Gitea runner. A **reviewer** (by default `gpt-6-astra`) comments on the change. A **fixer** (by default `claude-opus-5.5`) answers each comment, the reviewer's or anyone else's: it pushes a fix, replies, or defers. They go back and forth until every thread is either:

- **resolved**: the reviewer accepts the fix or the answer. When settling it took a judgement call, such as a trade-off or a design choice, the thread is resolved but flagged as a **decision** for you to look over, and the pull request gets the `author-review` label, or
- **deferred** to the author: the agents truly can't settle it, for example because it turns on intent nothing in the repository reveals. The pull request gets the `needs-author` label.

By default (`"defer": "best-effort"`) the agents decide what they can and flag it, so a pull request isn't left waiting on you midway. `"defer": "blocking"` defers every judgement call instead. See [Deferral modes](#deferral-modes).

Both agents run through the Copilot CLI. Each has its own label, and a run starts when a pull request carries either, and again on each push or review while it stays:

- **`autoreview`** runs the reviewer. Alone, it posts findings, rechecks them against later commits, and resolves those the author's commits settle. Every open finding waits on the author.
- **`autofix`** runs the fixer. Alone, it answers every open thread, including those other bots and people open, and leaves its answers open for whoever opened the thread.
- **Both** run the full deliberation: the fixer answers, and the reviewer verifies every answer, including those in threads it didn't open.

## How it works

A deterministic loop (`src/loop.ts`) does all the git and forge work, through a `Forge` interface (`src/forge.ts`) with GitHub and Gitea implementations. Each agent call is one `copilot -p` run that answers with a JSON verdict, which is checked against a schema (`src/schemas.ts`) and retried once if invalid. Agents never post, push or resolve anything themselves.

Each step runs only when its role's label is on.

1. **Recheck.** On a later run with new commits, the reviewer first checks each thread deferred to the author against them. Threads the commits settle are resolved. The rest stay deferred, and nothing is posted in them.
2. **Review.** The reviewer reads the diff (on later runs, only the commits since the last one) and reports up to 10 findings. Findings on lines the diff shows become inline threads. The rest go in the review summary, for the author. In blocking mode, the reviewer can also mark a finding `forAuthor`, which defers it from the start; in best-effort mode every inline finding goes to the fixer.
3. **Fix.** For each open thread, whoever opened it, the fixer answers `fix`, `reply` or `defer`. It may dismiss another bot's or person's comment with a reason. When it agrees with one but the fix would materially change the pull request's structure or behaviour, it defers, and mentions the person who commented (never a bot). A fix or reply that rests on a judgement call carries a `decision`: what was chosen, and the main alternative. A fix must pass the config's `checks`. It gets one retry with the failure in hand; if it still fails, it is dropped and the thread deferred, with the output. Each fix is its own commit, prefixed with the branch name. Fixes are pushed (never forced) before the replies that cite them are posted.
4. **Verify.** The reviewer gives every answered thread a verdict: `resolved` (the thread is resolved, unless a person opened it, who resolves it themselves), `follow-up` (back to the fixer) or `defer`. It may raise new findings, but only on lines that round changed.
5. Rounds repeat up to `maxRounds`. A thread whose agents still disagree after `maxExchanges` answers is deferred in blocking mode. In best-effort mode the reviewer decides it instead: it accepts the fixer's answer as a decision, or rules its own way, and the fixer carries out the ruling. A ruling that is still disputed is deferred, and so is anything open at the round cap, in either mode.
6. **Summary.** A comment lists what is left for you to decide, what was decided for you to review, what was answered and left open for the commenter, the commits, and the agent calls by model. It sets the labels to match: `needs-author` while any thread is deferred, `author-review` while any decision is unreviewed.

Rules that keep a deliberation from running away:

- Only the reviewer resolves threads.
- A deferral, by either agent, is final for the agents until a person replies in the thread, which hands it back to the fixer. Otherwise only the author's later commits settle it.
- A ruling at the exchange cap gets one more answer; if the reviewer still isn't satisfied, the thread is deferred.
- A person's reply in a thread goes to the fixer when `autofix` is on. With `autoreview` alone, it leaves the thread to the author, and threads others opened are left alone.
- A run with nothing new to review and no open threads posts nothing.
- A run started by a push of autoreview's own commit does nothing. Fix commits carry an
  `Autoreview: fixer` trailer, so this works even when one identity does everything.
- If the branch moves during a run, the push is rejected and the run stops. The run that the push started takes over.

All state lives in the pull request. Each comment ends with a hidden marker (`<!-- autoreview {…} -->`), so a run that crashed resumes where it stopped.

## Deferral modes

`defer` in the config sets how readily a thread goes to the author.

**`best-effort`** (the default) defers only what the agents truly can't settle:

- intent or outside constraints that neither the pull request's description, a plan it links to, nor the repository's documents reveal;
- anything destructive or irreversible: deleting data, dropping a feature, or rewriting history;
- visual judgement, while `visual` is false;
- a fix that still fails the checks after its retry.

For everything else, such as trade-offs, design choices within the pull request's scope, or interface and format changes a fix needs, the fixer picks the most conservative reasonable fix, commits it, and flags it as a decision. The summary lists decisions under "Decided for you, to review", with the file and line, what was chosen, and the alternative. The `author-review` label (`decisionLabel`) means "look at these when you review", not "blocked". A decision stays listed until a person replies in its thread.

**`blocking`** defers any judgement call: an unclear resolution, or one that would change the pull request's design, scope, a public interface, a format or visible behaviour.

## Knowing when a run is done

A run that deliberated ends with a summary comment whose hidden marker records the head it covered: `<!-- autoreview {"role":"reviewer","kind":"summary","head":"<sha>"} -->`. With only `autofix` on, the fixer posts it, with `"role":"fixer"`. Autoreview is done with the pull request when the newest summary's `head` is the pull request's current head and no autoreview workflow run is queued or running. A run with nothing new to do posts nothing, so the earlier summary still stands. Then:

- `needs-author` present: threads wait on the author ("For you to decide" in the summary).
- `author-review` present: nothing blocks, but decisions are listed for review.
- Neither: the pull request is clean.

While a run works, it shows as the commit status `autoreview/deliberation` on the pull request's latest commit. The status is pending while the run reviews or fixes, moves to each commit the run pushes, and ends as success with the run's counts, or as error when the run fails or the job is cancelled or times out. On GitHub it links to the run. Setting it needs the workflow's `statuses: write` permission; without that, the run logs a note and carries on. A branch rule can require the status, but only pull requests with a label get one. The run's log notes when each reviewer, fixer or verifier call starts and ends, and every 30 seconds while one is still working.

## Setup on GitHub

Nothing to create: both roles post and push as `github-actions[bot]` with the workflow's own token, and each comment names its role. For each repository:

```sh
git clone https://github.com/KurtPreston/autoreview.git ~/Code/autoreview
~/Code/autoreview/add.sh path/to/repo
```

This writes `.github/workflows/autoreview.yml` and `.autoreview.json` (existing files are kept) and creates the `autoreview`, `autofix`, `needs-author` and `author-review` labels, using your `gh` login or `GITHUB_TOKEN`. Review the generated config's `checks`, then commit both files.

- **Copilot.** The workflow grants `copilot-requests: write`, so the Copilot CLI runs on the workflow's token. In an organization's repository, usage is billed to the organization, which needs the Copilot policy "Allow use of Copilot CLI billed to the organization" and the configured models allowed. In a personal repository it bills the owner's seat. If that account has no Copilot, store a fine-grained token from an account that does, with the **Copilot Requests** permission, as the repository secret `COPILOT_GITHUB_TOKEN`, and the workflow uses it instead.
- **Checks on fixes.** Pushes made with the workflow's token start no workflows, so the other checks wouldn't see autoreview's fixes. `add.sh` lists the project's pull request workflows that have a `workflow_dispatch` trigger in the config's `dispatch`, and autoreview starts them after pushing. It names the ones without the trigger. Those pushes still create `pull_request` runs awaiting approval; leave them.
- **Restricted actions.** If the organization only allows its own actions, either ask an admin to allow `KurtPreston/autoreview` pinned to a commit, or run `add.sh --vendor`, which copies the action into `.github/actions/autoreview/` and uses that. Rerun it to update the copy.
- **Other reviewers.** The workflow also starts when someone submits a review, so the fixer answers other bots and people promptly. Reviews autoreview posts with the workflow's token start no runs.
- Pull requests from forks and drafts are skipped.

## Setup on Gitea

Do this once for your account:

1. Create two Gitea users, `autoreview-reviewer` and `autoreview-fixer`: Site Administration → User Accounts → Create User Account, or `gitea admin user create --username autoreview-reviewer --email … --random-password` on the server.
2. Signed in as each bot, create an access token with read and write access to repositories and issues (Settings → Applications).
3. Create a fine-grained GitHub token with the **Copilot Requests** permission, for the Copilot CLI.
4. Store the three as Actions secrets on your own account, so every repository you own can read them: `COPILOT_GITHUB_TOKEN`, `AUTOREVIEW_REVIEWER_TOKEN` and `AUTOREVIEW_FIXER_TOKEN`. Use Settings → Actions → Secrets, or run `add.sh <repo> --secrets`, which takes each from the environment or asks for it.

Then, for each repository:

```sh
git clone https://github.com/KurtPreston/autoreview.git ~/Code/autoreview
~/Code/autoreview/add.sh path/to/repo --setup-action https://github.com/KurtPreston/dotagents@main
```

This writes `.gitea/workflows/autoreview.yml` and `.autoreview.json` (existing files are kept), creates the labels, including `autofix`, and gives both bots write access. Gitea adds collaborators without an invitation. It uses your `tea` login, or `GITEA_TOKEN`. Review the generated config's `checks`, then commit both files.

Without the bot secrets, both roles post with the workflow's built-in token, as one identity. Pushes made with that token don't start workflows; list checks in `dispatch` to start them after a fix (Gitea 1.23 or later).

On Gitea, runs start on pull request events only, not reviews, so the fixer answers others' comments on the next push or label change.

### `add.sh` options

`--ref` (the autoreview ref the workflow uses, default `main`), `--vendor` (copy the action into the repository), `--setup-action` (a step to run before deliberating, repeatable; see [Standing instructions](#standing-instructions)), `--runs-on` (the runner label), and on Gitea `--secrets` and `--reviewer`/`--fixer` (bot names). The forge is chosen from the repository's origin.

## Configuration

`.autoreview.json` at the repository root. Every field is optional:

| Field                     | Default                                                 | Meaning                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewer`, `fixer`       | `gpt-6-astra`, `claude-opus-5.5`, both at `high` effort | `{ "model": "…", "effort": "…" }` for each role: any model the Copilot CLI accepts                                                                                                                                                                                                            |
| `checks`                  | `[]`                                                    | Commands a fix must pass before it is pushed                                                                                                                                                                                                                                                  |
| `heavyChecks`             | `[]`                                                    | Slower checks (tests, renders), run only with `heavy: true` on the action. Until then the fixer may not run them                                                                                                                                                                              |
| `visual`                  | `false`                                                 | Whether visual results can be checked. While it's false, findings that can only be judged by eye are deferred                                                                                                                                                                                 |
| `defer`                   | `best-effort`                                           | `best-effort`: the agents decide judgement calls themselves and flag them; only what they truly can't settle is deferred. `blocking`: any judgement call is deferred. See [Deferral modes](#deferral-modes)                                                                                   |
| `maxRounds`               | `3`                                                     | Fix-and-verify rounds per run                                                                                                                                                                                                                                                                 |
| `maxExchanges`            | `2`                                                     | Answers a thread may get before it is deferred as a disagreement                                                                                                                                                                                                                              |
| `context`                 | `["AGENTS.md"]`                                         | Files the agents read first for the project's conventions. A bare filename, such as `AGENTS.md`, is also picked up from every folder the pull request changes and the folders above it, so a monorepo's per-folder conventions apply where they belong. Use `./AGENTS.md` for the root's only |
| `reviewLabel`, `fixLabel` | `autoreview`, `autofix`                                 | The labels that run the reviewer and the fixer                                                                                                                                                                                                                                                |
| `deferLabel`              | `needs-author`                                          | The label marking threads left to you                                                                                                                                                                                                                                                         |
| `decisionLabel`           | `author-review`                                         | The label marking decisions the agents made for you to look over. It doesn't block anything                                                                                                                                                                                                   |
| `agentTimeoutMinutes`     | `20`                                                    | How long one agent call may run                                                                                                                                                                                                                                                               |
| `dispatch`                | `[]`                                                    | Workflow files, such as `["checks.yml"]`, to start on the branch after a run pushes fixes. Pushes made with a workflow's own token start no workflows, so list the checks that should see the fixes. Each needs a `workflow_dispatch` trigger                                                 |

The config is read from the pull request's head, so a pull request can change its own checks.

### Instruction files

Path-specific Copilot instructions, the `*.instructions.md` files under `.github/instructions`, are read too, with no configuration. Each one whose `applyTo` globs (comma-separated, relative to the root) match a file the pull request changes is listed for the agents, with its pattern, so they apply it to the files it covers. A file without `applyTo` applies to nothing. `excludeAgent: "code-review"` keeps a file from the reviewer, and `"cloud-agent"` keeps it from the fixer. The files are read from the pull request's head when a run starts.

## Standing instructions

Autoreview runs the deliberation. It doesn't decide what conventions the agents follow. The agents read whatever Copilot CLI instructions and settings `COPILOT_HOME` holds (by default `~/.copilot`). To give them yours, install them in a workflow step before the autoreview step that exports `COPILOT_HOME`. For [dotagents](https://github.com/KurtPreston/dotagents), which also turns off attribution trailers:

```yaml
- uses: https://github.com/KurtPreston/dotagents@main
- uses: https://github.com/KurtPreston/autoreview@main
  with: …
```

On GitHub, name actions as `KurtPreston/dotagents@main` rather than by URL. `add.sh --setup-action <uses>` writes such steps into a new workflow.

## The action

`action.yml` is a composite action that uses only GitHub-owned actions. It sets up Node and the Copilot CLI, points the checkout's `origin` at the pushing token and names commits after its user (`setup-git.sh`), and runs the loop from a copy outside the checkout. Its inputs are `copilot-token` (default: the workflow's token), `reviewer-token`, `fixer-token`, `token` (the fallback, default: the workflow's token), `pr`, `heavy` and `copilot-version`.

Agents run without the forge tokens in their environment, so the Copilot CLI uses `copilot-token` and only the loop can post or push.

The workflow template installs the project's npm dependencies first, when it has a lockfile, so the checks can run.

## Running it locally

```sh
./src/autoreview.ts run --pr 42 --repo path/to/repo --dry-run
```

`--dry-run` deliberates against an in-memory copy of the pull request. It prints every comment it would post, makes commits only in a temporary worktree, and pushes nothing. Without `--dry-run`, it posts and pushes for real as one identity: on GitHub `GITHUB_TOKEN`, `GH_TOKEN` or your `gh` login; on Gitea `GITEA_TOKEN` or your `tea` login. With `AUTOREVIEW_REVIEWER_TOKEN` and `AUTOREVIEW_FIXER_TOKEN` set, it posts as the two of them. The forge is chosen from the origin's host (`github.com` and `*.ghe.com` are GitHub); `AUTOREVIEW_FORGE=github` or `gitea` overrides it, such as for GitHub Enterprise Server. `--force` deliberates without either label (playing both roles), or on a draft or closed pull request. `threads --pr 42` lists a pull request's review threads.

Agent calls write their task and answer under `$TMPDIR/autoreview-<role>-*`, and the directory is kept when a call fails. Node runs with `--use-system-ca`, so servers with a private certificate authority work when the system trusts it.

## Development

The tool is TypeScript run directly by Node's type stripping (Node 22.20 or later), with no build step and no runtime dependencies. Avoid syntax that stripping rejects: enums, namespaces, and constructor parameter properties.

```sh
npm ci
npm run typecheck && npm run lint && npm run format:check && npm test
```

The tests run whole deliberations against a real git repository with a bare origin, an in-memory forge (`src/memory.ts`), and scripted agents. They also run the agent runner against a fake Copilot CLI (`test/fake-copilot.ts`). `.github/workflows/checks.yml` and `.gitea/workflows/checks.yml` run the same commands on every push and pull request.

## Not yet

- Pull requests from forks. The workflow's token can't push to them, so the GitHub workflow skips them.
- Visual verification and heavy checks, which wait for a stronger runner. When they arrive, set the workflow's `runs-on`, pass `heavy: true`, and set `visual` once the fixer can render and attach pictures.
- Review-triggered runs on Gitea. Its workflows start on pull request events only.
