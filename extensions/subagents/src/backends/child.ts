/**
 * Child-process helpers shared by the CLI-driven backends (codex, cursor,
 * opencode).
 *
 * All three spawn a long-lived or per-run child that itself spawns shell
 * commands, so they need the same two guarantees: resolve the binary from PATH
 * once, and tear the whole process *group* down so a wedged agent cannot orphan
 * a running command in the user's workspace.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const FORCE_KILL_AFTER_MS = 2_000;

export function executable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a CLI from PATH, then from `extraDirs` (installers that drop a binary
 * outside the login PATH — `~/.local/bin`, `~/.opencode/bin`). Callers memoize
 * the result, so availability checks after the first are allocation-only.
 */
export function resolveBinary(
  names: readonly string[],
  extraDirs: readonly string[] = [],
) {
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    ...extraDirs,
  ];
  for (const directory of directories) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Signal the whole process group on POSIX so tool descendants (shell commands
 * the agent spawned) die with it; a wedged or force-killed agent must not
 * orphan a still-running command in the workspace. Requires the child to have
 * been spawned `detached` on POSIX.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn(
        "taskkill",
        [
          "/pid",
          String(child.pid),
          "/T",
          ...(signal === "SIGKILL" ? ["/F"] : []),
        ],
        { stdio: "ignore", windowsHide: true },
      );
      const killDirect = () => {
        try {
          child.kill(signal);
        } catch {
          // Process may already be gone.
        }
      };
      killer.once("error", killDirect);
      killer.once("exit", (code) => {
        if (code !== 0) killDirect();
      });
      killer.unref();
      return;
    } catch {
      // Fall through to a direct signal when taskkill cannot be launched.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may already be gone; fall through to the direct signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

/** SIGTERM is normally enough; the second deadline covers a wedged process. */
export function terminateChild(child: ChildProcess, exited: () => boolean) {
  if (exited()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (lastTimer) clearTimeout(lastTimer);
      resolve();
    };
    child.once("exit", finish);
    killTree(child, "SIGTERM");
    forceTimer = setTimeout(() => {
      if (!exited()) killTree(child, "SIGKILL");
    }, FORCE_KILL_AFTER_MS);
    lastTimer = setTimeout(finish, FORCE_KILL_AFTER_MS + 500);
  });
}
