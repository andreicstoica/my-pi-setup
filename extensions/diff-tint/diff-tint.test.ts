import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundSequence,
  blend,
  parseTruecolor,
  tintSequence,
} from "./index.ts";

test("reads rgb out of both foreground and background sequences", () => {
  assert.deepEqual(parseTruecolor("\x1b[38;2;63;149;58m"), [63, 149, 58]);
  assert.deepEqual(parseTruecolor("\x1b[48;2;244;245;247m"), [244, 245, 247]);
});

test("256-colour sequences yield no tint, rather than a wrong one", () => {
  // Blending needs real channels; on a 256-colour terminal we leave diffs alone.
  assert.equal(parseTruecolor("\x1b[38;5;34m"), undefined);
  assert.equal(tintSequence("\x1b[38;5;34m", "\x1b[48;2;0;0;0m"), undefined);
  assert.equal(tintSequence("\x1b[38;2;0;255;0m", ""), undefined);
});

test("the tint lands near the background, not near the diff colour", () => {
  // one-light: green #3f953a on the #f4f5f7 row background.
  const tint = tintSequence("\x1b[38;2;63;149;58m", "\x1b[48;2;244;245;247m");
  assert.ok(tint);
  const rgb = parseTruecolor(tint);
  assert.ok(rgb);
  // Every channel is within 30 of the background: a wash, not a block.
  for (const [i, channel] of rgb.entries()) {
    const background = [244, 245, 247][i]!;
    assert.ok(
      Math.abs(channel - background) <= 30,
      `channel ${i}: ${channel} vs ${background}`,
    );
  }
  // ...but it has moved toward green, so it is not merely the background.
  assert.notDeepEqual(rgb, [244, 245, 247]);
  assert.ok(rgb[1]! >= rgb[0]!, "green channel should not be the lowest");
});

test("a dark theme tints downward from its own background", () => {
  // gruvbox-dark-hard: red on a near-black row.
  const tint = tintSequence("\x1b[38;2;251;73;52m", "\x1b[48;2;29;32;33m");
  const rgb = parseTruecolor(tint!);
  assert.ok(rgb);
  assert.ok(rgb[0]! > rgb[1]! && rgb[0]! > rgb[2]!, "red channel leads");
  assert.ok(rgb[0]! < 90, "still dark enough to read text on");
});

test("blend clamps out-of-range amounts", () => {
  assert.deepEqual(blend([0, 0, 0], [255, 255, 255], 2), [255, 255, 255]);
  assert.deepEqual(blend([0, 0, 0], [255, 255, 255], -1), [0, 0, 0]);
});

test("emits a background sequence, never a foreground one", () => {
  // A stray 38;2 here would recolour the text and hide the diff colour.
  assert.equal(backgroundSequence([1, 2, 3]), "\x1b[48;2;1;2;3m");
});
