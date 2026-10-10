import { expect, test } from "bun:test";
import { modelDispatchNotice } from "../omp/agent/lib/task-dispatch.ts";

const observed = { id: "a1", task: "校验模型", agent: "deepseek-worker", modelRole: "deepseek-worker", resolvedModelIdentity: "opencode-go/deepseek-v4.1-flash", resolvedThinkingLevel: "high" };

test("registered child starts pending and dedupes unchanged runtime observations", () => {
  expect(modelDispatchNotice("native", { ...observed, resolvedModelIdentity: undefined })?.content).toBe("子任务已启动：任务「校验模型」；代理 deepseek-worker；模型待确认；思考强度待确认。");
  const first = modelDispatchNotice("native", observed);
  expect(first?.content).toBe("子任务已确认实际模型：任务「校验模型」；代理 deepseek-worker；实际模型 opencode-go/deepseek-v4.1-flash；思考强度 high。");
  expect(modelDispatchNotice("native", observed, first?.key)).toBeUndefined();
});

test("a thinking or model change is reported as an update", () => {
  const first = modelDispatchNotice("controlled", observed)!;
  const update = modelDispatchNotice("controlled", { ...observed, resolvedThinkingLevel: "max" }, first.key);
  expect(update?.content).toContain("子任务模型状态更新");
  expect(update?.content).toContain("思考强度 max");
});

test("controlled launches also start pending and a resolved fallback is labeled", () => {
  expect(modelDispatchNotice("controlled", { id: "unknown", agent: "worker", task: "任务" })?.content).toContain("模型待确认");
  expect(modelDispatchNotice("controlled", { ...observed, resolvedModelIsFallback: true })?.content).toContain("实际模型 opencode-go/deepseek-v4.1-flash（回退）");
});
