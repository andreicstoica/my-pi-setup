import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMutation,
  emptyTodoState,
  type TodoMutation,
} from "./src/domain.ts";
import {
  renderCompactionHint,
  renderContextBlock,
  renderToolResult,
  renderWidgetLine,
  summarize,
} from "./src/prompt.ts";

const build = (...mutations: TodoMutation[]) => {
  let state = emptyTodoState();
  for (const m of mutations) state = applyMutation(state, m).state;
  return state;
};

const plan = () =>
  build(
    { create: [{ subject: "a" }, { subject: "b", activeForm: "Doing b" }] },
    {
      update: [
        { id: "1", status: "completed" },
        { id: "2", status: "in_progress" },
      ],
    },
  );

test("no context block when nothing is open", () => {
  assert.equal(renderContextBlock(emptyTodoState()), undefined);

  const finished = build(
    { create: [{ subject: "a" }] },
    { update: [{ id: "1", status: "completed" }] },
  );
  assert.equal(renderContextBlock(finished), undefined);
});

test("context block lists every item and names the active one", () => {
  const block = renderContextBlock(plan());

  assert.ok(block);
  assert.match(block, /^<todos>/);
  assert.match(block, /<\/todos>$/);
  assert.match(block, /1\. \[x\] a/);
  assert.match(block, /2\. \[>\] b/);
  assert.match(block, /Currently in progress: 2\./);
});

test("context block nags when nothing is in progress", () => {
  const block = renderContextBlock(build({ create: [{ subject: "a" }] }));

  assert.ok(block);
  assert.match(block, /Nothing is in_progress/);
});

test("context block is a single line-safe string", () => {
  const block = renderContextBlock(plan());

  assert.ok(block);
  assert.ok(!block.includes("\r"));
});

test("blocked and owned items are annotated", () => {
  const block = renderContextBlock(
    build({
      create: [
        { subject: "a" },
        { subject: "b", blockedBy: ["1"], owner: "codex" },
      ],
    }),
  );

  assert.ok(block);
  assert.match(block, /\(@codex\)/);
  assert.match(block, /\(blocked by 1\)/);
});

test("summarize counts done, running and blocked", () => {
  const state = build(
    {
      create: [
        { subject: "a" },
        { subject: "b" },
        { subject: "c", blockedBy: ["2"] },
      ],
    },
    {
      update: [
        { id: "1", status: "completed" },
        { id: "2", status: "in_progress" },
      ],
    },
  );

  assert.equal(summarize(state), "1/3 done · 1 in progress · 1 blocked");
});

test("cancelled items leave the denominator", () => {
  const state = build(
    { create: [{ subject: "a" }, { subject: "b" }] },
    { update: [{ id: "2", status: "cancelled" }] },
  );

  assert.equal(summarize(state), "0/1 done");
});

test("tool result carries warnings back to the model", () => {
  const state = build({ create: [{ subject: "a" }] });
  const text = renderToolResult(state, ["two todos are in_progress"]);

  assert.match(text, /warning: two todos are in_progress/);
});

test("widget prefers activeForm over subject", () => {
  assert.match(renderWidgetLine(plan()) ?? "", /Doing b/);
});

test("widget falls back to a pending count", () => {
  const line = renderWidgetLine(
    build({ create: [{ subject: "a" }, { subject: "b" }] }),
  );

  assert.match(line ?? "", /2 todos pending/);
});

test("widget and compaction hint go quiet when the plan is done", () => {
  const finished = build(
    { create: [{ subject: "a" }] },
    { update: [{ id: "1", status: "completed" }] },
  );

  assert.equal(renderWidgetLine(finished), undefined);
  assert.equal(renderCompactionHint(finished), undefined);
});

test("compaction hint counts unfinished work", () => {
  assert.match(renderCompactionHint(plan()) ?? "", /1 unfinished todo /);
});
