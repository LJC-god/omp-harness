import type { SwarmHost, SwarmToolCall, SwarmToolResult, SwarmToolSpec } from "./host.ts";
import { resolveLimits, swarmRequested, type Limits } from "./limits.ts";
import { computeMetrics } from "./metrics.ts";
import {
	ASSIGN_TASK_DESCRIPTION,
	CREATE_SUBAGENT_DESCRIPTION,
	READ_ONLY_TOOLS,
	SWARM_OFF_REASON,
	SWARM_TOOL_NAMES,
} from "./schema.ts";
import { SwarmSession, type AgentDef } from "./session.ts";

export interface AttachOptions {
	surface: "pi" | "omp";
	limits?: Partial<Limits>;
	home: string;
	cwd?: string;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
}

export interface SwarmHandle {
	readonly surface: "pi" | "omp";
	session(): SwarmSession;
	get enabled(): boolean;
	setEnabled(on: boolean): void;
	noteAgentStart(): void;
	noteTurnStart(turnIndex: number): void;
	refreshPrompt(): void;
	status(): ReturnType<SwarmSession["status"]> | ReturnType<SwarmSession["metrics"]>;
}

const PI_TOOLS: SwarmToolSpec[] = [
	{
		name: "create_subagent",
		description: CREATE_SUBAGENT_DESCRIPTION,
		promptSnippet: "Define a reusable read-only sub-agent",
		promptGuidelines: [
			"create_subagent only stores a configuration. It does not run the agent.",
			"Do not call create_subagent in the same message as assign_task.",
		],
		executionMode: "sequential",
		defaultActive: false,
	},
	{
		name: "assign_task",
		description: ASSIGN_TASK_DESCRIPTION,
		promptSnippet: "Launch a fresh sub-agent for one self-contained task",
		promptGuidelines: [
			"Issue all independent assign_task calls in ONE message so they run concurrently.",
			"Only parallelize when it shortens the longest branch.",
			"Do not put create_subagent in that same message.",
		],
		executionMode: "parallel",
		defaultActive: false,
	},
];

const STATUS_TOOL: SwarmToolSpec = {
	name: "swarm_status",
	description: "Report swarm budget and critical-path metrics.",
	promptSnippet: "Read swarm budget, critical steps, and finish rate",
	promptGuidelines: ["Read counters only. This does not launch a worker."],
	executionMode: "sequential",
	defaultActive: false,
};

/**
 * Wire policy to a host. `surface: "pi"` registers create_subagent, assign_task,
 * and swarm_status. `surface: "omp"` registers only swarm_status; the OMP adapter
 * maps the native task tool onto the same session.
 */
