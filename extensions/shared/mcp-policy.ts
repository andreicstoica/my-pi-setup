const READ_ONLY_MCP_SERVERS = new Set([
  "linear",
  "claude_ai_linear",
  "sentry",
  "claude_ai_sentry",
  "figma",
  "figma_desktop",
  "claude_ai_figma",
  "plugin_figma_figma",
]);

const MCP_WRITE_VERB =
  /(^|_)(create|update|delete|remove|set|write|send|upload|post|patch|put|archive|move|duplicate|rename|assign|comment|execute|generate|add|apply|import|export)(_|$)/;
const MCP_READ_VERB =
  /^(get|list|search|find|read|fetch|inspect|describe|browse|query|lookup|resolve|view)(_|$)/;
const EXPLICIT_WRITE_TOOLS = new Set(["use_figma", "use_figjam"]);

export interface McpToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export function parseMcpToolName(toolName: string) {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator === -1) return { server: rest, tool: "" };
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

export function evaluateMcpToolUse(toolName: string, hints?: McpToolHints) {
  const mcp = parseMcpToolName(toolName);
  if (!mcp) return undefined;
  const server = mcp.server.toLowerCase();
  const tool = mcp.tool.toLowerCase();

  if (
    (server === "liftoff" || server === "claude_ai_liftoff") &&
    (tool === "ask" || tool === "tool_ask")
  ) {
    return `${mcp.server}: metered ask is blocked. Use sql_query or get_schema instead.`;
  }
  if (!READ_ONLY_MCP_SERVERS.has(server)) return undefined;

  if (
    MCP_WRITE_VERB.test(tool) ||
    EXPLICIT_WRITE_TOOLS.has(tool) ||
    hints?.destructiveHint === true ||
    hints?.readOnlyHint === false
  ) {
    return `${mcp.server} is configured read-only; "${mcp.tool}" is not allowed to mutate it.`;
  }
  if (!MCP_READ_VERB.test(tool) && hints?.readOnlyHint !== true) {
    return `${mcp.server} is configured read-only; "${mcp.tool}" is not a recognized read operation.`;
  }
  return undefined;
}
