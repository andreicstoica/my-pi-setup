import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureForkSource, createForkSession } from "./src/fork.ts";

test("fork pins the active branch, excludes unfinished tool batches, and never writes the parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-fork-"));
  try {
    const parent = SessionManager.create(dir, dir);
    parent.appendMessage({
      role: "user",
      content: "Keep the blue button.",
      timestamp: 1,
    });
    const base = parent.appendMessage(fauxAssistantMessage("Understood."));
    parent.appendMessage({
      role: "user",
      content: "This abandoned branch is red.",
      timestamp: 2,
    });
    parent.branch(base);
    const active = parent.appendMessage({
      role: "user",
      content: "Inspect the button.",
      timestamp: 3,
    });
    parent.appendMessage(
      fauxAssistantMessage([
        fauxToolCall("read", { path: "button.ts" }, { id: "read-1" }),
        fauxToolCall("subagent_spawn", {}, { id: "spawn-1" }),
      ]),
    );
    parent.appendMessage({
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "partial batch" }],
      isError: false,
      timestamp: 4,
    });
    const source = captureForkSource(parent);
    assert.equal(source.leafId, active);
    parent.appendMessage({
      role: "user",
      content: "Arrived after capture.",
      timestamp: 5,
    });
    const file = parent.getSessionFile()!;
    const before = await readFile(file, "utf8");
    const parentLeaf = parent.getLeafId();
    const child = createForkSession(source, dir);
    assert.notEqual(child.getSessionFile(), file);
    assert.equal(child.getHeader()?.parentSession, file);
    assert.deepEqual(
      child.buildSessionContext().messages,
      parent.buildSessionContext().messages.slice(0, 3),
    );
    child.appendMessage({ role: "user", content: "Child only.", timestamp: 6 });
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(parent.getLeafId(), parentLeaf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fork preserves completed tool results and compaction state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-fork-compacted-"));
  try {
    const parent = SessionManager.create(dir, dir);
    parent.appendMessage({
      role: "user",
      content: "Old request",
      timestamp: 1,
    });
    const kept = parent.appendMessage({
      role: "user",
      content: "Retained constraint",
      timestamp: 2,
    });
    parent.appendCompaction("Earlier decisions", kept, 1000);
    parent.appendMessage(
      fauxAssistantMessage(fauxToolCall("read", {}, { id: "read-1" })),
    );
    parent.appendMessage({
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "complete result" }],
      isError: false,
      timestamp: 3,
    });
    const child = createForkSession(captureForkSource(parent), dir);
    assert.deepEqual(
      child.buildSessionContext().messages,
      parent.buildSessionContext().messages,
    );
    assert.throws(
      () => createForkSession(captureForkSource(parent), join(dir, "other")),
      /same working directory/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fork refuses an unsaved session rather than silently using fresh context", () => {
  const parent = SessionManager.inMemory();
  parent.appendMessage({
    role: "user",
    content: "Do not lose this.",
    timestamp: 1,
  });
  assert.throws(() => captureForkSource(parent), /saved parent session/);
});
