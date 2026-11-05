# Plan: github

## Goal

Run the deliberation on GitHub pull requests as well as Gitea ones, so it can settle review
findings on teammates' pull requests at work instead of leaving them for the author. The reviewer
and implementer stay separate models (`gpt-6-astra` reviews, `claude-opus-5.5` implements).

On GitHub, nothing runs as a person. A GitHub-hosted runner does the work; both roles post and push
as `github-actions[bot]` with the workflow's built-in token, and the Copilot CLI uses that same
token (`copilot-requests: write`), billed to the organization. Each comment's header names its role
and model. Locally, `run --pr` posts as the `gh` login.

Gitea keeps working as it does now: same runners, same bots, same comments. Its workflows fetch the
action from this GitHub repository.

A second effort, `autofix`, follows on its own branch: separate `autoreview` and `autofix` labels,
and a fixer that answers every review thread, not only autoreview's. See TASK-76.

## Scope

In:

- A `GitHub` forge beside `Gitea`, behind the existing `Forge` interface.
- Choosing the forge from the CI environment or the clone's origin, with tokens from
  `GITHUB_TOKEN` or `gh auth token` on GitHub.
- Recognising autoreview's own pushes by a commit trailer instead of by the pushing user, on both
  forges, since one identity may do everything.
- Starting other workflows after fix commits are pushed (the built-in token's pushes don't), via a
  `dispatch` config list and `workflow_dispatch`.
- `action.yml`, `setup-git.sh`, a GitHub workflow template, and `add.sh` for GitHub, with the
  Copilot CLI on the built-in token by default and a personal token as an option.
- `add.sh --vendor`: copy the action into a repository's `.github/actions/autoreview/`, for
  organizations that don't allow outside actions. The action uses only GitHub's own actions.
- A first live trial on this repository.

Out:

- The `autofix` split (TASK-76).
- A built-in polling command. Local `run --pr` is enough for a polling script.
- Fork pull requests on GitHub: the workflow token can't push to them, so they are skipped, as
  today.

## Execution rules

- All work happens on the `github` branch. One plan, one branch, one commit per phase.
- Prefix every commit message with `github: `.
- For each phase: implement only its scope, run validation, fix failures, commit.
- Work around small obstacles and log them under Obstacles. Stop only if a fundamental assumption is
  wrong or a finding reshapes the effort.
- Log existing bugs found along the way under Found bugs. Fold in fixes that belong to this effort,
  save small unrelated fixes for their own branches, and leave nuanced ones unfixed for discussion.
- Keep files under about 600 lines; `src/loop.ts` is already at 599, so new behaviour goes in new
  modules, not the loop.
- Nothing in this repository may name private hosts, networks or repositories; it is public.
- After the last phase: update docs and commit, delete this file and commit, open a pull request
  (ask first: the repository is public), fix each small unrelated bug on its own branch from `main`
  with its own pull request, then report results with every obstacle and workaround, every bug
  found and how it was handled, and how the user can try the changes.

## Validation

```sh
npm run typecheck && npm run lint && npm run format:check && npm test
```

Agent shells may inject `safe.bareRepository=explicit` through `GIT_CONFIG_*` variables, which
breaks the loop tests' bare origin. Clear them for the test run:
`env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 npm test` (repeat for each
index set).

## User steps

- **Before phase 1:** approve pushing the snapshot commit to `main` and this branch.
- **Phase 7 (live trial):** none for this personal repository: Copilot usage there is billed to
  your own seat through the built-in token.
- **On each Gitea repository using autoreview, after this lands:** point the workflow's `uses:` at
  `https://github.com/KurtPreston/autoreview@main` (or rerun `add.sh`).
- **At work, after this lands:** check that the organization allows actions from
  `KurtPreston/autoreview` (Settings → Actions → General). If not, ask an admin to allow it pinned
  to a commit, copy it into an organization repository, or use `add.sh --vendor`. Confirm the
  Copilot CLI policy "Allow use of Copilot CLI billed to the organization" is on and both models
  are allowed. Then run `add.sh <repo>`.

## Phases

### Phase 1: Recognise autoreview's own commits by a trailer

