import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWindows } from "./index.ts";

test("a single window drops its label", () => {
  // Codex reports one weekly window; "7d 99% (6d 23h)" said the same thing
  // twice, since the countdown already implies the window length.
  assert.equal(
    formatWindows([{ label: "7d", remainingPercent: 99, resetIn: "6d 23h" }]),
    "99% (6d 23h)",
  );
});

test("multiple windows keep their labels", () => {
  // Claude reports 5h and 7d; without labels the two percentages are ambiguous.
  assert.equal(
    formatWindows([
      { label: "5h", remainingPercent: 86, resetIn: "3h 28m" },
      { label: "7d", remainingPercent: 83, resetIn: "4d 1h" },
    ]),
    "5h 86% (3h 28m) 7d 83% (4d 1h)",
  );
});

test("a missing reset time is omitted, not rendered empty", () => {
  assert.equal(
    formatWindows([{ label: "7d", remainingPercent: 100, resetIn: null }]),
    "100%",
  );
});

test("no windows renders nothing", () => {
  assert.equal(formatWindows([]), "");
});
