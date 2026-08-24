# Reliability

## Context death and compaction

**Watch context, not the clock — and know which children compact.** A child that fills its window without compaction is killed and returns **nothing at all**; every finding it had already made dies with it. There is no spawn timeout either, so a subagent that looks hung is usually burning its window.

| Harness  | Auto-compacts a child?                                                          |
| -------- | ------------------------------------------------------------------------------- |
| `pi`     | **yes** — a pi child is a real in-process `AgentSession`, and `compaction.enabled` defaults to `true` (`core/settings-manager.js` `getCompactionEnabled`). Threshold and overflow compaction both run inside the child's own prompt loop |
| `claude` | no — Agent SDK subagents do not compact                                          |
| `codex`  | unverified; assume no                                                            |
| `cursor` | unverified; assume no                                                            |

So `bulk_scan` and `deep_question` (both pi) survive a full window at the cost of a summarization round. The children that die silently are the cursor and codex ones — `recon`, `mechanical_edit`, `scoped_implementation`, `review` — which is exactly where the cheap wide fan-out lives. Design the defenses for those.

Three defenses, in order of how much they save:

1. **The prompt asks the child to land early.** Every spawn carries "you will not be compacted — if your context is filling, report what you have as partial with the next step named". That converts a total loss into a usable partial, and it is the only defense that works while you are not watching. It stays on pi spawns too: landing early beats a summarization round that drops the `file:line` detail the report exists for.
2. **`subagent_check` reports context used and turn count.** A run past **60% with no text output yet** is not going to finish cleanly: cancel it and re-spawn the work split in two, rather than re-running the same prompt.
3. **Split before spawning.** A child dies on context because it was given breadth, not because the model was weak. `bulk_scan` exists for exactly this — five children each reading three directories will finish where one child reading fifteen dies.

A wide fan-out of cheap children is affordable, which makes (3) the cheap fix it was not before. Prefer four narrow `bulk_scan` slices to one broad `recon`.

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

Name those paths every time. Review runs on `codex`, and **codex does not discover `.agents/skills/` on its own** — claude and pi do. A codex reviewer that is only told "use the review skill" will not read it.
