/**
 * Minimal markdown memory. Two scopes, two zones each, no database.
 *
 *   ~/.pi/agent/memory/MEMORY.md                 global — user + harness
 *   ~/.pi/agent/memory/projects/<owner>-<repo>.md  per repo
 *     ## Pinned   — always injected, hard-capped. Durable facts.
 *     ## Log      — append-only, newest last. Only the TAIL is injected.
 *
 * Project memory is keyed on the git REMOTE, not the checkout path, so every kit
 * worktree of liftoff-app shares one file — a fact learned in one worktree is
 * true in all of them. It lives under the agent dir rather than in the repo, so
 * it cannot be committed into a worktree by accident, which is the failure mode
 * a `<repo>/MEMORY.md` would eventually hit.
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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
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

/**
 * Repo identity for project memory. The remote URL is the key, so every kit
 * worktree of liftoff-app maps to ONE file — worktrees are separate checkouts of
 * the same project, and a fact learned in one is true in all of them. Falls back
 * to the shared git dir (which worktrees also have in common) when there is no
 * remote, and to undefined outside a repo.
 */
export function repoSlug(options: {
  remoteUrl?: string;
  gitCommonDir?: string;
}) {
  const remote = options.remoteUrl?.trim();
  if (remote) {
    const match = remote.replace(/\.git$/, "").match(/[:/]([^/:]+)\/([^/]+)$/);
    if (match) return sanitize(`${match[1]}-${match[2]}`);
  }
  const common = options.gitCommonDir?.trim();
  if (common) {
    // `<repo>/.git` -> `<repo>`; a bare or worktree dir keeps its own name.
    const dir =
      path.basename(common) === ".git" ? path.dirname(common) : common;
    const name = path.basename(dir);
    if (name) return sanitize(name);
  }
  return undefined;
}

function sanitize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 64);
}

function git(cwd: string, args: string[]) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Cached per cwd: this runs on every turn and shelling out to git is not free. */
const projectPathCache = new Map<string, string | undefined>();

export function projectMemoryPath(cwd: string) {
  const cached = projectPathCache.get(cwd);
  if (cached !== undefined || projectPathCache.has(cwd)) return cached;

  const gitCommonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
  const slug = repoSlug({
    remoteUrl: git(cwd, ["config", "--get", "remote.origin.url"]),
    // `--git-common-dir` can be the relative ".git"; resolve against cwd.
    gitCommonDir: gitCommonDir ? path.resolve(cwd, gitCommonDir) : undefined,
  });
  const resolved = slug
    ? path.join(getAgentDir(), "memory", "projects", `${slug}.md`)
    : undefined;
  projectPathCache.set(cwd, resolved);
  return resolved;
}

