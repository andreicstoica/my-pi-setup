/**
 * Cursor backend — real implementation over the `cursor-agent` CLI.
 *
 * Unlike codex's long-lived `app-server`, cursor-agent has no persistent stdio
 * protocol: `-p/--print` is one-shot. So a session here owns a *chat id* rather
 * than a process — the first run creates the chat and learns its id from the
 * `system/init` event, and every later run re-enters it with `--resume <id>`.
 * Each run is therefore one child process whose stdout is a stream of
 * LF-delimited JSON events (`--output-format stream-json`), translated into the
 * same normalized SubagentEvents every other backend emits. Interrupt kills the
 * active child; the exit handler settles the run.
 *
 * POLICY NOTE: `../policy.ts` (the PreToolUse deny hook for MCP writes and
 * mutating aws calls) CANNOT be enforced here. It is a Claude Agent SDK hook,
 * and cursor-agent is a separate CLI with its own permission model — it exposes
 * no equivalent pre-tool callback over the stream-json protocol. A cursor child
 * runs under `--force` with cursor's own allow/deny config as the only guard.
 * Same limitation as the codex backend. Read-only intent must be stated in the
 * spawn prompt.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  ReasoningEffort,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import { resolveBinary, terminateChild } from "./child.ts";

const MODEL_LIST_TIMEOUT_MS = 5_000;
const PREVIEW_MAX_LENGTH = 1_024;
/** A protocol line larger than this without a newline means a broken peer. */
const STDOUT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

/** The prompt is an argv entry, so the child never needs a writable stdin. */
type CursorChild = ChildProcessByStdio<null, Readable, Readable>;

interface ToolState {
  readonly name: string;
  output: string;
}

// --- Binary resolution --------------------------------------------------------

let cachedCursorBinary: string | null | undefined;

/** Resolve once on first use; availability checks after that are allocation-only. */
function resolveCursorBinary() {
  if (cachedCursorBinary !== undefined) return cachedCursorBinary ?? undefined;
  const found = resolveBinary(
    process.platform === "win32"
      ? ["cursor-agent.exe", "cursor-agent.cmd"]
      : ["cursor-agent"],
    // The official installer drops the binary here and only patches interactive
    // shell rc files, so a pi process started outside a login shell misses it.
    [path.join(os.homedir(), ".local", "bin")],
  );
  cachedCursorBinary = found ?? null;
  return found;
}

// --- Model ids ----------------------------------------------------------------

/**
 * Cursor encodes BOTH reasoning effort and fast mode in the model id — there is
 * no `--effort` and no `--fast` flag. `cursor-grok-4.5` alone is NOT a real id
 * (passing it fails); the tiers are `-low` / `-medium` / `-high`, each with an
 * optional `-fast` twin. Composer 2.5 has no tiers at all, only `composer-2.5`
 * and `composer-2.5-fast`.
 *
 * Refresh this table with `cursor-agent --list-models`. It is only the fallback:
 * `spawn` probes the live list first and validates against that when it answers.
 *
 * (`--model` also accepts a bracket-override form —
 * `'claude-opus-4-8[context=1m,effort=high,fast=false]'` — which is passed
 * through verbatim by `resolveCursorModel`. Prefer the explicit `-fast` ids.)
 */
const KNOWN_CURSOR_MODELS: ReadonlyArray<string> = [
  "composer-2.5",
  "composer-2.5-fast",
  "cursor-grok-4.5-low",
  "cursor-grok-4.5-low-fast",
  "cursor-grok-4.5-medium",
  "cursor-grok-4.5-medium-fast",
  "cursor-grok-4.5-high",
  "cursor-grok-4.5-high-fast",
];

/** Default when the caller omits `model` entirely. */
const DEFAULT_CURSOR_MODEL = "composer-2.5";

/**
 * Families whose effort lives in the id suffix, with the tier used when the
 * caller gives a bare family name and no effort.
 */
const CURSOR_EFFORT_FAMILIES: ReadonlyMap<
  string,
  { readonly tiers: ReadonlyArray<string>; readonly fallback: string }
> = new Map([
  ["cursor-grok-4.5", { tiers: ["low", "medium", "high"], fallback: "medium" }],
]);

/** Shorthands the model is likely to write, mapped to the canonical family. */
const CURSOR_FAMILY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["grok", "cursor-grok-4.5"],
  ["grok-4.5", "cursor-grok-4.5"],
  ["grok4.5", "cursor-grok-4.5"],
  ["cursor-grok", "cursor-grok-4.5"],
  ["cursor-grok-4.5", "cursor-grok-4.5"],
  ["composer", "composer-2.5"],
  ["composer-2.5", "composer-2.5"],
  ["composer2.5", "composer-2.5"],
]);

