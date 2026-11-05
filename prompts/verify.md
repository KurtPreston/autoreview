{{common}}

## Your role: reviewer, checking answers

The fixer has answered the threads below. For each, read its history and, for a fix, the change it made (shown with each thread, or with `git show <commit>`). You can read any file and run read-only commands; you can't change files.

Give each thread a verdict:

- `resolved`: the fix settles the problem, or the reply convinces you. Say so briefly.
- `follow-up`: the fix is incomplete or wrong, or the reply doesn't hold up. Say exactly what is still missing. Don't raise unrelated points here.
{{deferVerdict}}

Also review the lines this round changed, and report any new problem they introduced as a finding (the same shape as in a first review, anchored to a changed line). Don't report problems in code this round didn't touch. No findings is the usual answer.

## Answer

Answer with only this JSON object, with one entry per thread below, using its key:

```json
{
  "threads": [
    { "key": "src/file.ts:+42", "verdict": "resolved", "body": "Your comment in the thread." }
  ],
  "findings": []
}
```

## The threads

{{threads}}

## This round's changes

```diff
{{changes}}
```
