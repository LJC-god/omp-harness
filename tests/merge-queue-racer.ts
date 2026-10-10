import * as fs from "node:fs";
import * as path from "node:path";
import { closeControlDb, dispatchAt, setControlTestDb } from "../omp/agent/extensions/omp-control.ts";

const input = JSON.parse(process.env.OMP_MERGE_RACER_INPUT ?? "{}") as { db: string; projectId: string; cwd: string; runId: string; sessionId: string; graphId: string; taskId: string; attemptId: string; claimToken: string };
const lab = process.env.OMP_EXPERIMENT_ROOT;
const root = lab && path.isAbsolute(lab) && /^D:[\\/]/i.test(lab) ? fs.realpathSync(path.resolve(lab)) : "";
if (!root || !/^D:[\\/]/i.test(root) || fs.readFileSync(path.join(root, ".omp-experiment-root"), "utf8").trim() !== "omp-dependency-lab/v1" || !path.resolve(input.db).toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) throw new Error("MERGE_QUEUE_RACER_REQUIRES_EXPERIMENT_ROOT");
setControlTestDb(input.db);
try {
	const result = await dispatchAt(input.db, { action: "merge_prepare", projectId: input.projectId, runId: input.runId, graphId: input.graphId, taskId: input.taskId, idempotencyKey: input.attemptId, claimToken: input.claimToken } as never, { cwd: input.cwd, sessionId: input.sessionId });
	process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
} finally { closeControlDb(); setControlTestDb(null); }
