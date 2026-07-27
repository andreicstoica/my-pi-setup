/**
 * Use the terminal's own cursor everywhere, instead of pi's drawn block.
 *
 * pi's text components draw a fake cursor as reverse video —
 * `\x1b[7m<grapheme>\x1b[0m` (pi-tui editor.js:436,442) — and normally hide the
 * real terminal cursor. The `showHardwareCursor` setting un-hides the real one
 * for IME positioning, but does not stop the fake one, so enabling it shows
 * *both*: a block with a bar at its leading edge.
 *
 * Two components do this: `Editor` (the main prompt) and `Input` (the
 * single-line field behind submenus, dialogs, and filter prompts). Patching
 * only the editor left every submenu still showing a block.
 *
 * The reverse-video pair is stripped from rendered lines, leaving the grapheme
 * itself intact so widths are unaffected. The terminal then draws the only
 * cursor, in whatever style it is configured for — a bar, in Ghostty with
 * `cursor-style = bar`.
 *
 * Guarded on `tui.getShowHardwareCursor()`, not on the marker. The marker is
 * emitted whenever the component is focused (editor.js:419
 * `const emitCursorMarker = this.focused`) regardless of the setting, so using
 * it as the guard would strip the drawn cursor even with the hardware cursor
 * disabled — leaving no visible cursor at all. The marker is still used to
 * locate the cursor's line; it is just not evidence that the real cursor is on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Input } from "@earendil-works/pi-tui";

/** The exact shape pi draws: reverse video around one grapheme (or a space). */
const FAKE_CURSOR = /\x1b\[7m(.*?)\x1b\[0m/;

/**
 * Atomic markers pi segments as a single grapheme: paster's image placeholders
 * (`[#image 1]`, merged by PasterEditor's `segment` override) and the editor's
 * own paste markers. Because they are one grapheme, pi's cursor already wraps
 * the *whole* marker in reverse video — so keeping the drawn cursor for exactly
 * these gives a block highlight over the entire token while the terminal's bar
 * still marks the caret at its leading edge. Anything else is a real character
 * and gets stripped as usual.
 */
const ATOMIC_MARKER =
  /^(?:\[#image \d+\]|\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\])$/;

type RenderFn = (width: number) => string[];
type PatchedRender = RenderFn & { __hardwareCursorOnly?: boolean };
type Renderable = { prototype?: { render?: PatchedRender } };
type HasTui = { tui?: { getShowHardwareCursor?: () => boolean } };

function stripFakeCursor(lines: string[]) {
  return lines.map((line) =>
    // Only the line holding the marker can hold the fake cursor, and only one
    // cursor exists, so a single non-global replace is enough.
    line.includes(CURSOR_MARKER)
      ? line.replace(FAKE_CURSOR, (drawn, inner: string) =>
          ATOMIC_MARKER.test(inner) ? drawn : inner,
        )
      : line,
  );
}

/** Returns a diagnostic on failure, undefined on success. Idempotent. */
function patchRender(component: Renderable, label: string) {
  const prototype = component?.prototype;
  const original = prototype?.render;

  if (typeof original !== "function") {
    return `${label}.prototype.render is missing — pi-tui changed`;
  }
  if (original.__hardwareCursorOnly) return undefined;

  const patched: PatchedRender = function (this: HasTui, width: number) {
    const lines = original.call(this, width);
    // Only remove pi's drawn cursor when the terminal is actually drawing one.
    return this.tui?.getShowHardwareCursor?.() ? stripFakeCursor(lines) : lines;
  };
  patched.__hardwareCursorOnly = true;
  prototype!.render = patched;
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const failures = [
    patchRender(Editor as Renderable, "Editor"),
    patchRender(Input as Renderable, "Input"),
  ].filter((failure): failure is string => typeof failure === "string");

  pi.on("session_start", (_event, ctx) => {
    if (failures.length > 0 && ctx.mode === "tui") {
      ctx.ui.notify(`editor-cursor: ${failures.join("; ")}`, "warning");
    }
  });
}
