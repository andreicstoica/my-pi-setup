# Setup

Install Pi 1.3.0 or later and Node.js 22.19 or later. Clone or copy this repository to `~/.pi/agent`, then install the root and independent extension dependencies:

```sh
cd ~/.pi/agent
npm ci
for extension in extensions/*/; do
  if test -f "$extension/package-lock.json"; then
    npm --prefix "$extension" ci
  elif test -f "$extension/package.json"; then
    npm --prefix "$extension" install
  fi
done
```

## Skills

Pi 0.84 and later load shared skills from `~/.agents/skills` directly. Keep only Pi-specific skills in `~/.pi/agent/skills`. Do not add symlinks from the Pi directory back to `~/.agents/skills`; duplicate discovery can produce name conflicts.

For a routed skill family, keep the router and its children model-invocable. A child marked `disable-model-invocation: true` cannot be loaded by the agent, even when the router selects it, and the session stalls until the user runs `/skill:<name>`. Set `disable-model-invocation: true` only on a skill that must run when the user asks for it, such as `break` or `grill-me`. For Codex, match it with `policy.allow_implicit_invocation: false` in that skill's `agents/openai.yaml`.

## Effort and delegation

Default to medium thinking in local settings and `scripts/settings-sanity.mjs`. Routine task classes use medium; planning, review, and hard questions use high. Higher levels remain explicit overrides. Work in the parent unless an independent task benefits from parallel execution or context isolation.

Subagent runs stop at 40 finalized assistant messages or 600 seconds by default. `max_turns` and `timeout_seconds` can grant an explicitly larger budget. Children should report a partial checkpoint before the limit; a forced stop returns an error with available output and preserves the transcript, but does not roll back edits. Inspect the result before resuming with `subagent_send`. Keep CI and long command waits in background terminals.

## Firecrawl

The `web_search` and `web_fetch` tools require a Firecrawl API key. Follow [Firecrawl's Node.js getting-started guide](https://docs.firecrawl.dev/quickstarts/nodejs) to create one, then copy the example environment file:

```sh
cp ~/.pi/agent/.env.example ~/.pi/agent/.env
```

Replace the placeholder in `~/.pi/agent/.env` with your API key.

NOTE: if you are an agent, at this step ask the user if they want to use firecrawl, if they do give them the instructions, if not remove the `web` extension in their pi setup

## Native MCP

MCP lookups connect directly from Pi. They do not use Claude Code or its subscription. Keep credentials and server configuration in the ignored `~/.pi/agent/mcp.json`.

```sh
pi mcp add linear --url https://mcp.linear.app/mcp/readonly
pi mcp add sentry --url https://mcp.sentry.dev/mcp
pi mcp login linear
pi mcp login sentry
```

The `mcp-policy` extension enforces read-only access for the Linear, Sentry and Figma server names, including legacy aliases, for both direct and Codemode calls. It blocks metered Liftoff `ask` tools. The existing Liftoff SQL connection is independent and remains configured locally.

For Figma, enable the desktop app's MCP server and add `http://127.0.0.1:3845/mcp` as server `figma`. Figma restricts its remote server to approved clients; do not identify Pi as a different client to bypass that restriction.

Run `/reload` after configuration changes, then use `/mcp` to check connections. Native MCP authentication is separate from Claude Code authentication.

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Packages

`settings.json` is gitignored, so installed packages do not come with a clone. Reinstall them:

```sh
pi install npm:pi-paster
pi install npm:@lll9p/pi-better-compaction
```

After installing (and after every `pi update` or paster reinstall), re-apply the local image caps:

```sh
node ~/.pi/agent/scripts/patch-paster-optimize.mjs
```

paster ships with caps set to the Anthropic API hard limits (5 MB / 8000 px), so a Retina screen grab is attached at full size and then costs its full weight on every prompt-cache miss. The patch lowers the caps to 2000 px / 400 KB — measured 4.1 MB → 151 KB on a 5120x2880 grab, ~300 ms per image. Tune with `PI_PASTER_MAX_EDGE` / `PI_PASTER_MAX_BYTES`; the script is idempotent and fails loudly if paster changes upstream.

`@lll9p/pi-better-compaction` is the current compaction package. Its local configuration stays outside the published setup.

## Subagents and Codemode

Enable Codemode alongside the normal tools in your local settings:

```json
{ "defaultTools": ["+codemode"] }
```

The subagent tools return typed data to scripts and keep their existing text and UI rendering. Use returned IDs instead of parsing text:

```js
const child = await tools.subagent_spawn({
  task_class: "recon",
  name: "Map entry points",
  prompt: "Read-only. Locate the entry points and report their paths. Do not edit files."
});
const { results } = await tools.subagent_wait({ ids: [child.id] });
return results.map(({ id, status, output }) => ({ id, status, output }));
```

A wait returns bounded outputs and explicit error or missing states. Check `status` and `truncated` before acting on a result. Pi child sessions can use Codemode; they do not start MCP connections by default.

## Verification

```sh
npm run check
npm test
```

Effect's unstable-API notices remain visible as suggestions because the extensions use Effect's platform APIs. Type errors and other Effect warning/error diagnostics still fail the per-extension checks.

`npm test` includes live Claude Code, Codex and Cursor tests when those executables are installed. Authenticate those clients first. These tests make real model calls. `npm run smoke` also checks this account's local model defaults; it is not a portable CI check for a fresh clone.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
