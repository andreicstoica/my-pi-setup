/**
 * Todo — a live, branch-aware plan for multi-step work.
 *
 * Tool (for the LLM):
 * - todo: create and/or update checklist items in one call. Ids are assigned
 *   on create. Warnings (two items in_progress, pending→completed jumps,
 *   unresolved blockers) come back in the result so the model self-corrects.
 *
 * The point of the design is that the plan cannot go stale. Every mutation is
 * appended to the session as a custom entry (state only, never in LLM context),
 * and the folded state is re-pinned at the tail of context on every request via
 * the `context` event. The model always reads one authoritative `<todos>` block
 * instead of archaeology through the transcript — which also means the plan
 * survives compaction for free.
 *
 * Because mutations live in session entries, `getBranch()` gives us exactly the
 * ones on the current path: forking or navigating the session tree rewinds the
 * checklist to match, with no extra bookkeeping.
 *
 * UI: the plan lives in a widget pinned above the editor, so it stays on screen
 * instead of scrolling away with the tool calls that produced it. It removes
 * itself once nothing is open. `/todos` collapses it to a single line and back.
 * The tool's own transcript entry stays one line, since the widget is the copy
 * worth reading.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyMutation,
  emptyTodoState,
  openItems,
  replay,
  type TodoMutation,
  type TodoState,
} from "./src/domain.ts";
import {
  renderCompactionHint,
  renderContextBlock,
  renderToolResult,
  summarize,
  TODO_PARAMETER_DESCRIPTIONS,
  TODO_PROMPT_GUIDELINES,
  TODO_PROMPT_SNIPPET,
  TODO_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { renderPanel, renderSnapshot } from "./src/view.ts";

const MUTATION_ENTRY = "todo/mutation";
const SNAPSHOT_ENTRY = "todo/snapshot";
const WIDGET_KEY = "todo";

const STATUS = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

/** Details attached to the tool result, read back by `renderResult`. */
type TodoDetails = {
  createdIds: string[];
  warnings: string[];
  summary: string;
};

