/**
 * Capability policy for headless subagents.
 *
 * Headless children run with `permissionMode: "bypassPermissions"` because they
 * have no UI to answer approval prompts — that is deliberate, and it stays:
 * subagents are meant to write code autonomously. But bypassing *approval* is
 * not the same as wanting *unlimited* capability, and two classes of call
 * should never happen unattended:
 *
 * 1. Writes through MCP servers we only ever want to read from (Sentry, Linear,
 *    Figma). Reads are the whole point of routing those tasks to a claude
 *    child; mutating a tracker or a design file is not.
 * 2. Mutating `aws` CLI calls. Reads are useful for diagnosis; a stray
 *    `aws s3 rm` is unrecoverable.
 *
 * These are enforced from a `PreToolUse` hook rather than `disallowedTools`,
 * because `disallowedTools` only removes whole tools — it cannot express
 * "Bash, but not mutating aws", and it cannot cover MCP tool names we have not
 * enumerated (Linear exposes almost nothing until it is authenticated).
 * A PreToolUse `permissionDecision: "deny"` is evaluated independently of
 * `permissionMode`, so it holds even under bypass.
 *
 * Both lists are deliberately *allow-list shaped* where the vocabulary is open
 * ended (aws has hundreds of verbs), and deny-list shaped where it is closed.
 *
 * COVERAGE — this only applies to the `claude` backend. `PreToolUse` is a
 * Claude Agent SDK hook, and `backends/claude.ts` is the only caller of
 * `evaluateToolUse`. The other harnesses are separate CLIs with their own
 * permission models and no equivalent pre-tool callback on the protocols they
 * expose:
 *
 * - codex   — `codex app-server`, spawned with `approvalPolicy: "never"` and
 *             `sandbox: "danger-full-access"`.
 * - cursor  — `cursor-agent -p`, spawned with `--force`; its stream-json output
 *             is a one-way event feed, so a tool call can be *observed* but not
 *             intercepted. Cursor's own allow/deny config is the only guard.
 * - pi      — in-process child session; pi exposes no per-spawn tool policy.
 *
 * Do not describe this module as a global guard. For those harnesses the only
 * real control is the spawn prompt, and read-only intent has to be written into
 * it explicitly.
 */

/**
 * MCP servers whose write tools are refused. Matched against the server
 * segment of an `mcp__<server>__<tool>` tool name.
 */
export const READ_ONLY_MCP_SERVERS: ReadonlySet<string> = new Set([
  "claude_ai_Sentry",
  "claude_ai_Linear",
  "plugin_figma_figma",
]);

/**
 * Verbs that mutate. Applied to the tool segment so servers we cannot
 * enumerate ahead of time are still covered. `execute_*` is included because
 * generic escape-hatch tools (e.g. Sentry's `execute_sentry_tool`) can perform
 * writes the name does not otherwise reveal.
 */
const MCP_WRITE_VERB =
  /(^|_)(create|update|delete|remove|set|write|send|upload|post|patch|put|archive|move|duplicate|rename|assign|comment|execute|generate|add|apply|import|export)(_|$)/;

/**
 * Write tools whose names carry no write verb, so the pattern above misses
 * them. `use_figma` is the important one: it executes arbitrary JavaScript in
 * the Figma file context, making it the most powerful mutation of the set.
 */
const EXPLICIT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "use_figma",
  "use_figjam",
]);

/** Parsed `mcp__server__tool` name, or undefined for non-MCP tools. */
export function parseMcpToolName(toolName: string) {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator === -1) return { server: rest, tool: "" };
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

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

// Shell metacharacters that start a new command. Splitting on these means an
// `aws` call hidden behind `&&`, `;`, a pipe, or a subshell is still inspected
// rather than only the first word of the whole string.
const COMMAND_SEPARATOR = /(?:\|\||&&|[;\n|&()])+/;

// Leading `VAR=value` assignments and wrappers that delegate to another
// command; the real executable is whatever follows them.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PASSTHROUGH_WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "nice",
  "nohup",
  "time",
  "xargs",
]);

/** Strip quotes so `"aws"` and `'aws'` are recognised as the executable. */
function unquote(token: string) {
  return token.replace(/^['"]|['"]$/g, "");
}

/** Basename, so `/usr/local/bin/aws` matches but `awslogs` does not. */
function basename(token: string) {
  const cleaned = unquote(token);
  const slash = cleaned.lastIndexOf("/");
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
}

/**
 * Extracts the aws invocations in a shell command as argument lists. Returns
 * an empty array when the command does not call aws at all.
 */
export function findAwsInvocations(command: string) {
  const found: string[][] = [];

  for (const segment of command.split(COMMAND_SEPARATOR)) {
    let tokens = segment.trim().split(/\s+/).filter(Boolean);

    // Peel env assignments and wrappers until the real executable is in front.
    while (tokens.length > 0) {
      const head = tokens[0]!;
      if (
        ENV_ASSIGNMENT.test(head) ||
        PASSTHROUGH_WRAPPERS.has(basename(head))
      ) {
        tokens = tokens.slice(1);
        continue;
      }
      break;
    }

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
 * Destructive shell commands no unattended child may run. A real incident
 * motivates this: a script that drop/recreated a newline-joined DB list wiped
 * the local `liftoff` database (2026-07-30). Database destruction, force
 * pushes to the trunk, and rm -rf aimed at a home/root path are never part of
 * a delegated task; a human runs those.
 */
export function findDestructiveCommand(command: string): string | undefined {
  for (const segment of command.split(COMMAND_SEPARATOR)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const executable = basename(tokens[0]!);

    if (executable === "dropdb") return "dropdb deletes a database";

    // SQL scanning is gated on a psql invocation so prose mentioning DROP
    // TABLE (commit messages, echo) is not a false positive.
    if (executable === "psql") {
      const sql = segment;
      if (/\bdrop\s+(database|schema|table)\b/i.test(sql)) {
        return "psql DROP DATABASE/SCHEMA/TABLE";
      }
      if (/\btruncate\s/i.test(sql)) return "psql TRUNCATE";
      if (/\bdelete\s+from\b(?![^;]*\bwhere\b)/i.test(sql)) {
        return "psql DELETE without a WHERE clause";
      }
    }

    if (executable === "git" && tokens[1] === "push") {
      const force = tokens.some(
        (t) => t === "--force" || t === "-f" || /^-[a-z]*f/.test(t),
      );
      const trunk = tokens.some((t) =>
        /^(master|main)$/.test(unquote(t).replace(/^.*:/, "")),
      );
      if (force && trunk) return "force push to master/main";
    }

    if (executable === "rm" && tokens.some((t) => /^-[a-z]*r/i.test(t))) {
      const targets = tokens
        .slice(1)
        .filter((t) => !t.startsWith("-"))
        .map(unquote);
      if (
        targets.some(
          (t) => t === "/" || t === "~" || t === "$HOME" || t.startsWith("../"),
        )
      ) {
        return "recursive rm aimed at root, home, or outside the working tree";
      }
    }
  }
  return undefined;
}

/**
 * The single policy entry point. Returns a denial reason, or undefined to let
 * the call proceed untouched.
 */
export function evaluateToolUse(toolName: string, toolInput: unknown) {
  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    const isWrite =
      MCP_WRITE_VERB.test(mcp.tool) || EXPLICIT_WRITE_TOOLS.has(mcp.tool);
    if (READ_ONLY_MCP_SERVERS.has(mcp.server) && isWrite) {
      return `${mcp.server} is configured read-only for subagents; "${mcp.tool}" looks like a write. Report the finding back instead of mutating it.`;
    }
    return undefined;
  }

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
