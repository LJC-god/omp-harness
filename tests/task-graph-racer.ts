import control, { closeControlDb, dispatchAt, setControlTestDb } from "../omp/agent/extensions/omp-control.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const input = JSON.parse(process.env.OMP_GRAPH_RACER_INPUT ?? "{}") as { db: string; projectId: string; cwd: string; runId: string; sessionId: string; graphId: string; taskId: string; key: string };
const lab = process.env.OMP_EXPERIMENT_ROOT;
const root = lab && path.isAbsolute(lab) && /^D:[\\/]/i.test(lab) ? fs.realpathSync(path.resolve(lab)) : "";
if (!root || !/^D:[\\/]/i.test(root) || fs.readFileSync(path.join(root, ".omp-experiment-root"), "utf8").trim() !== "omp-dependency-lab/v1" || !path.resolve(input.db).toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`) || !path.resolve(input.cwd).toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) throw new Error("TASK_GRAPH_RACER_REQUIRES_EXPERIMENT_ROOT");
setControlTestDb(input.db);
try {
	const result = await dispatchAt(input.db, { action: "task_claim", projectId: input.projectId, runId: input.runId, graphId: input.graphId, taskId: input.taskId, idempotencyKey: input.key } as never, { cwd: input.cwd, sessionId: input.sessionId });
	process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
} finally { closeControlDb(); setControlTestDb(null); }
