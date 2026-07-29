import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMutation,
  emptyTodoState,
  openItems,
  replay,
  type TodoMutation,
} from "./src/domain.ts";

const create = (...subjects: string[]): TodoMutation => ({
  create: subjects.map((subject) => ({ subject })),
});

test("create assigns sequential ids and starts everything pending", () => {
  const { state, createdIds } = applyMutation(
    emptyTodoState(),
    create("a", "b"),
  );

  assert.deepEqual(createdIds, ["1", "2"]);
  assert.deepEqual(
    state.items.map((t) => [t.id, t.subject, t.status]),
    [
      ["1", "a", "pending"],
      ["2", "b", "pending"],
    ],
  );
});

test("ids keep climbing across mutations", () => {
  let state = applyMutation(emptyTodoState(), create("a")).state;
  state = applyMutation(state, {
    update: [{ id: "1", status: "completed" }],
  }).state;
  const { createdIds } = applyMutation(state, create("b"));

  assert.deepEqual(createdIds, ["2"]);
});

test("replay is deterministic", () => {
  const log: TodoMutation[] = [
    create("a", "b"),
    { update: [{ id: "1", status: "in_progress" }] },
    {
      update: [
        { id: "1", status: "completed" },
        { id: "2", status: "in_progress" },
      ],
    },
  ];

  assert.deepEqual(replay(log), replay(log));
  assert.deepEqual(
    replay(log).items.map((t) => t.status),
    ["completed", "in_progress"],
  );
});

test("creates land before updates within one call", () => {
  const { state } = applyMutation(emptyTodoState(), {
    create: [{ subject: "a" }],
    update: [{ id: "1", status: "in_progress" }],
  });

  assert.equal(state.items[0]?.status, "in_progress");
});

test("empty subjects are skipped with a warning", () => {
  const { state, warnings } = applyMutation(emptyTodoState(), {
    create: [{ subject: "   " }],
  });

  assert.equal(state.items.length, 0);
  assert.match(warnings.join(), /empty subject/);
});

test("warns on two in_progress items", () => {
  const state = applyMutation(emptyTodoState(), create("a", "b")).state;
  const { warnings } = applyMutation(state, {
    update: [
      { id: "1", status: "in_progress" },
      { id: "2", status: "in_progress" },
    ],
  });

  assert.match(warnings.join(), /keep exactly one/);
});

test("warns when a step jumps pending to completed", () => {
  const state = applyMutation(emptyTodoState(), create("a")).state;
  const { warnings } = applyMutation(state, {
    update: [{ id: "1", status: "completed" }],
  });

  assert.match(warnings.join(), /pending → completed/);
});

test("pending to in_progress to completed is clean", () => {
  let state = applyMutation(emptyTodoState(), create("a")).state;
  state = applyMutation(state, {
    update: [{ id: "1", status: "in_progress" }],
  }).state;
  const { warnings } = applyMutation(state, {
    update: [{ id: "1", status: "completed" }],
  });

  assert.deepEqual(warnings, []);
});

test("warns when starting a blocked step, then stops once the blocker clears", () => {
  let state = applyMutation(emptyTodoState(), {
    create: [{ subject: "a" }, { subject: "b", blockedBy: ["1"] }],
  }).state;

  const blocked = applyMutation(state, {
    update: [{ id: "2", status: "in_progress" }],
  });
  assert.match(blocked.warnings.join(), /blocked by 1/);

  state = applyMutation(state, {
    update: [{ id: "1", status: "completed" }],
  }).state;
  const unblocked = applyMutation(state, {
    update: [{ id: "2", status: "in_progress" }],
  });
  assert.deepEqual(unblocked.warnings, []);
});

test("warns when a step completes while still blocked", () => {
  const state = applyMutation(emptyTodoState(), {
    create: [{ subject: "a" }, { subject: "b", blockedBy: ["1"] }],
  }).state;

  const { warnings } = applyMutation(state, {
    update: [{ id: "2", status: "completed" }],
  });

  assert.match(warnings.join(), /todo 2 completed while blocked by 1/);
});

test("warns on unknown ids", () => {
  const { warnings } = applyMutation(emptyTodoState(), {
    update: [{ id: "42", status: "completed" }],
  });

  assert.match(warnings.join(), /no todo with id 42/);
});

test("warns on a blockedBy pointing at nothing", () => {
  const { warnings } = applyMutation(emptyTodoState(), {
    create: [{ subject: "a", blockedBy: ["9"] }],
  });

  assert.match(warnings.join(), /unknown id 9/);
});

test("explanation sticks until replaced", () => {
  let state = applyMutation(emptyTodoState(), {
    ...create("a"),
    explanation: "scope grew",
  }).state;
  assert.equal(state.explanation, "scope grew");

  state = applyMutation(state, {
    update: [{ id: "1", status: "in_progress" }],
  }).state;
  assert.equal(state.explanation, "scope grew");

  state = applyMutation(state, {
    update: [{ id: "1", status: "completed" }],
    explanation: "done early",
  }).state;
  assert.equal(state.explanation, "done early");
});

test("cancelled items drop out of the open set", () => {
  let state = applyMutation(emptyTodoState(), create("a", "b")).state;
  state = applyMutation(state, {
    update: [{ id: "2", status: "cancelled" }],
  }).state;

  assert.deepEqual(
    openItems(state).map((t) => t.id),
    ["1"],
  );
});

test("mutations never alias prior state", () => {
  const first = applyMutation(emptyTodoState(), create("a")).state;
  applyMutation(first, { update: [{ id: "1", status: "completed" }] });

  assert.equal(first.items[0]?.status, "pending");
});
