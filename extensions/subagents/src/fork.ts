import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface ForkSource {
  readonly sessionFile: string;
  readonly leafId: string;
}

export function captureForkSource(
  parent: ExtensionContext["sessionManager"],
): ForkSource {
  const sessionFile = parent.getSessionFile();
  if (!sessionFile || !existsSync(sessionFile)) {
    throw new Error("Fork mode requires a saved parent session.");
  }
  const branch = parent.getBranch();
  let leafId = parent.getLeafId();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const calls = entry.message.content.filter(
      (part) => part.type === "toolCall",
    );
    const completed = new Set(
      branch
        .slice(index + 1)
        .flatMap((next) =>
          next.type === "message" && next.message.role === "toolResult"
            ? [next.message.toolCallId]
            : [],
        ),
    );
    // A spawn executes before its own tool result exists. Copying that batch
    // would leave dangling tool calls in the child's first provider request.
    if (calls.some((call) => !completed.has(call.id))) leafId = entry.parentId;
    break;
  }
  if (!leafId)
    throw new Error("Fork mode has no completed conversation checkpoint.");
  return { sessionFile, leafId };
}

export function createForkSession(
  source: ForkSource,
  cwd: string,
): SessionManager {
  if (!existsSync(source.sessionFile))
    throw new Error("The parent session file is no longer available.");
  // Branch a detached manager. The live parent's leaf and file must never change.
  const detached = SessionManager.open(source.sessionFile);
  if (resolve(detached.getCwd()) !== resolve(cwd)) {
    throw new Error(
      "Fork mode requires the same working directory as the parent.",
    );
  }
  if (!detached.getEntry(source.leafId))
    throw new Error("The parent checkpoint is no longer available.");
  detached.createBranchedSession(source.leafId);
  return detached;
}
