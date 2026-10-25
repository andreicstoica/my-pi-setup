# Reliability

## Bounded runs and partial results

Watch runtime, turns, and context. The manager interrupts each run after its `max_turns` or `timeout_seconds` budget (40 assistant messages or 600 seconds by default). A limit returns an error with available partial text and preserves the transcript. It does not roll back edits or prove the work is complete.

Before reaching a limit, the child must finish with a partial report: verified findings, files changed, checks run, blockers, and next action. Compaction differs across harnesses; it is not a checkpoint or a reason to keep exploring. A forced interruption preserves available output, not a guaranteed complete summary.

After a limit, inspect the working tree and transcript before continuing. Use `subagent_send` for a bounded remaining question on the same context; it starts a fresh per-run budget. Do not automatically respawn the original task. If more time is justified, create a replacement with explicit limits and the checkpoint rather than repeating exploration.

If a child uses substantial context or runtime without narrowing the problem, cancel it and reassess its premise. Do not infer failure from a context percentage alone, and do not poll for progress. Results arrive automatically; `subagent_wait` is only for a genuine dependency.

For CI or other long external commands, let a background terminal own the wait. A child should not spend its reasoning budget polling a command.

## Sending to a running child

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

## Read-only is instruction-only

`policy.ts` denies MCP writes and mutating `aws` calls, but **only on the `claude` harness** — it is a Claude Agent SDK `PreToolUse` hook, so codex, cursor, and pi children are not covered by it at all. And even on claude, pi cannot restrict tools per spawn the way Claude Code's `allowed-tools` does.

cursor-agent is a separate CLI with its own permission model, and it runs under `--force`. Same gap as the codex harness. Anything a cursor child must not do has to be stated in its prompt.

So a `recon` or review prompt must state "do not edit any file" in its own words, on every harness. A role that was supposed to be read-only having touched files is a real failure worth reporting to the user.

## The reviewer prompt

Claude Code and Codex both keep delegated work in versioned agent definitions (`.claude/agents/code-reviewer.md`, `~/.codex/agents/*.toml`) rather than retyping the standards into each spawn. pi points the child at a role file instead.

**There is no `reviewer` role.** The repo's own `.agents/skills/review/SKILL.md` already carries the checklist, the generated-file exclusions, the ">80% confident" bar, "read the full file, not only the diff", and the output format. A role file duplicated all of it. Point the reviewer at the skill instead, and add the three things the skill does not say — because it is written for a review in a normal session, not for an autonomous child:

```
Read-only. You are a second opinion, not a second author. Do not edit, stage, or commit anything.
Read .agents/skills/review/SKILL.md and follow its checklist and output format.
Read the domain skills it references by path: .agents/skills/{backend-patterns,frontend-patterns,database,celery-tasks,test-conventions}/SKILL.md
Check .claude/rules/ for path-specific rules (the tree only exists under .claude/, but its content is harness-neutral).
```

Name only the relevant skill paths so the review is reproducible. Current Codex discovers user and project `.agents/skills` and inherits skills in native subagents; explicit paths identify the intended project version rather than compensating for missing discovery.