export default function (pi: ExtensionAPI) {
  let state: TodoState = emptyTodoState();
  let ui: ExtensionUIContext | undefined;
  let collapsed = false;

  /**
   * Rebuild from the mutations on the current branch. Called whenever the
   * session path can have changed underneath us.
   */
  const resync = (ctx: ExtensionContext) => {
    const mutations = ctx.sessionManager
      .getBranch()
      .filter(
        (entry): entry is typeof entry & { data?: TodoMutation } =>
          entry.type === "custom" && entry.customType === MUTATION_ENTRY,
      )
      .map((entry) => entry.data)
      .filter((data): data is TodoMutation => Boolean(data));

    state = replay(mutations);
    refreshUI();
  };

  const refreshUI = () => {
    if (!ui) return;

    // The component factory overload is what gets us the theme; the string[]
    // one does not. Passing a fresh factory rebuilds the widget from `state`.
    ui.setWidget(
      WIDGET_KEY,
      openItems(state).length > 0
        ? (_tui, theme) =>
            new Text(renderPanel(state, theme, collapsed) ?? "", 1, 0)
        : undefined,
      { placement: "aboveEditor" },
    );

    // The spinner narrates the active step, which is the whole reason
    // activeForm exists.
    const running = state.items.find((t) => t.status === "in_progress");
    ui.setWorkingMessage(running?.activeForm || undefined);
  };

  // --- Lifecycle ---------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    resync(ctx);
  });

  // Navigating the session tree moves the leaf, so the branch — and therefore
  // the plan — changes.
  pi.on("session_tree", (_event, ctx) => resync(ctx));

  pi.on("session_compact", (_event, ctx) => {
    const hint = renderCompactionHint(state);
    if (hint) ctx.ui.notify(hint, "info");
    refreshUI();
  });

  pi.on("session_shutdown", () => {
    ui?.setWidget(WIDGET_KEY, undefined);
    ui?.setWorkingMessage();
    ui = undefined;
  });

  // --- Context pinning ---------------------------------------------------

  pi.on("context", (event) => {
    const block = renderContextBlock(state);
    if (!block) return;

    return {
      messages: [
        ...event.messages,
        { role: "user" as const, content: block, timestamp: Date.now() },
      ],
    };
  });

  // --- Tool --------------------------------------------------------------

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: TODO_TOOL_DESCRIPTION,
    promptSnippet: TODO_PROMPT_SNIPPET,
    promptGuidelines: TODO_PROMPT_GUIDELINES,
    parameters: Type.Object({
      create: Type.Optional(
        Type.Array(
          Type.Object({
            subject: Type.String({
              description: TODO_PARAMETER_DESCRIPTIONS.createSubject,
            }),
            activeForm: Type.Optional(
              Type.String({
                description: TODO_PARAMETER_DESCRIPTIONS.createActiveForm,
              }),
            ),
            blockedBy: Type.Optional(
              Type.Array(Type.String(), {
                description: TODO_PARAMETER_DESCRIPTIONS.createBlockedBy,
              }),
            ),
            owner: Type.Optional(
              Type.String({
                description: TODO_PARAMETER_DESCRIPTIONS.createOwner,
              }),
            ),
          }),
          { description: TODO_PARAMETER_DESCRIPTIONS.create },
        ),
      ),
      update: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({
              description: TODO_PARAMETER_DESCRIPTIONS.updateId,
            }),
            status: Type.Optional(
              Type.Union(STATUS.anyOf, {
                description: TODO_PARAMETER_DESCRIPTIONS.updateStatus,
              }),
            ),
            subject: Type.Optional(Type.String()),
            activeForm: Type.Optional(Type.String()),
            owner: Type.Optional(Type.String()),
            blockedBy: Type.Optional(Type.Array(Type.String())),
          }),
          { description: TODO_PARAMETER_DESCRIPTIONS.update },
        ),
      ),
      explanation: Type.Optional(
        Type.String({
          description: TODO_PARAMETER_DESCRIPTIONS.explanation,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const mutation: TodoMutation = {
        create: params.create,
        update: params.update,
        explanation: params.explanation,
      };

      if (!mutation.create?.length && !mutation.update?.length)
        throw new Error("todo needs at least one create or update.");

      const result = applyMutation(state, mutation);
      state = result.state;

      // appendEntry is a synchronous SessionManager write and never enters LLM
      // context, so it is safe to call mid-stream.
      pi.appendEntry<TodoMutation>(MUTATION_ENTRY, mutation);
      refreshUI();

      return {
        content: [
          { type: "text", text: renderToolResult(state, result.warnings) },
        ],
        details: {
          createdIds: result.createdIds,
          warnings: result.warnings,
          summary: summarize(state),
        },
      };
    },

    // The pinned widget is the copy worth reading, so the transcript entry
    // stays a single line instead of replaying the whole list on every call.
    renderResult(result, _options, theme) {
      const details = result.details as TodoDetails | undefined;
      const parts = [theme.fg("muted", details?.summary ?? "updated")];
      for (const warning of details?.warnings ?? [])
        parts.push(theme.fg("warning", `warning: ${warning}`));
      return new Text(parts.join(" · "), 1, 0);
    },
  });

  // --- Commands and rendering --------------------------------------------

  // The plan is already pinned above the editor, so this collapses it to one
  // line rather than appending another copy to the scrollback.
  pi.registerCommand("todos", {
    description: "Collapse or expand the pinned plan",
    handler: async (_args, ctx) => {
      resync(ctx);
      collapsed = !collapsed;
      refreshUI();
      if (openItems(state).length === 0)
        ctx.ui.notify("No open todos.", "info");
    },
  });

  // Mutation entries carry state only; they are already reflected in the tool
  // result above the fold, so they render as nothing.
  pi.registerEntryRenderer(MUTATION_ENTRY, () => ({
    render: () => [],
    invalidate: () => {},
  }));

  // Snapshots are no longer appended — `/todos` toggles the widget instead —
  // but sessions recorded before that change still carry these entries.
  pi.registerEntryRenderer<TodoState>(
    SNAPSHOT_ENTRY,
    (entry, _options, theme) =>
      new Text(renderSnapshot(entry.data ?? emptyTodoState(), theme), 0, 0),
  );
}
