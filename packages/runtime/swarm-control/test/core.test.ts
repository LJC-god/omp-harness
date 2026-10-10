import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachSwarm, type SwarmHost, type SwarmToolCall, type SwarmToolResult, type SwarmToolSpec } from "../src/attach.ts";
import { BudgetGuard } from "../src/budget.ts";
import { TurnClock } from "../src/clock.ts";
import { computeMetrics, type WorkerSnapshot } from "../src/metrics.ts";
import { AbortError } from "../src/scheduler.ts";
import { ORCH_BUDGET_REASON, SINGLE_WRITER_REASON, STAGE_CAP_REASON, SWARM_OFF_REASON, TOTAL_CAP_REASON, WRITE_ISOLATION_REASON } from "../src/schema.ts";
import { SwarmSession } from "../src/session.ts";
import { fitJsonPayload } from "../src/truncate.ts";
import { OmpSwarm } from "../adapters/omp.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";

const root = mkdtempSync(path.join(tmpdir(), "omp-swarm-"));
const home = path.join(root, "swarm");

function worker(partial: Partial<WorkerSnapshot> & Pick<WorkerSnapshot, "steps" | "status">): WorkerSnapshot {
	return { toolCalls: 0, empty: false, duplicate: false, ...partial };
}

function reasonOf(plan: { result?: unknown }): string {
	const result = plan.result as { details?: { reason?: string } };
	return result.details?.reason ?? "";
}

const limits = { orchSteps: 15, perStage: 16, totalAgents: 64, concurrency: 8, answerBytes: 6144, rampUp: null, workerTimeoutMs: 0, subSteps: 50 };

const guard = new BudgetGuard({ orchSteps: 2, perStage: 16, totalAgents: 64 });
assert.equal(guard.tryReserve(0).ok, true);
assert.equal(guard.tryReserve(1).ok, true);
const orchBlocked = guard.tryReserve(2);
assert.equal(orchBlocked.ok, false);
if (!orchBlocked.ok) assert.equal(orchBlocked.reason, ORCH_BUDGET_REASON);
assert.equal(guard.assigned, 2);

const stageGuard = new BudgetGuard({ orchSteps: 15, perStage: 2, totalAgents: 64 });
assert.equal(stageGuard.reserveBatch(0, 3).ok, false);
assert.equal(stageGuard.assigned, 0);
assert.equal(stageGuard.reserveBatch(0, 2).ok, true);
assert.equal(stageGuard.assigned, 2);

const totalGuard = new BudgetGuard({ orchSteps: 15, perStage: 16, totalAgents: 2 });
assert.equal(totalGuard.tryReserve(0).ok, true);
assert.equal(totalGuard.tryReserve(1).ok, true);
const totalBlocked = totalGuard.tryReserve(2);
assert.equal(totalBlocked.ok, false);
if (!totalBlocked.ok) assert.equal(totalBlocked.reason, TOTAL_CAP_REASON);

const clock = new TurnClock();
clock.noteAgentStart();
clock.noteTurnStart(0);
clock.noteTurnStart(1);
clock.noteAgentStart();
clock.noteTurnStart(0);
assert.equal(clock.current, 2);
assert.equal(clock.started, 3);

const parallel = computeMetrics({
	orchSteps: 1,
	orchStepBudget: 15,
	wallMs: 10,
	stages: [{ turn: 0, workers: [worker({ steps: 2, status: "success" }), worker({ steps: 5, status: "success" }), worker({ steps: 1, status: "success" })] }],
});
assert.equal(parallel.criticalSteps, 6);
assert.equal(parallel.totalSteps, 9);
assert.equal(parallel.speedupProxy, 9 / 6);
assert.equal(parallel.avgParallelism, 3);
assert.equal(parallel.serialCollapseRate, 0);
assert.equal(parallel.finishRate, 1);
assert.equal(parallel.stepsDefinition, "assistant_llm_turns");

