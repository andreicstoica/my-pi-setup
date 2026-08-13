import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  CursorModelError,
  cursorBackend,
  parseListModels,
  resolveCursorModel,
} from "./src/backends/cursor.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { SubagentManager } from "./src/manager.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string, model?: string): SpawnTask {
  return {
    prompt,
    title: "live Cursor test",
    cwd: process.cwd(),
    ...(model ? { model } : {}),
    parent,
  };
}

function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Cursor test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function cursorAvailable() {
  return Effect.runPromise(cursorBackend.available);
}

test("cursor model ids resolve from family + effort + fast", () => {
  assert.equal(resolveCursorModel(undefined, undefined), "composer-2.5");
  assert.equal(resolveCursorModel("composer-2.5", "high"), "composer-2.5");
  assert.equal(
    resolveCursorModel("composer-2.5-fast", undefined),
    "composer-2.5-fast",
  );
  // The bug this table exists for: bare `cursor-grok-4.6` is not a real id.
  assert.equal(
    resolveCursorModel("cursor-grok-4.6", "high"),
    "cursor-grok-4.6-high",
  );
  assert.equal(
    resolveCursorModel("grok-4.6", undefined),
    "cursor-grok-4.6-medium",
  );
  // Bare "grok" tracks the current generation.
  assert.equal(resolveCursorModel("grok", "xhigh"), "cursor-grok-4.6-xhigh");
  // `max` has no id; it asks for the family's top tier.
  assert.equal(resolveCursorModel("grok", "max"), "cursor-grok-4.6-xhigh");
  assert.equal(resolveCursorModel("grok-4.6", "off"), "cursor-grok-4.6-low");
  assert.equal(
    resolveCursorModel("grok-4.6-fast", "high"),
    "cursor-grok-4.6-high-fast",
  );
  // An explicit tier in the id beats the shared effort param.
  assert.equal(
    resolveCursorModel("cursor-grok-4.6-low-fast", "high"),
    "cursor-grok-4.6-low-fast",
  );
  // 4.5 kept only its `high` tier, so an inherited effort walks down to it
  // instead of failing the spawn.
  assert.equal(
    resolveCursorModel("grok-4.5", undefined),
    "cursor-grok-4.5-high",
  );
  assert.equal(resolveCursorModel("grok-4.5", "low"), "cursor-grok-4.5-high");
  assert.equal(
    resolveCursorModel("grok-4.5-fast", "max"),
    "cursor-grok-4.5-high-fast",
  );
  // A hand-spelled tier that no longer exists is still an error, not a downgrade.
  assert.throws(
    () => resolveCursorModel("cursor-grok-4.5-low", undefined),
    CursorModelError,
  );
  // Bracket overrides are cursor's own escape hatch and pass through.
  assert.equal(
    resolveCursorModel("claude-opus-4-8[effort=high,fast=false]", "low"),
    "claude-opus-4-8[effort=high,fast=false]",
  );
});

test("invalid cursor model combinations fail loudly", () => {
  // Composer has no tiers, so a spelled-out tier is a real mistake.
  assert.throws(
    () => resolveCursorModel("composer-2.5-high", undefined),
    CursorModelError,
  );
  // No fast variant in the known set.
  assert.throws(
    () => resolveCursorModel("composer-2.5-fast", undefined, ["composer-2.5"]),
    CursorModelError,
  );
  assert.throws(
    () => resolveCursorModel("no-such-model", "high"),
    CursorModelError,
  );
  // The error names the valid ids rather than silently downgrading.
  assert.match(
    (() => {
      try {
        resolveCursorModel("no-such-model", "high");
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })(),
    /composer-2\.5.*cursor-grok-4\.5-high-fast/s,
  );
});

test("parseListModels reads `<id> - <Display Name>` lines", () => {
  const ids = parseListModels(
    [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5-fast - Composer 2.5 Fast",
      "cursor-grok-4.5-high - Cursor Grok 4.5",
      "not a model line",
    ].join("\n"),
  );
  assert.deepEqual(ids, ["auto", "composer-2.5-fast", "cursor-grok-4.5-high"]);
});

test(
  "Cursor backend completes a live manager run",
  { timeout: 120_000 },
  async (t) => {
    if (!(await cursorAvailable())) {
      t.skip("cursor-agent executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn(
          "cursor",
          task("Reply with exactly: hello cursor", "composer-2.5-fast"),
        ),
      );

      await deadline(runTool(runtime, manager.waitFor([spawned.id])), 100_000);
      const done = manager.view.get(spawned.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello cursor/i);
      assert.equal(done?.meta.backend, "cursor");
      assert.ok(done?.meta.nativeSessionId);
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Cursor backend interrupt settles a live manager run",
  { timeout: 60_000 },
  async (t) => {
    if (!(await cursorAvailable())) {
      t.skip("cursor-agent executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn(
          "cursor",
          task(
            "Run `sleep 30`, then reply with the word finished.",
            "composer-2.5-fast",
          ),
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await deadline(
        runTool(runtime, manager.cancel([spawned.id])),
        20_000,
      );
      assert.equal(result[0]?.cancelled, true);
      assert.equal(manager.view.get(spawned.id)?.status, "error");
      assert.equal(manager.view.get(spawned.id)?.errorText, "Run was aborted");
    } finally {
      await runtime.dispose();
    }
  },
);
