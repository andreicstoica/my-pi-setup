import {
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { latestText, type SubagentSnapshot } from "./domain.ts";
import { API_FAILURE_ADVICE, looksLikeApiFailure } from "./prompt.ts";

export const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
export const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

const statusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("error"),
]);

const summarySchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  harness: Type.String(),
  cwd: Type.String(),
  status: statusSchema,
  model: Type.Optional(Type.String()),
  turns: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
});

export const spawnOutputSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  harness: Type.String(),
  cwd: Type.String(),
  status: statusSchema,
  model: Type.Optional(Type.String()),
});

export const listOutputSchema = Type.Object({
  subagents: Type.Array(summarySchema),
});

export const checkOutputSchema = Type.Intersect([
  summarySchema,
  Type.Object({
    output: Type.String(),
    truncated: Type.Boolean(),
    message: Type.String(),
  }),
]);

export const sendOutputSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("restarting")]),
  message: Type.String(),
});

export const cancelOutputSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      id: Type.String(),
      title: Type.String(),
      status: statusSchema,
      cancelled: Type.Boolean(),
    }),
  ),
});

export const waitOutputSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      id: Type.String(),
      title: Type.Optional(Type.String()),
      status: Type.Union([
        Type.Literal("running"),
        Type.Literal("done"),
        Type.Literal("error"),
        Type.Literal("missing"),
      ]),
      output: Type.String(),
      error: Type.Optional(Type.String()),
      truncated: Type.Boolean(),
    }),
  ),
});

export function projectSubagent(
  snap: SubagentSnapshot,
  options: { turns?: boolean } = { turns: true },
) {
  return {
    id: snap.id,
    title: snap.title,
    harness: snap.backend,
    cwd: snap.cwd,
    status: snap.status,
    ...(snap.meta.modelLabel ? { model: snap.meta.modelLabel } : {}),
    ...(options.turns !== false ? { turns: snap.turns } : {}),
    ...(snap.errorText ? { error: snap.errorText } : {}),
  };
}

export function projectCheck(snap: SubagentSnapshot, message: string) {
  const preview = truncateHead(latestText(snap), {
    maxBytes: 2048,
    maxLines: 20,
  });
  return {
    ...projectSubagent(snap, { turns: true }),
    output: preview.content,
    truncated: preview.truncated,
    message,
  };
}

export function projectWaitResults(
  entries: ReadonlyArray<readonly [string, SubagentSnapshot | undefined]>,
) {
  const results: WaitResult[] = [];
  for (const [index, [id, snap]] of entries.entries()) {
    const future = entries
      .slice(index + 1)
      .map(([futureId, futureSnap]) => minimumWaitResult(futureId, futureSnap));
    if (!snap) {
      results.push(
        fitWaitResult(
          { id, status: "missing", output: "", truncated: false },
          results,
          future,
        ),
      );
      continue;
    }
    const apiFailure =
      snap.status !== "error" && looksLikeApiFailure(snap.finalText ?? "");
    const source = snap.finalText || "(no output)";
    const output = truncateHead(source, {
      maxBytes: WAIT_PER_AGENT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    results.push(
      fitWaitResult(
        {
          id: snap.id,
          title: snap.title,
          status: apiFailure ? "error" : snap.status,
          output: output.content,
          ...(apiFailure
            ? {
                error: [API_FAILURE_ADVICE, snap.errorText]
                  .filter((part): part is string => Boolean(part))
                  .join("\n"),
              }
            : snap.errorText
              ? { error: snap.errorText }
              : {}),
          truncated: output.truncated,
        },
        results,
        future,
      ),
    );
  }
  return results;
}

type WaitResult = {
  id: string;
  title?: string;
  status: SubagentSnapshot["status"] | "missing";
  output: string;
  error?: string;
  truncated: boolean;
};

function minimumWaitResult(
  id: string,
  snap: SubagentSnapshot | undefined,
): WaitResult {
  if (!snap) return { id, status: "missing", output: "", truncated: false };
  const apiFailure =
    snap.status !== "error" && looksLikeApiFailure(snap.finalText ?? "");
  return {
    id: snap.id,
    status: apiFailure ? "error" : snap.status,
    output: "",
    truncated: Boolean(snap.finalText),
  };
}

function jsonBytes(results: readonly WaitResult[]) {
  return Buffer.byteLength(JSON.stringify({ results }), "utf8");
}

function truncateText(text: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  return truncateHead(text, { maxBytes, maxLines: DEFAULT_MAX_LINES }).content;
}

function fitWaitResult(
  initial: WaitResult,
  prior: readonly WaitResult[],
  future: readonly WaitResult[],
): WaitResult {
  const result = { ...initial };
  const fits = () =>
    Buffer.byteLength(JSON.stringify(result), "utf8") <=
      WAIT_PER_AGENT_MAX_BYTES &&
    jsonBytes([...prior, result, ...future]) <= WAIT_OUTPUT_MAX_BYTES;
  if (fits()) return result;

  result.truncated = true;
  delete result.title;
  if (fits()) return result;

  for (const field of ["error", "output"] as const) {
    const original = result[field];
    if (original === undefined) continue;
    let low = 0;
    let high = Buffer.byteLength(original, "utf8");
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      result[field] = truncateText(original, middle);
      if (fits()) {
        best = result[field];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    result[field] = best;
    if (field === "error" && best.length === 0) delete result.error;
    if (fits()) return result;
  }

  throw new Error(
    "Subagent wait metadata exceeds the structured result limit.",
  );
}
