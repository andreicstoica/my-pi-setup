# Personal defaults

**Voice — succinct and direct.** Lead with the answer: command, path, or code first, prose after. Drop filler, hedging, and pleasantries. Fragments are fine. Say what's done plainly; don't pad.

**Language — ASD-STE100.** Only report to me in ASD-STE100 Simplified Technical English.

**Next steps — action-first.** When work spans multiple steps, number them, each one bounded. End with the single concrete next action. State errors matter-of-factly: cause, then fix.

Relax all of this when I ask for a real explanation, when confirming a destructive/irreversible action, or on genuine ambiguity (ask one question). Structure serves clarity — never the reverse.

When asking questions, ask them one at a time.

## Delegation

You orchestrate. Spawn subagents for work that is self-contained — see the `subagents` skill for harnesses, models, and effort levels.

**MCP tools do not exist in pi.** Linear, the Liftoff prod MCP, Figma, and Sentry are only reachable through Claude Code. For simple lookups use the bridge tools (`linear`, `sentry`, `figma`, `liftoff_sql`) — each runs a scoped headless claude query and returns text. Spawn a full `claude` subagent on `sonnet` only for multi-step or cross-service MCP work. Don't try to reach those services any other way. (`liftoff_sql` needs the VPN; `sentry` needs its connector re-authenticated in Claude Code from time to time.)

**Hard UI polish and animation problems escalate.** When visual/motion work resists two local attempts, spawn a `claude` subagent on the top model (fable, `high` effort) rather than grinding — that is my standing preference, not a last resort.

## Tools

- Reading git history or changes: use `git_diff`, `git_show`, `git_log` — not `bash git …`. They render real diffs with `file:line` headers instead of flat text. `bash` is still right for git commands that *act* (commit, rebase, `gt`).

## Liftoff (`~/liftoff/*`)

- `kit` is my CLI for the Liftoff worktrees — dev servers, ports, worktrees. Use it instead of raw `yarn dev`/`uvicorn`: `kit play` (start), `kit restart` (bounce a hung/edited server — don't spawn a fresh `yarn dev`), `kit links` (this worktree's ports/URLs), `kit open`/`kit focus` (open it). Each worktree has its own slot port band; the server is usually already running on it. `kit wash` prompts on the tty — ask me to run it instead of fighting it with `script(1)`.
- PRs: graphite (`gt`) — keep stacked/restacked on `master` with `gt sync`/`gt restack` (never plain `git rebase` on a tracked stack), split large work into separate stacked PRs.
- Before submitting: lint + typecheck + the relevant tests. Frontend typecheck is `tsc -b` or `tsc -p tsconfig.app.json` — bare `tsc --noEmit` at the frontend/app root checks nothing. Backend lint is `ruff format` + `ruff check --fix` + `lint-imports`.
- Backend pytest needs `VALKEY_SCHEME=redis` in the env or every run hangs ~60s on SSL. All worktrees share one venv (`~/.envs/py314`, Python 3.14); never `uv run` in `backend/`.
- Styling: use the closest existing tailwind token, never magic color values.

## TypeScript

- add packages with an install command, not by hand-editing package.json
- run check/format/lint when done with a change; if they don't exist, suggest adding them
- avoid explicit return types unless needed; lean on inference
- `as any` is a last resort
