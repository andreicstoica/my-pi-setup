/** All model-facing strings for the subagents tools. */

/**
 * Describes subagent_spawn and the fixed concurrency cap. Harness, model, and
 * effort selection is deliberately NOT restated here — that guidance lives in
 * the `subagents` skill, which pi loads on demand (verified: skill bodies stay
 * out of the prompt until read), while this description is standing cost on
 * every request. The `harness` parameter description carries the short version.
 */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window and the chosen harness's normal host permissions. Fire-and-forget — returns an id immediately, and the subagent's final output is queued back to you when it settles, or collect it with subagent_wait. Children cannot see this conversation, ask the user, or spawn further agents, so the prompt must be self-contained. Read the `subagents` skill before choosing harness, model, or effort. Trusted working directories only. Max 4 running at once.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on a chosen harness (pi, Claude Code, Codex, or Cursor; own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Pick the subagent harness per task — there is no default-preferred harness. Match it to the work (tooling the task needs, the user's request, which harness suits the job).",
  "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back. A standard report contract is appended automatically, so state what you need reported, not how to format it.",
  name: 'Short human-readable name for this subagent (2-4 words), shown in listings and the UI. Its slug also becomes the subagent id used by wait/check/cancel, so name it after the task ("investigate auth regression" -> sa-investigate-auth-regression), not "agent 1".',
  harness:
    'Harness to run the subagent on: "pi" (in-process pi session; inherits this environment), "claude" (Claude Code), "codex" (Codex CLI), or "cursor" (Cursor Agent CLI). Choose deliberately per task.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Model hint, interpreted by the chosen harness (pi: "provider/model-id" or model id; claude: model alias like "sonnet"/"opus"; codex: model slug; cursor: "composer-2.5" or "cursor-grok-4.5", with an optional "-fast" suffix for fast mode — cursor encodes both effort and fast mode in the id, there is no fast flag). Omit for the harness default (pi inherits the current model).',
  reasoningEffort:
    "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget, cursor model-id tier). Choose per task rather than defaulting high: use low for mechanical or well-specified work (run a command, apply a known edit, collect facts), medium for ordinary implementation and investigation, and high or above only when the task genuinely turns on hard reasoning — an ambiguous bug, a design trade-off, an adversarial review. Omit for the harness default (pi inherits the current level).",
};

/**
 * Appended to every child prompt. The orchestrator sees only the child's final
 * message — never its transcript — yet across 144 mined spawns the returned
 * text routinely opened with conversational lead-in ("Perfect! I have the
 * complete timeline. Let me generate the final report:") before any content.
 * Under half of those spawns referenced a role file, so the role docs alone
 * cannot carry this. Kept to one short paragraph: it is standing cost on every
 * child, and the models mostly report well already.
 */
export const CHILD_REPORT_CONTRACT =
  "---\n" +
  "Report contract: your final message IS the result handed to the orchestrator, which cannot see this transcript. Lead with the answer — no preamble, no narration of the steps you took. Give concrete file paths, symbols, and commands rather than descriptions of them. State plainly anything you could not verify, could not do, or deliberately left undone; a gap you name is useful, a gap you omit is a bug. If you were asked a question, answer it in the first sentence.";

/** Composes the model-authored task prompt with the standing report contract. */
export function buildChildPrompt(prompt: string) {
  return `${prompt.trim()}\n\n${CHILD_REPORT_CONTRACT}`;
}

/**
 * Leading conversational filler a child emitted before its real report. Only
 * consulted on the first few lines, and only when a structural marker (`---`
 * or a markdown heading) follows — so prose that merely starts with "Now" is
 * never truncated.
 */
const PREAMBLE_OPENER =
  /^(perfect|great|excellent|ok(ay)?|alright|sure|got it|done|now|finally|let me|i'?ll|i'?ve|i have|here'?s|here is)\b/i;

/** Drops a child's lead-in so the orchestrator's context starts at the report. */
export function stripReportPreamble(output: string) {
  const lines = output.split("\n");
  const limit = Math.min(lines.length, 6);
  let marker = -1;

  for (let i = 0; i < limit; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^(-{3,}|#{1,6}\s)/.test(line)) {
      marker = i;
      break;
    }
    // Real content ahead of any marker: leave the output untouched.
    if (!PREAMBLE_OPENER.test(line)) return output;
  }

  if (marker <= 0) return output;
  const start = /^-{3,}$/.test(lines[marker].trim()) ? marker + 1 : marker;
  return lines.slice(start).join("\n").trim() || output;
}

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, exactly as returned by subagent_spawn, e.g. ["sa-investigate-auth", "sa-audit-css"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, exactly as returned by subagent_spawn, e.g. ["sa-investigate-auth"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result. Never call this in a loop to poll for completion: results are delivered to you automatically when the subagent settles, and subagent_wait blocks until then.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/**
 * A child can exit "done" with nothing but a provider error as its whole
 * output (observed: two subagents whose entire result was
 * "API Error: 529 Overloaded"). Treat that as a failure so the parent retries
 * instead of moving on with an empty answer. Scoped to short outputs so a real
 * report that merely mentions an API error is never reclassified.
 */
export function looksLikeApiFailure(output: string) {
  const trimmed = output.trim();
  if (!trimmed || trimmed.length > 600) return false;
  return (
    /^(\[?API Error|APIError|Request failed)\b/i.test(trimmed) ||
    /\boverloaded_error\b|\b529 Overloaded\b/i.test(trimmed)
  );
}

/** Appended whenever a settled child's output is really a provider error. */
export const API_FAILURE_ADVICE =
  "The output above is a model-API failure, not a result — the task did not run to completion. Respawn the subagent (same prompt) to retry.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const apiFailure =
    options.status !== "error" && looksLikeApiFailure(options.output);
  const verb =
    options.status === "error"
      ? "failed"
      : apiFailure
        ? "failed (model API error)"
        : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  // Failure detection runs on the raw output above; only the delivered body is trimmed.
  text += `\n\n${stripReportPreamble(options.output)}`;
  if (apiFailure) text += `\n\n${API_FAILURE_ADVICE}`;
  return text;
}
