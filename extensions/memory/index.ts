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
 * into a compact summary): cheap appends, a bounded read, plain text that the
 * `recall` tool searches when the window has moved past an entry.
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
/** `recall` reads the WHOLE file, so its result needs its own ceiling. */
const RECALL_MAX_BYTES = 4 * 1024;
const RECALL_MAX_HITS = 12;

const PINNED_HEADING = "## Pinned";
const LOG_HEADING = "## Log";

const TEMPLATE = `# Memory

Append-only. \`## Pinned\` is always in the model's context; \`## Log\` is
newest-last and only its tail is. Search the whole file with the \`recall\` tool
when you need something older. Prune with \`/memory-compact\`.

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

/** Whole entries, oldest first. The `- ` bullet is the only record separator. */
export function splitEntries(section: string) {
  if (!section.trim()) return [];
  return section
    .split(/\n(?=- )/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Bare terms, deduped. Dates and paths survive whole (`2026-07-22`,
 * `backend/api`) because those are exactly what a lookup is usually keyed on.
 */
export function queryTerms(query: string) {
  return Array.from(
    new Set(query.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? []),
  );
}

/**
 * Substring counting, not ranked retrieval — the corpus is a few hundred lines,
 * so the honest ceiling here is "better than nothing older being reachable at
 * all". A whole-word hit outscores a substring one so that `api` prefers `the
 * api` over `rapid`, and matching EVERY term outscores matching several of one,
 * which is what keeps a two-term lookup from drowning in single-term noise.
 */
export function scoreEntry(entry: string, terms: string[]) {
  if (terms.length === 0) return 0;
  const hay = entry.toLowerCase();
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const at = hay.indexOf(term);
    if (at === -1) continue;
    matched++;
    const before = at === 0 ? " " : hay[at - 1]!;
    const after = hay[at + term.length] ?? " ";
    const wholeWord = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    score += wholeWord ? 2 : 1;
  }
  return matched === terms.length ? score + terms.length : score;
}

export type MemoryScope = {
  label: string;
  path?: string;
  text?: string;
};

export type RecallHit = {
  entry: string;
  scope: string;
  zone: "Pinned" | "Log";
  score: number;
};

/**
 * Search every entry in both scopes, not just the injected tail. This is the
 * whole reason the tool exists: `## Log` is append-only and only its last
 * ~4KB rides in context, so without this an older entry is unreachable — the
 * model cannot even tell it was ever recorded.
 */
export function searchMemory(
  scopes: MemoryScope[],
  query: string,
  options?: { maxHits?: number; maxBytes?: number },
) {
  const maxHits = options?.maxHits ?? RECALL_MAX_HITS;
  const maxBytes = options?.maxBytes ?? RECALL_MAX_BYTES;
  const terms = queryTerms(query);

  const candidates: (RecallHit & { age: number })[] = [];
  let scanned = 0;
  for (const scope of scopes) {
    if (!scope.text) continue;
    const { pinned, log } = parseSections(scope.text);
    const zones = [
      { zone: "Pinned" as const, entries: splitEntries(pinned) },
      { zone: "Log" as const, entries: splitEntries(log) },
    ];
    for (const { zone, entries } of zones) {
      entries.forEach((entry, index) => {
        scanned++;
        const score = scoreEntry(entry, terms);
        if (score > 0)
          candidates.push({
            entry,
            scope: scope.label,
            zone,
            score,
            // Newest-last within a zone, so a higher index is more recent.
            age: entries.length - index,
          });
      });
    }
  }

  // Best match first; on a tie the newer entry wins, because memory has no
  // contradiction handling and the later wording is the one that survived.
  candidates.sort((a, b) => b.score - a.score || a.age - b.age);

  const hits: RecallHit[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const candidate of candidates) {
    const size = Buffer.byteLength(candidate.entry, "utf8") + 1;
    if (hits.length >= maxHits || bytes + size > maxBytes) {
      dropped++;
      continue;
    }
    const { age: _age, ...hit } = candidate;
    hits.push(hit);
    bytes += size;
  }
  return { hits, scanned, matched: candidates.length, dropped, terms };
}

