/**
 * Codex subscription usage in the footer, plus `/usage` for the full picture.
 *
 * Renders through `ctx.ui.setStatus()` rather than `setFooter()` so it composes
 * with the ui-customization extension, whose footer already appends extension
 * statuses under its own two lines. Setting a footer here would fight it.
 *
 * See ./src/codex.ts for why only codex is covered and not Claude.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  formatResetIn,
  readCodexUsage,
  severityToken,
  windowLabel,
  type CodexUsage,
  type UsageWindow,
} from "./src/codex.ts";

const STATUS_KEY = "usage";
/** Each refresh spawns a process, so don't do it per render. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { usage: CodexUsage | undefined; at: number } | undefined;
let inFlight: Promise<CodexUsage | undefined> | undefined;

async function getUsage(force: boolean) {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS)
    return cached.usage;
  // Collapse concurrent callers (session_start racing /usage) onto one probe.
  inFlight ??= readCodexUsage().then((usage) => {
    cached = { usage, at: Date.now() };
    inFlight = undefined;
    return usage;
  });
  return inFlight;
}

/** "7d: 17% left (2d 3h)" — remaining, because that's the number you act on. */
function describeWindow(window: UsageWindow, nowSeconds: number) {
  const remaining = Math.max(0, 100 - window.usedPercent);
  const resetIn = formatResetIn(window.resetsAt, nowSeconds);
  return {
    remaining,
    text: `${windowLabel(window)}: ${remaining}% left${resetIn ? ` (${resetIn})` : ""}`,
  };
}

function renderStatus(ctx: ExtensionContext, usage: CodexUsage | undefined) {
  if (!usage) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const parts: string[] = [];

  for (const window of [usage.primary, usage.secondary]) {
    if (!window) continue;
    const { remaining, text } = describeWindow(window, nowSeconds);
    parts.push(ctx.ui.theme.fg(severityToken(remaining), text));
  }
  if (parts.length === 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  // Credits are the backstop when a window empties, so a zero balance is worth
  // showing next to a low window rather than buried in `/usage`.
  if (usage.credits && !usage.credits.unlimited && !usage.credits.hasCredits) {
    parts.push(ctx.ui.theme.fg("dim", "no credits"));
  }

  ctx.ui.setStatus(
    STATUS_KEY,
    `${ctx.ui.theme.fg("dim", "codex")} ${parts.join(ctx.ui.theme.fg("dim", " · "))}`,
  );
}

function buildReport(usage: CodexUsage | undefined) {
  if (!usage) {
    return "Codex usage unavailable — is `codex` installed and logged in? (`codex login`)";
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const lines: string[] = [];
  const plan = usage.planType ? `plan: ${usage.planType}` : "plan: unknown";
  lines.push(
    `Codex — ${plan}${usage.limitName ? ` (${usage.limitName})` : ""}`,
  );

  const windows = [
    ["primary", usage.primary],
    ["secondary", usage.secondary],
  ] as const;
  let any = false;
  for (const [name, window] of windows) {
    if (!window) continue;
    any = true;
    const { text } = describeWindow(window, nowSeconds);
    lines.push(`  ${text}  —  ${window.usedPercent}% used [${name}]`);
  }
  if (!any) lines.push("  no rate-limit windows reported");

  if (usage.credits) {
    lines.push(
      usage.credits.unlimited
        ? "  credits: unlimited"
        : `  credits: ${usage.credits.balance ?? "0"}${usage.credits.hasCredits ? "" : " (none — nothing to fall back on)"}`,
    );
  }
  if (usage.spendControlReached) lines.push("  ⚠ spend control reached");
  if (usage.rateLimitReachedType)
    lines.push(`  ⚠ limit reached: ${usage.rateLimitReachedType}`);

  lines.push("");
  lines.push(
    "Claude 5h/7d percentages aren't readable from pi — your Claude Code statusline shows them.",
  );
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    renderStatus(ctx, await getUsage(false));
  });

  pi.registerCommand("usage", {
    description: "Show codex subscription usage (refreshes)",
    handler: async (_args, ctx) => {
      const usage = await getUsage(true);
      if (ctx.mode === "tui") renderStatus(ctx, usage);
      ctx.ui.notify(buildReport(usage), usage ? "info" : "warning");
    },
  });
}