const multi = computeMetrics({
	orchSteps: 4,
	orchStepBudget: 15,
	wallMs: 20,
	stages: [
		{ turn: 1, workers: [worker({ steps: 4, status: "success" })] },
		{ turn: 2, workers: [worker({ steps: 1, status: "success" }), worker({ steps: 1, status: "failure" })] },
	],
});
assert.equal(multi.criticalSteps, 1 + 4 + (1 + 1) + 2);
assert.equal(multi.totalSteps, 1 + 4 + (1 + 1 + 1) + 2);
assert.equal(multi.serialCollapseRate, 0.5);
assert.equal(multi.spuriousRate, 1 / 3);

const partial = computeMetrics({
	orchSteps: 1,
	orchStepBudget: 15,
	wallMs: 1,
	stages: [{
		turn: 0,
		workers: [
			worker({ steps: 1, status: "success", usage: { input: 10, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 15, costTotal: 0.2 } }),
			worker({ steps: 1, status: "success" }),
		],
	}],
});
assert.equal(partial.usage.coverage, "partial");
assert.equal(partial.usage.input, 10);
assert.equal(partial.usage.workersReported, 1);
assert.equal("output" in partial.usage ? partial.usage.output : undefined, 4);

const aborted = computeMetrics({
	orchSteps: 1,
	orchStepBudget: 15,
	wallMs: 1,
	stages: [{ turn: 0, workers: [worker({ steps: 1, status: "aborted", empty: true }), worker({ steps: 1, status: "success", duplicate: true })] }],
});
assert.equal(aborted.spuriousRate, 0.5);
assert.equal(aborted.finishRate, 0.5);

const empty = computeMetrics({ orchSteps: 0, orchStepBudget: 15, wallMs: 0, stages: [] });
assert.equal(empty.criticalSteps, 0);
assert.equal(empty.speedupProxy, 0);
assert.equal(empty.usage.coverage, "unreported");

const fitted = fitJsonPayload({ status: "success", answer: "字".repeat(8000), evidence: ["a"] }, DEFAULT_LIMITS.answerBytes);
assert.equal(fitted.truncated, true);
assert.ok(Buffer.byteLength(fitted.text) <= DEFAULT_LIMITS.answerBytes);

let attempts = 0;
const retrySession = new SwarmSession({
	limits,
	cwd: root,
	home,
	runSubtask: async () => {
		attempts += 1;
		if (attempts === 1) return { status: "failure", answer: "no", evidence: [], steps: 1, toolCalls: 0, reason: "no" };
		return { status: "success", answer: "yes", evidence: ["README.md:1"], steps: 2, toolCalls: 1 };
	},
});
retrySession.enabled = true;
retrySession.createAgent({ name: "scout", systemPrompt: "", readOnly: true, tools: ["read"] });
const retried = await retrySession.assign({ toolCallId: "retry", agent: "scout", prompt: "look" });
assert.equal(attempts, 2);
assert.equal(retried.details.attempts, 2);
assert.match(retried.text, /yes/);
assert.equal(retrySession.metrics().criticalSteps, 1 + 3);

let abortCalls = 0;
const abortSession = new SwarmSession({
	limits,
	cwd: root,
	home: path.join(root, "abort"),
	runSubtask: async () => {
		abortCalls += 1;
		throw new AbortError();
	},
});
abortSession.enabled = true;
abortSession.createAgent({ name: "scout", systemPrompt: "", readOnly: true });
await assert.rejects(() => abortSession.assign({ toolCallId: "abort", agent: "scout", prompt: "stop" }), AbortError);
assert.equal(abortCalls, 1);

function swarm(extra: { env?: NodeJS.ProcessEnv; limits?: Partial<typeof limits>; dir?: string } = {}) {
	return new OmpSwarm({
		home: extra.dir ?? path.join(root, "omp"),
		env: extra.env ?? { OMP_SWARM: "1" },
		limits: extra.limits,
	});
}

