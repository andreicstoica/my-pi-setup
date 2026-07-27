/**
 * Minimal markdown memory. One file, two zones, no database.
 *
 *   ~/.pi/agent/memory/MEMORY.md
 *     ## Pinned   — always injected, hard-capped. Durable facts.
 *     ## Log      — append-only, newest last. Only the TAIL is injected.
 *
 * The shape follows what actually survives in practice (OpenClaw's ~20KB
 * MEMORY.md plus append-only logs; ProjectMem's append-only event log projected
 * into a compact summary): cheap appends, a bounded read, plain text that `rg`
 * can search when the window has moved past an entry.
 *
 * Why two zones rather than one recency window: a pure tail evicts the oldest
 * entries first, and the oldest entries are exactly the load-bearing ones
 * ("never spawn pi subagents on anthropic"). Pinned is the fix, and it is why
 * this is not merely `cat MEMORY.md >> systemPrompt`.
 *
 * Known limits, stated rather than papered over: markdown memory has no ranked
 * retrieval and no contradiction handling, so a stale Pinned line outranks a
 * correct newer Log line forever. `/memory-compact` is the manual answer, and
 * the reason the caps are small enough that reading the whole file stays cheap.
 *
 * The file is deliberately gitignored — ~/.pi/agent is a PUBLIC repo.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Pinned is small on purpose: everything here is in context on every turn. */
const PINNED_MAX_BYTES = 2 * 1024;
/** Tail of the log that rides along. ~40 one-line entries. */
const LOG_WINDOW_BYTES = 4 * 1024;

const PINNED_HEADING = "## Pinned";
const LOG_HEADING = "## Log";

const TEMPLATE = `# Memory

Append-only. \`## Pinned\` is always in the model's context; \`## Log\` is
newest-last and only its tail is. Search the whole file with \`rg\` when you need
something older. Prune with \`/memory-compact\`.

${PINNED_HEADING}

${LOG_HEADING}
`;

function memoryPath() {
  return path.join(getAgentDir(), "memory", "MEMORY.md");
}

function read() {
  try {
    return fs.readFileSync(memoryPath(), "utf8");
  } catch {
    return undefined;
  }
}

/** Split on the two headings. Missing sections read as empty, never as an error. */
export function parseSections(text: string) {
  const pinnedAt = text.indexOf(PINNED_HEADING);
  const logAt = text.indexOf(LOG_HEADING);
  const pinned =
    pinnedAt === -1
      ? ""
      : text.slice(pinnedAt + PINNED_HEADING.length, logAt === -1 ? undefined : logAt);
  const log = logAt === -1 ? "" : text.slice(logAt + LOG_HEADING.length);
  return { pinned: pinned.trim(), log: log.trim() };
}

/**
 * Last whole entries fitting the budget. Entry-aligned so the window never
 * opens mid-sentence — a half-truncated memory reads as a complete one.
 */
export function tailEntries(log: string, maxBytes: number) {
  if (!log) return "";
  const entries = log
    .split(/\n(?=- )/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const kept: string[] = [];
  let bytes = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(entries[i]!, "utf8") + 1;
    if (bytes + size > maxBytes) break;
    kept.unshift(entries[i]!);
    bytes += size;
  }
  // A single entry larger than the whole budget still beats returning nothing.
  if (kept.length === 0 && entries.length > 0) return entries[entries.length - 1]!;
  return kept.join("\n");
}

export function buildMemoryPrompt(text: string) {
  const { pinned, log } = parseSections(text);
  const window = tailEntries(log, LOG_WINDOW_BYTES);
  if (!pinned && !window) return undefined;

  let prompt = "# Memory\n\nDurable facts about this user and their setup.";
  if (pinned) prompt += `\n\n## Pinned\n\n${pinned}`;
  if (window) {
    prompt += `\n\n## Recent notes (newest last)\n\n${window}`;
  }
  prompt +=
    `\n\nThis is the recent tail of \`${memoryPath()}\`; older notes are in that ` +
    `file — grep it before assuming something was never recorded. Record a new ` +
    `durable fact with the \`remember\` tool, never by editing the file directly.`;
  return prompt;
}

/** `- 2026-07-27 — text` — one line, sortable, greppable by date. */
function formatEntry(text: string) {
  const day = new Date().toISOString().slice(0, 10);
  const flat = text.replace(/\s+/g, " ").trim();
  return `- ${day} — ${flat}`;
}

function ensureFile() {
  const target = memoryPath();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, TEMPLATE, "utf8");
  }
  return target;
}

