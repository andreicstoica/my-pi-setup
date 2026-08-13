/**
 * Task classes: named presets that turn a judgment the orchestrator is good at
 * ("what kind of work is this?") into the lookups it gets wrong (which harness,
 * which model id, which effort, and whether the child may write).
 *
 * This is the same inversion `backends/cursor.ts` already applies to model ids —
 * the caller states intent, code derives the concrete value — lifted from one
 * backend to the routing decision itself. Before this, the whole table lived as
 * prose in `skills/subagents/SKILL.md` and was consulted only if the skill had
 * been loaded; an orchestrator that skipped it guessed a model id and burned a
 * run on the wrong backend.
 *
 * Deliberately a PRESET, not a gate. `task_class` fills only the fields the
 * caller omitted, so an explicit `harness`/`model`/`reasoning_effort` still
 * wins. A misjudged class must stay recoverable: the alternative — deriving
 * routing with no override path — turns one bad classification into a spawn
 * the parent cannot fix.
 *
 * The caps are a different matter. A parameter cannot enforce "at most 3
 * files": the child decides that, and nothing in the tool layer sees the diff.
 * What the tool layer *can* do is stop the cap from depending on the parent
 * remembering to write it down. SKILL.md requires read-only intent to be
 * restated in each child's own prompt on every harness, because `policy.ts`
 * reaches the `claude` backend only. So each class carries its cap as prompt
 * text and the spawn appends it — instruction-only, as it always was, but no
 * longer optional.
 */

import type { BackendName, ReasoningEffort } from "./domain.ts";

export interface TaskClass {
  /** Which harness this class of work belongs on. */
  readonly harness: BackendName;
  /** Concrete model hint for that harness, or undefined for its default. */
  readonly model?: string;
  readonly reasoningEffort: ReasoningEffort;
  /** One line for the tool schema, so the parent can choose without the skill. */
  readonly summary: string;
  /**
   * Appended to the child prompt. Carries the cap that no parameter can
   * enforce, phrased as an instruction to the child rather than a note to the
   * parent.
   */
  readonly constraint: string;
}

const READ_ONLY =
  "Read-only: do not create, edit, stage, delete, or commit any file. If the task appears to require a write, stop and report that instead of writing.";

/**
 * Mirrors the "Scoping work to models" table in
 * `skills/subagents/SKILL.md`. Keep the two in step — the skill explains why
 * each row is what it is, which does not belong in a tool schema.
 */
