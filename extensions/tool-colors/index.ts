/**
 * Colour tool titles by what the tool *does*, not uniformly.
 *
 * Every built-in pi tool renders its title through `theme.fg("toolTitle", …)`
 * (see `dist/core/tools/*.js`) and there is no extension hook for re-rendering
 * built-in tools, so the only seam is `fg` itself. `fg` is a prototype method
 * on the exported `Theme` class, so patching it once at load covers every
 * theme instance — including ones created later by a `/settings` switch, a
 * theme-file hot reload, or auto light/dark resync.
 *
 * The obvious alternative — wrapping the active theme in a Proxy and calling
 * `ctx.ui.setTheme(wrapped)` — is wrong here: `setTheme(instance)` routes to
 * the controller's `setThemeInstance()`, which calls `setAutoSync(false)` and
 * sets `activeThemeName = "<in-memory>"` (theme-controller.js:46-49). That
 * would silently kill the `"ayu-light/gruvbox-dark-hard"` auto-switching and
 * confuse `/settings`.
 *
 * This is a monkey-patch of an undocumented surface, so it verifies the shape
 * it expects and no-ops loudly rather than throwing if pi changes.
 */

import { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shouldRemap } from "./src/colors.ts";

type FgMethod = (color: string, text: string) => string;
type PatchedFg = FgMethod & { __toolColors?: boolean };

/**
 * Returns a diagnostic string on failure, undefined on success. Idempotent:
 * the marker lives on the patched function itself, so a `/reload` that re-runs
 * this module cannot double-wrap (and unlike a Proxy + `defineProperty`, the
 * marker cannot silently land on a different object than the one it guards).
 */
function patchThemePrototype() {
  const prototype = Theme?.prototype as { fg?: PatchedFg } | undefined;
  const original = prototype?.fg;

  if (typeof original !== "function") {
    return "Theme.prototype.fg is missing — pi's theme internals changed";
  }
  if (original.__toolColors) return undefined;

  const patched: PatchedFg = function (
    this: Theme,
    color: string,
    text: string,
  ) {
    const mapped = shouldRemap(color, text);
    if (mapped) {
      try {
        return original.call(this, mapped, text);
      } catch {
        // A theme missing the mapped token must not break rendering.
      }
    }
    return original.call(this, color, text);
  };
  patched.__toolColors = true;
  prototype!.fg = patched;
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const failure = patchThemePrototype();

  pi.on("session_start", (_event, ctx) => {
    // Surfaced at session start rather than at load so it reaches the TUI.
    if (failure && ctx.mode === "tui") {
      ctx.ui.notify(`tool-colors: ${failure}`, "warning");
    }
  });

  pi.registerCommand("tool-colors", {
    description: "Report per-tool-kind title colour status",
    handler: async (_args, ctx) => {
      const active =
        (Theme?.prototype as { fg?: PatchedFg })?.fg?.__toolColors === true;
      ctx.ui.notify(
        active
          ? "Tool colours active"
          : `Tool colours inactive: ${failure ?? "unknown"}`,
        active ? "info" : "warning",
      );
    },
  });
}