- Fix commits get an `Autoreview: implementer` trailer.
- The CLI skips a run whose head commit carries the trailer, instead of comparing
  `AUTOREVIEW_SENDER` with the implementer's login; drop `AUTOREVIEW_SENDER` from `action.yml`.
- Tests: a run on an autoreview commit is skipped; a run on the author's commit with the same
  identity is not.

### Phase 2: Give threads an opaque id

- Add `id: string` to `Thread` in `src/forge.ts`: the handle a forge needs to resolve it. Gitea and
  the memory forge set it from the first comment's id; behaviour is unchanged.

### Phase 3: The GitHub forge

- `src/github.ts`, implementing `Forge` with an injectable `fetch`, like `src/gitea.ts`:
  - REST for the pull request, diff, issue comments, reviews (`event: COMMENT`, `side: RIGHT`),
    replies (`/pulls/{n}/comments/{id}/replies`) and labels (created when missing).
  - GraphQL `reviewThreads` for threads (`isResolved`, `path`, `line` or `originalLine` when
    outdated, `diffSide`, comments with `databaseId`), and `resolveReviewThread`.
  - `login()` falls back to `github-actions[bot]` for the workflow token, which can't read `/user`.
  - `headBranch` is undefined for fork heads and deleted branches.
  - `dispatch(workflow, ref)` for `workflow_dispatch`.
- `test/github.test.ts` against recorded-shape responses, as `test/gitea.test.ts` does.

### Phase 4: Choose the forge and its tokens

- Move forge construction out of `src/autoreview.ts` into `src/forges.ts`: GitHub when
  `GITHUB_API_URL` points at a GitHub server or the origin is `github.com`; Gitea otherwise.
- GitHub tokens: `AUTOREVIEW_*` tokens if set, else `GITHUB_TOKEN`, else `gh auth token`.
- `threads --pr` and `run --dry-run` work against a GitHub pull request locally.

### Phase 5: Start other workflows after fixes

- Config field `dispatch: string[]` (default `[]`): workflow files to start with
  `workflow_dispatch` on the head branch after a run pushes commits. Called from the CLI after
  `deliberate` returns, not from the loop. Gitea logs and skips it if unsupported.
- Config and CLI tests.

### Phase 6: The action, templates and `add.sh` on GitHub

- `action.yml`: `copilot-token` defaults to the workflow token; uses only GitHub-owned actions.
- `setup-git.sh`: on GitHub, push as `github-actions[bot]`
  (`41898282+github-actions[bot]@users.noreply.github.com`).
- `templates/github.yml`: `pull_request` events; `permissions: contents: write,
  pull-requests: write, issues: write, actions: write, copilot-requests: write`; concurrency per
  pull request; skip drafts and fork heads.
- `add.sh` on a GitHub origin: writes `.github/workflows/autoreview.yml` and `.autoreview.json`,
  and creates the labels with `gh`. No bots, collaborators or secrets. `--vendor` copies
  `action.yml`, `setup-git.sh`, `src/` and `prompts/` into `.github/actions/autoreview/` and points
  `uses:` at it. Split `src/add.ts` by forge so each file stays small.
- `.github/workflows/checks.yml` running the validation, beside the Gitea one.
- Tests in `test/action.test.ts` and `test/add.test.ts`.

### Phase 7: Try it here

- Enable autoreview on this repository with `add.sh`, open a small trial pull request with a
  deliberate flaw, label it, and check: findings post as `github-actions[bot]` with role headers,
  a fix is pushed and dispatched checks run, the reviewer resolves the thread, and the summary and
  labels are right. Fix what misbehaves here and log it under Obstacles. Close the trial pull
  request afterwards.

## Obstacles

- **Copilot refused the built-in token on this personal repository** ("Access denied by policy
  settings", for every model, via both `GITHUB_TOKEN` and `COPILOT_GITHUB_TOKEN`), although the
  docs say a personal repository bills the owner's seat. Workaround: the workflow template passes
  `secrets.COPILOT_GITHUB_TOKEN || github.token`, so a fine-grained token with "Copilot
  Requests" can stand in. The organization path at work is unaffected.
- `gh auth status` in the agent's shell gets its login from `GITHUB_TOKEN`, so unsetting it for a
  local smoke test also logs gh out. Kept the variable.

## Found bugs
