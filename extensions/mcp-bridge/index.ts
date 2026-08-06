/**
 * mcp-bridge — scoped MCP lookups without a full subagent.
 *
 * pi has no MCP by design; the standing pattern was "spawn a claude subagent
 * with blanket permissions for anything needing Linear/Sentry/Figma/prod
 * data". That had two costs: every one-line lookup booted a maximal Claude
 * Code child (project CLAUDE.md + skills + every MCP server, 10-30s), and the
 * child ran with far more capability than a lookup needs — the
 * highest-severity finding of the 2026-07 setup review.
 *
 * This extension replaces the pattern for *lookups*: one first-class tool per
 * service, each running a headless Claude Code query hard-scoped to that
 * service's MCP tools. Scoping is enforced in a PreToolUse hook (an
 * allow-list by tool-name prefix), not by prompt text, and the subagents
 * policy (`evaluateToolUse`) still applies on top, so Linear/Sentry/Figma
 * writes are refused even though the query runs unattended. Children load
 * only user-level settings — no project context, which is also what makes
 * them fast.
 *
 * Multi-step MCP work (triage across services, implement-from-Figma) still
 * belongs on a full `claude` subagent.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveClaudeBinary } from "../subagents/src/backends/claude.ts";
import { evaluateToolUse } from "../subagents/src/policy.ts";

interface BridgeService {
  /** Registered tool name. */
  readonly name: string;
  readonly label: string;
  /** The `mcp__<server>` segment whose tools the child may call. */
  readonly server: string;
  readonly description: string;
  /** Tools denied even inside the allowed server (e.g. metered escape hatches). */
  readonly deniedTools?: readonly string[];
}

const SERVICES: readonly BridgeService[] = [
  {
    name: "linear",
    label: "Linear",
    server: "claude_ai_Linear",
    description:
      "Look up Linear (read-only): issues, projects, comments, teams, documents. Give a precise request ('status + latest comments of LIF-4091'); returns findings as text. For multi-service or multi-step work, spawn a claude subagent instead.",
  },
  {
    name: "sentry",
    label: "Sentry",
    server: "claude_ai_Sentry",
    description:
      "Look up Sentry (read-only): issues, events, stack traces, releases. Give a precise request ('most frequent errors in backend-api last 24h'); returns findings as text.",
  },
  {
    name: "figma",
    label: "Figma",
    server: "plugin_figma_figma",
    description:
      "Read from Figma (read-only): design context, screenshots, variables, metadata for a node URL. Give the Figma URL plus what you need; returns findings as text. Design edits belong on a claude subagent, not here.",
  },
  {
    name: "liftoff_sql",
    label: "Liftoff prod data",
    server: "liftoff",
    description:
      "Query Liftoff production data through the read-only replica (sql_query). Give a question or SQL ('how many users hit X last week'); returns rows/findings as text. The metered `ask` tool is blocked — this bridge is the free path.",
    deniedTools: ["mcp__liftoff__ask"],
  },
];

const TIMEOUT_MS = 240_000;
const MAX_TURNS = 16;

/** Extract text output from a bridge child's result message. */
function resultToText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { type?: string; subtype?: string; result?: unknown };
  if (m.type !== "result") return undefined;
  if (typeof m.result === "string") return m.result;
  return m.subtype ? `(${m.subtype}, no text result)` : "(no text result)";
}

export default function mcpBridge(pi: ExtensionAPI) {
  for (const service of SERVICES) {
    const allowedPrefix = `mcp__${service.server}__`;
    const denied = new Set(service.deniedTools ?? []);

    pi.registerTool({
      name: service.name,
      label: service.label,
      description: service.description,
      parameters: Type.Object({
        request: Type.String({
          description: `What to find out from ${service.label}. Self-contained and specific: names, ids, URLs, time ranges.`,
        }),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const claudeBinary = resolveClaudeBinary();
        const abortController = new AbortController();
        const onAbort = () => abortController.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);

        try {
          const stream = query({
            prompt:
              `You are a read-only lookup bridge for ${service.label}. ` +
              `Only the ${service.label} MCP tools are available; every other tool is denied. ` +
              `Answer this request and report the findings as plain text (ids, links, and exact values included):\n\n` +
              params.request,
            options: {
              cwd: ctx.cwd,
              // Approval prompts cannot be answered headlessly; capability is
              // bounded by the PreToolUse allow-list below instead.
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              hooks: {
                PreToolUse: [
                  {
                    hooks: [
                      async (hookInput) => {
                        if (hookInput.hook_event_name !== "PreToolUse")
                          return {};
                        const tool = hookInput.tool_name;
                        const deny = (reason: string) => ({
                          hookSpecificOutput: {
                            hookEventName: "PreToolUse" as const,
                            permissionDecision: "deny" as const,
                            permissionDecisionReason: reason,
                          },
                        });
                        if (denied.has(tool)) {
                          return deny(
                            `${tool} is blocked on this bridge (metered or out of scope).`,
                          );
                        }
                        if (!tool.startsWith(allowedPrefix)) {
                          return deny(
                            `This bridge is scoped to ${service.label} MCP tools only. Answer from what you have.`,
                          );
                        }
                        const denial = evaluateToolUse(
                          tool,
                          hookInput.tool_input,
                        );
                        return denial ? deny(denial) : {};
                      },
                    ],
                  },
                ],
              },
              // User-level settings only: the child needs the account's MCP
              // connectors, not the project's CLAUDE.md and skills — this is
              // most of the latency win over a full subagent.
              settingSources: ["user" as const],
              model: "sonnet",
              maxTurns: MAX_TURNS,
              abortController,
              ...(claudeBinary
                ? { pathToClaudeCodeExecutable: claudeBinary }
                : {}),
            },
          });

          for await (const message of stream) {
            const text = resultToText(message);
            if (text !== undefined) {
              return {
                content: [{ type: "text" as const, text }],
                details: { service: service.name },
              };
            }
          }
          throw new Error(
            `${service.label} bridge ended without a result message.`,
          );
        } catch (error) {
          if (signal?.aborted) {
            throw new Error(`${service.label} lookup was cancelled.`);
          }
          if (abortController.signal.aborted) {
            throw new Error(
              `${service.label} lookup timed out after ${TIMEOUT_MS / 1000}s.`,
            );
          }
          throw error instanceof Error ? error : new Error(String(error));
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      },

      renderCall(args, theme) {
        return new Text(
          theme.fg("toolTitle", theme.bold(`${service.name} `)) +
            theme.fg("accent", args.request ?? "…"),
          0,
          0,
        );
      },

      renderResult(result, { expanded, isPartial }, theme) {
        if (isPartial)
          return new Text(theme.fg("warning", "looking up…"), 0, 0);
        const text =
          result.content[0]?.type === "text"
            ? (result.content[0].text ?? "")
            : "";
        const lines = text.split("\n");
        if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);
        const preview = lines.slice(0, 3).join("\n");
        let out = theme.fg("toolOutput", preview);
        if (lines.length > 3)
          out += `\n${theme.fg("dim", `… +${lines.length - 3} lines (ctrl+o to expand)`)}`;
        return new Text(out, 0, 0);
      },
    });
  }
}