const off = swarm({ env: {}, dir: path.join(root, "off") });
assert.equal(off.plan({ tasks: [{ agent: "scout", task: "a" }] }).kind, "off");
assert.equal(off.status().assigned, 0);

const writers = swarm({ dir: path.join(root, "writers") });
const twoWriters = writers.plan({
	tasks: [
		{ agent: "task", task: "edit a", isolated: true },
		{ agent: "sonic", task: "edit b", isolated: true },
	],
});
assert.equal(twoWriters.kind, "block");
assert.equal(reasonOf(twoWriters), SINGLE_WRITER_REASON);
assert.equal(writers.status().assigned, 0);

const bareWriter = writers.plan({ tasks: [{ agent: "task", task: "edit c" }] });
assert.equal(bareWriter.kind, "block");
assert.equal(reasonOf(bareWriter), WRITE_ISOLATION_REASON);

const mixed = writers.plan({
	context: "Read only fan-out",
	tasks: [
		{ agent: "task", task: "edit d", isolated: true },
		{ task: "read 1" },
		{ agent: "security-reviewer", task: "read 2" },
		{ agent: "scout", task: "read 3" },
	],
});
assert.equal(mixed.kind, "run");
assert.equal(mixed.items?.length, 4);
assert.equal(mixed.items?.[0]?.isolated, true);
assert.match(mixed.items?.[1]?.task ?? "", /Read only fan-out/);
assert.equal(mixed.items?.[1]?.agent, "scout");

const capped = swarm({ dir: path.join(root, "cap"), limits: { perStage: 2, orchSteps: 2, totalAgents: 3 } });
capped.noteTurnStart(0);
const tooMany = capped.plan({ tasks: [{ task: "a" }, { task: "b" }, { task: "c" }] });
assert.equal(tooMany.kind, "block");
assert.equal(reasonOf(tooMany), STAGE_CAP_REASON);
const fits = capped.plan({ tasks: [{ task: "d" }, { task: "e" }] });
assert.equal(fits.kind, "run");
capped.noteTurnStart(1);
const rest = capped.plan({ tasks: [{ task: "f" }, { task: "g" }] });
assert.equal(rest.kind, "block");
assert.equal(reasonOf(rest), TOTAL_CAP_REASON);
capped.noteTurnStart(2);
const later = capped.plan({ tasks: [{ task: "h" }] });
assert.equal(later.kind, "block");
assert.equal(reasonOf(later), ORCH_BUDGET_REASON);

const fan = swarm({ dir: path.join(root, "fan") });
const planned = fan.plan({
	tasks: [1, 2, 3, 4].map(n => ({ agent: "scout", task: `SWARM_SCOUT ${n}` })),
});
assert.equal(planned.kind, "run");
const nativeCalls: Record<string, unknown>[] = [];
let nativeAttempts = 0;
const ran = await fan.run(planned, async (params) => {
	nativeAttempts += 1;
	nativeCalls.push(params);
	assert.equal("tools" in params, false);
	assert.equal("tasks" in params, false);
	assert.equal("context" in params, false);
	return {
		content: [{ type: "text", text: "scout-json" }],
		details: { results: [{ output: "scout-json", exitCode: 0, requests: 2, toolCount: 1 }] },
	};
});
assert.equal(nativeAttempts, 4);
assert.equal(nativeCalls.length, 4);
const body = JSON.parse((ran as { content: Array<{ text: string }> }).content[0]!.text);
assert.ok(body.assigned >= 4);
assert.equal(body.criticalSteps, 3);
assert.equal(body.metrics.avgParallelism, 4);
const reported = fan.status();
assert.equal(reported.assigned, 4);
assert.equal(reported.criticalSteps, 3);

