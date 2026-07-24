/**
 * Colour tool titles by what the tool *does*, not uniformly.
 *
 * `ctx.ui.setTheme()` accepts a Theme *instance*, which is the only seam for
 * influencing how built-in tools render. The mapping itself lives in
 * ./src/colors.ts so it can be tested without a TUI.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { withToolColors } from "./src/colors.ts";

const MARKER = "__toolColors";

function apply(ctx: ExtensionContext) {
  if (ctx.mode !== "tui") return false;

  const active = ctx.ui.theme;
  // Re-wrapping would still work, but the marker keeps `/tool-colors`
  // idempotent and makes the state inspectable.
  if ((active as unknown as Record<string, unknown>)[MARKER]) return true;

  const wrapped = withToolColors(
    active as Theme & { fg(color: string, text: string): string },
  );
  Object.defineProperty(wrapped, MARKER, { value: true });
  return ctx.ui.setTheme(wrapped as Theme).success;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    apply(ctx);
  });

  // A theme switch via /settings installs a fresh, unwrapped Theme.
  pi.registerCommand("tool-colors", {
    description: "Re-apply per-tool-kind title colours (after a theme switch)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        apply(ctx)
          ? "Tool colours applied"
          : "Tool colours unavailable in this mode",
        "info",
      );
    },
  });
}
