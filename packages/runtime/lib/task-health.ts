import { createHash } from "node:crypto";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" ? value as RecordValue : {};
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");
export const HEALTH_LIMITS = { startupMs: 120_000, silenceMs: 180_000, repeatErrors: 3 };

/** Measures executor evidence, never controller heartbeat or rendered status text. */
export class TaskHealth {
  startedAt: number;
  lastProgressAt: number;
  phase: "startup" | "model" | "tool" | "retry" = "startup";
  phaseAt: number;
  phaseMs = { startup: 0, model: 0, tool: 0, retry: 0 };
  tools = new Map<string, { name: string; key: string; deadline?: number }>();
  errors = new Map<string, number>();
  errorCount = 0;
  requestCount = 0;
  toolCount = 0;
  reason?: string;
  sawOutput = false;
  constructor(readonly limits = HEALTH_LIMITS, now = Date.now()) {
    this.startedAt = this.lastProgressAt = this.phaseAt = now;
  }
  transition(phase: TaskHealth["phase"], now: number) {
    this.phaseMs[this.phase] += Math.max(0, now - this.phaseAt);
    this.phaseAt = now;
    this.phase = phase;
  }
  event(input: unknown, now = Date.now()) {
    const event = record(input);
    if (event.type === "message_update") {
      const delta = record(event.assistantMessageEvent);
      if (["text_delta", "thinking_delta", "toolcall_delta"].includes(String(delta.type)) && typeof delta.delta === "string" && delta.delta.length) {
        this.sawOutput = true;
        this.lastProgressAt = now;
        if (!this.tools.size) this.transition("model", now);
      }
    } else if (event.type === "message_end" && record(event.message).role === "assistant" && Array.isArray(record(event.message).content) && (record(event.message).content as RecordValue[]).some(block => typeof block.text === "string" && block.text.length)) {
      this.sawOutput = true; this.lastProgressAt = now;
    } else if (event.type === "message_start" && record(event.message).role === "assistant") {
      this.requestCount++;
      // Request dispatch alone must not restart the no-output deadline.
    } else if (event.type === "tool_execution_start") {
      const args = record(event.args);
      const timeout = ["bash", "python", "exec"].includes(String(event.toolName)) ? Number(args.timeout) : 0;
      this.tools.set(String(event.toolCallId), { name: String(event.toolName), key: fingerprint([event.toolName, args]),
        deadline: Number.isFinite(timeout) && timeout > 0 ? now + timeout * 1000 + 15_000 : undefined });
      this.toolCount++;
      this.sawOutput = true;
      this.lastProgressAt = now;
      this.transition("tool", now);
    } else if (event.type === "tool_execution_end") {
      const tool = this.tools.get(String(event.toolCallId));
      this.tools.delete(String(event.toolCallId));
      this.lastProgressAt = now;
      if (event.isError) {
        this.errorCount++;
        const content = record(event.result).content;
        const stableContent = event.toolName === "bash" && Array.isArray(content) ? content.map(block => {
          const part = record(block);
          return part.type === "text" && typeof part.text === "string"
            ? { ...part, text: part.text.replace(/^Wall time: [0-9.]+ seconds\r?$/gm, "") } : part;
        }) : content;
        const key = fingerprint([tool?.key ?? event.toolName, stableContent]);
        const count = (this.errors.get(key) ?? 0) + 1;
        if (this.errors.size >= 16 && !this.errors.has(key)) this.errors.delete(this.errors.keys().next().value!);
        this.errors.set(key, count);
        if (count >= this.limits.repeatErrors) this.reason = "repeated_tool_error";
      } else if (["write", "edit", "apply_patch"].includes(String(event.toolName))) {
        // An actual repair changes the premise; read-only inspections do not.
        this.errors.clear();
      }
      this.transition(this.tools.size ? "tool" : "model", now);
    } else if (event.type === "auto_retry_start") {
      this.errorCount++;
      this.transition("retry", now);
    } else if (event.type === "auto_retry_end") {
      this.transition(this.tools.size ? "tool" : "model", now);
    }
  }
  check(now = Date.now(), pendingAsyncWork = false): string | undefined {
    if (this.reason) return this.reason;
    if (this.tools.size) {
      if ([...this.tools.values()].some(tool => tool.deadline !== undefined && now >= tool.deadline)) return "tool_deadline_exceeded";
      return; // Quiet builds have their native timeout and the unchanged total runtime cap.
    }
    if (pendingAsyncWork) return; // Native owner-job lifecycle owns these waits.
    if (!this.sawOutput && now - this.startedAt >= this.limits.startupMs) return "startup_no_output";
    if (this.sawOutput && now - this.lastProgressAt >= this.limits.silenceMs) return "no_progress";
  }
  summary(now = Date.now()) {
    const phaseMs = { ...this.phaseMs };
    phaseMs[this.phase] += Math.max(0, now - this.phaseAt);
    return { elapsedMs: now - this.startedAt, phase: this.phase, phaseMs, lastProgressAt: this.lastProgressAt,
      requests: this.requestCount, tools: this.toolCount, errors: this.errorCount, reason: this.reason };
  }
}

/** Owns only this invocation's signal; never aborts the root or guesses a PID. */
export async function guardedSubprocess<T extends object>(
  run: (options: RecordValue) => Promise<T>, options: RecordValue,
  limits = HEALTH_LIMITS,
): Promise<T & { taskHealth: object }> {
  const controller = new AbortController();
  const parentSignal = options.signal as AbortSignal | undefined;
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const health = new TaskHealth(limits);
  const onProgress = options.onProgress as ((progress: unknown) => void) | undefined;
  const bus = options.eventBus as { on(channel: string, handler: (value: unknown) => void): () => void } | undefined;
  const stopEvents = bus?.on("task:subagent:event", value => {
    const frame = record(value);
    if (typeof options.id === "string" && frame.id === options.id) health.event(frame.event);
  });
  let lastCounts = "";
  let activeTool = false;
  const timer = setInterval(() => {
    const supervised = typeof options.isSupervised === "function" && options.isSupervised();
    const reason = health.reason ?? (activeTool || supervised ? undefined : health.check());
    if (reason && !signal.aborted) {
      health.reason = reason;
      controller.abort(new Error(`OMP_TASK_HEALTH:${reason}; inspect retained task evidence before retrying`));
    }
  }, Math.max(10, Math.min(1000, limits.startupMs / 4)));
  timer.unref();
  try {
    const result = await run({ ...options, signal, onProgress: (value: unknown) => {
      const progress = record(value);
      const wasActive = activeTool;
      activeTool = typeof progress.currentTool === "string" && !!progress.currentTool;
      if (wasActive && !activeTool) health.lastProgressAt = Date.now();
      const counts = JSON.stringify([progress.tokens, progress.toolCount, progress.recentOutput]);
      if (counts !== lastCounts && (Number(progress.tokens) > 0 || Number(progress.toolCount) > 0 || (Array.isArray(progress.recentOutput) && progress.recentOutput.length))) {
        health.sawOutput = true;
        health.lastProgressAt = Date.now();
      }
      health.transition(activeTool ? "tool" : health.sawOutput ? "model" : "startup", Date.now());
      health.toolCount = Number(progress.toolCount ?? health.toolCount);
      health.requestCount = Number(progress.requests ?? health.requestCount);
      lastCounts = counts;
      onProgress?.(value);
    } });
    return { ...result, taskHealth: health.summary() };
  } finally { stopEvents?.(); clearInterval(timer); }
}
