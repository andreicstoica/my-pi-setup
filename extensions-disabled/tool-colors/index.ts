/**
 * Two jobs, one seam: colour tool titles by what the tool *does*, and wash diff
 * rows with a faint tint of their own colour.
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
 * would silently kill the `"one-light/gruvbox-dark-hard"` auto-switching and
 * confuse `/settings`.
 *
 * This is a monkey-patch of an undocumented surface, so it verifies the shape
 * it expects and no-ops loudly rather than throwing if pi changes.
 */

import { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decorateTitle, FALLBACK_COLOR, shouldRemap } from "./src/colors.ts";
import { BACKGROUND_KEY, TINTED_KEYS, tintSequence } from "./src/diff-tint.ts";

type FgMethod = (color: string, text: string) => string;
type PatchedFg = FgMethod & { __toolColors?: boolean };

/**
 * Returns a diagnostic string on failure, undefined on success. Idempotent:
 * the marker lives on the patched function itself, so a `/reload` that re-runs
 * this module cannot double-wrap (and unlike a Proxy + `defineProperty`, the
 * marker cannot silently land on a different object than the one it guards).
 */
/** Derived tints, keyed by theme instance then colour token. */
const tintCache = new WeakMap<object, Map<string, string | undefined>>();

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
    if (color === FALLBACK_COLOR) {
      // Every tool title gets the glyph, so the transcript scans by shape;
      // recognised kinds additionally get their own hue.
      const decorated = decorateTitle(text);
      const mapped = shouldRemap(color, text);
      if (mapped) {
        try {
          return original.call(this, mapped, decorated);
        } catch {
          // A theme missing the mapped token must not break rendering.
        }
      }
      return original.call(this, color, decorated);
    }

    const rendered = original.call(this, color, text);
    if (!TINTED_KEYS.has(color)) return rendered;

    // Per theme instance: a theme switch installs a new Theme, and a stale
    // cache would wash today's rows in yesterday's palette.
    let perTheme = tintCache.get(this);
    if (!perTheme) {
      perTheme = new Map();
      tintCache.set(this, perTheme);
    }
    if (!perTheme.has(color)) {
      let tint: string | undefined;
      try {
        // Probe through the ORIGINAL fg: calling this.fg would recurse.
        tint = tintSequence(
          original.call(this, color, ""),
          this.bg(BACKGROUND_KEY, ""),
        );
      } catch {
        tint = undefined;
      }
      perTheme.set(color, tint);
    }
    const tint = perTheme.get(color);
    // Reset the background only; the caller may still be in a foreground run.
    return tint ? `${tint}${rendered}\x1b[49m` : rendered;
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