/** The shared 7-point scale collapsed onto grok's three tiers. */
function cursorTier(effort: ReasoningEffort | undefined) {
  switch (effort) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    case undefined:
      return undefined;
  }
}

export class CursorModelError extends Error {}

function knownModelsMessage(known: ReadonlyArray<string>) {
  // Only the first-class ids are listed; the live list has ~190 entries and a
  // wall of them would be useless in an error message.
  const firstClass = known.filter(
    (id) => id.startsWith("composer-") || id.startsWith("cursor-grok-"),
  );
  return (firstClass.length > 0 ? firstClass : KNOWN_CURSOR_MODELS).join(", ");
}

/**
 * Map the shared `model` + `reasoningEffort` params onto a real cursor id.
 *
 * Accepts: a full id (`composer-2.5-fast`), a family plus effort
 * (`grok-4.5` + `high` -> `cursor-grok-4.5-high`), a family plus an explicit
 * `-fast` suffix (`grok-4.5-fast` + `high` -> `cursor-grok-4.5-high-fast`), or
 * a bracket-override string, which is passed through untouched.
 *
 * Fast mode is surfaced as a `-fast` suffix on the model string rather than a
 * separate boolean, because that is cursor's own vocabulary and it keeps the
 * shared spawn schema free of a single-harness parameter. An id that resolves
 * to something cursor does not offer throws rather than silently downgrading.
 */
export function resolveCursorModel(
  model: string | undefined,
  effort: ReasoningEffort | undefined,
  known: ReadonlyArray<string> = KNOWN_CURSOR_MODELS,
) {
  const raw = model?.trim();
  if (!raw) {
    // No model given: the default family has no tiers, so effort is moot.
    return DEFAULT_CURSOR_MODEL;
  }

  // Parameterized bracket form is cursor's own escape hatch — do not rewrite it.
  if (raw.includes("[")) return raw;

  const wantsFast = raw.endsWith("-fast");
  const withoutFast = wantsFast ? raw.slice(0, -"-fast".length) : raw;

  // Strip a tier the caller already spelled out so `grok-4.5-high` resolves
  // without depending on `effort`, and an explicit tier beats the shared param.
  const tierMatch = /^(.*)-(low|medium|high|xhigh|max|minimal)$/.exec(
    withoutFast,
  );
  const familyKey = (tierMatch?.[1] ?? withoutFast).toLowerCase();
  const explicitTier = tierMatch?.[2];

  const family = CURSOR_FAMILY_ALIASES.get(familyKey);
  if (!family) {
    // An id we do not recognize as a family: honor it verbatim if cursor lists
    // it, otherwise fail loudly rather than sending a certain-to-fail spawn.
    if (known.includes(raw)) return raw;
    throw new CursorModelError(
      `Unknown cursor model "${raw}". Valid first-class ids: ${knownModelsMessage(known)}.`,
    );
  }

  const tiers = CURSOR_EFFORT_FAMILIES.get(family);
  let resolved: string;
  if (!tiers) {
    // Composer has no tiers. An explicitly spelled tier is a real mistake;
    // an inherited `reasoningEffort` is not, so that one is simply ignored.
    if (explicitTier) {
      throw new CursorModelError(
        `Cursor model "${family}" has no reasoning tiers, so "${raw}" is not a valid id. Valid ids: ${knownModelsMessage(known)}.`,
      );
    }
    resolved = family;
  } else {
    const tier = explicitTier ?? cursorTier(effort) ?? tiers.fallback;
    if (!tiers.tiers.includes(tier)) {
      throw new CursorModelError(
        `Cursor model "${family}" has no "${tier}" tier (available: ${tiers.tiers.join(", ")}). Valid ids: ${knownModelsMessage(known)}.`,
      );
    }
    resolved = `${family}-${tier}`;
  }

  const withFast = wantsFast ? `${resolved}-fast` : resolved;
  if (!known.includes(withFast)) {
    throw new CursorModelError(
      wantsFast
        ? `Cursor has no fast variant "${withFast}". Valid ids: ${knownModelsMessage(known)}.`
        : `Unknown cursor model "${withFast}". Valid ids: ${knownModelsMessage(known)}.`,
    );
  }
  return withFast;
}

