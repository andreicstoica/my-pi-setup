---
name: playbooks
description: Step sequences for the task shapes that recur here — bug fix, investigation, shipping a stack. Invoke at the start of any multi-step task, before writing a plan of your own.
---

# Playbooks

Match the task to a playbook below. Copy its steps into the todo list **verbatim**, before any task-specific todos, and before you reason about the task.

The failure this prevents: reading a playbook, then writing a bespoke plan that quietly drops its named steps. A step you choose not to do stays in the list with `skip: <reason>`. Silent skipping is not allowed.

No playbook fits? Design one first — phases, the done predicate, and the gates — and say so before starting. Do not improvise step by step.

## The contract every playbook shares

**Done is a falsifiable predicate**, stated before work starts. "Works well" is not checkable.

**Verdicts are `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`.** Inconclusive never gets reported as a pass.

**Verify on the real artifact.** A subagent's self-report is not evidence. Read the diff yourself, run the thing, read the written value.

**Baselines come first.** For anything measured, capture the old number before the change.

**Delegate per `subagents`.** Reads and mechanical edits go out by `task_class`; you decompose and review. See `skills/subagents/SKILL.md`.

## Bug fix

1. Reproduce it yourself, on the real surface, before changing any code. State the reproduction as the done predicate: fixed means this exact sequence stops producing the symptom.
2. Delegate the trace — `task_class: recon` or a fan-out of `bulk_scan` slices — for the call path from symptom to suspect, reported as `file:line`.
3. Root-cause it. Ask why until you reach the cause. Name the cause in one sentence before you write the fix. A guard that silences the symptom needs to be labelled as a symptom fix.
4. Write the failing test first when a cheap local test path exists. Then the fix.
5. Verify: the reproduction from step 1, plus lint, typecheck, and the specific tests. Frontend typecheck is `tsc -b`. Backend needs `VALKEY_SCHEME=redis`.
6. Reply: the cause, the fix, the reproduction result, and what is still open.

## Investigation

Read-only. No file changes. If the answer needs a code change to find, say so and stop.

1. State the question as one sentence and what an answer would have to contain.
2. Fan out narrow `bulk_scan` slices over the candidate areas rather than one broad `recon`. Each returns `file:line`, not prose.
3. Record negative results — what you looked for and did not find. That stops the next agent re-searching.
4. Answer from cited evidence. Every claim carries a `file:line`. A path with no line is a guess and gets marked as one.
5. Reply: the answer, the evidence, what is inference, and the open questions.

## Shipping a stack

1. Verify each PR independently before arming anything. Green CI is not a verdict; it is one input.
2. Per PR: `gt sync` / `gt restack` (never a plain `git rebase` on a tracked stack), then lint, typecheck, and the tests that cover the diff.
3. Land only the contiguous verified run from the root. One `NOT VERIFIED` PR stops everything above it.
4. Anything irreversible — force-push to a shared branch, a merge, a deploy — pauses for the user.
5. Reply: which PRs are verified and how, which are held and why, and the exact next action.

## Reply shape

Short declarative sentences. Lead with the result. Name each principle that changed a decision, with the decision — see the six in the `engineering-principles` skill. Never fabricate a link or a citation.

For a long, unattended, or wide fan-out run, keep a trail with the `decision-log` skill.
