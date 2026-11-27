// The MCP Tasks extension (io.modelcontextprotocol/tasks, revision
// 2026-07-28) for the one slow tool call this server has: the relationship
// gap report. A client that declares the extension gets a task back at once
// and polls tasks/get for the result; any other client gets the result on
// the request itself, as before.
//
// The SDK (2.4.0) has no runtime for tasks, so this is the whole of it: a
// store of tasks held in memory by the endpoint, outside the per-request
// server. A task does not survive the plugin being reloaded; tasks/get then
// answers "unknown task", as the extension specifies for an expired one.

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

export type TaskStatus = "working" | "completed" | "failed" | "cancelled";

/** A task as the extension puts it on the wire. */
export interface TaskView {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  /** For a completed task: what the request would have returned. */
  result?: unknown;
  /** For a failed task: a JSON-RPC error. */
  error?: { code: number; message: string };
}

interface Entry extends TaskView {
  expires: number;
}

/** 256 bits, hex: a task id is all that a caller needs to read the task, so it must not be guessable. */
function newTaskId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class TaskStore {
  private readonly tasks = new Map<string, Entry>();

  constructor(
    /** How long a task is kept, from its creation. */
    private readonly ttlMs = 600_000,
    private readonly pollIntervalMs = 1_000,
    /** Tasks that may be working at once; past it `start` declines and the caller answers on the request. */
    private readonly maxWorking = 4,
    private readonly now: () => number = Date.now,
  ) {}

  private sweep(): void {
    const t = this.now();
    for (const [id, e] of this.tasks) if (e.expires <= t) this.tasks.delete(id);
  }

  private view(e: Entry): TaskView {
    const { expires: _expires, ...view } = e;
    return view;
  }

  /**
   * Start `work` and return its task, or undefined when too many are working.
   * `work` reports progress in words; what it resolves to is the task's result.
   */
  start(work: (progress: (message: string) => void) => Promise<unknown>): TaskView | undefined {
    this.sweep();
    if ([...this.tasks.values()].filter((e) => e.status === "working").length >= this.maxWorking) return undefined;
    const at = new Date(this.now()).toISOString();
    const entry: Entry = { taskId: newTaskId(), status: "working", createdAt: at, lastUpdatedAt: at, ttlMs: this.ttlMs, pollIntervalMs: this.pollIntervalMs, expires: this.now() + this.ttlMs };
    this.tasks.set(entry.taskId, entry);
    const touch = () => (entry.lastUpdatedAt = new Date(this.now()).toISOString());
    // A cancelled task keeps running to its end (the comparison cannot be interrupted); its result is dropped.
    const settle = (status: TaskStatus, rest: Partial<Entry>) => {
      if (entry.status !== "working") return;
      Object.assign(entry, rest, { status });
      touch();
    };
    void Promise.resolve()
      .then(() =>
        work((message) => {
          if (entry.status !== "working") return;
          entry.statusMessage = message;
          touch();
        }),
      )
      .then(
        (result) => settle("completed", { result, statusMessage: "Done." }),
        (err: unknown) => settle("failed", { error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, statusMessage: "The work failed." }),
      );
    return this.view(entry);
  }

  get(taskId: string): TaskView | undefined {
    this.sweep();
    const e = this.tasks.get(taskId);
    return e ? this.view(e) : undefined;
  }

  /** Cancel a task. False when there is no such task; a task already finished stays as it is. */
  cancel(taskId: string): boolean {
    this.sweep();
    const e = this.tasks.get(taskId);
    if (!e) return false;
    if (e.status === "working") {
      e.status = "cancelled";
      e.statusMessage = "Cancelled.";
      e.lastUpdatedAt = new Date(this.now()).toISOString();
    }
    return true;
  }
}
