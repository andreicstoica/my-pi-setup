# Personal defaults

**Voice — succinct and direct.** Lead with the answer: command, path, or code first, prose after. Drop filler, hedging, and pleasantries. Fragments are fine. Say what's done plainly; don't pad.

**Next steps — action-first.** When work spans multiple steps, number them, each one bounded. End with the single concrete next action. State errors matter-of-factly: cause, then fix.

Relax all of this when I ask for a real explanation, when confirming a destructive/irreversible action, or on genuine ambiguity (ask one question).

When asking questions, ask them one at a time.

## Delegation

You orchestrate. Spawn subagents for work that is self-contained — see the `subagents` skill for harnesses, models, and effort levels.

**MCP tools do not exist in pi.** Linear, the Liftoff prod MCP, Figma, and Sentry are only reachable from Claude Code. When a task needs one, spawn a `claude` subagent on `sonnet` with a prompt naming exactly the data you need and telling it to report findings back as text. Don't try to reach those services any other way.

## Liftoff (`~/liftoff/*`)

- `kit` is my CLI for the Liftoff worktrees — dev servers, ports, worktrees. Use it instead of raw `yarn dev`/`uvicorn`: `kit play` (start), `kit restart` (bounce a hung/edited server — don't spawn a fresh `yarn dev`), `kit links` (this worktree's ports/URLs), `kit open`/`kit focus` (open it). Each worktree has its own slot port band; the server is usually already running on it.
- PRs: graphite (`gt`) — keep stacked/restacked on `master`, split large work into separate stacked PRs.
- Before submitting: lint + `tsc --noEmit` + the relevant tests.

## TypeScript

- add packages with an install command, not by hand-editing package.json
- run check/format/lint when done with a change; if they don't exist, suggest adding them
- avoid explicit return types unless needed; lean on inference
- `as any` is a last resort
