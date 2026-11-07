import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piBin = existsSync(join(root, "bin/pi"))
  ? join(root, "bin/pi")
  : join(root, "node_modules/.bin/pi");

test(
  "installed Pi distinguishes fresh and forked child context",
  { timeout: 240_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-fork-live-"));
    try {
      const agentDir = join(dir, "agent");
      const cwd = join(dir, "workspace");
      const sessions = join(dir, "parents");
      await mkdir(agentDir);
      await mkdir(cwd);
      for (const name of ["auth.json", "models-store.json"]) {
        const source = join(getAgentDir(), name);
        if (existsSync(source)) await symlink(source, join(agentDir, name));
      }
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultTools: ["subagent_spawn", "subagent_wait"],
          cacheWarming: "off",
          enableInstallTelemetry: false,
          enableAnalytics: false,
        }),
      );
      const marker = "violet-731";
      const model =
        process.env.PI_FORK_TEST_MODEL ?? "openai-codex/gpt-6.1-sol";
      for (const mode of ["fresh", "fork"] as const) {
        const parent = SessionManager.create(cwd, sessions);
        parent.appendMessage({
          role: "user",
          content: `The experiment marker is ${marker}. Remember it for this conversation.`,
          timestamp: 1,
        });
        parent.appendMessage(
          fauxAssistantMessage("I will remember the experiment marker."),
        );
        const params = {
          name: `${mode} marker test`,
          harness: "pi",
          ...(mode === "fork"
            ? { context_mode: mode }
            : { model, reasoning_effort: "minimal" }),
          max_turns: 3,
          timeout_seconds: 60,
          prompt:
            "Read-only synthetic context test. What experiment marker was established earlier in the parent conversation? Reply only with its exact value, or UNKNOWN if your conversation has no experiment marker. Do not use tools.",
        };
        const started = Date.now();
        const result = await new Promise<{
          code: number | null;
          stderr: string;
        }>((resolveRun, reject) => {
          const child = spawn(
            piBin,
            [
              "--offline",
              "--print",
              "--mode",
              "json",
              "--session",
              parent.getSessionFile()!,
              "--model",
              model,
              "--thinking",
              "minimal",
              "--no-extensions",
              "-e",
              join(root, "extensions/subagents/index.ts"),
              "--no-mcp",
              "--no-skills",
              "--no-context-files",
              "--no-prompt-templates",
              "--tools",
              "subagent_spawn,subagent_wait",
              "--system-prompt",
              "Run this synthetic tool test exactly as instructed. Do not read or change any file.",
              `Call subagent_spawn exactly once with these exact arguments, without adding context to its prompt: ${JSON.stringify(params)}. Then call subagent_wait with that child's id. Finish with TEST COMPLETE.`,
            ],
            {
              cwd,
              env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agentDir,
                PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
                PI_TELEMETRY: "0",
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let stderr = "";
          child.stderr.on("data", (data) => {
            stderr += data;
          });
          const timer = setTimeout(() => child.kill("SIGTERM"), 100_000);
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolveRun({ code, stderr });
          });
        });
        assert.equal(result.code, 0, result.stderr.slice(-2000));
        const records = (await readFile(parent.getSessionFile()!, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const spawned = records.find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "subagent_spawn",
        );
        assert.ok(spawned, "Parent must execute subagent_spawn");
        assert.equal(
          spawned.message.isError,
          false,
          JSON.stringify(spawned.message.content),
        );
        assert.equal(spawned.message.details.model, model);
        assert.equal(spawned.message.details.contextMode, mode);
        const waited = records.find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "subagent_wait",
        );
        assert.ok(waited, "Parent must collect the child result");
        assert.equal(
          waited.message.isError,
          false,
          JSON.stringify(waited.message.content),
        );
        const childFiles = await readdir(join(agentDir, "sessions"), {
          recursive: true,
        });
        const transcripts = await Promise.all(
          childFiles
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => readFile(join(agentDir, "sessions", name), "utf8")),
        );
        // Forks are stored beside their parent; fresh sessions use the agent directory.
        const siblingFiles = await readdir(sessions);
        const forkTexts = await Promise.all(
          siblingFiles
            .filter(
              (name) =>
                name.endsWith(".jsonl") &&
                join(sessions, name) !== parent.getSessionFile(),
            )
            .map((name) => readFile(join(sessions, name), "utf8")),
        );
        const candidates = [...transcripts, ...forkTexts].map((text) =>
          text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
        const childRecords = candidates.find((entries) =>
          entries.some(
            (entry) =>
              entry.type === "session_info" &&
              entry.name === `subagent: ${params.name}`,
          ),
        );
        assert.ok(childRecords, "Child transcript must exist");
        const answer = childRecords
          .filter(
            (entry) =>
              entry.type === "message" && entry.message.role === "assistant",
          )
          .at(-1)?.message;
        const text = answer?.content
          .filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text)
          .join("")
          .trim();
        assert.equal(text, mode === "fork" ? marker : "UNKNOWN");
        console.log(
          JSON.stringify({
            mode,
            model,
            elapsedMs: Date.now() - started,
            answer: text,
            usage: answer.usage,
          }),
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
