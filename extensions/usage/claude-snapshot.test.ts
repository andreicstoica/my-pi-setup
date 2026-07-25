import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot, STALE_AFTER_SECONDS } from "./src/claude.ts";

// Shape written verbatim by ~/.claude/statusline-command.sh.
const snapshot = (writtenAt: number) =>
  JSON.stringify({
    written_at: writtenAt,
    five_hour: { used_percentage: 15, resets_at: writtenAt + 15420 },
    seven_day: { used_percentage: 10, resets_at: writtenAt + 576000 },
  });

test("parses the snapshot the statusline writes", () => {
  const now = 1_784_989_369;
  const usage = parseSnapshot(snapshot(now), now);
  assert.ok(usage);
  assert.equal(usage.fiveHour?.usedPercent, 15);
  assert.equal(usage.sevenDay?.usedPercent, 10);
  assert.equal(usage.fiveHour?.resetsAt, now + 15420);
  assert.equal(usage.stale, false);
  assert.equal(usage.ageSeconds, 0);
});

test("flags a snapshot that stopped refreshing", () => {
  const written = 1_000_000;
  const fresh = parseSnapshot(
    snapshot(written),
    written + STALE_AFTER_SECONDS - 1,
  );
  const stale = parseSnapshot(
    snapshot(written),
    written + STALE_AFTER_SECONDS + 1,
  );
  assert.equal(fresh?.stale, false);
  assert.equal(stale?.stale, true);
  // Age is reported so the panel can say how old, not just "stale".
  assert.equal(stale?.ageSeconds, STALE_AFTER_SECONDS + 1);
});

test("a clock that jumped backwards must not yield a negative age", () => {
  const usage = parseSnapshot(snapshot(2_000_000), 1_999_000);
  assert.equal(usage?.ageSeconds, 0);
  assert.equal(usage?.stale, false);
});

test("tolerates a partial snapshot", () => {
  // Only one window present — still useful.
  const oneWindow = JSON.stringify({
    written_at: 1_000_000,
    five_hour: { used_percentage: 42 },
  });
  const usage = parseSnapshot(oneWindow, 1_000_000);
  assert.equal(usage?.fiveHour?.usedPercent, 42);
  assert.equal(usage?.fiveHour?.resetsAt, undefined);
  assert.equal(usage?.sevenDay, undefined);
});

test("rejects unusable input rather than reporting zero usage", () => {
  const now = 1_000_000;
  assert.equal(parseSnapshot("not json", now), undefined);
  assert.equal(parseSnapshot("{}", now), undefined);
  // No written_at means staleness is unknowable, so the whole thing is suspect.
  assert.equal(
    parseSnapshot(JSON.stringify({ five_hour: { used_percentage: 5 } }), now),
    undefined,
  );
  // Both windows missing leaves nothing to show.
  assert.equal(
    parseSnapshot(JSON.stringify({ written_at: now }), now),
    undefined,
  );
  // A string percentage is not a percentage.
  assert.equal(
    parseSnapshot(
      JSON.stringify({ written_at: now, five_hour: { used_percentage: "5" } }),
      now,
    ),
    undefined,
  );
});

test("float percentages round to whole numbers", async () => {
  // Claude reports used_percentage as a float. 100 - 55.00000000000001 is
  // 44.99999999999999 in binary floating point, which rendered verbatim in the
  // footer. Codex reports an integer, so only the cc side ever showed it.
  const { parseSnapshot } = await import("./src/claude.ts");
  const now = 1_000_000;
  const raw = JSON.stringify({
    written_at: now,
    five_hour: { used_percentage: 55.00000000000001 },
    seven_day: { used_percentage: 7.6 },
  });
  const usage = parseSnapshot(raw, now);
  assert.equal(
    Math.max(0, Math.min(100, Math.round(100 - usage!.fiveHour!.usedPercent))),
    45,
  );
  assert.equal(
    Math.max(0, Math.min(100, Math.round(100 - usage!.sevenDay!.usedPercent))),
    92,
  );
});
