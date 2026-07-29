/** Terminal rendering for the `/todos` snapshot entry. */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Todo, TodoState, TodoStatus } from "./domain.ts";
import { summarize } from "./prompt.ts";

const GLYPH: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  cancelled: "⊘",
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
