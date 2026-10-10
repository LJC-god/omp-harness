type RuntimeTask = {
  id: string;
  agent: string;
  task: string;
  modelRole?: string;
  resolvedModelIdentity?: string;
  resolvedThinkingLevel?: string;
  resolvedModelIsFallback?: boolean;
};

export type ModelDispatchNotice = { key: string; content: string };

const label = (value: string) => {
  const text = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return [...text].slice(0, 80).join("");
};

/** Presentation only: callers supply registry-bound runtime progress. */
export function modelDispatchNotice(
  source: "native" | "controlled",
  task: RuntimeTask,
  previous?: string,
): ModelDispatchNotice | undefined {
  const model = task.resolvedModelIdentity?.trim();
  const taskLabel = label(task.task), agent = label(task.agent);
  if (!taskLabel || !agent) return;
  const effort = task.resolvedThinkingLevel?.trim() || "待确认";
  const key = [source, task.id, task.task, task.agent, model ?? "pending", effort, task.resolvedModelIsFallback ? "fallback" : "primary"].join("\u0000");
  if (key === previous) return;
  if (!model) return { key, content: `子任务已启动：任务「${taskLabel}」；代理 ${agent}；模型待确认；思考强度待确认。` };
  const verb = previous ? "模型状态更新" : "已确认实际模型";
  return { key, content: `子任务${verb}：任务「${taskLabel}」；代理 ${agent}；实际模型 ${model}${task.resolvedModelIsFallback ? "（回退）" : ""}；思考强度 ${effort}。` };
}
