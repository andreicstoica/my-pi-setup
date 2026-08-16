import { deepStrictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import { childExcludedTools } from "./src/backends/pi.ts";

const CONTROL_TOOLS = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
];

describe("childExcludedTools", () => {
  it("always withholds the control tools a headless child cannot use", () => {
    for (const provider of [undefined, "openai-codex", "opencode"]) {
      const excluded = childExcludedTools(provider);
      for (const tool of CONTROL_TOOLS) {
        ok(
          excluded.includes(tool),
          `${tool} must be withheld on provider ${provider}`,
        );
      }
    }
  });

  it("withholds the names OpenCode Zen reserves, so the child does not 400 on its first request", () => {
    const excluded = childExcludedTools("opencode");
    ok(excluded.includes("web_search"));
    ok(excluded.includes("web_fetch"));
  });

  it("leaves the web tools enabled on providers that accept them", () => {
    deepStrictEqual(childExcludedTools("openai-codex"), CONTROL_TOOLS);
    deepStrictEqual(childExcludedTools(undefined), CONTROL_TOOLS);
  });
});
