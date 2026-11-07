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
import subagentsExtension from "./index.ts";

const openSession = async (dir: string) => {
  const faux = createFauxCore({ provider: "faux" });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = faux.getModel();
  modelRuntime.registerProvider("faux", {
    name: "faux",
    baseUrl: "http://localhost.invalid",
    apiKey: "faux-key",
    api: model.api,
    streamSimple: faux.streamSimple as never,
    models: [
      {
        id: model.id,
        name: model.name,
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
      subagentsExtension,
    ],
  });
  await resourceLoader.reload();
  const settingsManager = SettingsManager.inMemory({});
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: modelRuntime.getModel("faux", model.id),
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
  });
  await session.bindExtensions({});

  const run = async (code: string) => {
    let result = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code })),
      fauxAssistantMessage("done"),
    ]);
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        event.toolName === "codemode"
      ) {
        result = event.result.content
          .filter((block: { type: string }) => block.type === "text")
          .map((block: { text?: string }) => block.text ?? "")
          .join("\n");
      }
    });
    await session.prompt("run");
    unsubscribe();
    assert.match(result, /^Script completed/);
    return JSON.parse(
      result.slice(result.indexOf("{"), result.lastIndexOf("}") + 1),
    );
  };
  return { session, run };
};

test("codemode receives typed subagent list data and rejects unknown ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagents-codemode-"));
  try {
    const { session, run } = await openSession(dir);
    assert.ok(session.getToolDefinition("subagent_list")?.outputSchema);

    const listed = await run("return await tools.subagent_list({});");
    assert.deepEqual(listed, { subagents: [] });

    const rejected = await run(`
      try {
        await tools.subagent_check({ id: "unknown" });
        return { rejected: false };
      } catch (error) {
        return { rejected: String(error).includes("Unknown subagent id") };
      }
    `);
    assert.deepEqual(rejected, { rejected: true });
    session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("codemode validates fork mode before starting a child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagents-fork-codemode-"));
  try {
    const { session, run } = await openSession(dir);
    const rejected = await run(`
      const attempt = async (extra) => {
        try {
          await tools.subagent_spawn({ name: "fork test", prompt: "Read only.", context_mode: "fork", ...extra });
          return "unexpected success";
        } catch (error) { return String(error); }
      };
      return {
        harness: await attempt({ harness: "claude" }),
        cwd: await attempt({ harness: "pi", working_dir: "/tmp" }),
        unsaved: await attempt({ harness: "pi" }),
      };
    `);
    assert.match(rejected.harness, /only by the pi harness/);
    assert.match(rejected.cwd, /same working directory/);
    assert.match(rejected.unsaved, /saved parent session/);
    session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
