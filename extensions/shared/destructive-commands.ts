/**
 * Shell-command parsing and the destructive-command rules, shared by every
 * caller that inspects a `bash` command before it runs.
 *
 * Two callers today, with deliberately different verdicts for the same match:
 *
 * - `subagents/src/policy.ts` — headless children. A match is a hard deny:
 *   nobody is watching, so the command is refused and surfaced for a human.
 * - `bash-guard` — this session. A match is a confirmation prompt: there is a
 *   TUI to answer it, and sometimes you really do mean to drop the database.
 *
 * Keep the *detection* here and the *verdict* in the caller. A rule that is
 * only ever right for one of the two does not belong in this file.
 */

/**
 * Shell metacharacters that start a new command. Splitting on these means a
 * call hidden behind `&&`, `;`, a pipe, or a subshell is still inspected
 * rather than only the first word of the whole string.
 */
export const COMMAND_SEPARATOR = /(?:\|\||&&|[;\n|&()])+/;

/**
 * Leading `VAR=value` assignments and wrappers that delegate to another
 * command; the real executable is whatever follows them.
 */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PASSTHROUGH_WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "nice",
  "nohup",
  "time",
  "xargs",
]);

/** Strip quotes so `"aws"` and `'aws'` are recognised as the executable. */
export function unquote(token: string) {
  return token.replace(/^['"]|['"]$/g, "");
}

/** Basename, so `/usr/local/bin/aws` matches but `awslogs` does not. */
export function basename(token: string) {
  const cleaned = unquote(token);
  const slash = cleaned.lastIndexOf("/");
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
}

/**
 * Drops leading env assignments and wrappers so the returned tokens start at
 * the real executable. Returns an empty array for a segment that is only
 * assignments or only whitespace.
 */
export function tokenizeSegment(segment: string) {
  let tokens = segment.trim().split(/\s+/).filter(Boolean);

  while (tokens.length > 0) {
    const head = tokens[0]!;
    if (ENV_ASSIGNMENT.test(head) || PASSTHROUGH_WRAPPERS.has(basename(head))) {
      tokens = tokens.slice(1);
      continue;
    }
    break;
  }

  return tokens;
}

/**
 * Destructive shell commands that must not run unattended. A real incident
 * motivates this: a script that drop/recreated a newline-joined DB list wiped
 * the local `liftoff` database (2026-07-30). Database destruction, force
 * pushes to the trunk, and rm -rf aimed at a home/root path are never routine.
 *
 * Returns a short human-readable reason, or undefined when nothing matched.
 */
export function findDestructiveCommand(command: string): string | undefined {
  for (const segment of command.split(COMMAND_SEPARATOR)) {
    const tokens = tokenizeSegment(segment);
    if (tokens.length === 0) continue;
    const executable = basename(tokens[0]!);

    if (executable === "dropdb") return "dropdb deletes a database";

    // SQL scanning is gated on a psql invocation so prose mentioning DROP
    // TABLE (commit messages, echo) is not a false positive.
    if (executable === "psql") {
      const sql = segment;
      if (/\bdrop\s+(database|schema|table)\b/i.test(sql)) {
        return "psql DROP DATABASE/SCHEMA/TABLE";
      }
      if (/\btruncate\s/i.test(sql)) return "psql TRUNCATE";
      if (/\bdelete\s+from\b(?![^;]*\bwhere\b)/i.test(sql)) {
        return "psql DELETE without a WHERE clause";
      }
    }

    if (executable === "git" && tokens[1] === "push") {
      const force = tokens.some(
        (t) => t === "--force" || t === "-f" || /^-[a-z]*f/.test(t),
      );
      const trunk = tokens.some((t) =>
        /^(master|main)$/.test(unquote(t).replace(/^.*:/, "")),
      );
      if (force && trunk) return "force push to master/main";
    }

    if (executable === "rm" && tokens.some((t) => /^-[a-z]*r/i.test(t))) {
      const targets = tokens
        .slice(1)
        .filter((t) => !t.startsWith("-"))
        .map(unquote);
      if (
        targets.some(
          (t) => t === "/" || t === "~" || t === "$HOME" || t.startsWith("../"),
        )
      ) {
        return "recursive rm aimed at root, home, or outside the working tree";
      }
    }
  }
  return undefined;
}
