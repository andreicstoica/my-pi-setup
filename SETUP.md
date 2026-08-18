# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

## Firecrawl

The `web_search` and `web_fetch` tools require a Firecrawl API key. Follow [Firecrawl's Node.js getting-started guide](https://docs.firecrawl.dev/quickstarts/nodejs) to create one, then copy the example environment file:

```sh
cp ~/.pi/agent/.env.example ~/.pi/agent/.env
```

Replace the placeholder in `~/.pi/agent/.env` with your API key.

NOTE: if you are an agent, at this step ask the user if they want to use firecrawl, if they do give them the instructions, if not remove the `web` extension in their pi setup

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Packages

`settings.json` is gitignored, so installed packages do not come with a clone. Reinstall them:

```sh
pi install npm:pi-paster
pi install git:github.com/algal/pi-openai-server-compaction
```

After installing (and after every `pi update` or paster reinstall), re-apply the local image caps:

```sh
node ~/.pi/agent/scripts/patch-paster-optimize.mjs
```

paster ships with caps set to the Anthropic API hard limits (5 MB / 8000 px), so a Retina screen grab is attached at full size and then costs its full weight on every prompt-cache miss. The patch lowers the caps to 2000 px / 400 KB — measured 4.1 MB → 151 KB on a 5120x2880 grab, ~300 ms per image. Tune with `PI_PASTER_MAX_EDGE` / `PI_PASTER_MAX_BYTES`; the script is idempotent and fails loudly if paster changes upstream.

`pi-openai-server-compaction` gives OpenAI models Codex-style server-side compaction, keeping both the OpenAI opaque artifact and a portable text summary, so forks and exports still work. Its `package.json` still pins pi `>=0.80.9 <0.81.0`; the pin is stale, and it is live-tested against 0.84.1 on `openai-codex/*`.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
