import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Todo, TodoStatus } from "./src/domain.ts";
import { collapseFinishedRuns, renderSnapshot } from "./src/view.ts";

/** "cpppc" → one completed, three pending, one cancelled, ids 1..5. */
const plan = (shape: string): Todo[] => {
  const status: Record<string, TodoStatus> = {
    c: "completed",
    x: "cancelled",
    p: "pending",
    i: "in_progress",
  };
  return [...shape].map((letter, index) => ({
    id: String(index + 1),
    subject: `todo ${index + 1}`,
    status: status[letter]!,
    blockedBy: [],
    createdSeq: 1,
    updatedSeq: 1,
  }));
};

/** Ids in render order, with "⋮" standing in for a collapsed stretch. */
const rows = (shape: string) =>
  collapseFinishedRuns(plan(shape)).map((row) => row?.id ?? "⋮");

test("short runs of finished items stay whole", () => {
  assert.deepEqual(rows("ccc"), ["1", "2", "3"]);
  assert.deepEqual(rows("cxc"), ["1", "2", "3"]);
});

test("a run of four collapses to first, ⋮, last", () => {
  assert.deepEqual(rows("cccc"), ["1", "⋮", "4"]);
});

test("a cancelled item collapses inside the run like any other", () => {
  assert.deepEqual(rows("ccxcc"), ["1", "⋮", "5"]);
});

test("a long run collapses to three rows", () => {
  assert.deepEqual(rows("c".repeat(20)), ["1", "⋮", "20"]);
});

test("an open item breaks the run and is always shown", () => {
  assert.deepEqual(rows("cccccpcccccc"), ["1", "⋮", "5", "6", "7", "⋮", "12"]);
  assert.deepEqual(rows("ccccicccc"), ["1", "⋮", "4", "5", "6", "⋮", "9"]);
});

test("open items pass through untouched", () => {
  assert.deepEqual(rows("pipppp"), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(rows(""), []);
});

test("trailing open work survives a long finished prefix", () => {
  assert.deepEqual(rows("ccccccccip"), ["1", "⋮", "8", "9", "10"]);
});

/** Colourless stand-in, so assertions read on glyphs rather than escapes. */
const plainTheme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const glyphs = (items: Todo[]) =>
  renderSnapshot({ items, nextId: items.length + 1, seq: 1 }, plainTheme)
    .split("\n")
    .slice(1)
    .map((line) => line.trim()[0]);

test("a pending item waiting on open work renders dotted", () => {
  const items = plan("ip");
  items[1]!.blockedBy = ["1"];

  assert.deepEqual(glyphs(items), ["◕", "◌"]);
});

test("a pending item is crisp once its blocker finishes", () => {
  const items = plan("cp");
  items[1]!.blockedBy = ["1"];

  assert.deepEqual(glyphs(items), ["●", "○"]);
});

test("an unknown blocker id does not wedge an item as blocked", () => {
  const items = plan("p");
  items[0]!.blockedBy = ["99"];

  assert.deepEqual(glyphs(items), ["○"]);
});
