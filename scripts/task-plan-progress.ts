type Task = {
  id: string;
  agent: string;
  writePaths: string[];
  sharedResources: string[];
  dependsOn: { taskId: string; maturity: string }[];
};

const cell = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[&<>|`]/g,
  character => `&#${character.charCodeAt(0)};`);
const diagram = (value: string) => value.replace(/[&<>"\r\n]/g,
  character => `#${character.charCodeAt(0)};`);

/** A view of runner observations; never grants a controller transition or product PASS. */
export function taskProgress(
  id: string, root: string, tasks: Task[], states: ReadonlyMap<string, string>,
  execution: "active" | "completed" | "stopped", mock: boolean,
): string {
  const indices = new Map(tasks.map((task, index) => [task.id, `t${index}`]));
  const rows = tasks.map(task => `| ${cell(task.id)} | ${cell(task.agent)} | ${cell(states.get(task.id) ?? "planned")} | ${cell(task.writePaths.join(", "))} | ${cell(task.sharedResources.join(", ") || "none")} | ${cell(task.dependsOn.map(dep => `${dep.taskId}: ${dep.maturity}`).join(", ") || "none")} | ${cell(`automation/${id}/${task.id}`)} | ${cell(`${root.replaceAll("\\", "/")}/worktrees/${task.id}`)} |`);
  const nodes = tasks.map(task => `  ${indices.get(task.id)}["${diagram(`${task.id} / ${task.agent} / ${states.get(task.id) ?? "planned"}`)}"]`);
  const edges = tasks.flatMap(task => task.dependsOn.map(dep => `  ${indices.get(dep.taskId)} -->|${diagram(dep.maturity)}| ${indices.get(task.id)}`));
  return [
    "# Task execution progress", "", `Execution: ${execution}. Executor: ${mock ? "MOCK (no model calls)" : "real"}.`, "",
    "Product acceptance: pending outside this runner. Technical/security checks and merged branches do not replace final product, visual or experience acceptance.", "",
    "States are observed milestones: planned paths may not exist; claimed does not mean the author or checks succeeded; delivered is a verified branch; merged is integrated. On stopped execution retain failure.json and receipts; do not infer retry permission.", "",
    "| Task | Role | State | Owned paths | Shared resources | Dependencies | Planned branch | Planned worktree |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |", ...rows, "",
    "```mermaid", "flowchart TD", ...nodes, ...edges, "```", "",
  ].join("\n");
}
