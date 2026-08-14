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

Never let a `pi` spawn inherit its model. Omitting `model` and `reasoning_effort` inherits the parent's _current_ model — and because every `/model` pick and Ctrl+P cycle rewrites the global default, the parent may be on a cheap model without either of us having chosen it for this task. A `task_class` sets both, which is the reason to prefer it; a spawn without a class must pass both by hand.

Spawn `pi` subagents on the `openai-codex` provider, or on `opencode` (OpenCode Zen) for the non-OpenAI models it unlocks.

- The `anthropic` provider has no credential here — the spawn fails. Anthropic models belong on the **`claude` harness**, which is covered by the Max subscription.
- `openrouter` is authenticated but reserved for manual use. Do not spawn on it.
- `opencode` is OpenCode Zen (hosted) and **is** authenticated. It is not the local `opencode` CLI, and it is not a subagent harness — it is a pi provider, reached as `opencode/<model-id>`. Only part of its catalogue is enabled on this account; see the table below.
- Cursor is its own harness (`harness: "cursor"`), not a pi provider.

Prefer `provider/model-id`; a bare model id only works when unambiguous.

| Model                        | Use for                                | Effort            |
| ---------------------------- | -------------------------------------- | ----------------- |
| `openai-codex/gpt-5.6-sol`   | difficult coding work                  | `high`            |
| `openai-codex/gpt-5.6-terra` | coding                                 | `medium`          |
| `openai-codex/gpt-5.6-luna`  | cheap/mechanical passes; deep one-offs; bounded UI tweaks | `medium`, `xhigh`, `max` |
| `openai-codex/gpt-5.3-codex-spark` | fast, fully specified work — run a command, answer a named lookup. **Its own weekly cap**, separate from the shared Codex one | `high` (`low`/`medium`/`xhigh` also valid; **no `max`**) |

### OpenCode Zen models (`opencode/…`)

Most of the Zen catalogue returns `401 "Model is disabled"` on this account — **every** `claude-*`, `gpt-*`, and `gemini-*` id is disabled, so never route those through Zen (use `openai-codex` or the `claude` harness instead). These are the ids verified to actually run:

| Model                    | $/Mtok in-out | Use for                                        |
| ------------------------ | ------------- | ---------------------------------------------- |
| `opencode/grok-4.5`      | 2 / 6         | the strongest Zen option; general + coding     |
| `opencode/kimi-k3`       | 3 / 15        | long-form reasoning                            |
| `opencode/deepseek-v4-pro` | 1.74 / 3.84 | coding                                         |
| `opencode/glm-5.2`       | 1.4 / 4.4     | coding                                         |
| `opencode/qwen3.6-plus`  | 0.5 / 3       | cheap general work                             |
| `opencode/minimax-m3`    | 0.3 / 1.2     | cheap mechanical passes                        |
| `opencode/deepseek-v4-flash` | 0.14 / 0.28 | cheapest metered option — the `bulk_scan` model |
| `opencode/big-pickle`    | free          | throwaway/experimental                         |

Also free and working, but unproven for real work: `laguna-s-2.1-free`, `longcat-2.0-free`, `mimo-v2.5-free`, `nemotron-3-ultra-free`.

Re-check availability by spawning a trivial prompt; a disabled model fails immediately with `401 Model is disabled` rather than burning a run.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Claude Code Harness

**Harness:** `claude`
**Prompt nicknames:** “claude”, “Claude Code”, “claude agent”, “claude subagent”, "cc"
**The Max plan is generous, so this harness is not the one to economize on.** Frontend work and MCP work belong here. Reserve Fable for vague guidance, decomposition, and plan orchestration; use Opus for frontend and for implementation that needs real strength.

| Model hint | Model               | Recommended effort | Reach for it when                                       |
| ---------- | ------------------- | ------------------ | ------------------------------------------------------- |
| `opus`     | latest Claude Opus  | `high`             | frontend, visual, animation, interaction work            |
| `fable`    | latest Claude Fable | `high`             | the goal is still vague and needs decomposition or a plan |
| `sonnet`   | latest Claude Sonnet | `high`            | multi-step MCP work that does not need Opus              |

