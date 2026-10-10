import * as path from "node:path";
import { AbortError } from "../src/scheduler.ts";
import { resolveLimits, swarmRequested, type Limits } from "../src/limits.ts";
import { parseTaskPayload, prepareStage, type NativeAssignment } from "../src/native-batch.ts";
import { SwarmSession } from "../src/session.ts";
import type { SubtaskRequest, SubtaskResult } from "../src/host.ts";
import type { WorkerUsage } from "../src/metrics.ts";

export type InvokeNative = (
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: ((update: unknown) => void) | undefined,
) => Promise<unknown>;

type RootCtx = {
	sessionManager: {
		getEntries: () => Array<{ type?: string }>;
		getSessionId: () => string;
	};
};

type OmpPi = {
	zod?: { object: (shape?: Record<string, unknown>) => unknown };
	on: (name: string, handler: (...args: any[]) => any) => void;
	registerTool: (tool: Record<string, unknown>) => void;
	registerCommand?: (name: string, options: Record<string, unknown>) => void;
	registerFlag?: (name: string, options: Record<string, unknown>) => void;
	getFlag?: (name: string) => boolean | string | undefined;
};

export interface OmpSwarmHooks {
	registerTaskHooks: (hook: { beforeInvoke?: (params: Record<string, unknown>) => unknown }) => void;
	isRoot: (ctx: RootCtx) => boolean;
}

export interface OmpPlan {
	kind: "off" | "block" | "run";
	result?: unknown;
	items?: NativeAssignment[];
	turn?: number;
}

/**
 * Thin OMP adapter. Policy stays in the core. This file only maps the native
 * `task` shadow onto that policy and registers `swarm_status`.
 */
export class OmpSwarm {
	private session: SwarmSession | undefined;
	private commandOverride: boolean | undefined;
	private flagOn = false;
	private invokeSlot: InvokeNative | undefined;
	private rootSessionId: string | undefined;

	constructor(private readonly options: { home?: string; limits?: Partial<Limits>; env?: NodeJS.ProcessEnv } = {}) {}

	enabled(): boolean {
		if (this.commandOverride !== undefined) return this.commandOverride;
		return this.flagOn || swarmRequested(this.options.env ?? process.env);
	}

	setEnabled(on: boolean): void {
		this.commandOverride = on;
		if (this.session) this.session.enabled = on;
		if (on) this.ensure();
	}

	noteAgentStart(): void {
		this.session?.noteAgentStart();
	}

	noteTurnStart(turnIndex: number): void {
		if (!this.enabled()) return;
		this.ensure().noteTurnStart(turnIndex);
	}

	promptSection(): string {
		if (!this.enabled()) return "";
		return this.ensure().promptSection("omp");
	}

	status(): Record<string, unknown> {
		if (!this.session) return { enabled: this.enabled(), assigned: 0, criticalSteps: 0 };
		return { ...this.session.status() };
	}

	plan(params: Record<string, unknown>): OmpPlan {
		if (!this.enabled()) return { kind: "off" };
		const session = this.ensure();
		const parsed = parseTaskPayload(params, "scout", index => `${session.runId}:${index}`);
		if ("error" in parsed) return { kind: "block", result: blocked(parsed.error) };
		const staged = prepareStage(session, parsed.items);
		if (!staged.ok) return { kind: "block", result: blocked(staged.reason) };
		return { kind: "run", items: parsed.items, turn: staged.turn };
	}

	async run(plan: OmpPlan, invoke: InvokeNative, signal?: AbortSignal): Promise<unknown> {
		if (!plan.items || plan.turn === undefined) throw new Error("swarm plan is not runnable");
		const session = this.ensure();
		this.invokeSlot = invoke;
		try {
			const payloads = await Promise.all(plan.items.map(item => session.assign({
				toolCallId: item.toolCallId,
				agent: item.agent,
				prompt: item.task,
				isolated: item.isolated,
				turn: plan.turn,
				...(signal ? { signal } : {}),
			})));
			const metrics = session.metrics();
			return {
				content: [{ type: "text", text: JSON.stringify({
					swarm: true,
					assigned: metrics.assigned,
					criticalSteps: metrics.criticalSteps,
					metrics,
					workers: payloads.map(payload => payload.text),
				}) }],
				details: { swarm: metrics },
			};
		} finally {
			this.invokeSlot = undefined;
		}
	}

	bind(pi: OmpPi, hooks: OmpSwarmHooks): void {
		if (typeof pi.registerFlag === "function") {
			pi.registerFlag("swarm", {
				type: "boolean",
				default: false,
				description: "Enable the swarm policy on the native task tool",
			});
		}
		const self = this;
		pi.registerTool({
			name: "swarm_status",
			label: "Swarm status",
			description: "Report swarm budget and critical-path metrics for this session.",
			approval: "read",
			strict: false,
			loadMode: "discoverable",
			parameters: pi.zod?.object({}) ?? {},
			async execute() {
				const details = self.status();
				return { content: [{ type: "text", text: JSON.stringify(details) }], details };
			},
		});
		hooks.registerTaskHooks({
			beforeInvoke: (params) => {
				const planned = self.plan(params);
				if (planned.kind === "off") return;
				if (planned.kind === "block") return { blockResult: planned.result };
				return { run: (invoke: InvokeNative, signal?: AbortSignal) => self.run(planned, invoke, signal) };
			},
		});
		pi.on("session_start", (_event: unknown, ctx: RootCtx) => {
			if (!hooks.isRoot(ctx)) return;
			self.rootSessionId = ctx.sessionManager.getSessionId();
			self.flagOn = typeof pi.getFlag === "function" && pi.getFlag("swarm") === true;
			if (self.session) self.session.enabled = self.enabled();
			if (self.enabled()) self.ensure();
		});
		pi.on("session_shutdown", (_event: unknown, ctx?: RootCtx) => {
			if (ctx && self.rootSessionId && ctx.sessionManager.getSessionId() !== self.rootSessionId) return;
			self.session?.shutdown();
			self.session = undefined;
		});
		pi.on("agent_start", (_event: unknown, ctx?: RootCtx) => {
			if (ctx && !hooks.isRoot(ctx)) return;
			self.noteAgentStart();
		});
		pi.on("turn_start", (event: { turnIndex?: number }, ctx?: RootCtx) => {
			if (ctx && !hooks.isRoot(ctx)) return;
			self.noteTurnStart(event?.turnIndex ?? 0);
		});
		pi.on("before_agent_start", (event: { systemPrompt?: string[] }, ctx?: RootCtx) => {
			if (ctx && !hooks.isRoot(ctx)) return;
			const section = self.promptSection();
			if (!section) return;
			return { systemPrompt: [...(event.systemPrompt ?? []), section] };
		});
		pi.registerCommand?.("swarm", {
			description: "Toggle swarm policy for this session",
			handler: () => { self.setEnabled(!self.enabled()); },
		});
	}

