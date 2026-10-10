import { READ_ONLY_AGENTS } from "./schema.ts";
import type { SwarmSession } from "./session.ts";

export interface NativeAssignment {
	agent: string;
	task: string;
	isolated: boolean;
	toolCallId: string;
}

export function parseTaskPayload(
	params: Record<string, unknown>,
	defaultAgent = "scout",
	ids: (index: number) => string = (index) => `swarm-${index}`,
): { items: NativeAssignment[] } | { error: string } {
	const context = typeof params.context === "string" ? params.context.trim() : "";
	const batched = Array.isArray(params.tasks);
	const rows = batched ? params.tasks as unknown[] : [params];
	if (batched && rows.length === 0) return { error: "task batch is empty" };
	const items: NativeAssignment[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (!row || typeof row !== "object" || Array.isArray(row)) return { error: "task item is not an object" };
		const record = row as Record<string, unknown>;
		const taskText = typeof record.task === "string" ? record.task : "";
		if (!taskText.trim()) return { error: "task text is empty" };
		const named = typeof record.agent === "string" ? record.agent.trim() : "";
		const agent = named || defaultAgent;
		const task = context ? `${context}\n\n${taskText}` : taskText;
		items.push({ agent, task, isolated: record.isolated === true, toolCallId: ids(index) });
	}
	return { items };
}

export function isReadOnlyAgent(name: string): boolean {
	return (READ_ONLY_AGENTS as readonly string[]).includes(name);
}

/**
 * Register unknown agents, reject illegal writer mixes, then reserve the whole
 * stage or nothing. A rejected batch does not hold slots.
 */
export function prepareStage(
	session: SwarmSession,
	items: NativeAssignment[],
): { ok: true; turn: number } | { ok: false; reason: string } {
	for (const item of items) {
		if (session.registry.has(item.agent)) continue;
		session.createAgent({
			name: item.agent,
			systemPrompt: "",
			readOnly: isReadOnlyAgent(item.agent),
			tools: [],
		});
	}
	const inspected = session.inspectStage(items.map(item => ({
		isolated: item.isolated,
		readOnly: session.registry.get(item.agent)?.readOnly === true,
	})));
	if (!inspected.ok) return inspected;
	return session.admitBatch(items.length);
}
