/**
 * Todo state as a pure reducer over an append-only mutation log.
 *
 * Nothing here touches time, randomness, or the filesystem: ids come from a
 * counter carried in the state, so replaying the same mutations in the same
 * order always rebuilds the same state. That is what makes session branching
 * work — pi hands us the mutations along the current branch and we fold.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Todo {
  id: string;
  subject: string;
  /** Present-continuous form shown while in_progress ("Wiring the dock"). */
  activeForm?: string;
  status: TodoStatus;
  owner?: string;
  blockedBy: string[];
  createdSeq: number;
  updatedSeq: number;
}

export interface TodoCreate {
  subject: string;
  activeForm?: string;
  blockedBy?: string[];
  owner?: string;
}

export interface TodoUpdate {
  id: string;
  status?: TodoStatus;
  subject?: string;
  activeForm?: string;
  owner?: string;
  blockedBy?: string[];
}

export interface TodoMutation {
  create?: TodoCreate[];
  update?: TodoUpdate[];
  /** Rationale, required by convention when the shape of the plan changes. */
  explanation?: string;
}

export interface TodoState {
  items: Todo[];
  nextId: number;
  seq: number;
  /** Explanation attached to the most recent mutation that carried one. */
  explanation?: string;
}

export interface ApplyResult {
  state: TodoState;
  /** Non-fatal discipline violations, fed back to the model in the result. */
  warnings: string[];
  createdIds: string[];
}

export const emptyTodoState = (): TodoState => ({
  items: [],
  nextId: 1,
  seq: 0,
});

export const isOpen = (todo: Todo) =>
  todo.status === "pending" || todo.status === "in_progress";

export const inProgress = (state: TodoState) =>
  state.items.filter((t) => t.status === "in_progress");

export const openItems = (state: TodoState) => state.items.filter(isOpen);

/**
 * Fold one mutation into the state. Never throws: bad input becomes a warning
 * so a malformed tool call degrades into feedback rather than a hard failure.
 */
export function applyMutation(
  state: TodoState,
  mutation: TodoMutation,
): ApplyResult {
  const warnings: string[] = [];
  const createdIds: string[] = [];
  const seq = state.seq + 1;
  const items = state.items.map((t) => ({ ...t, blockedBy: [...t.blockedBy] }));
  let nextId = state.nextId;

  for (const spec of mutation.create ?? []) {
    const subject = spec.subject.trim();
    if (!subject) {
      warnings.push("skipped a create with an empty subject");
      continue;
    }
    const id = String(nextId++);
    items.push({
      id,
      subject,
      activeForm: spec.activeForm?.trim() || undefined,
      status: "pending",
      owner: spec.owner,
      blockedBy: spec.blockedBy ?? [],
      createdSeq: seq,
      updatedSeq: seq,
    });
    createdIds.push(id);
  }

  for (const patch of mutation.update ?? []) {
    const todo = items.find((t) => t.id === patch.id);
    if (!todo) {
      warnings.push(`no todo with id ${patch.id}`);
      continue;
    }
    if (patch.status === "completed" && todo.status === "pending") {
      warnings.push(
        `todo ${todo.id} jumped pending → completed; mark it in_progress before working on it`,
      );
    }
    if (patch.status === "in_progress" || patch.status === "completed") {
      const blockers = todo.blockedBy.filter((id) => {
        const dep = items.find((t) => t.id === id);
        return dep ? isOpen(dep) : false;
      });
      if (blockers.length > 0)
        warnings.push(
          `todo ${todo.id} ${
            patch.status === "completed" ? "completed" : "started"
          } while blocked by ${blockers.join(", ")}`,
        );
    }
    if (patch.subject !== undefined) todo.subject = patch.subject.trim();
    if (patch.activeForm !== undefined)
      todo.activeForm = patch.activeForm.trim() || undefined;
    if (patch.owner !== undefined) todo.owner = patch.owner || undefined;
    if (patch.blockedBy !== undefined) todo.blockedBy = patch.blockedBy;
    if (patch.status !== undefined) todo.status = patch.status;
    todo.updatedSeq = seq;
  }

  for (const todo of items) {
    for (const dep of todo.blockedBy) {
      if (!items.some((t) => t.id === dep))
        warnings.push(`todo ${todo.id} is blocked by unknown id ${dep}`);
    }
  }

  const running = items.filter((t) => t.status === "in_progress");
  if (running.length > 1)
    warnings.push(
      `${running.length} todos are in_progress (${running
        .map((t) => t.id)
        .join(", ")}); keep exactly one`,
    );

  return {
    state: {
      items,
      nextId,
      seq,
      explanation: mutation.explanation?.trim() || state.explanation,
    },
    warnings: [...new Set(warnings)],
    createdIds,
  };
}

/** Rebuild state from the mutation log along the current session branch. */
export function replay(mutations: TodoMutation[]): TodoState {
  let state = emptyTodoState();
  for (const mutation of mutations)
    state = applyMutation(state, mutation).state;
  return state;
}