const flaky = swarm({ dir: path.join(root, "flaky") });
const one = flaky.plan({ tasks: [{ agent: "scout", task: "once" }] });
let flakyCalls = 0;
await flaky.run(one, async () => {
	flakyCalls += 1;
	if (flakyCalls === 1) return { isError: true, content: [{ type: "text", text: "no" }], details: { results: [{ output: "no", exitCode: 1, requests: 1 }] } };
	return { content: [{ type: "text", text: "yes" }], details: { results: [{ output: "yes", exitCode: 0, requests: 1 }] } };
});
assert.equal(flakyCalls, 2);

const stopped = swarm({ dir: path.join(root, "stopped") });
const stopPlan = stopped.plan({ tasks: [{ agent: "scout", task: "halt" }] });
let stopCalls = 0;
await assert.rejects(() => stopped.run(stopPlan, async () => {
	stopCalls += 1;
	return { details: { results: [{ aborted: true, output: "", requests: 1 }] } };
}), AbortError);
assert.equal(stopCalls, 1);

function fakeHost(run: SwarmHost["runSubtask"]) {
	const tools: Array<{ spec: SwarmToolSpec; execute: (call: SwarmToolCall) => Promise<SwarmToolResult> }> = [];
	const hooks: SwarmHost["hookToolCall"][] = [];
	let prompt = "";
	const host: SwarmHost = {
		registerTool(spec, execute) { tools.push({ spec, execute }); },
		hookToolCall(handler) { hooks.push(handler); },
		runSubtask: run,
		reportUsage() {},
		injectSystemPrompt(section) { prompt = section; },
		registerCommand() {},
	};
	return { host, tools, hooks, prompt: () => prompt };
}

const pi = fakeHost(async () => ({ status: "success", answer: "found", evidence: ["file:1"], steps: 1, toolCalls: 0 }));
const piHandle = attachSwarm(pi.host, { surface: "pi", home: path.join(root, "pi"), env: {} });
assert.deepEqual(pi.tools.map(tool => tool.spec.name), ["create_subagent", "assign_task", "swarm_status"]);
assert.equal(pi.tools.some(tool => tool.spec.name === "task" as SwarmToolSpec["name"]), false);
assert.equal(piHandle.enabled, false);
const assign = pi.tools.find(tool => tool.spec.name === "assign_task")!;
const blockedOff = await assign.execute({ toolCallId: "off", name: "assign_task", params: { agent: "reader", prompt: "look" } });
assert.match(blockedOff.text, /Agent swarm is off/);
assert.match(blockedOff.text, new RegExp(SWARM_OFF_REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
piHandle.setEnabled(true);
assert.match(pi.prompt(), /create_subagent/);
const create = pi.tools.find(tool => tool.spec.name === "create_subagent")!;
await create.execute({ toolCallId: "make", name: "create_subagent", params: { name: "reader", system_prompt: "read", tools: ["bash", "read"] } });
const done = await assign.execute({ toolCallId: "go", name: "assign_task", params: { agent: "reader", prompt: "look" } });
assert.match(done.text, /found/);
assert.doesNotMatch(done.text, /bash/);
const created = piHandle.session().registry.get("reader");
assert.deepEqual(created?.tools, ["read"]);
assert.equal(created?.readOnly, true);

const piCap = fakeHost(async () => ({ status: "success", answer: "x", evidence: [], steps: 1, toolCalls: 0 }));
const capHandle = attachSwarm(piCap.host, { surface: "pi", home: path.join(root, "pi-cap"), env: { OMP_SWARM: "1" }, limits: { perStage: 1 } });
assert.equal(capHandle.enabled, true);
capHandle.noteAgentStart();
capHandle.noteTurnStart(0);
const firstHook = await piCap.hooks[0]!({ toolCallId: "a", name: "assign_task", params: {} });
assert.equal(firstHook, undefined);
const secondHook = await piCap.hooks[0]!({ toolCallId: "b", name: "assign_task", params: {} });
assert.equal(secondHook && "block" in secondHook ? secondHook.block : "", STAGE_CAP_REASON);

rmSync(root, { recursive: true, force: true });
process.stdout.write("PASS omp-swarm\n");
