/**
 * Unified-diff parsing, kept free of pi imports so it stays unit-testable.
 *
 * Why this exists: pi renders `bash` output as one uniform `toolOutput` blob,
 * because it cannot know that arbitrary stdout happens to be a diff. The diff
 * tokens (`toolDiffAdded`/`toolDiffRemoved`/`toolDiffContext`) and the syntax
 * highlighter are already wired up — but only for the `edit`/`write` tools. So
 * `git show | rg` falls through to flat grey. Parsing the diff ourselves lets
 * the git tools render like `edit` does: `file:line` headers, red/green, and
 * syntax-highlighted context.
 */

export type DiffLineKind = "added" | "removed" | "context" | "meta";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Line number in the new file, when determinable. */
  readonly newLine?: number;
}

export interface DiffHunk {
  /** The `@@ … @@` header's starting line in the new file. */
  readonly startLine: number;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  readonly path: string;
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  /** Set for renames/copies so the header can show both sides. */
  readonly oldPath?: string;
  readonly binary?: boolean;
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses `git diff` / `git show` output. Unknown or unexpected lines are kept
 * as `meta` rather than dropped — a diff we half-understand must not silently
 * lose content, since the point is to show the user what changed.
 */
export function parseUnifiedDiff(output: string): DiffFile[] {
  const files: DiffFile[] = [];
  let path: string | undefined;
  let oldPath: string | undefined;
  let binary = false;
  let hunks: DiffHunk[] = [];
  let lines: DiffLine[] = [];
  let startLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;

  const flushHunk = () => {
    if (lines.length > 0) hunks.push({ startLine, lines });
    lines = [];
  };
  const flushFile = () => {
    flushHunk();
    if (path !== undefined) {
      files.push({
        path,
        hunks,
        added,
        removed,
        ...(oldPath && oldPath !== path ? { oldPath } : {}),
        ...(binary ? { binary: true } : {}),
      });
    }
    hunks = [];
    added = 0;
    removed = 0;
    binary = false;
    oldPath = undefined;
  };

  for (const raw of output.split("\n")) {
    const fileMatch = FILE_HEADER.exec(raw);
    if (fileMatch) {
      flushFile();
      oldPath = fileMatch[1];
      path = fileMatch[2];
      continue;
    }

    if (path === undefined) continue; // commit message / preamble

    const hunkMatch = HUNK_HEADER.exec(raw);
    if (hunkMatch) {
      flushHunk();
      startLine = Number(hunkMatch[1]);
      newLine = startLine;
      continue;
    }

    if (raw.startsWith("Binary files")) {
      binary = true;
      continue;
    }
    // Skip the index/mode/+++/--- preamble; the `diff --git` line already gave
    // us both paths, and these add noise without information.
    if (
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename from") ||
      raw.startsWith("rename to") ||
      raw.startsWith("new file mode") ||
      raw.startsWith("deleted file mode")
    ) {
      continue;
    }

    if (raw.startsWith("+")) {
      added += 1;
      lines.push({ kind: "added", text: raw.slice(1), newLine });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      removed += 1;
      lines.push({ kind: "removed", text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "context", text: raw.slice(1), newLine });
      newLine += 1;
    } else if (raw === "\\ No newline at end of file") {
      lines.push({ kind: "meta", text: raw });
    } else if (raw !== "") {
      lines.push({ kind: "meta", text: raw });
    }
  }

  flushFile();
  return files;
}

/** `+12 -3`, or `binary` — the one-line change summary for a collapsed call. */
export function formatChangeStat(files: readonly DiffFile[]) {
  if (files.length === 0) return "no changes";
  if (files.every((f) => f.binary)) return "binary";
  const added = files.reduce((sum, f) => sum + f.added, 0);
  const removed = files.reduce((sum, f) => sum + f.removed, 0);
  return `+${added} -${removed}`;
}

/** Basenames for the collapsed header, capped so it stays one line. */
export function summarizePaths(files: readonly DiffFile[], max = 2) {
  const names = files.map((f) => f.path.split("/").pop() ?? f.path);
  if (names.length === 0) return "";
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}
