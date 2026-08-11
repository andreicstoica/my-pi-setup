/**
 * Confirmation guard on this session's own `bash` tool.
 *
 * `subagents/src/policy.ts` already refuses destructive commands for headless
 * children. The main session was the gap: it runs the same `dropdb`, `psql
 * TRUNCATE`, force-push and `rm -rf ~` commands with nothing in the way — and
 * the 2026-07-30 local-DB wipe happened here, not in a child.
 *
 * The verdict differs from the subagent one on purpose. A child is denied,
 * because nobody is watching. This session has a TUI, so a match becomes a
 * confirmation dialog: sometimes you really do mean to drop the database, and a
 * hard block would only push the command into a `!` shell where nothing checks
 * it at all.
 *
 * Without a UI (`--print`, rpc, json) there is nobody to ask, so the command is
 * blocked and the reason is returned to the model.
 */

import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { findDestructiveCommand } from "../shared/destructive-commands.ts";

/** Message shown in the confirmation dialog. Exported for the test. */
export function confirmationMessage(reason: string, command: string) {
  return `${reason}\n\n${command}\n\nRun it anyway?`;
}

/** Refusal returned to the model when there is no UI to ask. */
export function headlessRefusal(reason: string) {
  return `Blocked: ${reason}. This session has no UI to confirm on — surface the command for a human to run.`;
}

/** Refusal returned to the model when the dialog was declined. */
export function declinedRefusal(reason: string) {
  return `Declined: ${reason}. Do not retry this command — ask what to do instead.`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (typeof command !== "string") return;

    const reason = findDestructiveCommand(command);
    if (!reason) return;

    if (!ctx.hasUI) {
      return { block: true, reason: headlessRefusal(reason) };
    }

    const approved = await ctx.ui.confirm(
      "Destructive command",
      confirmationMessage(reason, command),
    );
    if (approved) return;

    return { block: true, reason: declinedRefusal(reason) };
  });
}
