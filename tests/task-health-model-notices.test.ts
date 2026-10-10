import { expect, test } from "bun:test";
import taskHealth from "../omp/agent/extensions/task-health.ts";

type Handler = (...args: any[]) => any;

test("registry-bound native and controlled children report pending, runtime model, and effort updates", () => {
  const sent: Array<{ message: { content: string; customType?: string; details?: Record<string, unknown> }; options: { triggerTurn?: boolean } }> = [];
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler>();
  let poll: (() => void) | undefined;
  const sessionId = "root-session";
  const childSession = (model?: { modelIdentity: string; thinkingLevel: string }) => ({
    servingModel: model,
    prompt: async () => undefined,
    subscribe: () => () => undefined,
    hasPendingAsyncWork: () => false,
  });
  const owner = { id: "main", kind: "main", session: { sessionManager: { getSessionId: () => sessionId }, subscribe: () => () => undefined } };
  const native = { id: "native-child", kind: "sub", parentId: "main", status: "running", session: childSession() };
  const controlled = { id: "controlled-child", kind: "sub", parentId: "main", status: "running", session: childSession() };
  const unrelated = { id: "unrelated-child", kind: "sub", parentId: "other-main", status: "running", session: childSession() };
  const refs = [owner, native, controlled, unrelated];
  const registry = { list: () => refs, get: (id: string) => refs.find(ref => ref.id === id) };
  const pi = {
    pi: { AgentRegistry: { global: () => registry } },
    events: { on: (name: string, handler: Handler) => { eventHandlers.set(name, handler); return () => eventHandlers.delete(name); } },
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    sendMessage: (message: { content: string; customType?: string; details?: Record<string, unknown> }, options: { triggerTurn?: boolean }) => sent.push({ message, options }),
    appendEntry: () => undefined,
    logger: { warn: () => undefined },
    getAllTools: () => [],
    registerTool: () => undefined,
    zod: { object: () => ({}), number: () => ({ int() { return this; }, min() { return this; }, max() { return this; }, default() { return this; } }) },
  } as any;
  const context = {
    sessionManager: { getEntries: () => [], getSessionId: () => sessionId, getBranch: () => [] },
    setInterval: (callback: () => void) => { poll = callback; return 1; },
    clearTimer: () => undefined,
    ui: { notify: () => undefined },
  } as any;

  taskHealth(pi);
  handlers.get("session_start")?.({}, context);
  const progress = eventHandlers.get("task:subagent:progress")!;
  progress({ id: native.id, agent: "deepseek-worker", task: "native task", parentToolCallId: "call-1", progress: { resolvedThinkingLevel: "high" } });
  progress({ id: controlled.id, agent: "research-worker", task: "controlled task", progress: {} });
  progress({ id: unrelated.id, agent: "other-worker", task: "ignore me", progress: {} });

  expect(sent.map(item => item.message.content)).toEqual([
    "子任务已启动：任务「native task」；代理 deepseek-worker；模型待确认；思考强度待确认。",
    "子任务已启动：任务「controlled task」；代理 research-worker；模型待确认；思考强度待确认。",
  ]);
  expect(sent.every(item => item.options.triggerTurn === false)).toBe(true);
  expect(sent.every(item => item.message.customType === "omp-task-model-dispatch-v1")).toBe(true);
  expect(sent.slice(0, 2).map(item => item.message.details)).toEqual([
    { source: "native", id: "native-child", taskId: "native-child", agent: "deepseek-worker", modelIdentity: undefined, thinkingLevel: "high" },
    { source: "controlled", id: "controlled-child", taskId: "controlled-child", agent: "research-worker", modelIdentity: undefined, thinkingLevel: undefined },
  ]);
  const filteredContext = handlers.get("context")!({ messages: [
    { role: "custom", customType: "omp-task-model-dispatch-v1" },
    { role: "custom", customType: "omp-task-health-v1" },
    { role: "user" },
  ] });
  expect(filteredContext.messages).toEqual([{ role: "custom", customType: "omp-task-health-v1" }, { role: "user" }]);

  native.session.servingModel = { modelIdentity: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "max" };
  controlled.session.servingModel = { modelIdentity: "openai/gpt-5.6", thinkingLevel: "medium" };
  poll?.();
  expect(sent.map(item => item.message.content).filter(content => content.includes("实际模型"))).toEqual([
    "子任务模型状态更新：任务「native task」；代理 deepseek-worker；实际模型 opencode-go/deepseek-v4.1-flash；思考强度 max。",
    "子任务模型状态更新：任务「controlled task」；代理 research-worker；实际模型 openai/gpt-5.6；思考强度 medium。",
  ]);
  expect(sent.slice(2, 4).map(item => item.message.details)).toEqual([
    { source: "native", id: "native-child", taskId: "native-child", agent: "deepseek-worker", modelIdentity: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "max" },
    { source: "controlled", id: "controlled-child", taskId: "controlled-child", agent: "research-worker", modelIdentity: "openai/gpt-5.6", thinkingLevel: "medium" },
  ]);

  native.session.servingModel.thinkingLevel = "xhigh";
  poll?.();
  expect(sent.at(-1)?.message.content).toBe("子任务模型状态更新：任务「native task」；代理 deepseek-worker；实际模型 opencode-go/deepseek-v4.1-flash；思考强度 xhigh。");
  expect(sent).toHaveLength(5);
});
