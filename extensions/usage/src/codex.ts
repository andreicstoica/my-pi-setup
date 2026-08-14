/**
 * Codex subscription usage, read from `codex app-server`.
 *
 * Why this and not the Claude side too: Claude's plan *percentages* are not
 * reachable from outside Claude Code. The `get_usage` control request exists in
 * the Agent SDK protocol types but has no public method (SDK 0.3.216);
 * `accountInfo()` carries no rate limits and `getContextUsage()` is
 * context-only. The one external signal — a `rate_limit_event` on
 * `--output-format stream-json` — has status and reset times but no
 * utilization, and obtaining it costs a real API call. Claude Code's own
 * statusline already receives the percentages for free, so that half is better
 * served there.
 *
 * Codex, by contrast, exposes everything over the app-server's JSON-RPC:
 * `account/rateLimits/read` returns per-window `usedPercent`, `resetsAt`, and
 * `windowDurationMins`, plus plan type and credit balance.
 */

import { spawn } from "node:child_process";

export interface UsageWindow {
  readonly usedPercent: number;
  /** Unix seconds, or undefined when the server omits it. */
  readonly resetsAt?: number;
  /** 10080 = weekly, 300 = 5-hourly. Undefined when unlabelled. */
  readonly windowDurationMins?: number;
}

export interface CodexUsage {
  readonly primary?: UsageWindow;
  readonly secondary?: UsageWindow;
  readonly planType?: string;
  readonly limitName?: string;
  /** Credits act as the backstop once a window is exhausted. */
  readonly credits?: {
    readonly balance?: string;
    readonly hasCredits: boolean;
    readonly unlimited: boolean;
  };
  readonly spendControlReached?: boolean;
  readonly rateLimitReachedType?: string;
}

// --- Parsing (pure, unit-tested) --------------------------------------------

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseWindow(value: unknown): UsageWindow | undefined {
  const record = asRecord(value);
  const usedPercent = asNumber(record?.usedPercent);
  // usedPercent is the only required field on RateLimitWindow; without it the
  // window tells us nothing worth rendering.
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    resetsAt: asNumber(record?.resetsAt),
    windowDurationMins: asNumber(record?.windowDurationMins),
  };
}

/**
 * Accepts a `GetAccountRateLimitsResponse`. Prefers the `codex` bucket from
 * `rateLimitsByLimitId` and falls back to the flat `rateLimits` view, which the
 * schema documents as the backward-compatible mirror of the same data.
 */
export function parseRateLimitsResponse(
  value: unknown,
): CodexUsage | undefined {
  const root = asRecord(value);
  if (!root) return undefined;

  const byId = asRecord(root.rateLimitsByLimitId);
  const snapshot = asRecord(byId?.codex) ?? asRecord(root.rateLimits);
  if (!snapshot) return undefined;

  const credits = asRecord(snapshot.credits);

  return {
    primary: parseWindow(snapshot.primary),
    secondary: parseWindow(snapshot.secondary),
    planType:
      typeof snapshot.planType === "string" ? snapshot.planType : undefined,
    limitName:
      typeof snapshot.limitName === "string" ? snapshot.limitName : undefined,
    credits: credits
      ? {
          balance:
            typeof credits.balance === "string" ? credits.balance : undefined,
          hasCredits: credits.hasCredits === true,
          unlimited: credits.unlimited === true,
        }
      : undefined,
    spendControlReached: snapshot.spendControlReached === true,
    rateLimitReachedType:
      typeof snapshot.rateLimitReachedType === "string"
        ? snapshot.rateLimitReachedType
        : undefined,
  };
}

/** Human label for a window, derived from its duration. */
export function windowLabel(window: UsageWindow) {
  const mins = window.windowDurationMins;
  if (mins === undefined) return "limit";
  if (mins % 10080 === 0) {
    const weeks = mins / 10080;
    return weeks === 1 ? "7d" : `${weeks * 7}d`;
  }
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/**
 * Re-exported so callers of this module keep one import site, while the footer
 * — which now formats countdowns at draw time — can reach it without importing
 * across extensions.
 */
export { formatResetIn } from "../../shared/dashboard-state.ts";

/** Theme token for how alarming a remaining-percentage is. */
export function severityToken(remainingPercent: number) {
  if (remainingPercent <= 10) return "error";
  if (remainingPercent <= 25) return "warning";
  return "muted";
}

// --- Transport ---------------------------------------------------------------

const PROBE_TIMEOUT_MS = 10_000;

/**
 * One-shot `codex app-server` conversation: initialize, ask, exit. Spawning a
 * process per refresh is why the caller caches — but it costs no model tokens
 * and needs no separate auth, since the app-server uses the same login the
 * Codex CLI already has.
 */
export function readCodexUsage(): Promise<CodexUsage | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }

    let settled = false;
    const finish = (result: CodexUsage | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);
    child.on("error", () => finish(undefined));
    // A codex that exits before answering (not logged in, older build) must
    // resolve rather than hang the footer forever.
    child.on("exit", () => finish(undefined));

    const write = (message: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(undefined);
      }
    };

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message: Record<string, unknown> | undefined;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (message.id === 1) {
          // initialize answered — complete the handshake, then ask.
          write({ jsonrpc: "2.0", method: "initialized" });
          write({
            jsonrpc: "2.0",
            id: 2,
            method: "account/rateLimits/read",
            params: {},
          });
          continue;
        }
        if (message.id === 2) {
          finish(
            message.error ? undefined : parseRateLimitsResponse(message.result),
          );
        }
      }
    });

    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "pi-usage", title: "pi usage", version: "1.0.0" },
      },
    });
  });
}
