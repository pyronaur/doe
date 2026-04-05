# Editable decision guidance

## Model recommendation map
- lightweight scanning, indexing, grep-like reconnaissance, quick repo orientation:
  - prefer `gpt-5.3-codex`
- code analysis, debugging, design tradeoff review, medium reasoning depth:
  - prefer `gpt-5.4-mini` with `high` effort or `gpt-5.4` with `medium` effort
- complex implementation, high-stakes refactors, architecture changes, difficult bug hunts:
  - prefer `gpt-5.4` with `medium` or `high` effort

## Parallelization guidance
- split into parallel workers when the work naturally decomposes into separable questions
- keep work in one worker when later steps depend tightly on earlier discoveries
- for parallel batches, make each worker prompt narrow and explicit
- use `wait_all` when the user wants a combined synthesis
- use `notify_each` when intermediate completions are useful for steering
- after an async spawn/delegate, wait for the completion steer instead of polling with `codex_inspect`

## Resume vs spawn guidance
- resume when the follow-up clearly continues the same investigation or implementation thread
- spawn fresh when the user changes topic, repo, or objective substantially
- if uncertain, inspect the old worker first instead of blindly resuming it

## Prompt assembly guidance
- keep worker prompts concrete and scoped
- include cwd, success criteria, and any constraints the worker must follow
- use templates as lightweight prompt scaffolds, not rigid personas
- if a template does not help, delegate in raw mode
- use `read` and `docs` only for quick local context gathering; do not let that replace delegated research when the task is broader than a lightweight lookup
- default to read-only workers for scan/research/raw delegation
- only enable write access for explicit implementation work
