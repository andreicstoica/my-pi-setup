# Budgets and overrides

## Which pool a class spends

This is the whole design. Four budgets, and they are not interchangeable:

| Pool                    | Spent by                                | Costs                                                        |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------ |
| Cursor plan             | `cursor` harness                        | flat — free at the margin, so read and mechanical work lives here |
| OpenCode Zen (metered)  | `pi` + `opencode/…`                     | real cents per run, but no cap and no queue — this is what a wide fan-out is for |
| Claude Max              | `claude` harness (Opus, Fable)          | generous — frontend work and MCP work belong here            |
| Codex weekly cap        | `codex` harness, and `openai-codex/…` on pi | the scarcest pool, shared between every codex spawn and every luna spawn |

The rule that follows: **cheap read and edit work must never touch the Codex pool.** `openai-codex/gpt-5.6-luna` is cheap in dollars and expensive in the only currency that runs out — it draws from the same weekly cap as `review`. `deep_question` is the one remaining exception, because it is a single call, not a fan-out. A `routing.test.ts` case asserts the read/mechanical classes stay off that pool.

**Frontend work goes to Opus on the `claude` harness.** Visual, layout, animation, and interaction work is where model strength shows most and where a cheap model wastes the most attempts. Claude Max pays for it, so there is no reason to economize there. Use `ui_tweak` for UI polish and interaction changes with a clear target. Use `open_implementation` with Fable only when the goal needs interpretation, decomposition, or plan orchestration before implementation.

## The Codex cap

Codex has a hard usage budget — spend it deliberately. It is a weekly subscription cap, not a per-call cost, so a burned budget blocks the reviews you have not thought of yet. Three rules:

- **Scale the model to the review, not to the anxiety.** `luna` for a bounded diff or a single-file check, `terra` for a normal PR-sized review, `sol` only when the call is genuinely hard or the blast radius is large. Do not open at `sol`.
- **One reviewer per question.** Do not fan out three codex reviewers over the same diff for consensus — that is 3× budget for a vote you did not need. If you want a second opinion on a codex verdict, take it from `claude`/`fable`; the disagreement between two different backends is worth more than agreement between two codex runs.
- **Check the budget before a big fan-out.** `/usage` shows the codex weekly window. If it is already deep into the week's allowance, downgrade the model or route the review to `claude`/`fable` and say so, rather than silently spending the rest.

## Per-field overrides

**Overrides are per field, and the harness is special.**

`model` alone re-points the class's harness — that is how the Codex budget rule above is applied (`review` + `model: gpt-5.6-luna` for a bounded diff).

Overriding `harness` **drops the class's model**, because a model id belongs to one harness: `openai-codex/gpt-5.6-luna` means nothing to codex or claude. After a harness override, name the model too.

## The caps are instruction-only

The class writes its cap into the child's prompt so it no longer depends on you remembering to, but nothing inspects the child's diff. A `recon` child that edited a file is a real failure worth reporting to the user.