The backend passes `model` through to the Claude Agent SDK, so any alias it accepts works.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The extension maps these to Claude thinking-token budgets: 0, 1,024, 4,096, 10,000, 16,000, 32,000, and 63,999 tokens respectively.

Requires Claude Code to be installed and authenticated.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Best default for coding work:** `gpt-5.6-sol` at `high`. **For review/judgment work, start lower** — see the codex budget rule under "Scoping work to models"; the weekly cap is shared across every codex spawn, so a review that `terra` can settle should not be given to `sol`.

| Model           | Recommended effort | Reach for it when                                                      |
| --------------- | ------------------ | ---------------------------------------------------------------------- |
| `gpt-5.6-luna`  | `high`             | bounded diff, single-file check, recon, mechanical work                 |
| `gpt-5.6-terra` | `high`             | a normal PR-sized review — the default review model                     |
| `gpt-5.6-sol`   | `high`             | coding work, or a review where the call is hard or the blast radius big |
| `gpt-5.3-codex-spark` | `high`       | fully specified work only; bills to a **separate** weekly cap, so it does not compete with the reviews above. `max` is not a supported effort for it |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model; `off`/`minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Cursor Harness

**Harness:** `cursor`
**Prompt nicknames:** “cursor”, “cursor-agent”, “Cursor CLI”, “cursor agent”, “cursor subagent”
**This is now the cheap workhorse harness**, not a specialist one: `recon`, `mechanical_edit`, and `scoped_implementation` all route here, because the Cursor plan is flat and every run on it is a run that did not spend the Codex cap.

**Best default:** `cursor-grok-4.6-fast` for read and mechanical work; `cursor-grok-4.6` (no `-fast`) at `xhigh` when the work needs depth. `composer-2.5` is Cursor's own model — reach for it when grok is struggling with Cursor-specific tooling.

**Cursor encodes reasoning effort and fast mode in the model id, not in flags.** There is no `--effort` and no `--fast`; `cursor-grok-4.6` on its own is not a real id. The extension resolves a family plus `reasoning_effort` into the real id, so pass the family and let it do that.

| Model                  | Effort tiers?                    | Recommended effort | Resolves to                 |
| ---------------------- | -------------------------------- | ------------------ | --------------------------- |
| `cursor-grok-4.6`      | `low`/`medium`/`high`/`xhigh`    | `xhigh`            | `cursor-grok-4.6-xhigh`     |
| `cursor-grok-4.6-fast` | `low`/`medium`/`high`/`xhigh`    | `high`             | `cursor-grok-4.6-high-fast` |
| `composer-2.5`         | no — effort is ignored           | —                  | `composer-2.5`              |
| `composer-2.5-fast`    | no — effort is ignored           | —                  | `composer-2.5-fast`         |
| `cursor-grok-4.5`      | `high` only — the lower tiers were retired | `high`   | `cursor-grok-4.5-high`      |

**Fast mode is a `-fast` suffix on the `model` string** — there is no separate parameter. Append it to the family (`cursor-grok-4.6-fast`) or to a full id (`cursor-grok-4.6-low-fast`). Fast trades depth for latency; use it for reads and mechanical passes, not for judgment.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. For grok 4.6 these map `off`/`minimal`/`low` → `low`, `medium` → `medium`, `high` → `high`, `xhigh`/`max` → `xhigh`; omitting effort gives `medium`. An effort the family has no tier for walks to the nearest one it does have — which is what keeps an inherited `max` from failing a 4.5 spawn. A tier you *spell out* that does not exist still fails with the valid ids listed, because that is a mistake about the id, not an inherited default.

`grok`, `grok-4.6`, and `composer` are accepted as shorthand — bare `grok` means 4.6. A full id is passed through unchanged, as is Cursor's bracket-override form (`'claude-opus-4-8[context=1m,effort=high,fast=false]'`).

Requires the Cursor Agent CLI (`cursor-agent`) to be installed and logged in. Refresh the id table with `cursor-agent --list-models`.

**No capability guard.** `policy.ts` — which denies MCP writes and mutating `aws` calls — is a Claude Agent SDK hook and **cannot reach a cursor child**; cursor-agent is a separate CLI with its own permission model, and it runs under `--force`. Same gap as the codex harness. Anything a cursor child must not do has to be stated in its prompt.

## Scoping work to models

**This table now lives in code.** `subagent_spawn` takes a `task_class`, and `extensions/subagents/src/routing.ts` derives the harness, model, and effort from it and appends the row's cap to the child's prompt. Pass the class; do not retype the model id. The table below is the reasoning behind each row — read it to choose a class, or to decide that a class is wrong for this task.

Pick the class from the _work_, and cap the task to what that class allows. A cheap model is not a worse version of a good one — it is a model that must be given less rope. If a task does not fit a row, split it until it does; never widen the rope instead.

| `task_class`             | The work                                                       | Harness / model                    | Effort   | Cap the class enforces in the child prompt                          |
| ------------------------ | -------------------------------------------------------------- | ---------------------------------- | -------- | ------------------------------------------------------------------- |
| `recon`                  | locate files, trace a flow, summarize prior art                | `cursor` / `cursor-grok-4.6-fast`  | `high`   | read-only                                                           |
| `bulk_scan`              | one slice of a wide fan-out — same question over many paths    | `pi` / `opencode/deepseek-v4-flash`| `medium` | read-only; only the named paths; findings as `file:line`, not prose |
| `quick_task`             | fully specified work — run stated commands, answer a named lookup or grep | `pi` / `openai-codex/gpt-5.3-codex-spark` | `high` | only the named commands and the one question; no source file may change |
| `mechanical_edit`        | apply a stated diff, rename, mirror a file, delete dead code   | `cursor` / `cursor-grok-4.6-fast`  | `high`   | ≤3 files, all named in the prompt; zero design decisions left open  |
| `scoped_implementation`  | one component or endpoint, behavior fully specified            | `cursor` / `cursor-grok-4.6`       | `xhigh`  | ≤8 files; behavior stated, not just the goal                        |
| `ui_tweak`               | frontend, visual, or interaction work — polish, animation, layout | `claude` / `opus`               | `high`   | ≤8 files; preserve existing patterns and tokens                     |
| `open_implementation`    | vague guidance, decomposition, or plan orchestration           | `claude` / `fable`                 | `high`   | report discrete steps, open questions, and judgment calls            |
| `mcp_dependent`          | Linear, Figma, Sentry, Liftoff prod                            | `claude` / `fable`                 | `high`   | fetch and report; no implementing, no MCP writes                    |
| `review`                 | is this right, what's risky, what's missing                    | `codex` / `gpt-5.6-terra`          | `high`   | read-only, second opinion not second author, >80% confidence        |
| `deep_question`          | one hard problem, no breadth                                   | `pi` / `openai-codex/gpt-5.6-luna` | `xhigh`  | read-only; answer the one question, do not broaden                  |

**Which pool a class spends is the whole design.** Five budgets, and they are not interchangeable:

| Pool                    | Spent by                                | Costs                                                        |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------ |
| Cursor plan             | `cursor` harness                        | flat — free at the margin, so read and mechanical work lives here |
| OpenCode Zen (metered)  | `pi` + `opencode/…`                     | real cents per run, but no cap and no queue — this is what a wide fan-out is for |
| Claude Max              | `claude` harness (Opus, Fable)          | generous — frontend work and MCP work belong here            |
| Codex weekly cap        | `codex` harness, and `openai-codex/…` on pi | the scarcest pool, shared between every codex spawn and every luna spawn |
| Codex **Spark** weekly cap | `openai-codex/gpt-5.3-codex-spark`, on either the `pi` or the `codex` harness | its own window, shown as a second bar in the Codex TUI — spending it does not move the bar above |

The rule that follows: **cheap read and edit work must never touch the shared Codex pool.** `openai-codex/gpt-5.6-luna` is cheap in dollars and expensive in the only currency that runs out — it draws from the same weekly cap as `review`. `deep_question` is the one remaining exception, because it is a single call, not a fan-out. A `routing.test.ts` case asserts the read/mechanical classes stay off that pool.

**Spark is exempt from that rule, and it is the only openai-codex model that is.** It bills to the separate window above, so a `quick_task` fan-out costs nothing the `review` budget would have wanted. Two things follow:

- **`quick_task` is not a cheaper `recon`.** Spark is fast, not smart. `recon` keeps `cursor-grok-4.6-fast` and `bulk_scan` keeps `opencode/deepseek-v4-flash` because both read better than Spark does. Choose per task: if the child has to decide *where* to look, or judge what it found, use `recon`/`bulk_scan`. If the path, pattern, or command is already named in the prompt and the child only has to go get the answer, use `quick_task`.
- **Spark does not accept `max`.** Its efforts are `low`, `medium`, `high`, `xhigh`. `high` is both its default and the right one — a task that wants `max` is not a `quick_task`.

Verified 2026-08-14: Spark runs on both `codex exec -m gpt-5.3-codex-spark` and `pi --provider openai-codex --model gpt-5.3-codex-spark`. It is `supported_in_api: false`, so it is reachable through ChatGPT auth only — never through an API key.

**Frontend work goes to Opus on the `claude` harness.** Visual, layout, animation, and interaction work is where model strength shows most and where a cheap model wastes the most attempts. Claude Max pays for it, so there is no reason to economize there.

**Overrides are per field, and the harness is special.** `model` alone re-points the class's harness — that is how the codex budget rule below is applied (`review` + `model: gpt-5.6-luna` for a bounded diff). But overriding `harness` **drops the class's model**, because a model id belongs to one harness: `openai-codex/gpt-5.6-luna` means nothing to codex or claude. After a harness override, name the model too.

**The caps are still instruction-only.** The class writes them into the child's prompt so they no longer depend on you remembering to — but nothing inspects the child's diff. A `recon` child that edited a file is a real failure worth reporting to the user.

**Bounded frontend work goes to Opus.** Use `ui_tweak` for UI polish and interaction changes with a clear target. Use `open_implementation` with Fable only when the goal needs interpretation, decomposition, or plan orchestration before implementation. Discrete review work remains Codex work.

**Codex has a hard usage budget — spend it deliberately.** It is a weekly subscription cap, not a per-call cost, so a burned budget blocks the reviews you have not thought of yet. Three rules:

- **Scale the model to the review, not to the anxiety.** `luna` for a bounded diff or a single-file check, `terra` for a normal PR-sized review, `sol` only when the call is genuinely hard or the blast radius is large. Do not open at `sol`.
- **One reviewer per question.** Do not fan out three codex reviewers over the same diff for consensus — that is 3× budget for a vote you did not need. If you want a second opinion on a codex verdict, take it from `claude`/`fable`; the disagreement between two different backends is worth more than agreement between two codex runs.
- **Check the budget before a big fan-out.** `/usage` shows the codex weekly window. If it is already deep into the week's allowance, downgrade the model or route the review to `claude`/`fable` and say so, rather than silently spending the rest.

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

**There is no `reviewer` role.** The repo's own `.agents/skills/review/SKILL.md` already carries the checklist, the generated-file exclusions, the ">80% confident" bar, "read the full file, not only the diff", and the output format. A role file duplicated all of it. Point the reviewer at the skill instead, and add the three things the skill does not say — because it is written for a review in a normal session, not for an autonomous child:

```
Read-only. You are a second opinion, not a second author. Do not edit, stage, or commit anything.
Read .agents/skills/review/SKILL.md and follow its checklist and output format.
Read the domain skills it references by path: .agents/skills/{backend-patterns,frontend-patterns,database,celery-tasks,test-conventions}/SKILL.md
Check .claude/rules/ for path-specific rules (the tree only exists under .claude/, but its content is harness-neutral).
```

Name those paths every time. Review now runs on `codex`, and **codex does not discover `.agents/skills/` on its own** — claude and pi do. A codex reviewer that is only told "use the review skill" will not read it.

The role carries the standing rules — scope discipline, lockfile and generated-file exclusions, which skills to read by path, verify-and-report shape, ">80% confident" for review. The prompt then carries only what is specific to _this_ task. That is what keeps a spawn prompt short without making it thin.

Read-only is instruction-only here. `policy.ts` denies MCP writes and mutating `aws` calls, but **only on the `claude` harness** — it is a Claude Agent SDK `PreToolUse` hook, so codex, cursor, and pi children are not covered by it at all. And even on claude, pi cannot restrict tools per spawn the way Claude Code's `allowed-tools` does. So a `recon` or review prompt must state "do not edit any file" in its own words, on every harness, and a role that was supposed to be read-only having touched files is a real failure worth reporting to the user.

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

Call `subagent_spawn` with a complete `prompt`, a short `name`, and a `task_class`, plus optional `working_dir` and any per-field override. `harness` is required only when no class fits. **At most eight subagents run concurrently** — raised from four once the cheap classes moved off the Codex cap. The binding limit is now your own ability to read eight reports, not cost: eight children that return eight walls of text you skim is worse than three you actually use.

- `subagent_check({ id })`: peek without blocking.
- `subagent_send({ id, message })`: follow up on a settled near-miss, or correct a drifting run.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.

**Watch context, not the clock. No subagent is ever compacted.** This is the failure mode to design against: no harness compacts a child, so a child that fills its window is killed and returns **nothing at all** — every finding it had already made is lost with it. There is no spawn timeout either, so a subagent that looks hung is usually burning its window.

Three defenses, in order of how much they save:

1. **The prompt asks the child to land early.** Every spawn now carries "you will not be compacted — if your context is filling, report what you have as partial with the next step named". That converts a total loss into a usable partial, and it is the only defense that works while you are not watching.
2. **`subagent_check` reports context used and turn count.** A run past **60% with no text output yet** is not going to finish cleanly: cancel it and re-spawn the work split in two, rather than re-running the same prompt.
3. **Split before spawning.** A child dies on context because it was given breadth, not because the model was weak. `bulk_scan` exists for exactly this — five children each reading three directories will finish where one child reading fifteen dies.

A wide fan-out of cheap children is now affordable, which makes (3) the cheap fix it was not before. Prefer eight narrow `bulk_scan` slices to one broad `recon`.

**`subagent_send` is the cheap fix; re-spawning is the expensive one.** A follow-up reuses the child's context — the role file it read, `AGENTS.md`, its greps, its file reads. A re-spawn pays for all of that again. So a report that is nearly right, or a run you can see drifting, takes a send.

**What a send actually does depends on the harness**, and the difference matters when a run is already going wrong:

| Harness  | Send to a **running** child                                             |
| -------- | ----------------------------------------------------------------------- |
| `pi`     | reaches the run before its next model call — a real course correction    |
| `claude` | accepted, but queued for a later response, not the current one          |
| `codex`  | queued; picked up only once the current run settles                     |
| `cursor` | queued; picked up only once the current run settles                     |

No harness interrupts. If a codex or cursor run must stop **now**, that is `subagent_cancel`, not a send. Sending to a settled child starts a fresh run on its existing context and occupies one of the four slots.

**A send does not repair a wrong premise.** Reusing context is only a saving when the context is right and the answer is incomplete. A child that misunderstood the task carries that misunderstanding into every follow-up; cancel it and spawn a prompt that says what the follow-ups would have had to say. Past two sends to one child, the prompt was the problem — the tool says so too.

**Report, don't relay verbatim.** A finished subagent's output is written for you, not for the user. Read it, keep what changes the decision, and say it in your own words — including when a child's claim looks wrong. Never paste a wall of child output as your answer, and never state what a still-running child found; the result arrives on its own.
