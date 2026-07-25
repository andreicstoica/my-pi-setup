import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatResetIn,
  parseRateLimitsResponse,
  severityToken,
  windowLabel,
} from "./src/codex.ts";

// Captured verbatim from `account/rateLimits/read` on codex 0.145.0.
const LIVE_RESPONSE = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: 83,
      windowDurationMins: 10080,
      resetsAt: 1785337113,
    },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 83,
        windowDurationMins: 10080,
        resetsAt: 1785337113,
      },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      individualLimit: null,
      spendControlReached: false,
      planType: "plus",
      rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
};

test("parses the real app-server response", () => {
  const usage = parseRateLimitsResponse(LIVE_RESPONSE);
  assert.ok(usage);
  assert.equal(usage.primary?.usedPercent, 83);
  assert.equal(usage.primary?.windowDurationMins, 10080);
  assert.equal(usage.primary?.resetsAt, 1785337113);
  // codex-plus reports no 5h window.
  assert.equal(usage.secondary, undefined);
  assert.equal(usage.planType, "plus");
  assert.deepEqual(usage.credits, {
    balance: "0",
    hasCredits: false,
    unlimited: false,
  });
  assert.equal(usage.spendControlReached, false);
});

test("prefers the codex bucket but falls back to the flat view", () => {
  // The schema calls `rateLimits` a backward-compatible mirror, so an older
  // server that omits rateLimitsByLimitId must still parse.
  const flatOnly = { rateLimits: LIVE_RESPONSE.rateLimits };
  assert.equal(parseRateLimitsResponse(flatOnly)?.primary?.usedPercent, 83);

  // When both exist and disagree, the keyed bucket wins.
  const disagreeing = {
    rateLimits: { primary: { usedPercent: 1 } },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 99 } } },
  };
  assert.equal(parseRateLimitsResponse(disagreeing)?.primary?.usedPercent, 99);
});

test("rejects garbage instead of inventing zeroes", () => {
  // A window with no usedPercent tells us nothing; reporting "100% left" from
  // absent data would be worse than showing nothing.
  assert.equal(parseRateLimitsResponse(undefined), undefined);
  assert.equal(parseRateLimitsResponse({}), undefined);
  assert.equal(
    parseRateLimitsResponse({ rateLimits: { primary: {} } })?.primary,
    undefined,
  );
  assert.equal(
    parseRateLimitsResponse({ rateLimits: { primary: { usedPercent: "83" } } })
      ?.primary,
    undefined,
  );
});

test("labels windows by duration", () => {
  assert.equal(
    windowLabel({ usedPercent: 0, windowDurationMins: 10080 }),
    "7d",
  );
  assert.equal(windowLabel({ usedPercent: 0, windowDurationMins: 300 }), "5h");
  assert.equal(windowLabel({ usedPercent: 0, windowDurationMins: 1440 }), "1d");
  assert.equal(windowLabel({ usedPercent: 0, windowDurationMins: 90 }), "90m");
  assert.equal(windowLabel({ usedPercent: 0 }), "limit");
});

test("formats reset countdowns", () => {
  const now = 1_000_000;
  assert.equal(formatResetIn(now + 2 * 86400 + 3 * 3600, now), "2d 3h");
  assert.equal(formatResetIn(now + 3 * 3600 + 5 * 60, now), "3h 5m");
  assert.equal(formatResetIn(now + 45 * 60, now), "45m");
  assert.equal(formatResetIn(now - 10, now), "now");
  assert.equal(formatResetIn(undefined, now), undefined);
});

test("escalates severity as headroom shrinks", () => {
  assert.equal(severityToken(80), "muted");
  assert.equal(severityToken(26), "muted");
  assert.equal(severityToken(25), "warning");
  assert.equal(severityToken(11), "warning");
  assert.equal(severityToken(10), "error");
  assert.equal(severityToken(0), "error");
  // The live reading — 83% used, so 17% left — should read as a warning.
  assert.equal(severityToken(100 - 83), "warning");
});
