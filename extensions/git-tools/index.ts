/**
 * git-tools — diff-aware `git` tools for pi.
 *
 * pi renders `bash` output as one uniform `toolOutput` blob, because it cannot
 * know that arbitrary stdout happens to be a diff. So `git show … | rg` lands
 * as flat grey text, while the `edit`/`write` tools get proper red/green and
 * syntax highlighting from `components/diff.js`.
 *
 * These tools close that gap: they run git directly, parse the unified diff,
 * and render it the way `edit` does — `file:line` hunk headers, add/remove
 * colouring, and syntax-highlighted context — collapsed to a one-line call by
 * default. Same pattern the `file-search` extension uses for `fd`/`rg`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getLanguageFromPath,
  highlightCode,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatChangeStat,
  parseUnifiedDiff,
  summarizePaths,
  type DiffFile,
} from "./src/diff.ts";

const run = promisify(execFile);

/** Diffs can be enormous; cap what we hand the model and what we render. */
const MAX_OUTPUT_BYTES = 96 * 1024;
const COLLAPSED_HUNK_LINES = 6;

interface GitDetails {
  readonly files: DiffFile[];
  readonly stat: string;
  readonly truncated: boolean;
  readonly raw: string;
}

async function git(args: string[], cwd: string, signal?: AbortSignal) {
  const { stdout } = await run("git", args, {
    cwd,
    signal,
    maxBuffer: 8 * 1024 * 1024,
    // Force plain, parseable output regardless of the user's git config:
    // colour codes and a pager would both corrupt the diff parser.
    env: { ...process.env, GIT_PAGER: "cat", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout;
}

function truncate(text: string) {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES)
    return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT_BYTES), truncated: true };
}

/** Renders one file's hunks with real diff colours and highlighted context. */
function renderFile(file: DiffFile, theme: Theme, expanded: boolean) {
  const lines: string[] = [];
  const language = getLanguageFromPath(file.path);

  const heading =
    theme.fg("toolTitle", theme.bold(file.path)) +
    (file.oldPath ? theme.fg("dim", ` (was ${file.oldPath})`) : "") +
    theme.fg("muted", `  +${file.added} -${file.removed}`);
  lines.push(heading);

  if (file.binary) {
    lines.push(theme.fg("dim", "  binary file"));
    return lines;
  }

  for (const hunk of file.hunks) {
    // The file:line header is the thing that makes a diff navigable, and the
    // single biggest gap versus reading raw `git show` output.
    lines.push(theme.fg("dim", `  ${file.path}:${hunk.startLine}`));

    const shown = expanded
      ? hunk.lines
      : hunk.lines.slice(0, COLLAPSED_HUNK_LINES);
    for (const line of shown) {
      if (line.kind === "meta") {
        lines.push(theme.fg("dim", `    ${line.text}`));
        continue;
      }
      const token =
        line.kind === "added"
          ? "toolDiffAdded"
          : line.kind === "removed"
            ? "toolDiffRemoved"
            : "toolDiffContext";
      const sign =
        line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
      // Context lines get syntax highlighting; +/- lines keep the diff colour,
      // because two colour systems on one line reads as noise.
      const body =
        line.kind === "context" && language
          ? (highlightCode(line.text, language)[0] ?? line.text)
          : theme.fg(token, line.text);
      lines.push(`    ${theme.fg(token, sign)} ${body}`);
    }
    if (!expanded && hunk.lines.length > COLLAPSED_HUNK_LINES) {
      lines.push(
        theme.fg(
          "dim",
          `    … +${hunk.lines.length - COLLAPSED_HUNK_LINES} lines (ctrl+o to expand)`,
        ),
      );
    }
  }
  return lines;
}

function renderDiffResult(
  result: AgentToolResult<GitDetails>,
  expanded: boolean,
  theme: Theme,
) {
  const details = result.details;
  if (!details || details.files.length === 0) {
    return new Text(theme.fg("dim", "no changes"), 0, 0);
  }
  const lines: string[] = [];
  for (const file of details.files)
    lines.push(...renderFile(file, theme, expanded));
  if (details.truncated) {
    lines.push(
      theme.fg("warning", `  output truncated at ${MAX_OUTPUT_BYTES / 1024}KB`),
    );
  }
  return new Text(lines.join("\n"), 0, 0);
}

