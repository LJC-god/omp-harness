export type DependencyMaturity = "verified_commit" | "integrated";
export type TaskGraphDependency = { taskId: string; maturity: DependencyMaturity };
export type TaskGraphNode = { id: string; writePaths: string[]; sharedResources: string[]; dependsOn: TaskGraphDependency[] };
export type TaskGraphSpec = { targetRef: string; tasks: TaskGraphNode[] };

export class TaskGraphError extends Error {
	constructor(readonly code: string, message: string) { super(message); this.name = "TaskGraphError"; }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESOURCE = /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._:-]*)*$/;
const DEVICE = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;

export function taskNodeId(value: unknown): string {
	if (typeof value !== "string" || !ID.test(value)) throw new TaskGraphError("TASK_GRAPH_INVALID", "node id");
	return value;
}

/** Canonical repository-relative path or directory prefix; intentionally no glob language. */
export function taskScope(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 512) throw new TaskGraphError("TASK_GRAPH_SCOPE", "scope");
	const raw = value.normalize("NFC").replaceAll("\\", "/");
	if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || /[*?\[\]{}]/.test(raw) || raw.includes("\0")) throw new TaskGraphError("TASK_GRAPH_SCOPE", value);
	const parts = raw.split("/");
	if (!parts.length || parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new TaskGraphError("TASK_GRAPH_SCOPE", value);
	const canonical = parts.map(part => part.toLowerCase());
	if (canonical.some(part => part === ".git" || part === ".omp" || part.includes(":") || DEVICE.test(part))) throw new TaskGraphError("TASK_GRAPH_SCOPE", value);
	return canonical.join("/");
}

export function taskResource(value: unknown): string {
	if (typeof value !== "string" || value.length > 256) throw new TaskGraphError("TASK_GRAPH_RESOURCE", "resource");
	const resource = value.normalize("NFC").toLowerCase();
	if (!RESOURCE.test(resource)) throw new TaskGraphError("TASK_GRAPH_RESOURCE", value);
	return resource;
}

export function taskScopesOverlap(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new TaskGraphError("TASK_GRAPH_INVALID", label);
	return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskGraphError("TASK_GRAPH_INVALID", label);
	return value as Record<string, unknown>;
}

export function parseTaskGraph(value: unknown): TaskGraphSpec {
	const root = object(value, "plan");
	if (Object.keys(root).some(key => key !== "targetRef" && key !== "tasks")) throw new TaskGraphError("TASK_GRAPH_INVALID", "plan fields");
	if (typeof root.targetRef !== "string" || !root.targetRef) throw new TaskGraphError("TASK_GRAPH_INVALID", "targetRef");
	const tasks = array(root.tasks, "tasks");
	if (!tasks.length || tasks.length > 64) throw new TaskGraphError("TASK_GRAPH_INVALID", "task count");
	const parsed: TaskGraphNode[] = tasks.map(raw => {
		const node = object(raw, "task");
		if (Object.keys(node).some(key => !["id", "writePaths", "sharedResources", "dependsOn"].includes(key))) throw new TaskGraphError("TASK_GRAPH_INVALID", "task fields");
		const id = taskNodeId(node.id);
		const writePaths = array(node.writePaths, "writePaths").map(taskScope);
		const sharedResources = array(node.sharedResources, "sharedResources").map(taskResource);
		const dependsOn = array(node.dependsOn, "dependsOn").map(rawDep => {
			const dep = object(rawDep, "dependency");
			if (Object.keys(dep).some(key => key !== "taskId" && key !== "maturity")) throw new TaskGraphError("TASK_GRAPH_INVALID", "dependency fields");
			const taskId = taskNodeId(dep.taskId);
			if (dep.maturity !== "verified_commit" && dep.maturity !== "integrated") throw new TaskGraphError("TASK_GRAPH_INVALID", "dependency maturity");
			return { taskId, maturity: dep.maturity };
		});
		if (!writePaths.length) throw new TaskGraphError("TASK_GRAPH_SCOPE", "writePaths empty");
		if (new Set(writePaths).size !== writePaths.length || new Set(sharedResources).size !== sharedResources.length || new Set(dependsOn.map(dep => dep.taskId)).size !== dependsOn.length) throw new TaskGraphError("TASK_GRAPH_INVALID", id);
		return { id, writePaths, sharedResources, dependsOn };
	});
	if (new Set(parsed.map(task => task.id)).size !== parsed.length) throw new TaskGraphError("TASK_GRAPH_INVALID", "duplicate node");
	const byId = new Map(parsed.map(task => [task.id, task]));
	for (const node of parsed) for (const dep of node.dependsOn) {
		if (dep.taskId === node.id || !byId.has(dep.taskId)) throw new TaskGraphError("TASK_GRAPH_DEPENDENCY", `${node.id}:${dep.taskId}`);
	}
	const visited = new Set<string>(); const visiting = new Set<string>();
	const visit = (id: string) => {
		if (visiting.has(id)) throw new TaskGraphError("TASK_GRAPH_CYCLE", id);
		if (visited.has(id)) return;
		visiting.add(id); for (const dep of byId.get(id)!.dependsOn) visit(dep.taskId); visiting.delete(id); visited.add(id);
	};
	for (const node of parsed) visit(node.id);
	return { targetRef: root.targetRef, tasks: parsed };
}
