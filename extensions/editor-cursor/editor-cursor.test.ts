import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

// Mirrors the strip in ../index.ts. Kept here rather than exported from the
// extension because the extension's only job is to install it on a prototype.
const FAKE_CURSOR = /\x1b\[7m(.*?)\x1b\[0m/;
const strip = (line: string) =>
  line.includes(CURSOR_MARKER) ? line.replace(FAKE_CURSOR, "$1") : line;

test("removes the drawn block but keeps the character", () => {
  // Shape from pi-tui editor.js:436 — reverse video around one grapheme.
  const line = `abc${CURSOR_MARKER}\x1b[7md\x1b[0mefg`;
  assert.equal(strip(line), `abc${CURSOR_MARKER}defg`);
});

test("keeps the trailing space when the cursor sits at end of line", () => {
  // editor.js:442 adds a highlighted space and counts it in the line width, so
  // the space must survive or the width bookkeeping breaks.
  const line = `hello${CURSOR_MARKER}\x1b[7m \x1b[0m`;
  const out = strip(line);
  assert.equal(out, `hello${CURSOR_MARKER} `);
  assert.ok(out.endsWith(" "));
});

test("leaves lines without the marker untouched", () => {
  // No marker means showHardwareCursor is off, so the drawn block is the only
  // cursor there is and must not be removed.
  const line = "plain text \x1b[7mX\x1b[0m still here";
  assert.equal(strip(line), line);
});

test("does not disturb other styling on the cursor line", () => {
  const line = `\x1b[38;5;75mblue\x1b[39m ${CURSOR_MARKER}\x1b[7mZ\x1b[0m tail`;
  assert.equal(strip(line), `\x1b[38;5;75mblue\x1b[39m ${CURSOR_MARKER}Z tail`);
});

test("strips only one cursor even if reverse video appears twice", () => {
  // There is exactly one cursor; a non-global replace must not eat a second
  // reverse-video run that belongs to something else.
  const line = `${CURSOR_MARKER}\x1b[7ma\x1b[0m mid \x1b[7mb\x1b[0m`;
  assert.equal(strip(line), `${CURSOR_MARKER}a mid \x1b[7mb\x1b[0m`);
});

test("the marker pi emits is what we key on", () => {
  assert.equal(CURSOR_MARKER, "\x1b_pi:c\x07");
});

test("both cursor-drawing components are exported and patchable", async () => {
  // Editor is the main prompt; Input is the single-line field behind submenus,
  // dialogs and filter prompts. Patching only Editor left submenus showing a
  // block, which is the bug this covers.
  const tui = await import("@earendil-works/pi-tui");
  for (const name of ["Editor", "Input"] as const) {
    const component = tui[name] as { prototype?: { render?: unknown } };
    assert.equal(typeof component, "function", `${name} should be exported`);
    assert.equal(
      typeof component.prototype?.render,
      "function",
      `${name}.prototype.render should exist`,
    );
  }
});
