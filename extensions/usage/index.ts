/**
 * Subscription headroom for both harnesses, published to the dashboard footer.
 *
 * Publishes on USAGE_INFO_CHANNEL rather than owning a footer row, so
 * ui-customization can put usage on the left of a line it already renders
 * instead of the footer growing by a row per extension.
 *
 * Sources and why they differ: see ./src/codex.ts and ./src/claude.ts.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  emptyUsageInfoState,
  REFRESH_CHANNEL,
  USAGE_INFO_CHANNEL,
  type UsageInfoState,
  type UsageWindowState,
} from "../shared/dashboard-state.ts";
import { readClaudeUsage, type ClaudeUsage } from "./src/claude.ts";
import {
  formatResetIn,
  readCodexUsage,
  windowLabel,
  type CodexUsage,
  type UsageWindow,
} from "./src/codex.ts";

/** Each codex refresh spawns a process, so don't do it per render. */
const CODEX_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedCodex: { usage: CodexUsage | undefined; at: number } | undefined;
let inFlight: Promise<CodexUsage | undefined> | undefined;

async function getCodex(force: boolean) {
  if (
    !force &&
    cachedCodex &&
    Date.now() - cachedCodex.at < CODEX_CACHE_TTL_MS
  ) {
    return cachedCodex.usage;
  }
  // Collapse concurrent callers (session_start racing /usage) onto one probe.
  inFlight ??= readCodexUsage().then((usage) => {
    cachedCodex = { usage, at: Date.now() };
    inFlight = undefined;
    return usage;
  });
  return inFlight;
}

/**
 * Headroom as a whole number. Claude reports `used_percentage` as a float, so
 * a naive `100 - used` yields values like 44.99999999999999; codex reports an
 * integer, which is why only the Claude side ever showed it.
 */
function remainingPercent(usedPercent: number) {
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function toWindowState(window: UsageWindow): UsageWindowState {
  return {
    label: windowLabel(window),
    remainingPercent: remainingPercent(window.usedPercent),
    resetsAt: window.resetsAt ?? null,
  };
}

function buildState(
  codex: CodexUsage | undefined,
  claude: ClaudeUsage | undefined,
): UsageInfoState {
  const state = emptyUsageInfoState();

  for (const window of [codex?.primary, codex?.secondary]) {
    if (window) state.codex.push(toWindowState(window));
  }
  // Credits are the backstop once a window empties — only worth surfacing when
  // headroom is actually short.
  const lowest = Math.min(100, ...state.codex.map((w) => w.remainingPercent));
  state.codexNoCredits =
    !!codex?.credits &&
    !codex.credits.unlimited &&
    !codex.credits.hasCredits &&
    lowest <= 25;

  for (const [label, window] of [
    ["5h", claude?.fiveHour],
    ["7d", claude?.sevenDay],
  ] as const) {
    if (!window) continue;
    state.claude.push({
      label,
      remainingPercent: remainingPercent(window.usedPercent),
      resetsAt: window.resetsAt ?? null,
    });
  }
  state.claudeWrittenAt = claude?.writtenAt ?? null;

  return state;
}

function report(
  codex: CodexUsage | undefined,
  claude: ClaudeUsage | undefined,
) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lines: string[] = [];

  if (codex) {
    lines.push(`Codex — plan: ${codex.planType ?? "unknown"}`);
    const windows = [codex.primary, codex.secondary].filter(
      Boolean,
    ) as UsageWindow[];
    if (windows.length === 0) lines.push("  no rate-limit windows reported");
    for (const window of windows) {
      const w = toWindowState(window);
      const resetIn = formatResetIn(w.resetsAt, nowSeconds);
      lines.push(
        `  ${w.label}: ${w.remainingPercent}% left${resetIn ? ` (${resetIn})` : ""}  —  ${window.usedPercent}% used`,
      );
    }
    if (codex.credits) {
      lines.push(
        codex.credits.unlimited
          ? "  credits: unlimited"
          : `  credits: ${codex.credits.balance ?? "0"}${codex.credits.hasCredits ? "" : " (none to fall back on)"}`,
      );
    }
    if (codex.spendControlReached) lines.push("  ⚠ spend control reached");
    if (codex.rateLimitReachedType)
      lines.push(`  ⚠ limit reached: ${codex.rateLimitReachedType}`);
  } else {
    lines.push("Codex — unavailable (is `codex` installed and logged in?)");
  }

  lines.push("");
  if (claude) {
    const age = Math.round(claude.ageSeconds / 60);
    lines.push(
      `Claude Code — snapshot ${age}m old${claude.stale ? " (STALE)" : ""}`,
    );
    for (const [label, window] of [
      ["5h", claude.fiveHour],
      ["7d", claude.sevenDay],
    ] as const) {
      if (!window) continue;
      const resetIn = formatResetIn(window.resetsAt, nowSeconds);
      lines.push(
        `  ${label}: ${remainingPercent(window.usedPercent)}% left${resetIn ? ` (${resetIn})` : ""}`,
      );
    }
  } else {
    lines.push("Claude Code — no snapshot yet.");
    lines.push(
      "  Its statusline writes ~/.claude/usage-snapshot.json; run a Claude Code session once.",
    );
  }

  return lines.join("\n");
}

/** How often an idle session re-reads the numbers, so the footer never freezes. */
const IDLE_REFRESH_MS = 60 * 1000;

/**
 * Emits the file-sourced half immediately and again once codex answers. The
 * first emit costs a small `readFileSync`, so callers on hot paths (`input`,
 * `turn_end`) never wait on a spawned process; the second is a no-op refresh of
 * the same values while the codex cache is still warm.
 */
async function publish(pi: ExtensionAPI, force: boolean) {
  const emit = (
    codex: CodexUsage | undefined,
    claude: ClaudeUsage | undefined,
  ) => pi.events.emit(USAGE_INFO_CHANNEL, buildState(codex, claude));

  emit(cachedCodex?.usage, readClaudeUsage());
  const codex = await getCodex(force);
  const claude = readClaudeUsage();
  emit(codex, claude);
  return { codex, claude };
}

export default function (pi: ExtensionAPI) {
  let ticker: ReturnType<typeof setInterval> | undefined;

  // Published state was only ever built at session_start, so a long-lived
  // session showed percentages and countdowns from hours earlier as if current.
  // Every cheap signal now republishes; the codex TTL keeps the process spawns
  // down to one per five minutes regardless of how often this fires.
  const refresh = () => void publish(pi, false);

  pi.on("session_start", async () => {
    ticker ??= setInterval(refresh, IDLE_REFRESH_MS);
    await publish(pi, false);
  });
  pi.on("input", refresh);
  pi.on("turn_end", refresh);
  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, refresh);

  pi.on("session_shutdown", () => {
    stopRefreshListener();
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  });

  pi.registerCommand("usage", {
    description: "Show Codex and Claude Code subscription usage (refreshes)",
    handler: async (_args, ctx: ExtensionContext) => {
      const { codex, claude } = await publish(pi, true);
      ctx.ui.notify(
        report(codex, claude),
        codex || claude ? "info" : "warning",
      );
    },
  });
}
