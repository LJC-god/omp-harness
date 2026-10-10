import * as path from "node:path";
import { BudgetGuard } from "./budget.ts";
import { TurnClock } from "./clock.ts";
import type { Limits } from "./limits.ts";
import { computeMetrics, type SwarmMetrics, type WorkerSnapshot, type WorkerUsage } from "./metrics.ts";
import { AbortError, Scheduler } from "./scheduler.ts";
import {
	OMP_ORCHESTRATOR_RULES,
	ORCHESTRATOR_RULES,
	SINGLE_WRITER_REASON,
	STEPS_DEFINITION,
	SWARM_OFF_REASON,
	UNKNOWN_AGENT_REASON,
	WRITE_ISOLATION_REASON,
} from "./schema.ts";
import type { SubtaskRequest, SubtaskResult } from "./host.ts";
import { TraceLog } from "./trace.ts";
import { fitJsonPayload } from "./truncate.ts";

export interface AgentDef {
	name: string;
	systemPrompt: string;
	tools?: readonly string[];
	model?: string;
	readOnly: boolean;
}

export interface SessionOptions {
	limits: Limits;
	cwd: string;
	home: string;
	runId?: string;
	now?: () => number;
	runSubtask: (request: SubtaskRequest) => Promise<SubtaskResult>;
}

export interface AssignRequest {
	toolCallId: string;
	agent: string;
	prompt: string;
	isolated?: boolean;
	signal?: AbortSignal;
	onProgress?: (steps: number) => void;
	model?: string;
	fallbackModel?: string;
	thinking?: string;
	/** Set when the stage already reserved this slot. */
	turn?: number;
}

export interface ToolPayload {
	text: string;
	truncated: boolean;
	details: Record<string, unknown>;
	usage?: WorkerUsage;
}

/**
 * One swarm run. Hosts supply `runSubtask`. Stage ids stay monotonic when the
 * host resets its own turn index on each agent loop.
 */
export class SwarmSession {
	readonly limits: Limits;
	readonly registry = new Map<string, AgentDef>();
	readonly budget: BudgetGuard;
	readonly scheduler: Scheduler;
	readonly trace: TraceLog;
	readonly runId: string;
	readonly runDir: string;
	enabled = false;
	private readonly clock = new TurnClock();
	private readonly workers = new Map<number, WorkerSnapshot[]>();
	private readonly reservations = new Map<string, number>();
	private readonly seenTasks = new Set<string>();
	private readonly shutdownController = new AbortController();
	private readonly startedAt: number;
	private readonly now: () => number;
	private readonly runSubtask: SessionOptions["runSubtask"];
	private readonly cwd: string;
	private closed = false;

