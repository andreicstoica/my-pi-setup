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
 * UI: a one-line widget above the editor showing the active step, and `/todos`
 * to drop a rendered snapshot into the scrollback.
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
  replay,
  type TodoMutation,
  type TodoState,
} from "./src/domain.ts";
import {
  renderCompactionHint,
  renderContextBlock,
  renderToolResult,
  renderWidgetLine,
  summarize,
  TODO_PARAMETER_DESCRIPTIONS,
  TODO_PROMPT_GUIDELINES,
  TODO_PROMPT_SNIPPET,
  TODO_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { renderSnapshot } from "./src/view.ts";

const MUTATION_ENTRY = "todo/mutation";
const SNAPSHOT_ENTRY = "todo/snapshot";
const WIDGET_KEY = "todo";

const STATUS = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

export default function (pi: ExtensionAPI) {
  let state: TodoState = emptyTodoState();
  let ui: ExtensionUIContext | undefined;

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
    const line = renderWidgetLine(state);
    ui.setWidget(WIDGET_KEY, line ? [line] : undefined);

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
  });

  // --- Commands and rendering --------------------------------------------

  pi.registerCommand("todos", {
    description: "Show the current plan",
    handler: async (_args, ctx) => {
      resync(ctx);
      pi.appendEntry<TodoState>(SNAPSHOT_ENTRY, state);
    },
  });

  // Mutation entries carry state only; they are already reflected in the tool
  // result above the fold, so they render as nothing.
  pi.registerEntryRenderer(MUTATION_ENTRY, () => ({
    render: () => [],
    invalidate: () => {},
  }));

  pi.registerEntryRenderer<TodoState>(
    SNAPSHOT_ENTRY,
    (entry, _options, theme) =>
      new Text(renderSnapshot(entry.data ?? emptyTodoState(), theme), 0, 0),
  );
}
