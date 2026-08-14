export const MODEL_INFO_CHANNEL = "dashboard:model-info";
export const GIT_INFO_CHANNEL = "dashboard:git-info";
export const USAGE_INFO_CHANNEL = "dashboard:usage-info";
export const REFRESH_CHANNEL = "dashboard:refresh";

/**
 * Subscription headroom, published by the `usage` extension. Percentages are
 * *remaining*, not used, because that's the number acted on.
 */
export interface UsageInfoState {
  /** Codex weekly/5h windows. codex-plus reports only the weekly one. */
  codex: UsageWindowState[];
  /** Claude Code windows, via the snapshot its statusline writes. */
  claude: UsageWindowState[];
  /**
   * When Claude Code last wrote the snapshot, unix seconds. Staleness is derived
   * at render time rather than published as a boolean: the publisher cannot know
   * how long its state will sit on screen, and a frozen "fresh" flag is exactly
   * how an hours-old percentage came to read as current.
   */
  claudeWrittenAt: number | null;
  /** Codex has no credits to fall back on once a window empties. */
  codexNoCredits: boolean;
}

export interface UsageWindowState {
  /** "7d", "5h" */
  label: string;
  remainingPercent: number;
  /**
   * Unix seconds the window resets at, or null when unknown. Deliberately not a
   * pre-formatted "4d 11h": the countdown is only true at the instant it is
   * built, so it is formatted where it is drawn.
   */
  resetsAt: number | null;
}

export interface ModelInfoState {
  provider: string;
  modelId: string;
  modelName: string;
  thinking: string;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  cost: number;
  tokensPerSecond: number | null;
  generating: boolean;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  isDraft: boolean;
}

export interface GitInfoState {
  isRepository: boolean;
  branch: string | null;
  changedFiles: number;
  pullRequest: PullRequestInfo | null;
}

export function emptyModelInfoState(): ModelInfoState {
  return {
    provider: "",
    modelId: "no-model",
    modelName: "No model",
    thinking: "off",
    contextTokens: null,
    contextWindow: 0,
    contextPercent: null,
    cost: 0,
    tokensPerSecond: null,
    generating: false,
  };
}

export function emptyGitInfoState(): GitInfoState {
  return {
    isRepository: false,
    branch: null,
    changedFiles: 0,
    pullRequest: null,
  };
}

export function emptyUsageInfoState(): UsageInfoState {
  return {
    codex: [],
    claude: [],
    claudeWrittenAt: null,
    codexNoCredits: false,
  };
}

/**
 * Beyond this, the Claude snapshot is reported as stale rather than shown as
 * fact. Lives here because both the reader and the renderer need it.
 */
export const CLAUDE_STALE_AFTER_SECONDS = 30 * 60;

/** Compact "2d 3h" / "45m" / "now" until a window resets. */
export function formatResetIn(
  resetsAt: number | undefined | null,
  nowSeconds: number,
) {
  if (resetsAt === undefined || resetsAt === null) return undefined;
  const seconds = resetsAt - nowSeconds;
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableNumber(value: unknown) {
  return value === null || typeof value === "number";
}

export function isModelInfoState(value: unknown): value is ModelInfoState {
  if (!isRecord(value)) return false;

  return (
    typeof value.provider === "string" &&
    typeof value.modelId === "string" &&
    typeof value.modelName === "string" &&
    typeof value.thinking === "string" &&
    isNullableNumber(value.contextTokens) &&
    typeof value.contextWindow === "number" &&
    isNullableNumber(value.contextPercent) &&
    typeof value.cost === "number" &&
    isNullableNumber(value.tokensPerSecond) &&
    typeof value.generating === "boolean"
  );
}

function isPullRequestInfo(value: unknown): value is PullRequestInfo {
  if (!isRecord(value)) return false;

  return (
    typeof value.number === "number" &&
    typeof value.url === "string" &&
    typeof value.isDraft === "boolean"
  );
}

function isUsageWindowState(value: unknown): value is UsageWindowState {
  if (!isRecord(value)) return false;

  return (
    typeof value.label === "string" &&
    typeof value.remainingPercent === "number" &&
    isNullableNumber(value.resetsAt)
  );
}

export function isUsageInfoState(value: unknown): value is UsageInfoState {
  if (!isRecord(value)) return false;

  return (
    Array.isArray(value.codex) &&
    value.codex.every(isUsageWindowState) &&
    Array.isArray(value.claude) &&
    value.claude.every(isUsageWindowState) &&
    isNullableNumber(value.claudeWrittenAt) &&
    typeof value.codexNoCredits === "boolean"
  );
}

export function isGitInfoState(value: unknown): value is GitInfoState {
  if (!isRecord(value)) return false;

  return (
    typeof value.isRepository === "boolean" &&
    (value.branch === null || typeof value.branch === "string") &&
    typeof value.changedFiles === "number" &&
    (value.pullRequest === null || isPullRequestInfo(value.pullRequest))
  );
}
