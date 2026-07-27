/**
 * `!command` — run a shell command yourself, see the output inline, and leave it
 * in the model's context. Claude Code's bash mode, as a pi extension.
 *
 * Why an extension and not the bash tool: asking the model to run `git status`
 * costs a turn, and its rendering is tuned for the model's own calls. This is
 * the other direction — you run the thing, the agent reads over your shoulder.
 *
 * Two deliberate choices:
 *
 * - `deliverAs: "nextTurn"` puts the transcript in context WITHOUT triggering an
 *   LLM call, so a burst of `!` commands costs nothing until you actually ask
 *   something. `"steer"`/`"followUp"` would each provoke a response.
 * - The `input` event (not a `/command`) so `!` needs no space and reads like a
 *   shell prompt. It fires after extension commands are checked, so `/…` still
 *   wins and nothing here can shadow a real command.
 */

import {
  DEFAULT_MAX_LINES,
  keyHint,
  truncateHead,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Editor, Text } from "@earendil-works/pi-tui";

/** Collapsed output height. Long builds stay one expand away. */
const PREVIEW_LINES = 12;
/** Bytes of output handed to the model. Beyond this the tail is dropped. */
const CONTEXT_MAX_BYTES = 8 * 1024;
const TIMEOUT_MS = 120_000;

interface BangResult {
  command: string;
  cwd: string;
  code: number | null;
  killed?: boolean;
  output: string;
}

/**
 * `-l` rather than `-i`: a login shell picks up PATH and profile without the
 * job-control noise a non-tty interactive shell emits. Aliases live in
 * `.zshrc` and so are NOT expanded — same tradeoff as pi's own bash tool
 * (see its shell-aliases doc for the `shellCommandPrefix` workaround).
 */
function shellInvocation(command: string) {
  const shell = process.env.SHELL || "/bin/zsh";
  return { shell, args: ["-lc", command] };
}

/** stdout and stderr interleaved the way a terminal would show them. */
function combineStreams(stdout: string, stderr: string) {
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
}

export function formatForModel(result: BangResult) {
  const bounded = truncateHead(result.output || "(no output)", {
    maxBytes: CONTEXT_MAX_BYTES,
    maxLines: Math.min(400, DEFAULT_MAX_LINES),
  });
  let text =
    `The user ran a shell command in ${result.cwd} (not you — this is their ` +
    `terminal output, provided as context):\n\n$ ${result.command}\n${bounded.content}`;
  if (bounded.truncated) text += "\n[output truncated]";
  if (result.killed) {
    text += `\n[killed: exceeded ${TIMEOUT_MS / 1000}s]`;
  } else if (result.code !== 0) {
    text += `\n[exit ${result.code}]`;
  }
  return text;
}

/** `!ls -la` -> `ls -la`; `!` alone -> undefined. */
export function parseBang(text: string) {
  if (!text.startsWith("!")) return undefined;
  const command = text.slice(1).trim();
  return command.length > 0 ? command : undefined;
}

/**
 * A bare `!` is already shell mode even though there is no command yet — that
 * is the whole point of the border tint, so it must not wait for `parseBang`
 * (which rejects the empty command).
 */
export function isShellMode(text: string) {
  return text.startsWith("!");
}

/**
 * Recolor the input border while the line starts with `!`, so shell mode is
 * visible the moment you type it rather than after you hit enter.
 *
 * pi's editor draws its frame through the instance's own `borderColor`, so
 * swapping that for one render is enough — no re-implementing the frame. The
 * swap is restored in `finally` because the same instance renders normal turns.
 *
 * Composes with editor-cursor, which also wraps `Editor.prototype.render`:
 * each patch wraps whatever it found at load time, so both effects survive
 * regardless of load order. The marker property keeps a reload from stacking
 * the same wrapper twice.
 */
function patchShellModeBorder(getUI: () => ExtensionUIContext | undefined) {
  type RenderFn = (width: number) => string[];
  type Patched = RenderFn & { __bangShellBorder?: boolean };
  type EditorInternals = {
    getText?: () => string;
    borderColor?: (text: string) => string;
  };

  const prototype = Editor.prototype as unknown as { render?: Patched };
  const original = prototype.render;
  if (typeof original !== "function" || original.__bangShellBorder) return;

  const patched: Patched = function (this: EditorInternals, width: number) {
    if (!isShellMode(this.getText?.() ?? "")) return original.call(this, width);
    const theme = getUI()?.theme;
    if (!theme) return original.call(this, width);

    const saved = this.borderColor;
    this.borderColor = (text: string) => theme.fg("warning", text);
    try {
      return original.call(this, width);
    } finally {
      this.borderColor = saved;
    }
  };
  patched.__bangShellBorder = true;
  prototype.render = patched;
}

export default function (pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;
  patchShellModeBorder(() => ui);

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ui = ctx.ui;
  });

  pi.on("session_shutdown", () => {
    ui = undefined;
  });

  pi.on("input", async (event, ctx) => {
    // Only typed input. An extension-injected or RPC message starting with `!`
    // is not someone reaching for a shell.
    if (event.source !== "interactive") return { action: "continue" };
    const command = parseBang(event.text);
    if (!command) return { action: "continue" };

    const { shell, args } = shellInvocation(command);
    let result: BangResult;
    try {
      const exec = await pi.exec(shell, args, { timeout: TIMEOUT_MS });
      result = {
        command,
        cwd: ctx.cwd,
        code: exec.code,
        killed: exec.killed,
        output: combineStreams(exec.stdout, exec.stderr),
      };
    } catch (error) {
      result = {
        command,
        cwd: ctx.cwd,
        code: null,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    pi.sendMessage(
      {
        customType: "bang-shell",
        content: formatForModel(result),
        display: true,
        details: result,
      },
      // Sits in context until the next real prompt. Never starts a turn.
      { deliverAs: "nextTurn" },
    );

    return { action: "handled" };
  });

  pi.registerMessageRenderer("bang-shell", (message, { expanded }, theme) => {
    const details = (message.details ?? {}) as Partial<BangResult>;
    const failed = details.killed || (details.code ?? 0) !== 0;

    let text =
      theme.fg(failed ? "error" : "success", "! ") +
      theme.fg("toolTitle", theme.bold(details.command ?? "?"));
    if (details.killed) {
      text += theme.fg("error", ` timed out after ${TIMEOUT_MS / 1000}s`);
    } else if (failed) {
      text += theme.fg("error", ` exit ${details.code}`);
    }

    const lines = (details.output ?? "").split("\n").filter(Boolean);
    if (lines.length === 0) {
      text += `\n${theme.fg("dim", "(no output)")}`;
      return new Text(text, 0, 0);
    }
    const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
    for (const line of shown) text += `\n${theme.fg("toolOutput", line)}`;
    const hidden = lines.length - shown.length;
    if (hidden > 0) {
      text += `\n${theme.fg(
        "dim",
        `… +${hidden} lines (${keyHint("app.tools.expand", "to expand")})`,
      )}`;
    }
    return new Text(text, 0, 0);
  });
}