export const TASK_CLASSES = {
  recon: {
    harness: "cursor",
    model: "cursor-grok-4.6-fast",
    reasoningEffort: "high",
    summary: "locate files, trace a flow, or summarize prior art; read-only",
    constraint: READ_ONLY,
  },
  bulk_scan: {
    harness: "pi",
    model: "opencode/deepseek-v4-flash",
    reasoningEffort: "medium",
    summary:
      "one slice of a wide fan-out — the same narrow question asked of many files or dirs; read-only, metered per token so keep the slice small",
    constraint: `${READ_ONLY} You are one slice of a wider sweep. Answer only for the paths named in this prompt and do not widen the search; another child covers the rest. Report findings as a short list with file:line, not prose.`,
  },
  mechanical_edit: {
    harness: "cursor",
    model: "cursor-grok-4.6-fast",
    reasoningEffort: "high",
    summary:
      "apply a stated diff, rename, mirror a file, or delete dead code; at most 3 named files and no open design decisions",
    constraint:
      "Scope: at most 3 files, and only files named in this prompt. Every decision is already made here — if you find one that is not, stop and report it rather than deciding it yourself.",
  },
  scoped_implementation: {
    harness: "cursor",
    model: "cursor-grok-4.6",
    reasoningEffort: "xhigh",
    summary:
      "one component or endpoint whose behavior is fully specified here; at most 8 files",
    constraint:
      "Scope: at most 8 files. The behavior you must produce is stated in this prompt — build that, not a more general version of it. If the prompt states a goal but not the behavior, report the ambiguity instead of resolving it.",
  },
  ui_tweak: {
    harness: "claude",
    model: "opus",
    reasoningEffort: "high",
    summary:
      "frontend, visual, or interaction work — UI polish, animation, layout; Opus, and the Max plan pays for it; at most 8 files",
    constraint:
      "Scope: this is bounded frontend work. At most 8 files. Preserve existing patterns and design tokens — never introduce a magic color or spacing value. Do not expand the task into a redesign; if the requested behavior is unclear, stop and report the ambiguity.",
  },
  open_implementation: {
    harness: "claude",
    model: "fable",
    reasoningEffort: "high",
    summary:
      "vague, interpretive guidance or planning that needs Fable; use ui_tweak for frontend work and scoped_implementation once behavior is specified",
    constraint:
      "Use Fable for guidance, decomposition, and plan orchestration when the goal is still ambiguous. Do not use this class for bounded frontend work. Report the discrete steps, open questions, and judgment calls.",
  },
  mcp_dependent: {
    harness: "claude",
    model: "fable",
    reasoningEffort: "high",
    summary:
      "needs Linear, Figma, Sentry, or the Liftoff prod MCP — only this harness has MCP",
    constraint:
      "Fetch and report. Do not implement anything off the back of what you find, and do not write through any MCP tool.",
  },
  review: {
    harness: "codex",
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    summary:
      "is this right, what is risky, what is missing; read-only. Override the model to luna for a bounded diff or sol only when the call is genuinely hard",
    constraint: `${READ_ONLY} You are a second opinion, not a second author. Read the full files, not only the diff, and report only findings you are more than 80% confident in.`,
  },
  deep_question: {
    harness: "pi",
    model: "openai-codex/gpt-5.6-luna",
    reasoningEffort: "xhigh",
    summary:
      "one hard question and no breadth — depth is what the high effort buys, not scope",
    constraint: `${READ_ONLY} Answer the one question asked. Do not broaden the investigation to adjacent questions, however tempting.`,
  },
} as const satisfies Record<string, TaskClass>;

export type TaskClassName = keyof typeof TASK_CLASSES;

export const TASK_CLASS_NAMES = Object.keys(TASK_CLASSES) as [
  TaskClassName,
  ...TaskClassName[],
];

/**
 * One line per class, for the `task_class` schema description.
 *
 * This is standing prompt cost on every request, which the spawn description
 * otherwise avoids by deferring harness/model guidance to the skill. It is
 * bought deliberately: the point of the parameter is that a parent which never
 * loaded the skill still routes correctly, and it cannot do that from bare enum
 * values. Roughly 130 tokens against a wasted run on the wrong backend.
 */
export function describeTaskClasses() {
  return TASK_CLASS_NAMES.map(
    (name) => `- ${name}: ${TASK_CLASSES[name].summary}`,
  ).join("\n");
}

/**
 * Merge a task class with the caller's explicit fields. Explicit always wins;
 * the class fills the rest. With no class, the caller's fields pass through and
 * `harness` is required — which is why the caller, not this function, reports
 * the "one of the two" error.
 */
export function resolveRouting(options: {
  taskClass?: TaskClassName;
  harness?: BackendName;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}) {
  const preset = options.taskClass
    ? TASK_CLASSES[options.taskClass]
    : undefined;
  return {
    harness: options.harness ?? preset?.harness,
    // A caller-supplied model belongs to a caller-supplied harness. Falling
    // back to the preset's model would be wrong whenever the caller overrode
    // the harness instead: "codex" + "openai-codex/gpt-5.6-luna" is not a
    // model id codex accepts.
    model:
      options.model ??
      (options.harness && options.harness !== preset?.harness
        ? undefined
        : preset?.model),
    reasoningEffort: options.reasoningEffort ?? preset?.reasoningEffort,
    constraint: preset?.constraint,
  };
}