function readFile(target: string | undefined) {
  if (!target) return undefined;
  try {
    return fs.readFileSync(target, "utf8");
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
      : text.slice(
          pinnedAt + PINNED_HEADING.length,
          logAt === -1 ? undefined : logAt,
        );
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
  if (kept.length === 0 && entries.length > 0)
    return entries[entries.length - 1]!;
  return kept.join("\n");
}

/** One scope's zones, rendered. Undefined when the scope has nothing to say. */
function renderScope(text: string | undefined, heading: string) {
  if (!text) return undefined;
  const { pinned, log } = parseSections(text);
  const window = tailEntries(log, LOG_WINDOW_BYTES);
  if (!pinned && !window) return undefined;

  let out = `## ${heading}`;
  if (pinned) out += `\n\n### Pinned\n\n${pinned}`;
  if (window) out += `\n\n### Recent notes (newest last)\n\n${window}`;
  return out;
}

export function buildMemoryPrompt(sources: {
  global?: string;
  project?: string;
  projectLabel?: string;
  paths?: { global?: string; project?: string };
}) {
  const sections = [
    renderScope(sources.global, "Global — the user and their harness"),
    renderScope(
      sources.project,
      `Project — ${sources.projectLabel ?? "this repo"}`,
    ),
  ].filter((section): section is string => section !== undefined);
  if (sections.length === 0) return undefined;

  const files = [sources.paths?.global, sources.paths?.project]
    .filter((file): file is string => Boolean(file))
    .join(" and ");

  return (
    `# Memory\n\nDurable facts recorded across sessions.\n\n${sections.join("\n\n")}` +
    `\n\nThese are the recent tails of ${files || "the memory files"}; older ` +
    `notes are still in those files — grep before assuming something was never ` +
    `recorded. Add a fact with the \`remember\` tool, never by editing the files.`
  );
}

/** `- 2026-07-27 — text` — one line, sortable, greppable by date. */
function formatEntry(text: string) {
  const day = new Date().toISOString().slice(0, 10);
  const flat = text.replace(/\s+/g, " ").trim();
  return `- ${day} — ${flat}`;
}

function ensureFile(target: string) {
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
  const remember = (options: {
    fact: string;
    pinned: boolean;
    cwd: string;
    scope: "project" | "global";
  }) => {
    const projectPath = projectMemoryPath(options.cwd);
    // Asking for project scope outside a repo silently writing to global would
    // hide the fact from the place it belongs, so say which file was used.
    const target = ensureFile(
      options.scope === "project" && projectPath ? projectPath : memoryPath(),
    );
    const current = fs.readFileSync(target, "utf8");
    const entry = formatEntry(options.fact);
    const next = appendToSection(
      current,
      options.pinned ? "pinned" : "log",
      entry,
    );
    fs.writeFileSync(target, next, "utf8");

    const { pinned: pinnedText } = parseSections(next);
    return {
      entry,
      target,
      overflow: Buffer.byteLength(pinnedText, "utf8") > PINNED_MAX_BYTES,
    };
  };

  pi.on("before_agent_start", (event, ctx) => {
    const projectPath = projectMemoryPath(ctx.cwd);
    const memory = buildMemoryPrompt({
      global: readFile(memoryPath()),
      project: readFile(projectPath),
      projectLabel: projectPath ? path.basename(projectPath, ".md") : undefined,
      paths: { global: memoryPath(), project: projectPath },
    });
    if (!memory) return undefined;
    // Appending the same block each turn keeps the prefix stable, so prompt
    // caching still hits. Injecting a message instead would grow the session.
    return { systemPrompt: `${event.systemPrompt}\n\n${memory}` };
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Append ONE durable fact to memory. The bar is high: a fact earns a slot " +
      "only if it will still be true and still be useful weeks from now, AND it " +
      "cannot be recovered by reading the repo, the git history, or AGENTS.md. " +
      "Most things fail that bar — when unsure, do not record.\n\n" +
      "RECORD: a constraint discovered the hard way (a tool that silently " +
      "no-ops, an credential that does not exist, a parameter whose wrong " +
      "spelling fails quietly); a decision plus the reason it was made that way; " +
      "a workflow the user corrected you on.\n\n" +
      "DO NOT RECORD: anything cosmetic (themes, colours, fonts, padding); " +
      "task or session state ('currently refactoring X'); file contents, paths " +
      "or APIs a `read`/`rg` would show; restatements of AGENTS.md or CLAUDE.md; " +
      "one-off answers; anything you have not verified.",
    promptSnippet:
      "Record a durable, hard-won fact about this project or the user's setup",
    promptGuidelines: [
      "Call remember only for a fact that survives the session AND is not discoverable from the repo — a silent failure mode, a decision and its reason, a correction the user made. Cosmetic preferences and task state never qualify.",
      "Default to project scope; use global only for facts about the user or the pi harness itself that hold in every repo.",
      "One fact per call, self-contained, absolute dates. Pin only hard constraints that must never fall out of context.",
    ],
    parameters: Type.Object({
      fact: Type.String({
        description:
          "The fact, one or two sentences, self-contained. Absolute dates, not 'today'.",
      }),
      scope: Type.Optional(
        StringEnum(["project", "global"] as const, {
          description:
            "project (default) = true of this repo, shared by all its worktrees. global = true of the user or the pi harness everywhere.",
        }),
      ),
      pinned: Type.Optional(
        Type.Boolean({
          description:
            "True only for facts that must be in context every turn (safety rails, hard constraints). Default false.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "project";
      const { entry, target, overflow } = remember({
        fact: params.fact,
        pinned: params.pinned === true,
        cwd: ctx.cwd,
        scope,
      });
      let text = `Recorded in ${target}:\n${entry}`;
      if (scope === "project" && !projectMemoryPath(ctx.cwd)) {
        text += `\n\nNote: ${ctx.cwd} is not in a git repo, so this went to global memory.`;
      }
      if (overflow) {
        text +=
          `\n\nPinned section now exceeds ${PINNED_MAX_BYTES} bytes — it rides in ` +
          `every turn, so tell the user to run /memory-compact.`;
      }
      return { content: [{ type: "text", text }], details: { entry, target } };
    },
  });

  const registerRemember = (name: string, scope: "project" | "global") => {
    pi.registerCommand(name, {
      description:
        `Append a fact to ${scope} memory (prefix with ! to pin it)` +
        (scope === "project" ? " — shared by every worktree of this repo" : ""),
      handler: async (args, ctx) => {
        const input = args.trim();
        if (!input) {
          ctx.ui.notify(`usage: /${name} <fact>  (!<fact> to pin)`, "warning");
          return;
        }
        const pinned = input.startsWith("!");
        const { entry, target, overflow } = remember({
          fact: pinned ? input.slice(1) : input,
          pinned,
          cwd: ctx.cwd,
          scope,
        });
        ctx.ui.notify(
          `${pinned ? "pinned" : "remembered"} in ${path.basename(target)}: ${entry}`,
          "info",
        );
        if (overflow)
          ctx.ui.notify(
            "pinned section is over budget — /memory-compact",
            "warning",
          );
      },
    });
  };

  registerRemember("remember", "project");
  registerRemember("remember-global", "global");

  pi.registerCommand("memory", {
    description:
      "Show which memory files are loaded and how much is in context",
    handler: async (_args, ctx) => {
      const projectPath = projectMemoryPath(ctx.cwd);
      const lines = (
        [
          ["global", memoryPath()],
          ["project", projectPath],
        ] as const
      ).map(([label, file]) => {
        if (!file) return `${label}: (not in a git repo)`;
        const text = readFile(file);
        if (!text) return `${label}: (none yet) ${file}`;
        const { pinned, log } = parseSections(text);
        const total = log ? log.split(/\n(?=- )/).length : 0;
        const injected = tailEntries(log, LOG_WINDOW_BYTES);
        const shown = injected ? injected.split(/\n(?=- )/).length : 0;
        return (
          `${label}: ${Buffer.byteLength(pinned, "utf8")}B pinned, ` +
          `${shown}/${total} log entries in context — ${file}`
        );
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("memory-compact", {
    description:
      "Ask the agent to prune and dedupe memory (project by default)",
    handler: async (args, ctx) => {
      const wantsGlobal = args.trim() === "global";
      const target = wantsGlobal
        ? memoryPath()
        : (projectMemoryPath(ctx.cwd) ?? memoryPath());
      pi.sendUserMessage(
        `Compact ${target}. Read it, then rewrite it in place: merge duplicates, ` +
          `drop anything stale, cosmetic, or now discoverable from the repo, keep ` +
          `Pinned under ${PINNED_MAX_BYTES} bytes, preserve the two headings and ` +
          `the \`- YYYY-MM-DD — fact\` line format, and keep the newest wording ` +
          `when two entries disagree. Show me what you removed and why.`,
      );
    },
  });
}
