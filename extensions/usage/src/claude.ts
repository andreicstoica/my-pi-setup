/**
 * Claude Code subscription usage, read from the snapshot its statusline writes.
 *
 * Claude's plan percentages are not obtainable by asking: there is no `claude
 * usage` subcommand, the Agent SDK's `get_usage` control request has no public
 * method (0.3.216), `accountInfo()` carries no rate limits, and the
 * `rate_limit_event` on `--output-format stream-json` has reset times but no
 * utilization — and costs a real API call to get.
 *
 * But Claude Code *pushes* the percentages into the user's statusline command
 * on every refresh. `~/.claude/statusline-command.sh` persists them to
 * `~/.claude/usage-snapshot.json`; this reads that file. Free, no API call, and
 * as fresh as the last Claude Code render — which is why staleness is surfaced
 * rather than hidden: a number from yesterday is worse than no number.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SNAPSHOT_PATH = join(homedir(), ".claude", "usage-snapshot.json");

/** Beyond this, the snapshot is reported as stale rather than shown as fact. */
export const STALE_AFTER_SECONDS = 30 * 60;

export interface ClaudeWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number;
}

export interface ClaudeUsage {
  readonly fiveHour?: ClaudeWindow;
  readonly sevenDay?: ClaudeWindow;
  readonly writtenAt: number;
  readonly stale: boolean;
  readonly ageSeconds: number;
}

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

function parseWindow(value: unknown): ClaudeWindow | undefined {
  const record = asRecord(value);
  const usedPercent = asNumber(record?.used_percentage);
  if (usedPercent === undefined) return undefined;
  return { usedPercent, resetsAt: asNumber(record?.resets_at) };
}

/** Pure so the staleness boundary is testable without touching the clock. */
export function parseSnapshot(
  raw: string,
  nowSeconds: number,
): ClaudeUsage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const root = asRecord(value);
  const writtenAt = asNumber(root?.written_at);
  if (writtenAt === undefined) return undefined;

  const fiveHour = parseWindow(root?.five_hour);
  const sevenDay = parseWindow(root?.seven_day);
  if (!fiveHour && !sevenDay) return undefined;

  const ageSeconds = Math.max(0, nowSeconds - writtenAt);
  return {
    fiveHour,
    sevenDay,
    writtenAt,
    ageSeconds,
    stale: ageSeconds > STALE_AFTER_SECONDS,
  };
}

/** Missing file is the normal state before Claude Code has rendered once. */
export function readClaudeUsage(nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    return parseSnapshot(readFileSync(SNAPSHOT_PATH, "utf8"), nowSeconds);
  } catch {
    return undefined;
  }
}
