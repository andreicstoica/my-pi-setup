/** Terminal rendering for the pinned widget and the `/todos` snapshot entry. */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { openItems, type Todo, type TodoState, type TodoStatus } from "./domain.ts";
import { renderWidgetLine, summarize } from "./prompt.ts";

/**
 * All four must share one font's metrics or rows drift horizontally and
 * vertically. These are all in JetBrains Mono (Ghostty's default) with
 * identical advance (600/1000) and bounds — U+25D0 ◐ and U+2298 ⊘ are not
 * (◐ is absent entirely and falls back; ⊘ sits 30 units low on the math axis).
 */
const GLYPH: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◕",
  completed: "●",
  cancelled: "◌",
};

const ROLE: Record<TodoStatus, ThemeColor> = {
  pending: "muted",
  in_progress: "accent",
  completed: "success",
  cancelled: "dim",
};

function renderTodo(todo: Todo, theme: Theme): string {
  const glyph = theme.fg(ROLE[todo.status], GLYPH[todo.status]);
  const subject =
    todo.status === "completed" || todo.status === "cancelled"
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

  return [header, ...state.items.map((t) => renderTodo(t, theme))].join("\n");
}

export function renderSnapshot(state: TodoState, theme: Theme): string {
  const header =
    theme.fg("accent", theme.bold("todos")) +
    theme.fg("muted", ` · ${summarize(state)}`);

  if (state.items.length === 0)
    return `${header}\n  ${theme.fg("dim", "(none)")}`;

  const lines = state.items.map((t) => renderTodo(t, theme));
  if (state.explanation)
    lines.push("", `  ${theme.fg("muted", state.explanation)}`);

  return [header, ...lines].join("\n");
}