function diffResult(
  raw: string,
  truncated: boolean,
): AgentToolResult<GitDetails> {
  const files = parseUnifiedDiff(raw);
  return {
    // The model gets the raw diff — rendering is for the human. Sending a
    // prettified version would make line numbers harder for it to cite.
    content: [{ type: "text", text: raw || "no changes" }],
    details: { files, stat: formatChangeStat(files), truncated, raw },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool<ReturnType<typeof diffParameters>, GitDetails>({
    name: "git_diff",
    label: "Git Diff",
    description:
      "Show a git diff with file:line hunk headers and syntax highlighting. Prefer this over `bash git diff` — the output is rendered as a real diff instead of flat text. Omit `revision_range` for the working tree.",
    promptSnippet:
      "Show a git diff, rendered with file:line headers and diff colouring",
    parameters: diffParameters(),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["diff", "--no-color", "--no-ext-diff"];
      if (params.staged) args.push("--staged");
      if (params.revision_range) args.push(params.revision_range);
      if (params.paths?.length) args.push("--", ...params.paths);
      const { text, truncated } = truncate(await git(args, ctx.cwd, signal));
      return diffResult(text, truncated);
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("git diff"));
      if (args.staged) text += theme.fg("dim", " --staged");
      if (args.revision_range)
        text += " " + theme.fg("accent", args.revision_range);
      if (args.paths?.length)
        text += theme.fg("muted", ` — ${args.paths.join(" ")}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "diffing…"), 0, 0);
      return renderDiffResult(result, expanded, theme);
    },
  });

  pi.registerTool<ReturnType<typeof showParameters>, GitDetails>({
    name: "git_show",
    label: "Git Show",
    description:
      "Show a commit's diff with file:line hunk headers and syntax highlighting. Prefer this over `bash git show` — the output is rendered as a real diff instead of flat text.",
    promptSnippet:
      "Show a commit's diff, rendered with file:line headers and diff colouring",
    parameters: showParameters(),
    async execute(_id, params, signal, ctxUpdate, ctx) {
      void ctxUpdate;
      const args = ["show", "--no-color", "--no-ext-diff", params.revision];
      if (params.paths?.length) args.push("--", ...params.paths);
      const { text, truncated } = truncate(await git(args, ctx.cwd, signal));
      return diffResult(text, truncated);
    },
    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("git show")) +
        " " +
        theme.fg("accent", args.revision);
      if (args.paths?.length)
        text += theme.fg("muted", ` — ${args.paths.join(" ")}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "reading commit…"), 0, 0);
      const stat = result.details?.stat;
      const paths = result.details ? summarizePaths(result.details.files) : "";
      const header = new Text(
        theme.fg("muted", `${paths}${stat ? `  ${stat}` : ""}`),
        0,
        0,
      );
      const body = renderDiffResult(result, expanded, theme);
      return {
        render: (width: number) => [
          ...header.render(width),
          ...body.render(width),
        ],
        invalidate: () => {
          header.invalidate();
          body.invalidate();
        },
      };
    },
  });

  pi.registerTool<ReturnType<typeof logParameters>, { count: number }>({
    name: "git_log",
    label: "Git Log",
    description:
      "List commits as one line each (sha, subject). Use for history and ancestry questions; use git_show to see a commit's changes.",
    promptSnippet: "List git commits, one per line",
    parameters: logParameters(),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = [
        "log",
        "--no-color",
        `--max-count=${params.limit ?? 20}`,
        "--pretty=format:%h %s",
      ];
      if (params.revision_range) args.push(params.revision_range);
      if (params.paths?.length) args.push("--", ...params.paths);
      const { text, truncated } = truncate(await git(args, ctx.cwd, signal));
      const count = text ? text.split("\n").length : 0;
      return {
        content: [{ type: "text", text: text || "no commits" }],
        details: { count },
        ...(truncated ? {} : {}),
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("git log"));
      if (args.revision_range)
        text += " " + theme.fg("accent", args.revision_range);
      text += theme.fg("dim", ` -${args.limit ?? 20}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "reading log…"), 0, 0);
      const body =
        result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = body.split("\n");
      const shown = expanded ? lines : lines.slice(0, 10);
      let text = shown
        .map((line) => {
          const space = line.indexOf(" ");
          if (space === -1) return theme.fg("toolOutput", line);
          // The sha is the part you copy, so give it the accent.
          return (
            theme.fg("accent", line.slice(0, space)) +
            theme.fg("toolOutput", line.slice(space))
          );
        })
        .join("\n");
      if (!expanded && lines.length > 10) {
        text +=
          "\n" +
          theme.fg("dim", `… +${lines.length - 10} more (ctrl+o to expand)`);
      }
      return new Text(text, 0, 0);
    },
  });
}

function diffParameters() {
  return Type.Object({
    revision_range: Type.Optional(
      Type.String({
        description:
          "Revision or range, e.g. 'HEAD~3', 'master...feature'. Omit for the working tree.",
      }),
    ),
    staged: Type.Optional(
      Type.Boolean({
        description: "Diff the index instead of the working tree.",
      }),
    ),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        description: "Limit the diff to these paths.",
      }),
    ),
  });
}

function showParameters() {
  return Type.Object({
    revision: Type.String({
      description: "Commit-ish to show, e.g. a sha, tag, or 'HEAD'.",
    }),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        description: "Limit the output to these paths.",
      }),
    ),
  });
}

function logParameters() {
  return Type.Object({
    revision_range: Type.Optional(
      Type.String({ description: "Revision or range, e.g. 'master..HEAD'." }),
    ),
    limit: Type.Optional(
      Type.Number({ description: "Maximum commits to list (default 20)." }),
    ),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        description: "Limit history to these paths.",
      }),
    ),
  });
}
