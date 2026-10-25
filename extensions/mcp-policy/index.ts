import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluateMcpToolUse } from "../shared/mcp-policy.ts";

export default function mcpPolicy(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!event.toolName.startsWith("mcp__")) return;
    const tool = pi
      .getAllTools()
      .find((entry) => entry.name === event.toolName);
    const reason = evaluateMcpToolUse(event.toolName, tool?.annotations);
    if (reason) return { block: true, reason };
  });
}
