import { STEPS_DEFINITION } from "./schema.ts";

export type WorkerStatus = "success" | "failure" | "aborted";

export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

export interface WorkerSnapshot {
	steps: number;
	toolCalls: number;
	status: WorkerStatus;
	empty: boolean;
	duplicate: boolean;
	usage?: WorkerUsage;
}

export interface StageSnapshot {
	turn: number;
	workers: WorkerSnapshot[];
}

export interface UsageRollup {
	coverage: "unreported" | "partial" | "full";
	workersReported: number;
	workersAssigned: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costTotal?: number;
}

export interface SwarmMetrics {
	stepsDefinition: typeof STEPS_DEFINITION;
	orchSteps: number;
	orchStepBudget: number;
	criticalSteps: number;
	totalSteps: number;
	speedupProxy: number;
	avgParallelism: number;
	serialCollapseRate: number;
	finishRate: number;
	spuriousRate: number;
	assigned: number;
	succeeded: number;
	failed: number;
	aborted: number;
	totalToolCalls: number;
	wallMs: number;
	usage: UsageRollup;
}

export interface MetricsInput {
	orchSteps: number;
	orchStepBudget: number;
	stages: StageSnapshot[];
	wallMs: number;
}

/**
 * Critical steps follow the stage sum with S_main = 1:
 *   Σ_t (1 + max_i S_sub,i^(t))
 * for stages that launched at least one sub-agent, plus 1 for every other
 * orchestrator turn. S_sub counts assistant LLM turns, not tool calls.
 */
export function computeMetrics(input: MetricsInput): SwarmMetrics {
	const assignStages = input.stages.filter(stage => stage.workers.length > 0);
	const workers = assignStages.flatMap(stage => stage.workers);
	const assigned = workers.length;
	const succeeded = workers.filter(worker => worker.status === "success").length;
	const failed = workers.filter(worker => worker.status === "failure").length;
	const aborted = workers.filter(worker => worker.status === "aborted").length;
	const spurious = workers.filter(isSpurious).length;

	let criticalFromStages = 0;
	let totalFromStages = 0;
	for (const stage of assignStages) {
		const steps = stage.workers.map(worker => worker.steps);
		const slowest = steps.reduce((max, value) => Math.max(max, value), 0);
		const sum = steps.reduce((total, value) => total + value, 0);
		criticalFromStages += 1 + slowest;
		totalFromStages += 1 + sum;
	}
	const nonAssignTurns = Math.max(0, input.orchSteps - assignStages.length);
	const criticalSteps = criticalFromStages + nonAssignTurns;
	const totalSteps = totalFromStages + nonAssignTurns;

	return {
		stepsDefinition: STEPS_DEFINITION,
		orchSteps: input.orchSteps,
		orchStepBudget: input.orchStepBudget,
		criticalSteps,
		totalSteps,
		speedupProxy: criticalSteps > 0 ? totalSteps / criticalSteps : 0,
		avgParallelism: assignStages.length > 0 ? assigned / assignStages.length : 0,
		serialCollapseRate: assignStages.length > 0
			? assignStages.filter(stage => stage.workers.length === 1).length / assignStages.length
			: 0,
		finishRate: assigned > 0 ? succeeded / assigned : 0,
		spuriousRate: assigned > 0 ? spurious / assigned : 0,
		assigned,
		succeeded,
		failed,
		aborted,
		totalToolCalls: workers.reduce((sum, worker) => sum + worker.toolCalls, 0),
		wallMs: input.wallMs,
		usage: rollupUsage(workers),
	};
}

function isSpurious(worker: WorkerSnapshot): boolean {
	if (worker.status === "aborted") return false;
	return worker.status === "failure" || worker.empty || worker.duplicate;
}

function rollupUsage(workers: WorkerSnapshot[]): UsageRollup {
	const reported = workers.filter(worker => worker.usage !== undefined);
	const coverage = workers.length === 0 || reported.length === 0
		? "unreported"
		: reported.length === workers.length
			? "full"
			: "partial";
	const rollup: UsageRollup = {
		coverage,
		workersReported: reported.length,
		workersAssigned: workers.length,
	};
	if (reported.length === 0) return rollup;
	const sum = (pick: (usage: WorkerUsage) => number) =>
		reported.reduce((total, worker) => total + pick(worker.usage as WorkerUsage), 0);
	rollup.input = sum(usage => usage.input);
	rollup.output = sum(usage => usage.output);
	rollup.cacheRead = sum(usage => usage.cacheRead);
	rollup.cacheWrite = sum(usage => usage.cacheWrite);
	rollup.totalTokens = sum(usage => usage.totalTokens);
	rollup.costTotal = sum(usage => usage.costTotal);
	return rollup;
}