/** Result text. Says what it scanned and what it cut — never a silent cap. */
export function renderRecall(
  result: ReturnType<typeof searchMemory>,
  query: string,
) {
  if (result.terms.length === 0)
    return `No searchable terms in "${query}" — give recall a word or two of the fact you are after.`;
  if (result.hits.length === 0)
    return (
      `No memory entry matches "${query}" (searched all ${result.scanned} ` +
      `entries across both scopes, not just the tail in context). Treat this ` +
      `as "never recorded", not "scrolled out of the window".`
    );

  const byScope = new Map<string, RecallHit[]>();
  for (const hit of result.hits) {
    const list = byScope.get(hit.scope) ?? [];
    list.push(hit);
    byScope.set(hit.scope, list);
  }
  const sections = Array.from(byScope, ([scope, hits]) => {
    const lines = hits.map((hit) =>
      hit.zone === "Pinned" ? `${hit.entry}  [pinned]` : hit.entry,
    );
    return `## ${scope}\n\n${lines.join("\n")}`;
  });

  let out = `${result.hits.length} of ${result.matched} matching entries (${result.scanned} searched).\n\n${sections.join("\n\n")}`;
  if (result.dropped > 0)
    out += `\n\n${result.dropped} lower-scoring match${result.dropped === 1 ? "" : "es"} omitted — narrow the query to see them.`;
  return out;
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
    `notes are still in those files — call \`recall\` before assuming something ` +
    `was never recorded. Add a fact with the \`remember\` tool, never by ` +
    `editing the files.`
  );
}

/**
 * `- 2026-07-27 — text` — one line, sortable, greppable by date.
 *
 * A leading bullet and/or date on the incoming fact is stripped first: a model
 * that has read the file often mimics the format it saw, which stamped entries
 * as `- 2026-07-27 — 2026-07-27 — …` once observed in the wild.
 */
export function formatEntry(text: string, today = new Date()) {
  const day = today.toISOString().slice(0, 10);
  const flat = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-\s+/, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s*[—–-]\s*/, "")
    .trim();
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

  /** Both scopes, labelled the way the injected prompt labels them. */
  const memoryScopes = (cwd: string): MemoryScope[] => {
    const projectPath = projectMemoryPath(cwd);
    return [
      { label: "Global", path: memoryPath(), text: readFile(memoryPath()) },
      {
        label: projectPath
          ? `Project — ${path.basename(projectPath, ".md")}`
          : "Project",
        path: projectPath,
        text: readFile(projectPath),
      },
    ];
  };

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search the FULL memory files for entries matching a query. Only the " +
      "recent tail of `## Log` is injected into your context — every older " +
      "entry is reachable ONLY here, so a fact being absent from your context " +
      "is not evidence it was never recorded.\n\n" +
      "CALL IT when the user refers to a past decision, correction, or " +
      "constraint you cannot see; before saying something was never discussed " +
      "or never recorded; before `remember`, to avoid appending a duplicate; " +
      "and when starting work on an area this repo may already have gotchas " +
      "about.\n\n" +
      "Query with the distinctive words of the fact — a name, a flag, a path, " +
      "a date. Matching is literal substring scoring, not semantic: prefer " +
      "`migration drop column` over `what did we learn about deploys`.",
    promptSnippet: "Search memory for something older than the injected tail",
    promptGuidelines: [
      "Call recall before concluding that a fact was never recorded — your context holds only the tail of the log, not the whole file.",
      "Call recall before remember when the fact might already be there; duplicates are never pruned automatically.",
      "Query with distinctive literal terms (names, flags, paths, dates). Matching is substring-based, not semantic.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Distinctive words to match, space-separated. Literal substrings, not a question.",
      }),
      scope: Type.Optional(
        StringEnum(["all", "project", "global"] as const, {
          description:
            "all (default) searches both. Narrow only when the scope is certain.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "all";
      const all = memoryScopes(ctx.cwd);
      const selected =
        scope === "global"
          ? all.slice(0, 1)
          : scope === "project"
            ? all.slice(1)
            : all;
      const result = searchMemory(selected, params.query);
      return {
        content: [{ type: "text", text: renderRecall(result, params.query) }],
        details: { hits: result.hits, scanned: result.scanned },
      };
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

  pi.registerCommand("recall", {
    description: "Search all of memory, including entries older than the tail",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("usage: /recall <terms>", "warning");
        return;
      }
      const result = searchMemory(memoryScopes(ctx.cwd), query);
      ctx.ui.notify(renderRecall(result, query), "info");
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
