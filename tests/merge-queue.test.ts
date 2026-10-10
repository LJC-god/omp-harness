import { afterAll, beforeAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeModule, runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";
const { AgentRegistry } = await import(runtimeModule("pi-coding-agent/src/registry/agent-registry.ts"));
const { Settings } = await import(runtimeModule("pi-coding-agent/src/config/settings.ts"));
const { z } = await import(runtimePackageFile("omptype", "src/zod.ts"));
import control, { closeControlDb, dispatchAt, openControlDbAt, setControlTestDb, setTestBeforeMergeAdmission } from "../omp/agent/extensions/omp-control.ts";

function experimentRoot() {
	const configured = process.env.OMP_EXPERIMENT_ROOT;
	if (!configured || !path.isAbsolute(configured) || !/^D:[\\/]/i.test(configured)) throw new Error("MERGE_QUEUE_TEST_REQUIRES_EXPERIMENT_ROOT");
	const root = fs.realpathSync(path.resolve(configured)); const marker = path.join(root, ".omp-experiment-root");
	if (!/^D:[\\/]/i.test(root) || fs.readFileSync(marker, "utf8").trim() !== "omp-dependency-lab/v1") throw new Error("MERGE_QUEUE_TEST_REQUIRES_EXPERIMENT_ROOT");
	return root;
}
const lab = experimentRoot(); const marker = crypto.randomUUID(); const root = path.join(lab, "worktrees", `omp-merge-${marker}`);
const target = path.join(root, "target"), authorA = path.join(root, "author-a"), authorB = path.join(root, "author-b"), candidateB = path.join(root, "candidate-b"), candidateA = path.join(root, "candidate-a");
const db = path.join(lab, "evidence", `omp-merge-${marker}.sqlite`); const settings = Settings.isolated(); const owner = `merge-${marker}`;
const authorSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" } }, required: ["status"] };
const gateSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" }, findings: { type: "array", items: { type: "object", additionalProperties: false, properties: {}, required: [] } }, evidence: { type: "array", items: { type: "string" } } }, required: ["status", "runId", "generation", "findings", "evidence"] };
let execute: any; let subprocess: (options: any) => Promise<any>;
function command(cwd: string, args: string[], fail = true) { const r = Bun.spawnSync({ cmd: args, cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } }); if (fail && r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`); return r; }
function git(cwd: string, ...args: string[]) { return command(cwd, ["git", "-C", cwd, ...args]); }
function head(cwd: string) { return git(cwd, "rev-parse", "HEAD").stdout.toString().trim(); }
async function call(projectId: string, cwd: string, runId: string | undefined, input: Record<string, unknown>) { return dispatchAt(db, { projectId, ...(runId ? { runId } : {}), ...input } as never, { sessionId: owner, cwd, settings }); }
async function register(cwd: string) { return dispatchAt(db, { action: "project_register", canonicalRoot: cwd } as never, { sessionId: owner, cwd, settings }); }
async function spawn(projectId: string, cwd: string, runId: string, key: string, agent: string, schema: object, extra: Record<string, unknown> = {}) {
	const out = await execute(key, { action: "project_spawn", projectId, runId, idempotencyKey: key, agent, task: `merge queue lab ${key}`, outputSchema: schema, ...extra }, new AbortController().signal, () => {}, { cwd, settings, sessionManager: { getSessionId: () => owner, getEntries: () => [] } });
	if (out.isError) throw new Error(JSON.stringify(out.content)); return out.details;
}
async function gate(projectId: string, cwd: string, runId: string, key: string) {
	const gen = String((await call(projectId, cwd, runId, { action: "generation_get" })).generation);
	subprocess = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS", runId, generation: gen, findings: [], evidence: ["merge candidate gate"] } } });
	expect(await spawn(projectId, cwd, runId, key, "verifier", gateSchema, { gate: "verification" })).toMatchObject({ state: "succeeded" });
}

beforeAll(() => {
	fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.dirname(db), { recursive: true }); fs.mkdirSync(target, { recursive: true });
	git(target, "init", "-b", "main", target); git(target, "config", "user.email", "merge@example.invalid"); git(target, "config", "user.name", "merge queue");
	fs.mkdirSync(path.join(target, "src")); fs.writeFileSync(path.join(target, ".gitignore"), ".omp/\n"); fs.writeFileSync(path.join(target, "src", "base.ts"), "export const base = true;\n"); git(target, "add", "."); git(target, "commit", "-m", "base");
	for (const [branch, worktree] of [["author-a", authorA], ["author-b", authorB], ["candidate-b", candidateB]] as const) git(target, "worktree", "add", "-b", branch, worktree, "HEAD");
	setControlTestDb(db); control({ zod: z, pi: { AgentRegistry, runSubprocess: (options: any) => subprocess(options) }, registerTool: (tool: any) => { execute = tool.execute; }, registerCommand() {} } as never);
});
afterAll(() => { setTestBeforeMergeAdmission(null); closeControlDb(); setControlTestDb(null); });

test("explicit FIFO queue pins real candidate and target roots, blocks stale apply, then merges a new attempt", async () => {
	const targetProject = String((await register(target)).projectId), aProject = String((await register(authorA)).projectId), bProject = String((await register(authorB)).projectId), bCandidateProject = String((await register(candidateB)).projectId);
	const targetRun = String((await call(targetProject, target, undefined, { action: "run_begin", risk: "mechanical" })).runId), aRun = String((await call(aProject, authorA, undefined, { action: "run_begin", risk: "mechanical" })).runId), bRun = String((await call(bProject, authorB, undefined, { action: "run_begin", risk: "mechanical" })).runId), bCandidateRun = String((await call(bCandidateProject, candidateB, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	const plan = { targetRef: "main", tasks: [{ id: "a", writePaths: ["src/a.ts"], sharedResources: [], dependsOn: [] }, { id: "b", writePaths: ["src/b.ts"], sharedResources: [], dependsOn: [] }] };
	await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "merge", graphPlan: plan });
	for (const [id, projectId, cwd, runId] of [["a", aProject, authorA, aRun], ["b", bProject, authorB, bRun]] as const) {
		const claim = await call(projectId, cwd, runId, { action: "task_claim", graphId: "merge", taskId: id, idempotencyKey: `${id}-author` });
		subprocess = async () => { fs.writeFileSync(path.join(cwd, "src", `${id}.ts`), `export const ${id} = true;\n`); git(cwd, "add", `src/${id}.ts`); git(cwd, "commit", "-m", id); return { exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS" } } }; };
		expect(await spawn(projectId, cwd, runId, `${id}-author`, "fast-worker", authorSchema, { graphId: "merge", taskId: id, claimToken: claim.claimToken })).toMatchObject({ state: "succeeded" });
		await gate(projectId, cwd, runId, `${id}-gate`); expect(await call(projectId, cwd, runId, { action: "run_status" })).toMatchObject({ taskComplete: true }); expect(await call(projectId, cwd, runId, { action: "task_deliver", graphId: "merge", taskId: id, claimToken: claim.claimToken })).toMatchObject({ state: "delivered" });
	}
	const a = await call(targetProject, target, targetRun, { action: "merge_enqueue", graphId: "merge", taskId: "a", idempotencyKey: "attempt-a" });
	const b = await call(targetProject, target, targetRun, { action: "merge_enqueue", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b" });
	await expect(call(bCandidateProject, candidateB, bCandidateRun, { action: "merge_prepare", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b", claimToken: b.claimToken })).rejects.toThrow("MERGE_FIFO");
	// A queued head has no lock yet and remains explicitly cancellable by its frozen target run.
	expect(await call(targetProject, target, targetRun, { action: "merge_reconcile", graphId: "merge", taskId: "a", idempotencyKey: "attempt-a", claimToken: a.claimToken, cancel: true })).toMatchObject({ state: "cancelled" });
	const prepared = await call(bCandidateProject, candidateB, bCandidateRun, { action: "merge_prepare", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b", claimToken: b.claimToken });
	expect(prepared).toMatchObject({ state: "candidate_ready" });
	const missing = await call(bCandidateProject, candidateB, bCandidateRun, { action: "merge_verify", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b", claimToken: b.claimToken });
	expect(missing).toMatchObject({ state: "blocked", reason: "TASK_GATES_REQUIRED" });
	expect(await call(targetProject, target, targetRun, { action: "merge_reconcile", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b", claimToken: b.claimToken, cancel: true })).toMatchObject({ state: "cancelled" });
	git(target, "worktree", "add", "-b", "candidate-a", candidateA, "HEAD"); const aCandidateProject = String((await register(candidateA)).projectId), aCandidateRun = String((await call(aCandidateProject, candidateA, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	const retry = await call(targetProject, target, targetRun, { action: "merge_enqueue", graphId: "merge", taskId: "a", idempotencyKey: "attempt-a2" });
	expect(await call(aCandidateProject, candidateA, aCandidateRun, { action: "merge_prepare", graphId: "merge", taskId: "a", idempotencyKey: "attempt-a2", claimToken: retry.claimToken })).toMatchObject({ state: "candidate_ready" });
	await gate(aCandidateProject, candidateA, aCandidateRun, "a-candidate-gate");
	expect(await call(aCandidateProject, candidateA, aCandidateRun, { action: "merge_verify", graphId: "merge", taskId: "a", idempotencyKey: "attempt-a2", claimToken: retry.claimToken })).toMatchObject({ state: "verified" });
	fs.writeFileSync(path.join(target, "src", "moves.ts"), "export const moved = true;\n"); git(target, "add", "src/moves.ts"); git(target, "commit", "-m", "target moves");
	expect(await call(targetProject, target, targetRun, { action: "merge_apply", graphId: "merge", taskId: "a", idempotencyKey: "attempt-a2", claimToken: retry.claimToken })).toMatchObject({ state: "blocked", reason: "MERGE_TARGET_MOVED" });
	expect(await call(targetProject, target, targetRun, { action: "merge_reconcile", graphId: "merge", taskId: "a", idempotencyKey: "attempt-a2", claimToken: retry.claimToken, cancel: true })).toMatchObject({ state: "cancelled" });
	const candidateFinal = path.join(root, "candidate-final"); git(target, "worktree", "add", "-b", "candidate-final", candidateFinal, "HEAD"); const finalProject = String((await register(candidateFinal)).projectId), finalRun = String((await call(finalProject, candidateFinal, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	const bRetry = await call(targetProject, target, targetRun, { action: "merge_enqueue", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b2" });
	expect(await call(finalProject, candidateFinal, finalRun, { action: "merge_prepare", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b2", claimToken: bRetry.claimToken })).toMatchObject({ state: "candidate_ready" });
	await gate(finalProject, candidateFinal, finalRun, "b-final-gate"); expect(await call(finalProject, candidateFinal, finalRun, { action: "merge_verify", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b2", claimToken: bRetry.claimToken })).toMatchObject({ state: "verified" });
	expect(await call(targetProject, target, targetRun, { action: "merge_apply", graphId: "merge", taskId: "b", idempotencyKey: "attempt-b2", claimToken: bRetry.claimToken })).toMatchObject({ state: "merged" });
	expect(head(target)).toBe(head(candidateFinal)); expect((await call(targetProject, target, targetRun, { action: "merge_status" })).lock).toBeNull();
	// This hook runs after project_spawn's early checks but inside its admission
	// transaction. It proves a queue lock introduced in that window still fences a writer.
	setTestBeforeMergeAdmission(() => {
		const controlDb = openControlDbAt(db); const row = controlDb.query<any, []>("SELECT id,common_vol,common_index,target_project_id,target_ref,target_owner,target_run_id FROM merge_queue_items WHERE state='cancelled' ORDER BY id LIMIT 1").get();
		controlDb.query("INSERT INTO merge_integration_locks(common_vol,common_index,queue_id,target_project_id,target_ref,owner,run_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(row.common_vol, row.common_index, row.id, row.target_project_id, row.target_ref, row.target_owner, row.target_run_id, Date.now());
	});
	await expect(spawn(targetProject, target, targetRun, "admission-race", "fast-worker", authorSchema)).rejects.toThrow("MERGE_LOCKED"); setTestBeforeMergeAdmission(null);
}, 60_000);
