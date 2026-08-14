import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWindows } from "./index.ts";

const NOW = 1_786_714_600;
const HOUR = 3600;
const DAY = 86400;

test("a single window drops its label", () => {
  // Codex reports one weekly window; "7d 99% (6d 23h)" said the same thing
  // twice, since the countdown already implies the window length.
  assert.equal(
    formatWindows(
      [
        {
          label: "7d",
          remainingPercent: 99,
          resetsAt: NOW + 6 * DAY + 23 * HOUR,
        },
      ],
      NOW,
    ),
    "99% (6d 23h)",
  );
});

test("multiple windows keep their labels", () => {
  // Claude reports 5h and 7d; without labels the two percentages are ambiguous.
  assert.equal(
    formatWindows(
      [
        {
          label: "5h",
          remainingPercent: 86,
          resetsAt: NOW + 3 * HOUR + 28 * 60,
        },
        { label: "7d", remainingPercent: 83, resetsAt: NOW + 4 * DAY + HOUR },
      ],
      NOW,
    ),
    "5h 86% (3h 28m) 7d 83% (4d 1h)",
  );
});

test("a missing reset time is omitted, not rendered empty", () => {
  assert.equal(
    formatWindows(
      [{ label: "7d", remainingPercent: 100, resetsAt: null }],
      NOW,
    ),
    "100%",
  );
});

test("no windows renders nothing", () => {
  assert.equal(formatWindows([], NOW), "");
});

test("the countdown tracks the clock, not the publish time", () => {
  // The regression this guards: countdowns were formatted once, when the usage
  // extension published, so a footer left up for hours kept claiming the same
  // "4h 13m" and eventually "(now)" long after the window had rolled over.
  const window = {
    label: "5h",
    remainingPercent: 90,
    resetsAt: NOW + 4 * HOUR,
  };
  assert.equal(formatWindows([window], NOW), "90% (4h 0m)");
  assert.equal(formatWindows([window], NOW + 2 * HOUR), "90% (2h 0m)");
  assert.equal(formatWindows([window], NOW + 5 * HOUR), "90% (now)");
});
