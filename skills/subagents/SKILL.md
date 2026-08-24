---
name: subagents
description: Route and manage delegated work across Pi, Claude, Codex, and Cursor. Read before spawning any subagent or choosing a task_class. Do not load for work that stays in the parent session.
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Pick a task_class

`subagent_spawn` takes a `task_class`. `extensions/subagents/src/routing.ts` derives the harness, model, and effort from it and appends the row's cap to the child's prompt. Pass the class; do not retype the model id.

| `task_class`             | The work                                                       | Harness / model                    | Effort   | Cap the class enforces in the child prompt                          |
| ------------------------ | -------------------------------------------------------------- | ---------------------------------- | -------- | ------------------------------------------------------------------- |
| `recon`                  | locate files, trace a flow, summarize prior art                | `cursor` / `cursor-grok-4.6-fast`  | `high`   | read-only                                                           |
| `bulk_scan`              | one slice of a wide fan-out — same question over many paths    | `pi` / `opencode/deepseek-v4-flash`| `medium` | read-only; only the named paths; findings as `file:line`, not prose |
| `mechanical_edit`        | apply a stated diff, rename, mirror a file, delete dead code   | `cursor` / `cursor-grok-4.6-fast`  | `high`   | ≤3 files, all named in the prompt; zero design decisions left open  |
| `scoped_implementation`  | one component or endpoint, behavior fully specified            | `cursor` / `cursor-grok-4.6`       | `xhigh`  | ≤8 files; behavior stated, not just the goal                        |
| `ui_tweak`               | frontend, visual, or interaction work — polish, animation, layout | `claude` / `opus`               | `high`   | ≤8 files; preserve existing patterns and tokens                     |
| `open_implementation`    | vague guidance, decomposition, or plan orchestration           | `claude` / `fable`                 | `high`   | report discrete steps, open questions, and judgment calls            |
| `mcp_dependent`          | Linear, Figma, Sentry, Notion, Liftoff prod                    | `claude` / `sonnet`                | `medium` | fetch and report; no implementing, no MCP writes                    |
| `review`                 | is this right, what's risky, what's missing                    | `codex` / `gpt-5.6-terra`          | `high`   | read-only, second opinion not second author, >80% confidence        |
| `deep_question`          | one hard problem, no breadth                                   | `pi` / `openai-codex/gpt-5.6-luna` | `xhigh`  | read-only; answer the one question, do not broaden                  |

Pick the class from the _work_, and cap the task to what that class allows. A cheap model is not a worse version of a good one — it is a model that must be given less rope. If a task does not fit a row, split it until it does; never widen the rope instead.

Two rules override the table:

- **The orchestrator is never luna.** Decomposition is the judgment most sensitive to model strength, and a bad split cannot be recovered by strong children. If the parent is on luna and the user wants real work done, say so and ask them to switch before you fan out.
- **Splitting beats upgrading.** When a task is too big for its class, the fix is two smaller spawns, not the same prompt on a bigger model. Oversized prompts fail the same way on every model — they just cost more first.

**Never let a `pi` spawn inherit its model.** Omitting `model` and `reasoning_effort` inherits the parent's _current_ model, and every `/model` pick and Ctrl+P cycle rewrites the global default. A `task_class` sets both, which is the reason to prefer it. A spawn without a class must pass both by hand.

Overriding a class's `model` re-points its harness and is the normal way to scale a review down. Overriding `harness` **drops the class's model** — name the model too. See `reference/budgets.md`.

## Prompt contract

On top of the role, every spawn that may write files states all six, or it does not get spawned:

1. **Goal** — the outcome, in one sentence.
2. **In scope** — the files it may touch, named. "Find the relevant files" is a recon task, not an edit task.
3. **Out of scope** — what not to touch, beyond what the role already forbids.
4. **Skills to read, by path** — subagents inherit project skills but will not find them from a terse prompt. Name them: "read `.agents/skills/database/SKILL.md` before writing the migration".
5. **Verify** — the exact repository commands that must pass. For Liftoff frontend work use `tsc -b`, never bare `tsc --noEmit`; name the specific lint and test commands. Not "make sure it works".
6. **Report** — what to hand back.

A prompt under ~1000 characters for an implementation task is a warning sign; the failed runs in this setup's history averaged ~900 and produced scope creep, committed lockfiles, and tests written against the implementation.

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
