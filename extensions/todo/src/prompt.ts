/**
 * Everything the model reads: the tool description, the guideline bullets the
 * system prompt picks up, and the `<todos>` block re-pinned into context on
 * every request.
 *
 * The plan-quality examples are lifted from the Codex CLI's `update_plan`
 * prompt, which is well tuned and worth not reinventing.
 */

import {
  isOpen,
  openItems,
  type Todo,
  type TodoState,
  type TodoStatus,
} from "./domain.ts";

export const TODO_TOOL_DESCRIPTION = `Track the plan for multi-step work as a live checklist the user can see.

Call this when work takes more than a couple of steps, when the user hands you
several things at once, or when you discover follow-up work mid-task. Skip it
for single-step or purely conversational requests — a checklist for trivial
work is noise.

One call can create and update in the same request. Ids are assigned on create
and returned to you; use them in \`update\`.

Statuses: pending, in_progress, completed, cancelled.

Keep exactly one item in_progress at a time. Mark an item in_progress before
you start it, and completed the moment it is genuinely done — not in a batch at
the end. If understanding changes (steps split, merge, reorder, get dropped),
update the plan first and pass \`explanation\` saying why.

Only mark completed when it is actually finished. If you hit a blocker, leave it
in_progress and create a new item for the blocker.

Steps should be short — a single line, roughly 5-9 words, phrased so it is
obvious when it is done.

Good plans:
  1. Add CLI entry with file args
  2. Parse Markdown via CommonMark library
  3. Apply semantic HTML template
  4. Handle code blocks, images, links
  5. Add error handling for invalid files

  1. Define CSS variables for colors
  2. Add toggle with localStorage state
  3. Refactor components to use variables
  4. Verify all views for readability

Bad plans (too vague, no verifiable finish line):
  1. Create CLI tool
  2. Add Markdown parser
  3. Convert to HTML

  1. Add dark mode toggle
  2. Save preference
  3. Make styles look good

Do not restate the checklist in your reply — the user already sees it rendered.
Summarize what changed and what is next instead.`;

export const TODO_PROMPT_SNIPPET =
  "todo: track and update the visible plan for multi-step work";

export const TODO_PROMPT_GUIDELINES = [
  "For multi-step work, keep the `todo` checklist current: exactly one item in_progress, completed marked as you go, never batch-completed at the end.",
  "The current checklist is re-pinned into your context each turn inside a `<todos>` block — trust that block over anything older in the transcript.",
  "Never repeat the checklist contents in your reply; the harness renders it.",
];

export const TODO_PARAMETER_DESCRIPTIONS = {
  create: "New items to append, in order. Each starts as pending.",
  createSubject: "Imperative one-liner, roughly 5-9 words.",
  createActiveForm:
    'Present continuous form shown in the spinner while this item runs (e.g. "Wiring the dock").',
  createBlockedBy: "Ids of items that must finish before this one can start.",
  createOwner: "Agent name that owns this item, when delegating.",
  update: "Patches to existing items, applied after any creates in this call.",
  updateId: "Id of the item to patch.",
  updateStatus: "New status for the item.",
  explanation:
    "Why the plan changed. Include this whenever steps are added, dropped, or reordered mid-task.",
} as const;

const MARK: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: ">",
  completed: "x",
  cancelled: "-",
};

const line = (todo: Todo) => {
  const parts = [`${todo.id}. [${MARK[todo.status]}] ${todo.subject}`];
  if (todo.owner) parts.push(`(@${todo.owner})`);
  const blockers = todo.blockedBy;
  if (blockers.length > 0) parts.push(`(blocked by ${blockers.join(", ")})`);
  return parts.join(" ");
};

/**
 * The block injected at the tail of context every turn. Returns undefined when
 * there is nothing open, so finished plans stop costing tokens.
 */
export function renderContextBlock(state: TodoState): string | undefined {
  if (openItems(state).length === 0) return undefined;

  const body = state.items.map(line).join("\n");
  const running = state.items.find((t) => t.status === "in_progress");
  const footer = running
    ? `Currently in progress: ${running.id}.`
    : "Nothing is in_progress — mark the next item in_progress before working on it.";

  return [
    "<todos>",
    "Live plan for this session. This is the authoritative copy; ignore older",
    "versions in the transcript. Keep it current with the `todo` tool.",
    "",
    body,
    "",
    footer,
    "</todos>",
  ].join("\n");
}

/** What the tool call returns to the model. */
export function renderToolResult(state: TodoState, warnings: string[]): string {
  const body = state.items.length
    ? state.items.map(line).join("\n")
    : "(no todos)";
  const counts = summarize(state);
  const out = [body, "", counts];
  if (warnings.length > 0)
    out.push("", ...warnings.map((w) => `warning: ${w}`));
  return out.join("\n");
}

export function summarize(state: TodoState): string {
  const done = state.items.filter((t) => t.status === "completed").length;
  const total = state.items.filter((t) => t.status !== "cancelled").length;
  const running = state.items.filter((t) => t.status === "in_progress").length;
  const blocked = state.items.filter(
    (t) =>
      isOpen(t) &&
      t.blockedBy.some((id) => {
        const dep = state.items.find((d) => d.id === id);
        return dep ? isOpen(dep) : false;
      }),
  ).length;

  const parts = [`${done}/${total} done`];
  if (running > 0) parts.push(`${running} in progress`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(" · ");
}

/** One-line widget text, or undefined when there is nothing worth showing. */
export function renderWidgetLine(state: TodoState): string | undefined {
  const open = openItems(state);
  if (open.length === 0) return undefined;

  const running = state.items.find((t) => t.status === "in_progress");
  const label = running
    ? running.activeForm || running.subject
    : `${open.length} todo${open.length === 1 ? "" : "s"} pending`;
  return `todo · ${label} · ${summarize(state)} · /todos`;
}

/** Reminder surfaced after compaction so the plan is never silently dropped. */
export function renderCompactionHint(state: TodoState): string | undefined {
  const open = openItems(state);
  if (open.length === 0) return undefined;
  return `${open.length} unfinished todo${open.length === 1 ? "" : "s"} carried through compaction — see the <todos> block.`;
}
