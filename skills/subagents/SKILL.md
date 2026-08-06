---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Best default:** Use when the user does not request another harness.

Always pass `model` and `reasoning_effort` explicitly. Omitting them inherits the parent's _current_ model — and because every `/model` pick and Ctrl+P cycle rewrites the global default, the parent may be on a cheap model without either of us having chosen it for this task. Never let a spawn inherit.

Spawn `pi` subagents only on the `openai-codex` provider.

- The `anthropic` provider has no credential here — the spawn fails. Anthropic models belong on the **`claude` harness**, which is covered by the Max subscription.
- `openrouter` is authenticated but reserved for manual use. Do not spawn on it.
- There is no `opencode` credential. That provider is OpenCode Zen (hosted, needs `OPENCODE_API_KEY`), not a local `opencode serve`.
- Other CLIs (cursor-agent, opencode) are invoked by the user directly, never by you.

Prefer `provider/model-id`; a bare model id only works when unambiguous.

| Model                        | Use for                                | Effort            |
| ---------------------------- | -------------------------------------- | ----------------- |
| `openai-codex/gpt-5.6-sol`   | coding                                 | `high`            |
| `openai-codex/gpt-5.6-terra` | coding                                 | `medium`          |
| `openai-codex/gpt-5.6-luna`  | cheap/mechanical passes; deep one-offs | `medium`, `xhigh` |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Claude Code Harness

**Harness:** `claude`
**Prompt nicknames:** “claude”, “Claude Code”, “claude agent”, “claude subagent”, "cc"
**Best default:** use the latest fable model on high reasoning. Do not default to anything else, if the user does not specify, use fable.

| Model hint | Model               | Recommended effort |
| ---------- | ------------------- | ------------------ |
| `fable`    | latest Claude Fable | `high`             |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The extension maps these to Claude thinking-token budgets: 0, 1,024, 4,096, 10,000, 16,000, 32,000, and 63,999 tokens respectively.

Requires Claude Code to be installed and authenticated.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Best default:** `gpt-5.6-sol` with `high` effort for coding work. Do not use anything other than sol unless the user specifically asks for it.

