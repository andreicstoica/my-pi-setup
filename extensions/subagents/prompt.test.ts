import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildPrompt,
  buildSubagentResultMessage,
  describeSendOutcome,
  stripReportPreamble,
} from "./src/prompt.ts";

test("a send to a live run reads as steering only where the backend supports it", () => {
  const steered = describeSendOutcome({
    id: "sa-x",
    running: true,
    steering: true,
  });
  assert.match(steered, /while it runs/);
  assert.doesNotMatch(steered, /cancel/);

  const queued = describeSendOutcome({
    id: "sa-x",
    running: true,
    steering: false,
  });
  assert.match(queued, /cannot steer a live run/);
  // A parent that wanted to stop the run needs to be told the real lever.
  assert.match(queued, /subagent_cancel/);
});

test("a send to a settled subagent is described as a fresh run", () => {
  const restarted = describeSendOutcome({
    id: "sa-x",
    running: false,
    steering: true,
  });
  assert.match(restarted, /already settled/);
  assert.match(restarted, /existing context/);
});

test("buildChildPrompt appends the report contract once", () => {
  const composed = buildChildPrompt("  Investigate the auth regression.  ");
  assert.match(composed, /^Investigate the auth regression\.\n\n---\n/);
  assert.equal(composed.match(/Report contract:/g)?.length, 1);
});

test("stripReportPreamble drops lead-in ahead of a rule", () => {
  const output = [
    "Perfect! I have the complete timeline. Let me generate the final report:",
    "",
    "---",
    "",
    "## FINAL REPORT",
    "Body.",
  ].join("\n");
  assert.equal(stripReportPreamble(output), "## FINAL REPORT\nBody.");
});

test("stripReportPreamble drops lead-in ahead of a heading", () => {
  const output = "Great, here's what I found:\n\n### Findings\n- one";
  assert.equal(stripReportPreamble(output), "### Findings\n- one");
});

test("stripReportPreamble leaves a report that already leads with content", () => {
  const output = "## Findings\nPerfect isolation was never achieved.";
  assert.equal(stripReportPreamble(output), output);
});

test("stripReportPreamble leaves prose that merely opens conversationally", () => {
  // No structural marker follows, so there is nothing safe to cut.
  const output =
    "Now the cache warms on boot, which removes the cold-start stall.";
  assert.equal(stripReportPreamble(output), output);
});

test("stripReportPreamble never empties a report", () => {
  assert.equal(stripReportPreamble("---"), "---");
  assert.equal(stripReportPreamble(""), "");
});

test("stripReportPreamble ignores markers past the leading window", () => {
  const output = `${"Body line.\n".repeat(8)}---\n## Later`;
  assert.equal(stripReportPreamble(output), output);
});

test("result message strips preamble but keeps API-failure detection on raw output", () => {
  const failure = buildSubagentResultMessage({
    id: "sa-x",
    title: "x",
    status: "done",
    output: "API Error: 529 Overloaded",
  });
  assert.match(failure, /failed \(model API error\)/);

  const report = buildSubagentResultMessage({
    id: "sa-y",
    title: "y",
    status: "done",
    output: "Okay, let me write it up:\n\n---\n\n## Result\nDone.",
  });
  assert.match(report, /finished\.\n\n## Result\nDone\.$/);
});
