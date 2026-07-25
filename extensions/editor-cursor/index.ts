/**
 * Use the terminal's own cursor in the editor instead of pi's drawn block.
 *
 * pi's editor draws a fake cursor as reverse video — `\x1b[7m<grapheme>\x1b[0m`
 * (pi-tui editor.js:436,442) — and normally hides the real terminal cursor. The
 * `showHardwareCursor` setting un-hides the real one for IME positioning, but
 * does not stop the fake one, so enabling it shows *both*: a block with a bar
 * at its leading edge.
 *
 * This strips the reverse-video pair from rendered editor lines, leaving the
 * grapheme itself intact so widths are unaffected. The terminal then draws the
 * only cursor, in whatever style the terminal is configured for — a bar, in
 * Ghostty with `cursor-style = bar`.
 *
 * Self-guarding: the fake cursor is only removed on lines that carry
 * CURSOR_MARKER, which pi emits immediately before it and *only* when the
 * hardware cursor is enabled. If `showHardwareCursor` is ever turned off, the
 * marker disappears, nothing is stripped, and the drawn block comes back —
 * so this can never leave the editor with no visible cursor at all.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor } from "@earendil-works/pi-tui";

/** The exact shape pi draws: reverse video around one grapheme (or a space). */
const FAKE_CURSOR = /\x1b\[7m(.*?)\x1b\[0m/;

type RenderFn = (width: number) => string[];
type PatchedRender = RenderFn & { __hardwareCursorOnly?: boolean };

function patchEditorPrototype() {
  const prototype = Editor?.prototype as { render?: PatchedRender } | undefined;
  const original = prototype?.render;

  if (typeof original !== "function") {
    return "Editor.prototype.render is missing — pi-tui's editor changed";
  }
  if (original.__hardwareCursorOnly) return undefined;

  const patched: PatchedRender = function (this: Editor, width: number) {
    const lines = original.call(this, width);
    return lines.map((line) =>
      // Only the line holding the marker can hold the fake cursor, and only
      // one cursor exists, so a single non-global replace is enough.
      line.includes(CURSOR_MARKER) ? line.replace(FAKE_CURSOR, "$1") : line,
    );
  };
  patched.__hardwareCursorOnly = true;
  prototype!.render = patched;
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const failure = patchEditorPrototype();

  pi.on("session_start", (_event, ctx) => {
    if (failure && ctx.mode === "tui") {
      ctx.ui.notify(`editor-cursor: ${failure}`, "warning");
    }
  });
}
