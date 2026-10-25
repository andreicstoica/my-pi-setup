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
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluateMcpToolUse } from "../shared/mcp-policy.ts";
import mcpPolicy from "./index.ts";

async function withSession(
  run: (context: {
    session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    faux: ReturnType<typeof createFauxCore>;
    executed: string[];
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-native-mcp-policy-"));
  let session:
    Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const faux = createFauxCore({ provider: "faux" });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
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
    const executed: string[] = [];
    const fixtures: ExtensionFactory = (pi) => {
      for (const name of [
        "mcp__linear__list_issues",
        "mcp__linear__create_issue",
        "mcp__sentry__update_issue",
        "mcp__figma__use_figma",
        "mcp__liftoff__tool_get_schema",
        "mcp__liftoff__tool_sql_query",
        "mcp__liftoff__ask",
        "mcp__github__create_issue",
      ]) {
        pi.registerTool({
          name,
          label: name,
          description: "MCP policy fixture",
          parameters: Type.Object({}),
          async execute() {
            executed.push(name);
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        });
      }
    };
    const settingsManager = SettingsManager.inMemory({
      defaultTools: ["+codemode"],
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      extensionFactories: [createCodemodeExtension(), mcpPolicy, fixtures],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(directory),
      modelRuntime,
      model: modelRuntime.getModel("faux", model.id),
    }));
    await session.bindExtensions({ mode: "print" });
    await run({ session, faux, executed });
  } finally {
    session?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test("native MCP calls are blocked before a write or metered tool executes", async () => {
  await withSession(async ({ session, faux, executed }) => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("mcp__linear__create_issue", {}),
        fauxToolCall("mcp__liftoff__ask", {}),
        fauxToolCall("mcp__linear__list_issues", {}),
      ]),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Run fixtures");
    assert.deepEqual(executed, ["mcp__linear__list_issues"]);
    const results = session.messages.filter(
      (message) => message.role === "toolResult",
    );
    assert.equal(
      results.find(
        (message) => message.toolName === "mcp__linear__create_issue",
      )?.isError,
      true,
    );
    assert.equal(
      results.find((message) => message.toolName === "mcp__liftoff__ask")
        ?.isError,
      true,
    );
    assert.equal(
      results.find((message) => message.toolName === "mcp__linear__list_issues")
        ?.isError,
      false,
    );
  });
});

test("Codemode nested calls use the same native MCP restrictions", async () => {
  await withSession(async ({ session, faux, executed }) => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: `
        const results = await Promise.allSettled([
          tools.mcp__linear__create_issue({}),
          tools.mcp__sentry__update_issue({}),
          tools.mcp__figma__use_figma({}),
          tools.mcp__liftoff__ask({}),
          tools.mcp__liftoff__tool_sql_query({}),
          tools.mcp__liftoff__tool_get_schema({}),
          tools.mcp__github__create_issue({}),
        ]);
        return results.map((result) => result.status);
      `,
        }),
      ),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Run nested fixtures");
    assert.deepEqual(executed.sort(), [
      "mcp__github__create_issue",
      "mcp__liftoff__tool_get_schema",
      "mcp__liftoff__tool_sql_query",
    ]);
    const result = [...session.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "toolResult" && message.toolName === "codemode",
      );
    assert.ok(result && result.role === "toolResult");
    const output = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    assert.match(output, /Script completed/);
    assert.match(
      output,
      /\["rejected","rejected","rejected","rejected","fulfilled","fulfilled","fulfilled"\]/,
    );
  });
});

test("read-only server hints cannot enable writes and unknown actions fail closed", () => {
  assert.ok(
    evaluateMcpToolUse("mcp__linear__get_issue", { readOnlyHint: false }),
  );
  assert.ok(
    evaluateMcpToolUse("mcp__figma__get_design_context", {
      destructiveHint: true,
    }),
  );
  assert.ok(
    evaluateMcpToolUse("mcp__figma__use_figma", { readOnlyHint: true }),
  );
  assert.ok(evaluateMcpToolUse("mcp__sentry__run_arbitrary_action"));
  assert.equal(
    evaluateMcpToolUse("mcp__sentry__whoami", { readOnlyHint: true }),
    undefined,
  );
  assert.equal(
    evaluateMcpToolUse("mcp__claude_ai_Linear__get_issue"),
    undefined,
  );
});
