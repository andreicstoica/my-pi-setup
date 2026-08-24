# Harnesses

Per-harness model ids, effort tiers, and thinking-budget mappings. Read this when overriding a class's model or harness, or when no `task_class` fits.

Thinking budgets are the same seven levels everywhere — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — but each harness maps them differently. The mappings are noted per section.

## Pi

**Harness:** `pi`
**Prompt nicknames:** "pi", "pi agent", "pi subagent"
**Best default:** use when the user does not request another harness.

Spawn `pi` subagents on the `openai-codex` provider, or on `opencode` (OpenCode Zen) for the non-OpenAI models it unlocks.

- The `anthropic` provider has no credential here — the spawn fails. Anthropic models belong on the **`claude` harness**, which is covered by the Max subscription.
- `openrouter` is authenticated but reserved for manual use. Do not spawn on it.
- `opencode` is OpenCode Zen (hosted) and **is** authenticated. It is not the local `opencode` CLI, and it is not a subagent harness — it is a pi provider, reached as `opencode/<model-id>`. Only part of its catalogue is enabled on this account.
- Cursor is its own harness (`harness: "cursor"`), not a pi provider.

Prefer `provider/model-id`; a bare model id only works when unambiguous.

| Model                        | Use for                                | Effort            |
| ---------------------------- | -------------------------------------- | ----------------- |
| `openai-codex/gpt-5.6-sol`   | difficult coding work                  | `high`            |
| `openai-codex/gpt-5.6-terra` | coding                                 | `medium`          |
| `openai-codex/gpt-5.6-luna`  | cheap/mechanical passes; deep one-offs; bounded UI tweaks | `medium`, `xhigh`, `max` |

Thinking budgets map directly to pi thinking levels.

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

## Claude Code

**Harness:** `claude`
**Prompt nicknames:** "claude", "Claude Code", "claude agent", "claude subagent", "cc"

**The Max plan is generous, so this harness is not the one to economize on.** Frontend work and MCP work belong here. Reserve Fable for vague guidance, decomposition, and plan orchestration; use Opus for frontend and for implementation that needs real strength.

| Model hint | Model               | Recommended effort | Reach for it when                                       |
| ---------- | ------------------- | ------------------ | ------------------------------------------------------- |
| `opus`     | latest Claude Opus  | `high`             | frontend, visual, animation, interaction work            |
| `fable`    | latest Claude Fable | `high`             | the goal is still vague and needs decomposition or a plan |
| `sonnet`   | latest Claude Sonnet | `high`            | multi-step MCP work that does not need Opus              |

The backend passes `model` through to the Claude Agent SDK, so any alias it accepts works.

Thinking budgets map to Claude thinking-token budgets: 0, 1,024, 4,096, 10,000, 16,000, 32,000, and 63,999 tokens.

Requires Claude Code to be installed and authenticated.

## Codex

**Harness:** `codex`
**Prompt nicknames:** "codex", "Codex CLI", "codex agent", "codex subagent"

**Best default for coding work:** `gpt-5.6-sol` at `high`. **For review/judgment work, start lower** — see `budgets.md`. The weekly cap is shared across every codex spawn, so a review that `terra` can settle should not be given to `sol`.

| Model           | Recommended effort | Reach for it when                                                      |
| --------------- | ------------------ | ---------------------------------------------------------------------- |
| `gpt-5.6-luna`  | `high`             | bounded diff, single-file check, recon, mechanical work                 |
| `gpt-5.6-terra` | `high`             | a normal PR-sized review — the default review model                     |
| `gpt-5.6-sol`   | `high`             | coding work, or a review where the call is hard or the blast radius big |

Codex maps thinking budgets to the nearest effort the selected model supports; `off`/`minimal` become `minimal`, `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Cursor

**Harness:** `cursor`
**Prompt nicknames:** "cursor", "cursor-agent", "Cursor CLI", "cursor agent", "cursor subagent"

**This is the cheap workhorse harness**, not a specialist one: `recon`, `mechanical_edit`, and `scoped_implementation` all route here, because the Cursor plan is flat and every run on it is a run that did not spend the Codex cap.

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

For grok 4.6 the thinking budgets map `off`/`minimal`/`low` → `low`, `medium` → `medium`, `high` → `high`, `xhigh`/`max` → `xhigh`; omitting effort gives `medium`. An effort the family has no tier for walks to the nearest one it does have, which is what keeps an inherited `max` from failing a 4.5 spawn. A tier you *spell out* that does not exist still fails with the valid ids listed, because that is a mistake about the id, not an inherited default.

`grok`, `grok-4.6`, and `composer` are accepted as shorthand — bare `grok` means 4.6. A full id is passed through unchanged, as is Cursor's bracket-override form (`'claude-opus-4-8[context=1m,effort=high,fast=false]'`).

Requires the Cursor Agent CLI (`cursor-agent`) to be installed and logged in. Refresh the id table with `cursor-agent --list-models`.