export function attachSwarm(host: SwarmHost, options: AttachOptions): SwarmHandle {
	const limits = resolveLimits({
		...(host.getFlag ? { flag: (name) => host.getFlag!(name) } : {}),
		env: options.env ?? {},
		...(options.limits ? { override: options.limits } : {}),
	});
	let session: SwarmSession | undefined;
	let enabled = swarmRequested(options.env ?? {}, host.getFlag?.("swarm") === true);

	function open(): SwarmSession {
		const created = new SwarmSession({
			limits,
			cwd: options.cwd ?? process.cwd(),
			home: options.home,
			...(options.now ? { now: options.now } : {}),
			runSubtask: (request) => host.runSubtask(request),
		});
		created.enabled = enabled;
		session = created;
		return created;
	}

	function current(): SwarmSession {
		return session ?? open();
	}

	const handle: SwarmHandle = {
		surface: options.surface,
		session: () => current(),
		get enabled() { return enabled; },
		setEnabled(on: boolean) {
			enabled = on;
			if (session) session.enabled = on;
			if (on) current();
			handle.refreshPrompt();
		},
		noteAgentStart() { if (session) session.noteAgentStart(); },
		noteTurnStart(turnIndex: number) { if (session || enabled) current().noteTurnStart(turnIndex); },
		refreshPrompt() {
			host.injectSystemPrompt(enabled ? current().promptSection(options.surface) : "");
		},
		status: () => session ? session.status() : {
			...computeMetrics({ orchSteps: 0, orchStepBudget: limits.orchSteps, stages: [], wallMs: 0 }),
			maxInFlight: 0,
			concurrencyCap: limits.concurrency,
			trace: "",
			runId: "",
			enabled: false,
		},
	};

	const tools = options.surface === "pi" ? [...PI_TOOLS, STATUS_TOOL] : [STATUS_TOOL];
	if (options.surface === "omp" && tools.some(tool => tool.name !== "swarm_status")) {
		throw new Error("OMP swarm surface must not register a second task tool");
	}

	for (const tool of tools) {
		host.registerTool(tool, (call) => dispatch(tool, call));
	}

	if (options.surface === "pi") {
		host.hookToolCall((call) => {
			if (call.name !== "assign_task") return;
			const decision = current().admit(call.toolCallId);
			if (!decision.ok) return { block: decision.reason };
			return;
		});
	}

	host.registerCommand?.("swarm", () => {
		handle.setEnabled(!enabled);
	});

	async function dispatch(tool: SwarmToolSpec, call: SwarmToolCall): Promise<SwarmToolResult> {
		if (tool.name === "swarm_status") {
			const metrics = handle.status();
			host.reportUsage({ toolCallId: call.toolCallId, coverage: metrics.usage.coverage });
			return { text: JSON.stringify(metrics), details: { ...metrics } };
		}
		if (!enabled) return { text: SWARM_OFF_REASON, details: { reason: SWARM_OFF_REASON }, isError: true };
		if (tool.name === "create_subagent") {
			const name = stringParam(call.params.name);
			const systemPrompt = stringParam(call.params.system_prompt);
			if (!name || !systemPrompt) return { text: "create_subagent requires name and system_prompt", details: {}, isError: true };
			const toolsRequested = Array.isArray(call.params.tools) ? call.params.tools.filter((item): item is string => typeof item === "string") : undefined;
			const def: AgentDef = {
				name,
				systemPrompt,
				tools: filterReadOnly(toolsRequested),
				readOnly: true,
				...(typeof call.params.model === "string" && call.params.model.trim() ? { model: call.params.model.trim() } : {}),
			};
			current().createAgent(def);
			return { text: `Subagent "${name}" created.`, details: { name, tools: def.tools ?? [] } };
		}
		const payload = await current().assign({
			toolCallId: call.toolCallId,
			agent: stringParam(call.params.agent) ?? "",
			prompt: stringParam(call.params.prompt) ?? "",
			...(call.signal ? { signal: call.signal } : {}),
			...(call.model ? { model: call.model } : {}),
			...(call.thinking ? { thinking: call.thinking } : {}),
			...(call.onProgress ? { onProgress: call.onProgress } : {}),
		});
		if (payload.usage) {
			host.reportUsage({ toolCallId: call.toolCallId, usage: payload.usage, coverage: "full" });
		} else {
			host.reportUsage({ toolCallId: call.toolCallId, coverage: "unreported" });
		}
		return {
			text: payload.text,
			details: payload.details,
			...(payload.details.status === "failure" ? { isError: true } : {}),
			...(payload.usage ? { usage: payload.usage } : {}),
		};
	}

	handle.refreshPrompt();
	return handle;
}

export function filterReadOnly(requested: readonly string[] | undefined): string[] {
	if (!requested || requested.length === 0) return [...READ_ONLY_TOOLS];
	const allowed = new Set<string>(READ_ONLY_TOOLS);
	const picked = requested.filter(tool => allowed.has(tool));
	return picked.length > 0 ? picked : [...READ_ONLY_TOOLS];
}

function stringParam(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export const ATTACHED_PI_TOOLS = SWARM_TOOL_NAMES;
