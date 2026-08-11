import assert from "node:assert/strict";
import test from "node:test";
import { buildChildPrompt } from "./src/prompt.ts";
import {
  describeTaskClasses,
  resolveRouting,
  TASK_CLASS_NAMES,
  TASK_CLASSES,
} from "./src/routing.ts";

test("a task class fills harness, model, and effort", () => {
  const routing = resolveRouting({ taskClass: "review" });
  assert.equal(routing.harness, "codex");
  assert.equal(routing.model, "gpt-5.6-terra");
  assert.equal(routing.reasoningEffort, "high");
  assert.match(routing.constraint ?? "", /Read-only/);
});

test("UI tweaks route to Luna Max", () => {
  const routing = resolveRouting({ taskClass: "ui_tweak" });
  assert.equal(routing.harness, "pi");
  assert.equal(routing.model, "openai-codex/gpt-5.6-luna");
  assert.equal(routing.reasoningEffort, "max");
  assert.match(routing.constraint ?? "", /bounded UI tweak/);
});

test("explicit fields override the class field by field", () => {
  const routing = resolveRouting({
    taskClass: "review",
    model: "gpt-5.6-luna",
  });
  // Same harness, so the model override is the only change.
  assert.equal(routing.harness, "codex");
  assert.equal(routing.model, "gpt-5.6-luna");
  assert.equal(routing.reasoningEffort, "high");
});

test("overriding the harness drops the class model rather than mismatching it", () => {
  // "openai-codex/gpt-5.6-luna" is a pi provider/model string; handing it to
  // the claude harness would fail the spawn or silently pick something else.
  const routing = resolveRouting({ taskClass: "recon", harness: "claude" });
  assert.equal(routing.harness, "claude");
  assert.equal(routing.model, undefined);
  // Effort and the read-only constraint still apply — only the model was
  // harness-specific.
  assert.equal(routing.reasoningEffort, "medium");
  assert.match(routing.constraint ?? "", /Read-only/);
});

test("an overriding harness keeps the class model when it is the same harness", () => {
  const routing = resolveRouting({ taskClass: "recon", harness: "pi" });
  assert.equal(routing.model, "openai-codex/gpt-5.6-luna");
});

test("no class leaves every field to the caller", () => {
  const routing = resolveRouting({ harness: "cursor" });
  assert.equal(routing.harness, "cursor");
  assert.equal(routing.model, undefined);
  assert.equal(routing.reasoningEffort, undefined);
  assert.equal(routing.constraint, undefined);
});

test("no class and no harness resolves to no harness, so the caller can reject it", () => {
  assert.equal(resolveRouting({}).harness, undefined);
});

test("every class routes to a real harness and carries a constraint", () => {
  for (const name of TASK_CLASS_NAMES) {
    const entry = TASK_CLASSES[name];
    assert.ok(
      ["pi", "claude", "codex", "cursor"].includes(entry.harness),
      `${name} routes to an unknown harness`,
    );
    // The constraint is the only carrier of the caps and of read-only intent:
    // policy.ts reaches the claude backend alone, so an empty constraint means
    // an unbounded child on three of the four harnesses.
    assert.ok(entry.constraint.length > 0, `${name} has no constraint`);
    assert.ok(entry.summary.length > 0, `${name} has no summary`);
  }
});

test("a pi task class names its provider so the child cannot inherit a stray model", () => {
  for (const name of TASK_CLASS_NAMES) {
    const entry = TASK_CLASSES[name];
    if (entry.harness !== "pi") continue;
    assert.match(
      entry.model ?? "",
      /^[a-z-]+\//,
      `${name} must give provider/model-id, not a bare id`,
    );
  }
});

test("the class constraint reaches the child above the report contract", () => {
  const routing = resolveRouting({ taskClass: "mechanical_edit" });
  const prompt = buildChildPrompt("Rename the helper.", routing.constraint);
  const constraintAt = prompt.indexOf("at most 3 files");
  const contractAt = prompt.indexOf("Report contract:");
  assert.ok(constraintAt > 0, "constraint missing from the child prompt");
  assert.ok(constraintAt < contractAt, "constraint must precede the contract");
});

test("the schema description lists every class", () => {
  const described = describeTaskClasses();
  for (const name of TASK_CLASS_NAMES) {
    assert.match(described, new RegExp(`- ${name}: `));
  }
});
