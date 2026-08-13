/** Terminal rendering for the pinned widget and the `/todos` snapshot entry. */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  isBlocked,
  openItems,
  type Todo,
  type TodoState,
  type TodoStatus,
} from "./domain.ts";
import { renderWidgetLine, summarize } from "./prompt.ts";

/**
 * All four must share one font's metrics or rows drift horizontally. These are
 * all in JetBrains Mono (Ghostty's default) at the same 600/1000 advance —
 * U+25D0 ◐ is not, it is absent entirely and falls back to another font.
 *
 * ⊗ sits on the math axis, so it rides 30/1000 em below the geometric circles.
 * That is under half a pixel at any readable size, and worth it: ◌ was too
 * close to ○ to tell a cancelled item from a pending one at a glance.
 */
const GLYPH: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◕",
  completed: "●",
  cancelled: "⊗",
};

/**
 * A pending item still waiting on a dependency renders dotted and dim, so the
 * crisp ○ rows are exactly the work that can be picked up right now. This is
 * the per-row form of the "N blocked" count in the header.
 */
const BLOCKED_GLYPH = "◌";

const ROLE: Record<TodoStatus, ThemeColor> = {
  pending: "muted",
  in_progress: "accent",
  completed: "success",
  cancelled: "dim",
};

function renderTodo(todo: Todo, items: Todo[], theme: Theme): string {
  const blocked = todo.status === "pending" && isBlocked(todo, items);
  const glyph = blocked
    ? theme.fg("dim", BLOCKED_GLYPH)
    : theme.fg(ROLE[todo.status], GLYPH[todo.status]);
  const subject =
    todo.status === "cancelled"
      ? theme.fg("dim", theme.strikethrough(todo.subject))
      : todo.status === "completed"
        ? theme.fg("dim", todo.subject)
        : todo.status === "in_progress"
          ? theme.bold(todo.subject)
          : todo.subject;

  const tags: string[] = [];
  if (todo.owner) tags.push(`@${todo.owner}`);
  if (todo.blockedBy.length > 0)
    tags.push(`blocked by ${todo.blockedBy.join(", ")}`);

  const suffix =
    tags.length > 0 ? theme.fg("muted", ` · ${tags.join(" · ")}`) : "";
  return `  ${glyph} ${theme.fg("dim", todo.id.padStart(2))} ${subject}${suffix}`;
}

/**
 * A run of this many finished items collapses to first · ⋮ · last. Below it,
 * collapsing would hide fewer rows than it is worth, so the run stays whole.
 */
const MIN_COLLAPSED_RUN = 4;

const ELLIPSIS_ROW = "⋮";

/**
 * Drop the middle of every long run of finished (completed or cancelled) items
 * so the live end of the plan stays on screen. Anything still open breaks a
 * run and is always shown, so a stalled item cannot hide inside a collapse.
 *
 * Ids therefore skip across a ⋮ row. That is deliberate — the row marks where.
 */
export function collapseFinishedRuns(items: Todo[]): (Todo | null)[] {
  const rows: (Todo | null)[] = [];
  let start = 0;

  const finished = (todo: Todo) =>
    todo.status === "completed" || todo.status === "cancelled";

  while (start < items.length) {
    if (!finished(items[start]!)) {
      rows.push(items[start]!);
      start += 1;
      continue;
    }
    let end = start;
    while (end < items.length && finished(items[end]!)) end += 1;

    const run = items.slice(start, end);
    if (run.length < MIN_COLLAPSED_RUN) rows.push(...run);
    else rows.push(run[0]!, null, run[run.length - 1]!);
    start = end;
  }

  return rows;
}

const renderRows = (items: Todo[], theme: Theme) =>
  collapseFinishedRuns(items).map((row) =>
    row === null
      ? `  ${theme.fg("dim", ELLIPSIS_ROW)}`
      : renderTodo(row, items, theme),
  );

/**
 * The pinned widget above the editor. Returns undefined when nothing is open,
 * so a finished plan takes itself off screen.
 *
 * Collapsed falls back to the one-line form; expanded shows the whole plan so
 * it stays put instead of scrolling away as tool calls.
 */
export function renderPanel(
  state: TodoState,
  theme: Theme,
  collapsed: boolean,
): string | undefined {
  if (openItems(state).length === 0) return undefined;

  if (collapsed) {
    const line = renderWidgetLine(state);
    return line ? theme.fg("muted", line) : undefined;
  }

  const header =
    theme.fg("accent", theme.bold("todos")) +
    theme.fg("muted", ` · ${summarize(state)} · /todos to collapse`);

  return [header, ...renderRows(state.items, theme)].join("\n");
}

export function renderSnapshot(state: TodoState, theme: Theme): string {
  const header =
    theme.fg("accent", theme.bold("todos")) +
    theme.fg("muted", ` · ${summarize(state)}`);

  if (state.items.length === 0)
    return `${header}\n  ${theme.fg("dim", "(none)")}`;

  const lines = renderRows(state.items, theme);
  if (state.explanation)
    lines.push("", `  ${theme.fg("muted", state.explanation)}`);

  return [header, ...lines].join("\n");
}
