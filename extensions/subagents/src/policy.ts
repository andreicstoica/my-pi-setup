/**
 * Headless Claude children cannot answer approval dialogs. Restricted MCP
 * and destructive shell calls must still be denied before execution.
 */

import {
  COMMAND_SEPARATOR,
  basename,
  findDestructiveCommand,
  tokenizeSegment,
  unquote,
} from "../../shared/destructive-commands.ts";

import {
  evaluateMcpToolUse,
  parseMcpToolName,
} from "../../shared/mcp-policy.ts";

export { findDestructiveCommand, parseMcpToolName };

/**
 * `aws` operations that only read. Everything else on a read-only-by-policy
 * service is refused, because the verb space is too large to deny-list: a new
 * mutating verb must not become allowed by default.
 */
const AWS_READ_ONLY_OPERATION =
  /^(describe|list|get|batch-get|lookup|search|scan|query|head|check|validate|estimate|preview|simulate|test|filter)([-_]|$)/;

/** Non-verb-prefixed aws operations that are still reads. */
const AWS_READ_ONLY_EXTRAS: ReadonlySet<string> = new Set([
  "ls",
  "help",
  "tail",
  "filter-log-events",
  "wait",
]);

/**
 * Extracts the aws invocations in a shell command as argument lists. Returns
 * an empty array when the command does not call aws at all.
 */
export function findAwsInvocations(command: string) {
  const found: string[][] = [];

  for (const segment of command.split(COMMAND_SEPARATOR)) {
    const tokens = tokenizeSegment(segment);
    if (tokens.length === 0) continue;
    if (basename(tokens[0]!) !== "aws") continue;
    found.push(tokens.slice(1).map(unquote));
  }

  return found;
}

/**
 * Decides a single aws invocation. `args` excludes the `aws` executable.
 * Unrecognised shapes are refused rather than allowed, so a command this
 * parser does not understand cannot mutate anything by accident.
 */
export function classifyAwsInvocation(args: readonly string[]) {
  const positional = args.filter((token) => !token.startsWith("-"));

  // Bare `aws`, or flag-only forms like `aws --version`: nothing to mutate.
  if (positional.length === 0) return undefined;

  // First positional is the service, second is the operation.
  const operation = positional[1];
  if (!operation) {
    // `aws s3` alone just prints usage.
    return undefined;
  }

  if (
    AWS_READ_ONLY_EXTRAS.has(operation) ||
    AWS_READ_ONLY_OPERATION.test(operation)
  ) {
    return undefined;
  }

  return `aws ${positional[0]} ${operation} is not a read-only operation`;
}

/**
 * The single policy entry point. Returns a denial reason, or undefined to let
 * the call proceed untouched.
 */
export function evaluateToolUse(toolName: string, toolInput: unknown) {
  if (parseMcpToolName(toolName)) return evaluateMcpToolUse(toolName);

  if (toolName !== "Bash") return undefined;

  const command =
    toolInput && typeof toolInput === "object" && "command" in toolInput
      ? (toolInput as { command?: unknown }).command
      : undefined;
  if (typeof command !== "string") return undefined;

  for (const args of findAwsInvocations(command)) {
    const denial = classifyAwsInvocation(args);
    if (denial) {
      return `${denial}. Mutating aws calls are blocked for subagents — surface the command for a human to run.`;
    }
  }

  const destructive = findDestructiveCommand(command);
  if (destructive) {
    return `Blocked: ${destructive}. Destructive commands are never run by subagents — surface the command for a human to run.`;
  }

  return undefined;
}