	private ensure(): SwarmSession {
		if (this.session) {
			this.session.enabled = this.enabled();
			return this.session;
		}
		const created = new SwarmSession({
			limits: resolveLimits({
				env: this.options.env ?? process.env,
				...(this.options.limits ? { override: this.options.limits } : {}),
			}),
			cwd: process.cwd(),
			home: this.options.home ?? swarmHome(),
			runSubtask: (request) => this.executeNative(request),
		});
		created.enabled = this.enabled();
		this.session = created;
		return created;
	}

	private async executeNative(request: SubtaskRequest): Promise<SubtaskResult> {
		const invoke = this.invokeSlot;
		if (!invoke) throw new Error("OMP swarm runner is unset");
		const params: Record<string, unknown> = { agent: request.agentName, task: request.task };
		if (request.isolated) params.isolated = true;
		const signal = request.timeoutMs > 0
			? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
			: request.signal;
		try {
			return nativeToResult(await invoke(params, signal, undefined));
		} catch (error) {
			if (request.signal.aborted || signal.aborted) throw new AbortError(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
}

let installed: OmpSwarm | undefined;

export function installOmpSwarm(pi: OmpPi, hooks: OmpSwarmHooks): OmpSwarm {
	if (installed) return installed;
	installed = new OmpSwarm();
	installed.bind(pi, hooks);
	return installed;
}

export function resetOmpSwarmForTests(): void {
	installed = undefined;
}

function swarmHome(): string {
	const explicit = process.env.OMP_SWARM_HOME ?? process.env.PARL_SWARM_HOME;
	if (explicit) {
		if (!path.isAbsolute(explicit)) throw new Error("OMP_SWARM_HOME_NOT_ABSOLUTE");
		return path.resolve(explicit);
	}
	const home = process.env.OMP_HOME;
	if (!home || !path.isAbsolute(home)) throw new Error("OMP_HOME_UNSET");
	return path.join(path.resolve(home), "agent", "swarm");
}

function blocked(reason: string) {
	return {
		content: [{ type: "text", text: JSON.stringify({ status: "failure", reason }) }],
		details: { blocked: true, reason },
		isError: true,
	};
}

function nativeToResult(raw: unknown): SubtaskResult {
	const result = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
	const results = Array.isArray(details.results) ? details.results : [];
	const child = results[0] && typeof results[0] === "object" ? results[0] as Record<string, unknown> : undefined;
	const output = typeof child?.output === "string" ? child.output : textOf(result);
	const aborted = child?.aborted === true || details.aborted === true;
	const exitCode = typeof child?.exitCode === "number" ? child.exitCode : 0;
	const failed = result.isError === true || exitCode !== 0;
	const steps = typeof child?.requests === "number" && child.requests > 0 ? child.requests : 1;
	const toolCalls = typeof child?.toolCount === "number" ? child.toolCount : 0;
	const usage = mapUsage(child?.usage);
	if (aborted) {
		const error = new AbortError(typeof child?.reason === "string" ? child.reason : "aborted");
		error.steps = steps;
		error.toolCalls = toolCalls;
		throw error;
	}
	return {
		status: failed ? "failure" : "success",
		answer: output,
		evidence: [],
		steps,
		toolCalls,
		...(typeof child?.resolvedModelIdentity === "string" ? { model: child.resolvedModelIdentity } : {}),
		...(usage ? { usage } : {}),
		...(failed ? { reason: output || "task failed" } : {}),
	};
}

function textOf(result: Record<string, unknown>): string {
	const content = Array.isArray(result.content) ? result.content : [];
	return content.map(block => {
		if (!block || typeof block !== "object") return "";
		const text = (block as { text?: unknown }).text;
		return typeof text === "string" ? text : "";
	}).join("");
}

function mapUsage(value: unknown): WorkerUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Record<string, unknown>;
	const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
	const num = (item: unknown) => typeof item === "number" && Number.isFinite(item) ? item : undefined;
	if (num(usage.input) === undefined && num(usage.output) === undefined && num(usage.totalTokens) === undefined) return undefined;
	return {
		input: num(usage.input) ?? 0,
		output: num(usage.output) ?? 0,
		cacheRead: num(usage.cacheRead) ?? 0,
		cacheWrite: num(usage.cacheWrite) ?? 0,
		totalTokens: num(usage.totalTokens) ?? 0,
		costTotal: num(cost.total) ?? num(usage.costTotal) ?? 0,
	};
}
