import type { AgentRef, AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { TaskHealth, guardedSubprocess } from "../lib/task-health.ts";
import { modelDispatchNotice } from "../lib/task-dispatch.ts";

const METRIC = "omp-task-health-v1";
const MODEL_DISPATCH = "omp-task-model-dispatch-v1";
const isRoot = (ctx: ExtensionContext) => !ctx.sessionManager.getEntries().some(entry => entry.type === "session_init");
const failureNotice = (kind: string) => `${kind === "tls_certificate" ? "主模型请求的证书校验失败" : "主模型请求失败"}，本轮已停止，尚未完成的工作不会自动继续。已完成的操作仍可能有效；继续前先核对原始错误、子任务结果和文件状态，保留已有成果，再执行尚未完成的步骤。`;

export default function taskHealth(pi: ExtensionAPI) {
  const registry = pi.pi.AgentRegistry.global(); // Use the CLI's registry, not a second SDK module singleton.
  let context: ExtensionContext | undefined;
  let owner: AgentRef | undefined;
  let stopEvents: (() => void) | undefined;
  let stopProgressEvents: (() => void) | undefined;
  let rootHealth: TaskHealth | undefined;
  let rootSession: AgentSession | undefined;
  let stopRootEvents: (() => void) | undefined;
  const seen = new WeakSet<object>();
  const dispatches = new Map<string, { source: "native" | "controlled"; id: string; agent: string; task: string; modelRole?: string; resolvedModelIdentity?: string; resolvedThinkingLevel?: string; resolvedModelIsFallback?: boolean }>();
  const notices = new Map<string, string>();
  let stopTimer: (() => void) | undefined;
  const watched = new Map<AgentRef, { health: TaskHealth; unsubscribe?: () => void; session?: AgentSession;
    originalPrompt?: AgentSession["prompt"]; guardedPrompt?: AgentSession["prompt"]; stopped?: string; reported?: boolean }>();
  const emit = (ref: AgentRef, status: string) => {
    const state = watched.get(ref);
    if (!state || !context) return;
    pi.appendEntry(METRIC, { agentId: ref.id, sessionId: context.sessionManager.getSessionId(), status,
      ...state.health.summary(), sessionFile: ref.sessionFile });
  };
  const release = (ref: AgentRef) => {
    const state = watched.get(ref);
    state?.unsubscribe?.();
    if (state?.session && state.originalPrompt && state.session.prompt === state.guardedPrompt) state.session.prompt = state.originalPrompt;
    watched.delete(ref);
    dispatches.delete(ref.id);
    notices.delete(`native\u0000${ref.id}`);
    notices.delete(`controlled\u0000${ref.id}`);
  };
  const notifyModel = (dispatch: { source: "native" | "controlled"; id: string; agent: string; task: string; modelRole?: string; resolvedModelIdentity?: string; resolvedThinkingLevel?: string; resolvedModelIsFallback?: boolean }) => {
    if (!context) return;
    const noticeKey = `${dispatch.source}\u0000${dispatch.id}`;
    const notice = modelDispatchNotice(dispatch.source, dispatch, notices.get(noticeKey));
    if (!notice) return;
    notices.set(noticeKey, notice.key);
    // Display-only: observations must never queue another model turn.
    pi.sendMessage({ customType: MODEL_DISPATCH, content: notice.content, display: true, details: {
      source: dispatch.source, id: dispatch.id, taskId: dispatch.id, agent: dispatch.agent,
      modelIdentity: dispatch.resolvedModelIdentity, thinkingLevel: dispatch.resolvedThinkingLevel,
    } }, { triggerTurn: false });
  };
  const observe = (ref: AgentRef) => {
    const dispatch = dispatches.get(ref.id);
    const serving = ref.session?.servingModel;
    if (!dispatch) return;
    if (!serving?.modelIdentity) { notifyModel(dispatch); return; }
    // servingModel is the current effective runtime binding; progress fills only absent effort metadata.
    notifyModel({ ...dispatch, resolvedModelIdentity: serving.modelIdentity,
      resolvedThinkingLevel: serving.thinkingLevel ?? dispatch.resolvedThinkingLevel,
      resolvedModelIsFallback: serving.isFallback });
  };
  const poll = () => {
    if (!context) return;
    owner = registry.list().find(ref => ref.kind === "main" && ref.session?.sessionManager.getSessionId() === context!.sessionManager.getSessionId());
    if (!owner) return;
    if (owner.session && rootSession !== owner.session) {
      stopRootEvents?.(); rootSession = owner.session;
      stopRootEvents = owner.session.subscribe(event => rootHealth?.event(event));
    }
    for (const ref of registry.list()) {
      if (ref.kind !== "sub" || ref.parentId !== owner.id || ref.status !== "running") continue;
      let state = watched.get(ref);
      if (!state) { state = { health: new TaskHealth() }; watched.set(ref, state); }
      if (ref.session && state.session !== ref.session) {
        state.unsubscribe?.();
        state.session = ref.session;
        const session = ref.session;
        state.originalPrompt = session.prompt;
        const original = session.prompt;
        const captured = state;
        state.guardedPrompt = function (...args) {
          if (captured.stopped) return Promise.reject(new Error(`OMP_TASK_HEALTH:${captured.stopped}; inspect retained evidence before retrying`));
          return original.apply(this, args);
        };
        session.prompt = state.guardedPrompt;
        state.unsubscribe = session.subscribe(event => { if (!seen.has(event)) { seen.add(event); captured.health.event(event); } });
      }
      observe(ref);
      if (state.stopped) continue;
      const reason = state.health.check(Date.now(), ref.session?.hasPendingAsyncWork?.() ?? false);
      if (!reason) continue;
      const manager = owner.session?.asyncJobManager;
      const job = manager?.getRunningJobs({ ownerId: owner.id }).find(item => item.agentId === ref.id);
      // An unbound blocking launch is handled by its invocation guard below.
      if (!ref.session && !job) continue;
      if (registry.get(ref.id) !== ref || ref.parentId !== owner.id || ref.status !== "running") continue;
      state.stopped = reason;
      state.health.reason = reason;
      emit(ref, "cancelling");
      if (job) manager!.cancel(job.id, { ownerId: owner.id });
      if (ref.session) void ref.session.abort({ reason: `OMP_TASK_HEALTH:${reason}`, goalReason: "internal" }).catch(error => {
        pi.logger.warn("Task health cancellation did not settle", { agentId: ref.id, error: String(error) });
      });
      pi.sendMessage({ customType: METRIC, content: `子任务 ${ref.id} 已请求取消，原因：${reason}。请先检查执行记录、保留的日志和文件改动，确认停止后再决定是否重试；无需关闭主会话，不要重复执行已有写入。`, display: true }, { deliverAs: "followUp", triggerTurn: true });
    }
    for (const [ref, state] of watched) {
      if (registry.get(ref.id) !== ref || ref.status !== "running") {
        if (!state.reported) { state.reported = true; emit(ref, state.stopped ? `cancel_requested_native_${ref.status}` : ref.status); }
        // Keep a stopped prompt guarded until native cleanup; idle can precede its reminder loop.
        if (!state.stopped || registry.get(ref.id) !== ref || !ref.session) release(ref);
      }
    }
  };
  const reset = () => { stopRootEvents?.(); stopRootEvents = undefined; rootSession = undefined; stopEvents?.(); stopEvents = undefined; stopProgressEvents?.(); stopProgressEvents = undefined; rootHealth = undefined; stopTimer?.(); stopTimer = undefined; for (const ref of watched.keys()) release(ref); dispatches.clear(); notices.clear(); context = undefined; owner = undefined; };
  const start = (_event: unknown, ctx: ExtensionContext) => {
    reset();
    if (!isRoot(ctx)) return;
    context = ctx;
    owner = registry.list().find(ref => ref.kind === "main" && ref.session?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId());
    stopEvents = pi.events.on("task:subagent:event", (payload: unknown) => {
      const frame = payload as { id: string; event: object };
      poll();
      const ref = registry.get(frame.id);
      const state = ref && watched.get(ref);
      if (state && !seen.has(frame.event)) { seen.add(frame.event); state.health.event(frame.event); }
    });
    stopProgressEvents = pi.events.on("task:subagent:progress", (payload: unknown) => {
      const frame = payload as { id?: unknown; agent?: unknown; task?: unknown; parentToolCallId?: unknown; progress?: Record<string, unknown> };
      const progress = frame.progress ?? {};
      const id = typeof frame.id === "string" ? frame.id : typeof progress.id === "string" ? progress.id : undefined;
      const agent = typeof frame.agent === "string" ? frame.agent : typeof progress.agent === "string" ? progress.agent : undefined;
      const task = typeof frame.task === "string" ? frame.task : typeof progress.task === "string" ? progress.task : undefined;
      if (!id || !agent || !task) return;
      const dispatch = { source: (typeof frame.parentToolCallId === "string" ? "native" : "controlled") as "native" | "controlled", id, agent, task,
        modelRole: typeof progress.modelRole === "string" ? progress.modelRole : undefined,
        resolvedModelIdentity: typeof progress.resolvedModelIdentity === "string" ? progress.resolvedModelIdentity : undefined,
        resolvedThinkingLevel: typeof progress.resolvedThinkingLevel === "string" ? progress.resolvedThinkingLevel : undefined,
        resolvedModelIsFallback: progress.resolvedModelIsFallback === true };
      dispatches.set(id, dispatch);
      const ref = registry.get(id);
      if (ref && ref.kind === "sub" && ref.parentId === owner?.id) observe(ref);
    });
    poll();
    const timer = ctx.setInterval(poll, 500);
    stopTimer = () => ctx.clearTimer(timer);
    const native = pi.getAllTools().find(tool => tool.name === "task" && tool.sourceInfo.source === "builtin");
    if (!native) return;
    pi.registerTool({ name: "task", label: "Task", description: native.description, parameters: native.parameters, loadMode: "essential",
      // Native adapters proxy these fields although ToolDefinition does not declare them yet.
      ...{ lenientArgValidation: true, promptGuidelines: native.promptGuidelines }, strict: false,
      async execute(_id, params, signal, onUpdate, toolCtx) {
        if (!toolCtx.invokeTool) throw new Error("Native task invocation is unavailable");
        const childIds = new Set<string>();
        const result = await guardedSubprocess(async options => toolCtx.invokeTool!(params as Record<string, unknown>, {
          signal: options.signal as AbortSignal,
          onUpdate: update => {
            const details = update.details as { progress?: Array<Record<string, unknown>> } | undefined;
            const progress = details?.progress ?? [];
            for (const item of progress) if (typeof item.id === "string") childIds.add(item.id);
            // A healthy sibling or active tool prevents cancelling a whole batch.
            (options.onProgress as (value: unknown) => void)({
              currentTool: progress.some(item => item.currentTool) ? "active-child-tool" : undefined,
              tokens: progress.reduce((n, item) => n + Number(item.tokens ?? 0), 0),
              toolCount: progress.reduce((n, item) => n + Number(item.toolCount ?? 0), 0),
              recentOutput: progress.flatMap(item => Array.isArray(item.recentOutput) ? item.recentOutput : []),
            });
            onUpdate?.(update);
          },
        }), { signal, isSupervised: () => {
          poll();
          // Binding a session is not successful startup; initialization can still hang.
          return [...childIds].some(id => { const ref = registry.get(id); const state = ref && watched.get(ref); return !!state?.session && state.health.sawOutput; });
        } });
        return result;
      },
    });
  };
  pi.on("session_start", start);
  pi.on("session_shutdown", reset);
  pi.on("session_switch", start);
  // Keep user-visible dispatch receipts out of later model requests; health records remain available to their tool.
  pi.on("context", event => ({ messages: event.messages.filter(message => !(message.role === "custom" && message.customType === MODEL_DISPATCH)) }));
  pi.on("agent_start", (_event, ctx) => { if (isRoot(ctx)) rootHealth = new TaskHealth(); });
  pi.on("tool_call", (event) => { if (!rootSession) rootHealth?.event({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.input }); });
  pi.on("tool_result", (event) => { if (!rootSession) rootHealth?.event({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: { content: event.content } }); });
  pi.on("agent_end", (event, ctx) => {
    poll();
    if (isRoot(ctx)) {
      const last = event.messages?.findLast(message => message.role === "assistant");
      const failed = !event.willContinue && last?.role === "assistant" && last.stopReason === "error";
      const providerFailure = failed
        ? /certificate|CERT_|unable to verify|self.signed/i.test(last.errorMessage ?? "") ? "tls_certificate" : "provider_error"
        : undefined;
      if (rootHealth || failed) pi.appendEntry(METRIC, { agentId: "Main",
        status: event.willContinue ? "turn_continuing" : failed ? "turn_failed" : "turn_finished",
        ...rootHealth?.summary(), ...(providerFailure ? { providerFailure } : {}) });
      if (providerFailure) ctx.ui.notify(failureNotice(providerFailure), "error");
    }
    rootHealth = undefined;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!isRoot(ctx)) return;
    const last = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom"
      && entry.customType === METRIC && (entry.data as { agentId?: string })?.agentId === "Main");
    if (last?.type !== "custom") return;
    const data = last.data as { status?: string; providerFailure?: string };
    if (data.status !== "turn_failed" || !data.providerFailure) return;
    return { message: { customType: METRIC, display: true,
      content: `上轮中断记录（仅供核对，不是新授权）：${failureNotice(data.providerFailure)} 向用户准确说明中断原因，不要把已停止的主轮描述为仍在执行。` } };
  });
  pi.registerTool({ name: "omp_task_metrics", label: "Task timing", approval: "read", strict: true, description: "Read bounded task health and phase timings from this session branch. No logs, prompts or credentials. Measurements are observations, not acceptance evidence.",
    parameters: pi.zod.object({ limit: pi.zod.number().int().min(1).max(30).default(10) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rows = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === METRIC).slice(-params.limit);
      return { content: [{ type: "text", text: JSON.stringify(rows.map(entry => entry.type === "custom" ? entry.data : null)) }] };
    },
  });
}
