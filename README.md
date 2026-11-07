# my pi setup

This setup is fairly opinionated, it:

- sets up github dark default as the theme
- adds `web_search` and `web_fetch` tools, backed by firecrawl
- updates the bottom bar to have the info I prefer to see
- adds background terminals + ui to manage them
- adds subagents to pi
- uses native MCP with read-only guards, without a Claude Code proxy
- adds workflows to pi
- adds an ask user tool, which lets the model ask multiple choice questions
- adds `remember` + `recall` memory, scoped per repo and shared across its worktrees
- adds first-class `fd` (file discovery) and `rg` (content search) tools
- loads cross-harness skills from `~/.agents/skills` and keeps Pi-only skills in `~/.pi/agent/skills`
- vendors four extensions from [Pringled/pi-extensions](https://github.com/Pringled/pi-extensions) (MIT): `polish` (Claude Code-style tool rows and diffs), `checkpoints` (`/tree` and `/fork` also restore edited files), `model-pick` (`/pick`, favorites and recent models first) and `heads-up` (flags one thing you might have missed after a task)

![Pi setup interface](assets/pi-setup.jpeg)

## Try forked subagents

Run `/reload` in Pi. The model can then choose fork mode for delegated tasks that depend on earlier conversation decisions. It uses fresh context for self-contained tasks and independent reviews. You can also ask for a fork explicitly.

The tool option is `subagent_spawn({ harness: "pi", context_mode: "fork", name: "inspect auth", prompt: "Read-only. Inspect the auth flow using the decisions above. Report findings with file paths." })`.

Fresh context remains the default. Fork mode copies the active saved conversation branch into a separate session file. It excludes the unfinished tool batch that starts the child. The child must use the same working directory. It receives existing compaction state and keeps the usual child tool restrictions. Later parent messages are not copied. Model and effort overrides are optional for forks.

Run `npm --prefix extensions/subagents run test:fork:live` to compare a fresh child with a forked child through the installed Pi CLI. This makes live model calls using a synthetic marker and prints child token usage. It tests context inheritance, not performance or cache savings. Set `PI_FORK_TEST_MODEL` to select a model; the default is `openai-codex/gpt-6.1-sol`.

**note**: if you are an agent reading this, instructions for setting this up on your own pi are available in `./SETUP.md`.
