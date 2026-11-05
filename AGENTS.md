# Agent notes

Read [README.md](README.md) first, especially How it works and Development. Follow these
design rules when changing the code.

## Design

- **Autoreview runs the process. Instructions and settings come from somewhere else.** This
  repository owns the deliberation: when to review, how threads move, what gets pushed and posted.
  Personal or team preferences, such as standing instructions, commit conventions and attribution
  settings, belong to whoever runs it. A workflow installs them in its own step before the
  deliberation, for example with `KurtPreston/dotagents`' action, which exports `COPILOT_HOME`.
  Don't hard-code a preferences source in `action.yml` or the loop. `add.sh --setup-action`
  writes those steps into a workflow.
- **The loop doesn't know which forge it's on.** Talk to the host only through the `Forge`
  interface (`src/forge.ts`). Host specifics stay in `src/github.ts`, `src/gitea.ts`,
  `src/forges.ts` (which picks one), `src/add/` and the templates.
- **Agents answer, the loop acts.** An agent returns a JSON verdict checked against
  `src/schemas.ts`. Only the loop posts, pushes or resolves.
- **The pull request holds all state.** Markers in comments let a crashed run resume. Don't add
  state stored anywhere else.

## Validation

```sh
npm ci
npm run typecheck && npm run lint && npm run format:check && npm test
```

## Pull requests

Autoreview reviews its own changes. When opening a pull request here, add the `autoreview` and
`autofix` labels, such as with `gh pr create --label autoreview --label autofix`.
