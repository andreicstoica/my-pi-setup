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

**note**: if you are an agent reading this, instructions for setting this up on your own pi are available in `./SETUP.md`.