	constructor(options: SessionOptions) {
		this.limits = options.limits;
		this.cwd = options.cwd;
		this.budget = new BudgetGuard(options.limits);
		this.scheduler = new Scheduler({
			concurrency: options.limits.concurrency,
			rampUp: options.limits.rampUp,
		});
		this.now = options.now ?? Date.now;
		this.startedAt = this.now();
		this.runId = options.runId ?? `${this.startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.runDir = path.join(options.home, "runs", this.runId);
		this.trace = new TraceLog(path.join(this.runDir, "trace.jsonl"));
		this.runSubtask = options.runSubtask;
		this.trace.write({ type: "run_start", runId: this.runId, cwd: this.cwd, limits: options.limits });
	}

	noteAgentStart(): void {
		this.clock.noteAgentStart();
	}

	noteTurnStart(turnIndex: number): void {
		this.clock.noteTurnStart(turnIndex);
		this.trace.write({ type: "turn_start", turn: this.clock.current, hostTurnIndex: turnIndex });
	}

	get turn(): number {
		return this.clock.current;
	}

	admit(toolCallId: string): { ok: true; turn: number } | { ok: false; reason: string } {
		if (!this.enabled) return { ok: false, reason: SWARM_OFF_REASON };
		if (this.closed) return { ok: false, reason: "Swarm session is shut down." };
		const decision = this.budget.tryReserve(this.clock.current);
		if (!decision.ok) {
			this.trace.write({ type: "assign_blocked", turn: this.clock.current, reason: decision.reason });
			return decision;
		}
		this.reservations.set(toolCallId, decision.turn);
		this.trace.write({ type: "assign_reserved", turn: decision.turn, toolCallId, assigned: this.budget.assigned });
		return decision;
	}

	admitBatch(count: number): { ok: true; turn: number } | { ok: false; reason: string } {
		if (!this.enabled) return { ok: false, reason: SWARM_OFF_REASON };
		if (this.closed) return { ok: false, reason: "Swarm session is shut down." };
		const decision = this.budget.reserveBatch(this.clock.current, count);
		if (!decision.ok) {
			this.trace.write({ type: "assign_blocked", turn: this.clock.current, reason: decision.reason, count });
			return decision;
		}
		this.trace.write({ type: "assign_reserved", turn: decision.turn, count, assigned: this.budget.assigned });
		return decision;
	}

	createAgent(def: AgentDef): void {
		this.registry.set(def.name, def);
		this.trace.write({ type: "agent_created", name: def.name, readOnly: def.readOnly, tools: def.tools ?? [] });
	}

	inspectStage(items: Array<{ isolated: boolean; readOnly: boolean }>): { ok: true } | { ok: false; reason: string } {
		const writers = items.filter(item => !item.readOnly);
		if (writers.length > 1) return { ok: false, reason: SINGLE_WRITER_REASON };
		if (writers.length === 1 && !writers[0]!.isolated) return { ok: false, reason: WRITE_ISOLATION_REASON };
		return { ok: true };
	}

	async assign(request: AssignRequest): Promise<ToolPayload> {
		let turn = request.turn ?? this.reservations.get(request.toolCallId);
		if (turn === undefined) {
			const decision = this.admit(request.toolCallId);
			if (!decision.ok) return this.failurePayload(decision.reason, 0, 0);
			turn = decision.turn;
		}
		const def = this.registry.get(request.agent);
		if (!def) {
			this.record(turn, { steps: 0, toolCalls: 0, status: "failure", empty: true, duplicate: false });
			return this.failurePayload(UNKNOWN_AGENT_REASON, 0, 0);
		}

		const taskKey = `${request.agent}\0${request.prompt.trim()}`;
		const duplicate = this.seenTasks.has(taskKey);
		this.seenTasks.add(taskKey);
		const signal = linkSignals(request.signal, this.shutdownController.signal);
		const model = request.model ?? def.model ?? request.fallbackModel;

		let release: (() => void) | undefined;
		try {
			release = await this.scheduler.acquire(signal);
			let last: SubtaskResult | undefined;
			let steps = 0;
			let toolCalls = 0;
			let attempts = 0;
			const usages: WorkerUsage[] = [];
			for (let attempt = 1; attempt <= 2; attempt += 1) {
				if (signal.aborted) throw new AbortError();
				attempts = attempt;
				try {
					last = await this.runSubtask({
						toolCallId: request.toolCallId,
						attempt,
						agentName: def.name,
						systemPrompt: def.systemPrompt,
						task: request.prompt,
						tools: def.tools ?? [],
						isolated: request.isolated === true,
						readOnly: def.readOnly,
						...(model ? { model } : {}),
						...(request.thinking ? { thinking: request.thinking } : {}),
						subSteps: this.limits.subSteps,
						timeoutMs: this.limits.workerTimeoutMs,
						signal,
						...(request.onProgress ? { onProgress: request.onProgress } : {}),
					});
				} catch (error) {
					if (error instanceof AbortError || signal.aborted) {
						const aborted = error instanceof AbortError ? error : new AbortError();
						this.record(turn, {
							steps: steps + aborted.steps,
							toolCalls: toolCalls + aborted.toolCalls,
							status: "aborted",
							empty: true,
							duplicate,
						});
						throw aborted;
					}
					last = {
						status: "failure",
						answer: error instanceof Error ? error.message : String(error),
						evidence: [],
						steps: 0,
						toolCalls: 0,
						reason: error instanceof Error ? error.message : String(error),
					};
				}
				if (last.status === "aborted") {
					this.record(turn, {
						steps: steps + last.steps,
						toolCalls: toolCalls + last.toolCalls,
						status: "aborted",
						empty: true,
						duplicate,
					});
					const aborted = new AbortError(last.reason);
					aborted.steps = last.steps;
					aborted.toolCalls = last.toolCalls;
					throw aborted;
				}
				steps += last.steps;
				toolCalls += last.toolCalls;
				if (last.usage) usages.push(last.usage);
				if (last.status === "success" || attempt === 2) break;
				this.trace.write({
					type: "retry",
					turn,
					agent: request.agent,
					toolCallId: request.toolCallId,
					reason: last.reason ?? "failure",
				});
			}
			if (!last) throw new Error("worker produced no result");
			const usage = combineUsage(usages);
			this.record(turn, {
				steps,
				toolCalls,
				status: last.status,
				empty: last.answer.trim().length === 0,
				duplicate,
				...(usage ? { usage } : {}),
			});
			return this.payload({ ...last, steps, toolCalls, ...(usage ? { usage } : {}) }, attempts);
		} finally {
			release?.();
		}
	}

	metrics(): SwarmMetrics & { maxInFlight: number; concurrencyCap: number; trace: string; runId: string; enabled: boolean } {
		const metrics = computeMetrics({
			orchSteps: this.clock.started,
			orchStepBudget: this.limits.orchSteps,
			stages: [...this.workers.entries()].map(([turn, workers]) => ({ turn, workers })),
			wallMs: Math.max(0, this.now() - this.startedAt),
		});
		return {
			...metrics,
			maxInFlight: this.scheduler.highWater,
			concurrencyCap: this.scheduler.cap,
			trace: this.trace.file,
			runId: this.runId,
			enabled: this.enabled,
		};
	}

	status(): ReturnType<SwarmSession["metrics"]> {
		const snapshot = this.metrics();
		this.trace.write({ type: "status", metrics: snapshot });
		return snapshot;
	}

	promptSection(surface: "pi" | "omp"): string {
		if (!this.enabled) return "";
		const metrics = this.metrics();
		const rules = surface === "omp" ? OMP_ORCHESTRATOR_RULES : ORCHESTRATOR_RULES;
		const left = Math.max(0, metrics.orchStepBudget - metrics.orchSteps);
		return [
			rules,
			"",
			`Steps count ${STEPS_DEFINITION} (one assistant LLM turn).`,
			`Budget: ${left} orchestrator steps left (${metrics.orchSteps} started of ${metrics.orchStepBudget}).`,
			`Critical steps so far: ${metrics.criticalSteps}. Finish rate: ${metrics.finishRate}. Parallelism: ${metrics.avgParallelism}.`,
		].join("\n");
	}

	shutdown(): void {
		if (this.closed) {
			this.shutdownController.abort();
			return;
		}
		this.closed = true;
		this.shutdownController.abort();
		this.trace.write({ type: "shutdown", metrics: this.metrics() });
	}

	private record(turn: number, snapshot: WorkerSnapshot): void {
		const list = this.workers.get(turn) ?? [];
		list.push(snapshot);
		this.workers.set(turn, list);
		this.trace.write({
			type: "worker_end",
			turn,
			status: snapshot.status,
			steps: snapshot.steps,
			toolCalls: snapshot.toolCalls,
			duplicate: snapshot.duplicate,
		});
	}

	private payload(result: SubtaskResult, attempts: number): ToolPayload {
		const fitted = fitJsonPayload(
			{
				status: result.status,
				answer: result.answer,
				evidence: result.evidence,
				...(result.artifact ? { artifact: result.artifact } : {}),
				steps: result.steps,
				attempts,
				...(result.reason ? { reason: result.reason } : {}),
			},
			this.limits.answerBytes,
		);
		return {
			text: fitted.text,
			truncated: fitted.truncated,
			details: {
				status: result.status,
				steps: result.steps,
				toolCalls: result.toolCalls,
				attempts,
				...(result.artifact ? { artifact: result.artifact } : {}),
				...(result.transcript ? { transcript: result.transcript } : {}),
				...(result.reason ? { reason: result.reason } : {}),
				...(result.model ? { model: result.model } : {}),
			},
			...(result.usage ? { usage: result.usage } : {}),
		};
	}

	private failurePayload(reason: string, steps: number, attempts: number): ToolPayload {
		const fitted = fitJsonPayload(
			{ status: "failure", answer: reason, evidence: [], steps, attempts, reason },
			this.limits.answerBytes,
		);
		return {
			text: fitted.text,
			truncated: fitted.truncated,
			details: { status: "failure", steps, attempts, reason },
		};
	}
}

function combineUsage(usages: WorkerUsage[]): WorkerUsage | undefined {
	if (usages.length === 0) return undefined;
	return usages.reduce(
		(total, usage) => ({
			input: total.input + usage.input,
			output: total.output + usage.output,
			cacheRead: total.cacheRead + usage.cacheRead,
			cacheWrite: total.cacheWrite + usage.cacheWrite,
			totalTokens: total.totalTokens + usage.totalTokens,
			costTotal: total.costTotal + usage.costTotal,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 },
	);
}

function linkSignals(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (primary?.aborted || secondary?.aborted) {
		controller.abort();
		return controller.signal;
	}
	primary?.addEventListener("abort", abort, { once: true });
	secondary?.addEventListener("abort", abort, { once: true });
	return controller.signal;
}
