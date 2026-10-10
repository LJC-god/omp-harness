import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ambientLabPaths } from "../lib/ambient-lab.ts";
import { afterReset, asRecord, CHECKPOINT, collectUsage, latest, REPORT, renderUsage, SOURCE, startWindow, WINDOW } from "../lib/task-usage.ts";

export default function taskUsage(pi: ExtensionAPI) {
  const root = (ctx: ExtensionContext) => !ctx.sessionManager.getEntries().some(e => e.type === "session_init");
  const ambientLab = ambientLabPaths();
  const sessionsRoot = ambientLab?.root ?? path.join(os.homedir(), ".omp", "agent", "sessions");
  const build = (ctx: ExtensionContext) => collectUsage({ branch: ctx.sessionManager.getBranch(),
    sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), sessionsRoot });
  const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]+$/.test(value);
  let sending = false;

  pi.on("tool_result", (event, ctx) => {
    if (!root(ctx)) return;
    const input = asRecord(event.input), details = asRecord(event.details);
    if (event.toolName === "omp_checkpoint" && input.action === "update" && !event.isError) {
      const branch = ctx.sessionManager.getBranch();
      if (input.reset === true || !latest(branch, WINDOW)) pi.appendEntry(WINDOW, startWindow(branch, Date.now()));
    }
    // Controlled workers retain transcripts even when their compact return omits usage.
    if (event.toolName === "omp_control" && input.action === "project_spawn" && validId(details.agentId)
      && validId(input.projectId) && (input.runId === undefined || validId(input.runId))) {
      const result = asRecord(details.result), execution = asRecord(details.execution);
      const sessionFile = [details.sessionFile, details.outputPath, result.sessionFile, result.outputPath, execution.sessionFile, execution.outputPath]
        .find((value): value is string => typeof value === "string" && path.isAbsolute(value));
      // In lab mode the controller's own result is authoritative; never synthesize a C: transcript path.
      if (sessionFile) pi.appendEntry(SOURCE, { sessionFile });
      else if (!ambientLab) pi.appendEntry(SOURCE, { sessionFile: path.join(sessionsRoot, "control", input.projectId, input.runId ?? "unbound", details.agentId) + ".jsonl" });
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!root(ctx) || event.willContinue || sending) return;
    const branch = afterReset(ctx.sessionManager.getBranch());
    const checkpoint = latest(branch, CHECKPOINT);
    if (checkpoint?.data?.status !== "complete") return;
    // A task boundary is an existing semantic checkpoint, not a guess from a PASS/tool exit.
    const window = latest(branch, WINDOW);
    const prior = latest(branch, REPORT)?.data;
    if (prior && prior.windowId === window?.id) return;
    const assistant = event.messages.findLast(m => m.role === "assistant");
    if (assistant?.role === "assistant" && ["error", "aborted"].includes(assistant.stopReason)) return;
    sending = true;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const report = await build(ctx);
      // Native agent_end extensions can run before the prompt's finally has unwound.
      // Wait on the existing session lifecycle so a display message cannot queue another model turn.
      const owner = pi.pi.AgentRegistry.global().list().find(ref => ref.kind === "main"
        && ref.session?.sessionManager.getSessionId() === sessionId);
      if (owner?.session) await owner.session.waitForIdle();
      if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.sessionManager.getSessionId() !== sessionId
        || latest(ctx.sessionManager.getBranch(), WINDOW)?.id !== window?.id
        || latest(ctx.sessionManager.getBranch(), CHECKPOINT)?.id !== checkpoint.id) return;
      const content = renderUsage(report);
      // This is a display-only footer: no new model request, gate, DB or billing integration.
      pi.appendEntry(REPORT, { ...report, windowId: window?.id });
      pi.sendMessage({ customType: REPORT, content, display: true, details: report }, { triggerTurn: false });
    } catch (error) {
      pi.logger.warn("Task usage summary unavailable", { error: String(error) });
      ctx.ui.notify("本次用量统计未能生成；任务交付状态不受影响。可稍后调用 omp_usage_report 查看。", "warning");
    } finally { sending = false; }
  });

  pi.registerTool({ name: "omp_usage_report", label: "Task usage", approval: "read", strict: true,
    description: "Read recorded per-model tokens and request durations for the current task/checkpoint on this session branch, including referenced child transcripts. No model calls, billing estimates or completion decisions. Completed major tasks receive an automatic footer; this tool is only for on-demand inspection.",
    parameters: pi.zod.object({}).strict(),
    async execute(_id, _input, _signal, _onUpdate, ctx) {
      if (!root(ctx)) throw new Error("SUBAGENT_FORBIDDEN: use the root task usage report");
      const report = await build(ctx);
      return { content: [{ type: "text", text: renderUsage(report) }], details: report };
    },
  });
  // Persist the report for the user without making the next request re-read a large table.
  pi.on("context", event => ({ messages: event.messages.filter(m => !(m.role === "custom" && m.customType === REPORT)) }));
}
