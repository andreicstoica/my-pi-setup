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
  /** Claude's numbers come from a file; flag when it hasn't refreshed lately. */
  claudeStale: boolean;
  /** Codex has no credits to fall back on once a window empties. */
  codexNoCredits: boolean;
}

export interface UsageWindowState {
  /** "7d", "5h" */
  label: string;
  remainingPercent: number;
  /** "4d 11h", or null when the reset time is unknown. */
  resetIn: string | null;
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
  return { codex: [], claude: [], claudeStale: false, codexNoCredits: false };
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
    (value.resetIn === null || typeof value.resetIn === "string")
  );
}

export function isUsageInfoState(value: unknown): value is UsageInfoState {
  if (!isRecord(value)) return false;

  return (
    Array.isArray(value.codex) &&
    value.codex.every(isUsageWindowState) &&
    Array.isArray(value.claude) &&
    value.claude.every(isUsageWindowState) &&
    typeof value.claudeStale === "boolean" &&
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