| Model           | Recommended effort |
| --------------- | ------------------ |
| `gpt-5.6-sol`   | `high`             |
| `gpt-5.6-terra` | `high`             |
| `gpt-5.6-luna`  | `high`             |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model; `off`/`minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Scoping work to models

Pick the model from the _task class_, and cap the task to what that class allows. A cheap model is not a worse version of a good one — it is a model that must be given less rope. If a task does not fit a row, split it until it does; never widen the rope instead.

| Task class                                                                         | Model                       | Effort   | Hard cap                                                                 |
| ---------------------------------------------------------------------------------- | --------------------------- | -------- | ------------------------------------------------------------------------ |
| **Recon** — locate files, trace a flow, summarize prior art                        | `openai-codex/gpt-5.6-luna` | `medium` | read-only; say "Do not edit any file"                                    |
| **Mechanical edit** — apply a stated diff, rename, mirror a file, delete dead code | `openai-codex/gpt-5.6-luna` | `medium` | ≤3 files, all named in the prompt; zero design decisions left open       |
| **Scoped implementation** — one component or endpoint, behavior fully specified    | `openai-codex/gpt-5.6-sol`  | `high`   | ≤8 files; the prompt states the desired behavior, not just the goal      |
| **Open-ended implementation** — match a design, wire a flow across FE+BE           | `claude` / `fable`          | `high`   | needs the 1M window; **never** sonnet/opus (200k) and never luna         |
| **MCP-dependent** — Linear, Figma, Sentry, Liftoff prod                            | `claude` / `fable`          | `high`   | only harness with MCP; keep it to fetching + reporting, not implementing |
| **Review / judgment** — is this right, what's risky, what's missing                | `claude` / `fable`          | `high`   | read-only; a reviewer that edits stops being a second opinion            |
| **Deep single question** — one hard problem, no breadth                            | `openai-codex/gpt-5.6-luna` | `xhigh`  | one question; luna at xhigh is for depth, not for scope                  |

Two rules that override the table:

- **The orchestrator is never luna.** Decomposition is the judgment most sensitive to model strength, and a bad split cannot be recovered by strong children. If the parent is on luna and the user wants real work done, say so and ask them to switch before you fan out.
- **Splitting beats upgrading.** When a task is too big for its class, the fix is two smaller spawns, not the same prompt on a bigger model. Oversized prompts fail the same way on every model — they just cost more first.

## Roles

Claude Code and Codex both keep delegated work in versioned agent definitions (`.claude/agents/code-reviewer.md`, `~/.codex/agents/*.toml`) rather than retyping the standards into each spawn. pi has no agent-definition parameter, so the same thing is done by pointing the child at a role file. Open the spawn prompt with:

```
Read /Users/acs/.pi/agent/skills/subagents/roles/<role>.md and follow it.
```

| Role          | For                                  | Writes? |
| ------------- | ------------------------------------ | ------- |
| `recon`       | mapping, tracing, locating prior art | no      |
| `implementer` | any spawn that changes files         | yes     |
| `reviewer`    | second opinion on a diff             | no      |

The role carries the standing rules — scope discipline, lockfile and generated-file exclusions, which skills to read by path, verify-and-report shape, ">80% confident" for review. The prompt then carries only what is specific to _this_ task. That is what keeps a spawn prompt short without making it thin.

Read-only is instruction-only here. `policy.ts` denies MCP writes and mutating `aws` globally, but pi cannot restrict tools per spawn the way Claude Code's `allowed-tools` does — so a `recon` or `reviewer` prompt must state "do not edit any file" in its own words too, and a role that was supposed to be read-only having touched files is a real failure worth reporting to the user.

## Prompt contract

On top of the role, every spawn that may write files states all six, or it does not get spawned:

1. **Goal** — the outcome, in one sentence.
2. **In scope** — the files it may touch, named. "Find the relevant files" is a recon task, not an edit task.
3. **Out of scope** — what not to touch, beyond what the role already forbids.
4. **Skills to read, by path** — subagents inherit project skills but will not find them from a terse prompt. Name them: "read `.agents/skills/database/SKILL.md` before writing the migration".
5. **Verify** — the exact commands that must pass: `lint`, `tsc --noEmit`, and the specific tests. Not "make sure it works".
6. **Report** — what to hand back.

A prompt under ~1000 characters for an implementation task is a warning sign; the failed runs in this setup's history averaged ~900 and produced scope creep, committed lockfiles, and tests written against the implementation.

## Concurrent writers need separate trees

Claude Code isolates parallel file-mutating agents in their own git worktrees for a reason: agents editing the same tree at once produce diffs none of them intended, and the parent cannot tell which one did what. pi has no isolation flag — `working_dir` is the whole mechanism — so:

- Any number of read-only spawns can share a tree.
- **Two spawns that write should not share one.** Either run them sequentially, or give each its own `kit` worktree via `working_dir`.
- Never fan out four writers onto one worktree because the tasks "feel unrelated". Files are shared even when features are not.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, `model`, and `reasoning_effort`, plus optional `working_dir`. At most four subagents run concurrently.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.

**Watch context, not the clock.** There is no spawn timeout — a subagent that looks hung is usually burning its window. `subagent_check` reports context used and turn count. A run past **60% with no text output yet** is not going to finish cleanly: cancel it, and re-spawn the work split in two rather than re-running the same prompt. Letting it reach 100% wastes the whole run and returns nothing.

**There is no steer.** Claude Code can send a correcting message into a live agent; pi exposes no such tool — `subagent_send` does not exist, and `/subagents` takeover is the user's, not yours. So a drifting run has exactly two outcomes: let it finish, or cancel and re-spawn with a better prompt. Front-load the prompt accordingly.

**Report, don't relay verbatim.** A finished subagent's output is written for you, not for the user. Read it, keep what changes the decision, and say it in your own words — including when a child's claim looks wrong. Never paste a wall of child output as your answer, and never state what a still-running child found; the result arrives on its own.