/** `<id> - <Display Name>` lines from `cursor-agent --list-models`. */
export function parseListModels(stdout: string) {
  const ids: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+\S/.exec(line);
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

/** Probe the live catalogue so the hardcoded table only has to be a fallback. */
function listCursorModels(binary: string) {
  return new Promise<ReadonlyArray<string> | undefined>((resolve) => {
    let child: CursorChild;
    try {
      child = spawn(binary, ["--list-models"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (value: ReadonlyArray<string> | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), MODEL_LIST_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, 256 * 1024);
    });
    child.once("error", () => finish(undefined));
    child.once("exit", (code) => {
      const ids = code === 0 ? parseListModels(stdout) : [];
      finish(ids.length > 0 ? ids : undefined);
    });
  });
}

// --- Protocol helpers ---------------------------------------------------------

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function records(value: unknown) {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is JsonRecord => item !== undefined)
    : [];
}

function safeJson(value: unknown) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : text.slice(0, PREVIEW_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

function firstLine(value: unknown) {
  if (typeof value !== "string") return undefined;
  const line = value.split("\n").find((candidate) => candidate.trim());
  return line?.trim().slice(0, PREVIEW_MAX_LENGTH);
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

/** Concatenated text of an `assistant`/`user` message's content blocks. */
function messageText(message: unknown) {
  return records(record(message)?.content)
    .filter((block) => stringValue(block.type) === "text")
    .map((block) => stringValue(block.text) ?? "")
    .join("");
}

/**
 * A `tool_call` payload is `{ <name>ToolCall: { args, result? }, toolCallId, … }`.
 * The tool's identity is the key itself, so find the single `*ToolCall` entry
 * rather than enumerating cursor's (open-ended) tool set.
 */
export function cursorToolCall(payload: JsonRecord) {
  for (const [key, value] of Object.entries(payload)) {
    if (!key.endsWith("ToolCall")) continue;
    const body = record(value);
    if (!body) continue;
    return {
      name: key.slice(0, -"ToolCall".length) || key,
      args: record(body.args),
      result: record(body.result),
    };
  }
  return undefined;
}

function toolArgsPreview(name: string, args: JsonRecord | undefined) {
  if (!args) return undefined;
  // Shell and file tools have one obviously-interesting field; everything else
  // falls back to a truncated JSON blob.
  return (
    firstLine(args.command) ??
    firstLine(args.path) ??
    firstLine(args.filePath) ??
    firstLine(args.query) ??
    safeJson(args)
  );
}

function toolResultPreview(result: JsonRecord | undefined) {
  if (!result) return undefined;
  const success = record(result.success);
  const error = record(result.error);
  const body = error ?? success ?? result;
  return (
    firstLine(body.content) ??
    firstLine(body.output) ??
    firstLine(body.message) ??
    firstLine(safeJson(body))
  );
}

/** Result shape is `{ success: … }` or `{ error: … }`; absent means unknown. */
function toolFailed(
  subtype: string | undefined,
  result: JsonRecord | undefined,
) {
  if (subtype === "failed" || subtype === "error" || subtype === "aborted") {
    return true;
  }
  return result !== undefined && record(result.error) !== undefined;
}

// --- The session --------------------------------------------------------------

const makeCursorSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const resolved = resolveCursorBinary();
    if (!resolved) {
      return yield* new SpawnError({
        message:
          "cursor-agent executable was not found on PATH or ~/.local/bin.",
      });
    }
    // Re-bound so the narrowing survives into `startRun`, which the run loop
    // calls back into after this generator has returned.
    const binary: string = resolved;

    // Validate against the live catalogue when it answers quickly; the
    // hardcoded table is the fallback so a slow/offline probe cannot block a
    // spawn (and its concurrency reservation) or reject a valid new model id.
    const liveModels = yield* Effect.promise(() => listCursorModels(binary));
    const modelId = yield* Effect.try({
      try: () =>
        resolveCursorModel(task.model, task.reasoningEffort, liveModels),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const state = {
      closed: false,
      closing: false,
      activeRun: false,
      interruptRequested: false,
      runSerial: 0,
      chatId: undefined as string | undefined,
      child: undefined as CursorChild | undefined,
      childExited: true,
      finalText: "",
      lastAssistantText: "",
      streamedText: "",
      runError: undefined as string | undefined,
      pendingPrompts: [] as string[],
      stderr: "",
      meta: {
        backend: "cursor",
        modelLabel: modelId,
      } satisfies SubagentMeta as SubagentMeta,
    };
    const tools = new Map<string, ToolState>();

    const queuedView = () =>
      state.pendingPrompts.map((text) => ({
        text,
        kind: "follow-up" as const,
      }));

    const settleRun = (outcome: RunOutcome, serial = state.runSerial) => {
      if (!state.activeRun || serial !== state.runSerial) return;
      state.activeRun = false;
      state.interruptRequested = false;
      state.child = undefined;
      tools.clear();
      emit({ _tag: "RunSettled", outcome });
      queueMicrotask(startNextQueued);
    };

    const startNextQueued = () => {
      if (state.closed || state.activeRun) return;
      const next = state.pendingPrompts.shift();
      if (next === undefined) return;
      emit({ _tag: "QueueChanged", queued: queuedView() });
      startRun(next);
    };

    const emitToolStart = (callId: string, payload: JsonRecord) => {
      if (tools.has(callId)) return;
      const call = cursorToolCall(payload);
      if (!call) return;
      tools.set(callId, { name: call.name, output: "" });
      const argsPreview = toolArgsPreview(call.name, call.args);
      const toolPart: TranscriptPart = {
        type: "toolCall",
        toolId: callId,
        name: call.name,
        argsPreview,
      };
      emit({ _tag: "AssistantMessage", parts: [toolPart] });
      emit({ _tag: "ToolStart", toolId: callId, name: call.name, argsPreview });
    };

    const emitToolEnd = (
      callId: string,
      payload: JsonRecord,
      subtype: string | undefined,
    ) => {
      const call = cursorToolCall(payload);
      if (!call) return;
      if (!tools.has(callId)) emitToolStart(callId, payload);
      const live = tools.get(callId);
      tools.delete(callId);
      emit({
        _tag: "ToolEnd",
        toolId: callId,
        name: live?.name ?? call.name,
        isError: toolFailed(subtype, call.result),
        outputPreview: toolResultPreview(call.result),
      });
    };

    const handleEvent = (message: JsonRecord, serial: number) => {
      if (state.closed || !state.activeRun || serial !== state.runSerial)
        return;
      const type = stringValue(message.type);
      const subtype = stringValue(message.subtype);
      switch (type) {
        case "system": {
          if (subtype !== "init") break;
          const sessionId = stringValue(message.session_id);
          const modelLabel = stringValue(message.model);
          if (sessionId) state.chatId = sessionId;
          state.meta = {
            ...state.meta,
            ...(sessionId ? { nativeSessionId: sessionId } : {}),
            ...(modelLabel ? { modelLabel } : {}),
          };
          emit({ _tag: "MetaChanged", meta: state.meta });
          break;
        }
        case "thinking": {
          const delta = stringValue(message.text);
          if (subtype === "delta" && delta) {
            emit({ _tag: "AssistantDelta", kind: "thinking", delta });
          }
          break;
        }
        case "assistant": {
          const text = messageText(message.message);
          if (!text) break;
          // With --stream-partial-output, incremental chunks carry a
          // `timestamp_ms` and the finalized whole message does not. Treating
          // the finalized one as a delta would duplicate the entire reply.
          if (message.timestamp_ms !== undefined) {
            state.streamedText += text;
            emit({ _tag: "AssistantDelta", kind: "text", delta: text });
          } else {
            state.streamedText = "";
            state.lastAssistantText = text;
            emit({ _tag: "AssistantMessage", parts: [{ type: "text", text }] });
          }
          break;
        }
        case "tool_call": {
          const callId =
            stringValue(message.call_id) ??
            stringValue(record(message.tool_call)?.toolCallId);
          const payload = record(message.tool_call);
          if (!callId || !payload) break;
          if (subtype === "started") emitToolStart(callId, payload);
          else emitToolEnd(callId, payload, subtype);
          break;
        }
        case "error": {
          const messageText =
            stringValue(message.message) ??
            stringValue(record(message.error)?.message) ??
            safeJson(message.error) ??
            "Cursor run failed";
          state.runError = boundedError(messageText);
          emit({ _tag: "BackendError", message: state.runError });
          break;
        }
        case "result": {
          const usage = record(message.usage);
          const tokens =
            (numberValue(usage?.inputTokens) ?? 0) +
            (numberValue(usage?.cacheReadTokens) ?? 0) +
            (numberValue(usage?.outputTokens) ?? 0);
          if (tokens > 0) emit({ _tag: "UsageChanged", tokens });
          const finalText = stringValue(message.result);
          if (message.is_error === true || subtype === "error") {
            state.runError = boundedError(
              finalText ?? state.runError ?? "Cursor run failed",
            );
          } else if (finalText !== undefined) {
            // The `result` event carries the authoritative final answer, so
            // final text never depends on the delta/finalization heuristic.
            state.finalText = finalText;
          }
          break;
        }
      }
    };

    const finishRun = (serial: number, detail: string | undefined) => {
      if (!state.activeRun || serial !== state.runSerial) return;
      const partialText =
        state.finalText ||
        state.lastAssistantText ||
        state.streamedText ||
        undefined;
      if (state.interruptRequested) {
        settleRun({ _tag: "Interrupted", partialText }, serial);
        return;
      }
      const errorText = state.runError ?? detail;
      if (errorText) {
        settleRun(
          { _tag: "Failed", errorText: boundedError(errorText), partialText },
          serial,
        );
        return;
      }
      settleRun(
        {
          _tag: "Completed",
          finalText: state.finalText || state.lastAssistantText,
        },
        serial,
      );
    };

    function startRun(text: string) {
      if (state.closed || state.activeRun) return;
      const serial = ++state.runSerial;
      state.activeRun = true;
      state.interruptRequested = false;
      state.runError = undefined;
      state.finalText = "";
      state.lastAssistantText = "";
      state.streamedText = "";
      state.stderr = "";
      emit({ _tag: "UserMessage", text });
      emit({ _tag: "RunStarted" });

      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        // Headless children cannot answer approval prompts. The caller already
        // chose to launch an autonomous subagent, so allow commands unless
        // cursor's own config explicitly denies them.
        "--force",
        "--trust",
        "--model",
        modelId,
        ...(state.chatId ? ["--resume", state.chatId] : []),
        "--",
        text,
      ];

      let child: CursorChild;
      try {
        child = spawn(binary, args, {
          cwd: task.cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // Own process group on POSIX so teardown can signal the whole tree:
          // a wedged agent must not orphan a still-running shell command.
          detached: process.platform !== "win32",
        });
      } catch (error) {
        settleRun({ _tag: "Failed", errorText: boundedError(error) }, serial);
        return;
      }
      state.child = child;
      state.childExited = false;

      let stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // cursor-agent occasionally prints non-JSON notices on stdout;
            // those are diagnostics, not a protocol break.
            continue;
          }
          const event = record(parsed);
          if (event) handleEvent(event, serial);
        }
        if (stdoutBuffer.length > STDOUT_BUFFER_MAX_BYTES) {
          // A frame this large with no newline is protocol corruption, and an
          // unbounded buffer is a memory leak. Run-fatal: the exit handler
          // settles it.
          stdoutBuffer = "";
          state.runError = "Cursor emitted an oversized protocol frame.";
          void terminateChild(child, () => state.childExited);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        state.stderr = `${state.stderr}${chunk}`.slice(-4096);
      });
      child.once("error", (error) => {
        state.childExited = true;
        finishRun(serial, `cursor-agent failed: ${boundedError(error)}`);
      });
      child.once("exit", (code, signal) => {
        state.childExited = true;
        if (code === 0) {
          finishRun(serial, undefined);
          return;
        }
        const suffix = firstLine(state.stderr);
        finishRun(
          serial,
          `cursor-agent exited (${signal ?? `code ${code ?? "unknown"}`})${suffix ? `: ${suffix}` : ""}`,
        );
      });
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (state.closing) return;
        state.closing = true;
        const child = state.child;
        // Settle before marking closed so the run gets the correct
        // "Interrupted" outcome instead of the pump's generic fallback.
        if (state.activeRun) {
          settleRun({
            _tag: "Interrupted",
            partialText:
              state.finalText ||
              state.lastAssistantText ||
              state.streamedText ||
              undefined,
          });
        }
        state.closed = true;
        state.pendingPrompts = [];
        if (child) await terminateChild(child, () => state.childExited);
        Queue.endUnsafe(events);
      }),
    );

    emit({ _tag: "MetaChanged", meta: state.meta });
    startRun(task.prompt);

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          if (state.activeRun) {
            state.pendingPrompts.push(text);
            emit({ _tag: "QueueChanged", queued: queuedView() });
            return Effect.void;
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed || !state.activeRun) return;
        state.pendingPrompts = [];
        emit({ _tag: "QueueChanged", queued: [] });
        state.interruptRequested = true;
        const child = state.child;
        // A one-shot CLI run has no interrupt channel — killing the process
        // group is the interrupt. The exit handler settles the run.
        if (child) await terminateChild(child, () => state.childExited);
      }),
    } satisfies SubagentSession;
  });

export const cursorBackend: SubagentBackend = {
  name: "cursor",
  capabilities: {
    // Each run is its own one-shot process, so a message sent mid-run can only
    // be queued as a follow-up turn — the same shape as codex.
    steering: false,
    modelSelection: true,
    // Effort is real, but only for families whose ids carry a tier (grok).
    reasoningEffort: true,
  },
  available: Effect.sync(() => resolveCursorBinary() !== undefined),
  spawn: makeCursorSession,
};