/** Append into a section, creating the heading if the file predates it. */
export function appendToSection(
  text: string,
  section: "pinned" | "log",
  entry: string,
) {
  const heading = section === "pinned" ? PINNED_HEADING : LOG_HEADING;
  const at = text.indexOf(heading);
  if (at === -1) return `${text.trimEnd()}\n\n${heading}\n\n${entry}\n`;

  const bodyStart = at + heading.length;
  const nextHeading = text.indexOf("\n## ", bodyStart);
  const end = nextHeading === -1 ? text.length : nextHeading;
  const body = text.slice(bodyStart, end).replace(/\s+$/, "");
  return `${text.slice(0, bodyStart)}${body}\n${entry}\n${text.slice(end)}`;
}

export default function (pi: ExtensionAPI) {
  const remember = (input: string, pinned: boolean) => {
    const target = ensureFile();
    const current = fs.readFileSync(target, "utf8");
    const entry = formatEntry(input);
    const next = appendToSection(current, pinned ? "pinned" : "log", entry);
    fs.writeFileSync(target, next, "utf8");

    const { pinned: pinnedText } = parseSections(next);
    const overflow = Buffer.byteLength(pinnedText, "utf8") > PINNED_MAX_BYTES;
    return { entry, overflow };
  };

  pi.on("before_agent_start", (event) => {
    const text = read();
    if (!text) return undefined;
    const memory = buildMemoryPrompt(text);
    if (!memory) return undefined;
    // Appending the same block each turn keeps the prefix stable, so prompt
    // caching still hits. Injecting a message instead would grow the session.
    return { systemPrompt: `${event.systemPrompt}\n\n${memory}` };
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Append one durable fact to the user's memory file. Use for things that " +
      "stay true across sessions and are not discoverable from the code: their " +
      "preferences, environment quirks, decisions and the reason behind them. " +
      "Do NOT record task state, file contents, or anything already in AGENTS.md.",
    promptSnippet: "Append a durable fact about the user or their setup to memory",
    promptGuidelines: [
      "Call remember when the user states a durable preference, or when you learn a non-obvious environment fact the hard way.",
      "One fact per call, phrased so it still makes sense months later. Pin only what must never be evicted from context.",
    ],
    parameters: Type.Object({
      fact: Type.String({
        description:
          "The fact, one or two sentences, self-contained. Absolute dates, not 'today'.",
      }),
      pinned: Type.Optional(
        Type.Boolean({
          description:
            "True only for facts that must be in context every turn (safety rails, hard constraints). Default false.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { entry, overflow } = remember(params.fact, params.pinned === true);
      let text = `Recorded in ${memoryPath()}:\n${entry}`;
      if (overflow) {
        text +=
          `\n\nPinned section now exceeds ${PINNED_MAX_BYTES} bytes — it rides in ` +
          `every turn, so tell the user to run /memory-compact.`;
      }
      return { content: [{ type: "text", text }], details: { entry } };
    },
  });

  pi.registerCommand("remember", {
    description: "Append a fact to memory (prefix with ! to pin it)",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("usage: /remember <fact>  (or /remember !<fact> to pin)", "warning");
        return;
      }
      const pinned = input.startsWith("!");
      const { entry, overflow } = remember(pinned ? input.slice(1) : input, pinned);
      ctx.ui.notify(`${pinned ? "pinned" : "remembered"}: ${entry}`, "info");
      if (overflow) ctx.ui.notify("pinned section is over budget — /memory-compact", "warning");
    },
  });

  pi.registerCommand("memory", {
    description: "Show the memory file path and what is currently in context",
    handler: async (_args, ctx) => {
      const text = read();
      if (!text) {
        ctx.ui.notify(`no memory yet — ${memoryPath()}`, "info");
        return;
      }
      const { pinned, log } = parseSections(text);
      const entries = log ? log.split(/\n(?=- )/).length : 0;
      const injected = tailEntries(log, LOG_WINDOW_BYTES);
      const shown = injected ? injected.split(/\n(?=- )/).length : 0;
      ctx.ui.notify(
        `${memoryPath()} — ${Buffer.byteLength(pinned, "utf8")}B pinned, ` +
          `${shown}/${entries} log entries in context`,
        "info",
      );
    },
  });

  pi.registerCommand("memory-compact", {
    description: "Ask the agent to prune and dedupe the memory file",
    handler: async (_args, _ctx) => {
      pi.sendUserMessage(
        `Compact ${memoryPath()}. Read it, then rewrite it in place: merge ` +
          `duplicates, drop what is stale or now obvious, keep Pinned under ` +
          `${PINNED_MAX_BYTES} bytes, preserve the two headings and the ` +
          `\`- YYYY-MM-DD — fact\` line format, and keep the newest wording when ` +
          `two entries disagree. Show me a diff summary of what you removed.`,
      );
    },
  });
}
