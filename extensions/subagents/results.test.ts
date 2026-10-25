import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  projectSubagent,
  projectWaitResults,
  WAIT_OUTPUT_MAX_BYTES,
} from "./src/results.ts";
import { API_FAILURE_ADVICE } from "./src/prompt.ts";

const snapshot = (
  overrides: Partial<SubagentSnapshot> = {},
): SubagentSnapshot =>
  ({
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "Audit output",
    prompt: "secret parent prompt",
    cwd: "/work",
    status: "done",
    createdAt: 0,
    meta: { backend: "pi", modelLabel: "faux/test" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "done",
    turns: 2,
    ...overrides,
  }) as SubagentSnapshot;

test("projectSubagent returns a data snapshot without prompt or transcript", () => {
  const source = snapshot({ errorText: "failed" });
  const projected = projectSubagent(source);

  assert.deepEqual(projected, {
    id: "sa-1",
    title: "Audit output",
    harness: "pi",
    cwd: "/work",
    status: "done",
    model: "faux/test",
    turns: 2,
    error: "failed",
  });
  (source as { title: string }).title = "Changed after projection";
  assert.equal(projected.title, "Audit output");
});

test("wait projections cap each output and the total independently", () => {
  const large = "x".repeat(20 * 1024);
  const results = projectWaitResults([
    ["sa-1", snapshot({ id: "sa-1", finalText: large })],
    ["sa-2", snapshot({ id: "sa-2", finalText: large })],
    ["sa-3", snapshot({ id: "sa-3", finalText: large })],
    ["sa-4", snapshot({ id: "sa-4", finalText: large })],
  ]);

  assert.equal(results.length, 4);
  assert.ok(results.every((result) => result.truncated));
  assert.ok(
    results.every(
      (result) => Buffer.byteLength(result.output, "utf8") <= 16 * 1024,
    ),
  );
  assert.ok(
    results.reduce(
      (total, result) => total + Buffer.byteLength(result.output, "utf8"),
      0,
    ) <=
      48 * 1024,
  );
});

test("wait projections retain missing ids without inventing a successful result", () => {
  assert.deepEqual(projectWaitResults([["sa-gone", undefined]]), [
    {
      id: "sa-gone",
      status: "missing",
      output: "",
      truncated: false,
    },
  ]);
});

test("wait projections cap every record and the complete JSON envelope", () => {
  const results = projectWaitResults(
    Array.from({ length: 64 }, (_, index) => [
      `sa-${index}`,
      snapshot({
        id: `sa-${index}`,
        title: "title ".repeat(1024),
        errorText: "error ".repeat(1024),
        finalText: "🌊".repeat(8192),
      }),
    ]),
  );

  assert.equal(results.length, 64);
  assert.ok(results.every((result) => result.id.startsWith("sa-")));
  assert.ok(results.every((result) => result.status === "done"));
  assert.ok(results.every((result) => result.truncated));
  assert.ok(
    results.every(
      (result) =>
        Buffer.byteLength(JSON.stringify(result), "utf8") <= 16 * 1024,
    ),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify({ results }), "utf8") <=
      WAIT_OUTPUT_MAX_BYTES,
  );
});

test("wait projections report detected model API failures as errors with advice", () => {
  const [result] = projectWaitResults([
    [
      "sa-api",
      snapshot({
        id: "sa-api",
        status: "done",
        finalText: "API Error: 529 Overloaded",
      }),
    ],
  ]);

  assert.equal(result?.status, "error");
  assert.equal(result?.error, API_FAILURE_ADVICE);
});
