---
name: subagents
description: Route and manage delegated work across Pi, Claude, Codex, and Cursor. Read before spawning any subagent or choosing a task_class. Do not load for work that stays in the parent session.
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Decide whether to delegate

Work in the parent by default. Delegate an independent task when it can run alongside useful parent work, isolate noisy research, or provide a requested second opinion. A small fix or sequential investigation does not need a recon/implementation/review chain. Use parallel tool calls for simple independent reads.

Give each child one owner and one finish line. Do not repeat its assigned work in the parent. Keep dependent edits with one owner; do not split them merely to create parallelism. An inexpensive model still costs startup, context, review, and coordination time.

## Pick a task_class

`subagent_spawn` takes a `task_class`. `extensions/subagents/src/routing.ts` derives the harness, model, and effort from it and appends the row's cap to the child's prompt. Pass the class; do not retype the model id.

| `task_class`             | The work                                                       | Harness / model                    | Effort   | Cap the class enforces in the child prompt                          |
| ------------------------ | -------------------------------------------------------------- | ---------------------------------- | -------- | ------------------------------------------------------------------- |
| `recon`                  | locate files, trace a flow, summarize prior art                | `cursor` / `grok-4.7-fast`  | `medium`   | read-only                                                           |
| `bulk_scan`              | one slice of a wide fan-out — same question over many paths    | `pi` / `opencode/deepseek-v4-flash`| `medium` | read-only; only the named paths; findings as `file:line`, not prose |
| `mechanical_edit`        | apply a stated diff, rename, mirror a file, delete dead code   | `cursor` / `grok-4.7-fast`  | `medium`   | ≤3 files, all named in the prompt; zero design decisions left open  |
| `scoped_implementation`  | one component or endpoint, behavior fully specified            | `cursor` / `grok-4.7`       | `medium`  | ≤8 files; behavior stated, not just the goal                        |
| `ui_tweak`               | frontend, visual, or interaction work — polish, animation, layout | `claude` / `opus`               | `medium`   | ≤8 files; preserve existing patterns and tokens                     |
| `open_implementation`    | vague guidance, decomposition, or plan orchestration           | `claude` / `fable`                 | `high`   | report discrete steps, open questions, and judgment calls            |
| `mcp_dependent`          | Linear, Figma, Sentry, Notion, Liftoff prod                    | `claude` / `sonnet`                | `medium` | fetch and report; no implementing, no MCP writes                    |
| `review`                 | is this right, what's risky, what's missing                    | `codex` / `gpt-5.6-terra`          | `high`   | read-only, second opinion not second author, >80% confidence        |
| `deep_question`          | one hard problem, no breadth                                   | `pi` / `openai-codex/gpt-6-luna` | `high`  | read-only; answer the one question, do not broaden                  |

Pick the class from the _work_, and cap the task to what that class allows. A cheap model is not a worse version of a good one — it is a model that must be given less rope. If a task does not fit a row, split it until it does; never widen the rope instead.

Effort defaults are medium for routine work and high for planning, review, and hard questions. Use higher effort only for a specific reason or user request; do not upgrade merely because a task has several files.

Split only along independent boundaries. If a task does not fit a class, narrow the deliverable or keep it in the parent instead of building a chain of handoffs. Escalate model or effort when a concrete reasoning failure warrants it, not as a substitute for scope.

**Never let a `pi` spawn inherit its model.** Omitting `model` and `reasoning_effort` inherits the parent's _current_ model, and every `/model` pick and Ctrl+P cycle rewrites the global default. A `task_class` sets both, which is the reason to prefer it. A spawn without a class must pass both by hand.

Overriding a class's `model` re-points its harness and is the normal way to scale a review down. Overriding `harness` **drops the class's model** — name the model too. See `reference/budgets.md`.

## Prompt contract

On top of the role, every spawn that may write files states all six, or it does not get spawned:

1. **Goal** — the outcome, in one sentence.
2. **In scope** — the files it may touch, named. "Find the relevant files" is a recon task, not an edit task.
3. **Out of scope** — what not to touch, beyond what the role already forbids.
4. **Skills to read, by path** — subagents inherit project skills but will not find them from a terse prompt. Name them: "read `.agents/skills/database/SKILL.md` before writing the migration".
5. **Verify** — the exact focused repository commands that must pass. Use the project's current instructions for typechecking and tests. Assign shared-database tests and full-suite verification to one owner; do not run them concurrently in parent and children.
6. **Report** — what to hand back.

State the stopping condition. Finish when the assigned behavior and focused checks are complete; do not add adjacent fixes, abstractions, or review rounds. Preserve existing loading, request concurrency, state, and public contracts unless changing them is the task. A complete short prompt is better than padding it to a character target.

## Execution limits and checkpoints

Every run defaults to **40 finalized assistant messages or 600 seconds**, whichever comes first. `max_turns` and `timeout_seconds` on `subagent_spawn` override these limits for an explicitly larger task. `subagent_send` resumes the existing context with a fresh run budget; it is not an automatic retry.

Return a partial checkpoint before the limit: verified findings, files changed, checks run, blockers, and the next action. The harness interrupts at the limit and reports an error with available partial text and the saved transcript, never a clean completion. Interrupted writes are not rolled back; inspect the working tree before resuming. A hard stop cannot guarantee the child wrote a complete summary.

After two attempts at the same failure without new evidence, report the blocker. Use background terminals for CI and long commands rather than dedicating a child to polling them. Do not restart a budget-limited child unchanged; narrow the remaining task or deliberately grant more time before spawning a replacement.

## Roles

pi has no agent-definition parameter, so standing rules live in a role file. Open the spawn prompt with:

```
Read /Users/acs/.pi/agent/skills/subagents/roles/<role>.md and follow it.
```

| Role          | For                                  | Writes? |
| ------------- | ------------------------------------ | ------- |
| `recon`       | mapping, tracing, locating prior art | no      |
| `implementer` | any spawn that changes files         | yes     |

The role carries the standing rules — scope discipline, lockfile and generated-file exclusions, which skills to read by path, verify-and-report shape, ">80% confident" for review. The prompt then carries only what is specific to _this_ task. That is what keeps a spawn prompt short without making it thin.

There is no `reviewer` role — the repo's own review skill already carries the checklist. `reference/reliability.md` has the four lines a codex reviewer needs on top of it, and why codex needs the paths named.

## Spawn and manage

Call `subagent_spawn` with a complete `prompt`, a short `name`, and a `task_class`, plus optional `working_dir` and any per-field override. `harness` is required only when no class fits. **At most four subagents run concurrently** (`MAX_RUNNING`, `extensions/subagents/src/domain.ts`). The binding limit is your own ability to read the reports, not cost.

- `subagent_check({ id })`: peek without blocking. Reports context used and turn count.
- `subagent_send({ id, message })`: follow up on a settled near-miss, or correct a drifting run.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.

**Concurrent writers need separate trees.** Any number of read-only spawns can share a tree. Two spawns that write should not: run them sequentially, or give each its own `kit` worktree via `working_dir`. Files are shared even when features are not.

**Report, don't relay verbatim.** A finished subagent's output is written for you, not for the user. Read it, keep what changes the decision, and say it in your own words — including when a child's claim looks wrong. Never paste a wall of child output as your answer, and never state what a still-running child found.

## Reference

Load only the file you need.

- **`reference/harnesses.md`** — per-harness model ids, effort tiers, thinking-budget mappings, the OpenCode Zen catalogue, and which providers are authenticated. Read before overriding a class's model or harness, or when no class fits.
- **`reference/budgets.md`** — which of the four pools each harness spends, the Codex weekly-cap rules, and how per-field overrides interact.
- **`reference/reliability.md`** — context death and compaction per harness, `subagent_send` semantics per harness, read-only enforcement gaps, and the reviewer prompt.
