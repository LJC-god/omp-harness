import type { SwarmToolName } from "./schema.ts";
import type { WorkerUsage } from "./metrics.ts";

/** One worker invocation. The host runs it; the core never spawns a process. */
export interface SubtaskRequest {
	toolCallId: string;
	attempt: number;
	agentName: string;
	systemPrompt: string;
	task: string;
	tools: readonly string[];
	isolated: boolean;
	readOnly: boolean;
	model?: string;
	thinking?: string;
	subSteps: number;
	timeoutMs: number;
	signal: AbortSignal;
	onProgress?: (steps: number) => void;
}

export interface SubtaskResult {
	status: "success" | "failure" | "aborted";
	answer: string;
	evidence: string[];
	artifact?: string;
	steps: number;
	toolCalls: number;
	reason?: string;
	model?: string;
	transcript?: string;
	usage?: WorkerUsage;
}

export interface SwarmToolSpec {
	name: SwarmToolName;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	executionMode: "sequential" | "parallel";
	defaultActive: false;
}

export interface SwarmToolCall {
	toolCallId: string;
	name: string;
	params: Record<string, unknown>;
	signal?: AbortSignal;
	model?: string;
	thinking?: string;
	onProgress?: (steps: number) => void;
}

export interface SwarmToolResult {
	text: string;
	details: Record<string, unknown>;
	isError?: boolean;
	usage?: WorkerUsage;
}

export interface UsageReport {
	toolCallId: string;
	usage?: WorkerUsage;
	coverage: "unreported" | "partial" | "full";
}

/**
 * What a host must provide. Pi and OMP each implement this.
 * The core calls these methods and does not import either host.
 */
export interface SwarmHost {
	registerTool(tool: SwarmToolSpec, execute: (call: SwarmToolCall) => Promise<SwarmToolResult>): void;
	hookToolCall(handler: (call: SwarmToolCall) => void | { block?: string } | Promise<void | { block?: string }>): void;
	runSubtask(request: SubtaskRequest): Promise<SubtaskResult>;
	reportUsage(report: UsageReport): void;
	injectSystemPrompt(section: string): void;
	getFlag?(name: string): boolean | string | undefined;
	registerCommand?(name: string, handler: () => void): void;
}
