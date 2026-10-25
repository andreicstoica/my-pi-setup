import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import todoExtension from "./index.ts";

type Run = {
  output: string;
  isError: boolean;
};

/**
 * Real Pi session with the real codemode and todo extensions. Only the model
 * is scripted: it emits one `codemode` call per script, then stops.
 */
const openSession = async (dir: string, sessionManager: SessionManager) => {
  const faux = createFauxCore({ provider: "faux" });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const fauxModel = faux.getModel();
  modelRuntime.registerProvider("faux", {
    name: "faux",
    baseUrl: "http://localhost.invalid",
    apiKey: "faux-key",
    api: fauxModel.api,
    streamSimple: faux.streamSimple as never,
    models: [
      {
        id: fauxModel.id,
        name: fauxModel.name,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      todoExtension,
    ],
  });
  await resourceLoader.reload();

  const settingsManager = SettingsManager.inMemory({});
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });

  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: modelRuntime.getModel("faux", fauxModel.id),
    resourceLoader,
    settingsManager,
    sessionManager,
  });
  await session.bindExtensions({});

  const runs: Run[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "codemode") {
      const text = event.result.content
        .map((block: { type: string; text?: string }) =>
          block.type === "text" ? block.text : "",
        )
        .join("\n");
      runs.push({ output: text, isError: Boolean(event.isError) });
    }
  });

  const run = async (script: string) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: script })),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("run");
    return runs[runs.length - 1]!;
  };

  return { session, run };
};

const jsonFrom = (run: Run) => {
  assert.equal(run.isError, false, run.output);
  assert.match(run.output, /^Script completed/);
  const start = run.output.indexOf("{");
  return JSON.parse(run.output.slice(start, run.output.lastIndexOf("}") + 1));
};

test("codemode scripts receive typed todo data and replay it after resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-codemode-"));
  const sessionManager = SessionManager.inMemory();
  try {
    const first = await openSession(dir, sessionManager);

    const created = jsonFrom(
      await first.run(`
        const made = await tools.todo({
          create: [
            { subject: "Write test", activeForm: "Writing test" },
            { subject: "Ship it", owner: "me" },
          ],
        });
        const [testId, shipId] = made.createdIds;
        const updated = await tools.todo({
          update: [
            { id: testId, status: "completed" },
            { id: shipId, status: "in_progress" },
          ],
        });
        return {
          createdIds: made.createdIds,
          warnings: updated.warnings,
          summary: updated.summary,
          madeIsSnapshot: made.items.map((i) => i.status),
          items: updated.items,
        };
      `),
    );

    assert.deepEqual(created.createdIds, ["1", "2"]);
    assert.deepEqual(created.warnings, []);
    assert.equal(typeof created.summary, "string");
    assert.deepEqual(created.madeIsSnapshot, ["in_progress", "pending"]);
    assert.deepEqual(
      created.items.map((i: { id: string; status: string }) => [
        i.id,
        i.status,
      ]),
      [
        ["1", "completed"],
        ["2", "in_progress"],
      ],
    );
    assert.equal(created.items[0].subject, "Write test");
    assert.equal(created.items[0].activeForm, "Writing test");
    assert.equal(created.items[1].owner, "me");
    assert.deepEqual(created.items[1].blockedBy, []);
    assert.equal(typeof created.items[1].createdSeq, "number");
    assert.equal(typeof created.items[1].updatedSeq, "number");
    first.session.dispose();

    const resumed = await openSession(dir, sessionManager);
    const replayed = jsonFrom(
      await resumed.run(`
        const next = await tools.todo({
          create: [{ subject: "After resume" }],
          update: [{ id: "2", status: "completed" }],
        });
        return { createdIds: next.createdIds, summary: next.summary,
          statuses: next.items.map((i) => i.id + ":" + i.status) };
      `),
    );
    assert.deepEqual(replayed.createdIds, ["3"]);
    assert.deepEqual(replayed.statuses, [
      "1:completed",
      "2:completed",
      "3:in_progress",
    ]);
    resumed.session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("todo declares an output schema and sequential execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-codemode-"));
  try {
    const { session } = await openSession(dir, SessionManager.inMemory());
    const tool = session.getToolDefinition("todo");
    assert.ok(tool, "todo registered");
    assert.equal(tool.executionMode, "sequential");
    const schema = tool.outputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "createdIds",
      "items",
      "summary",
      "warnings",
    ]);
    session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
