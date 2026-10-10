import { afterAll, beforeAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
const { AgentRegistry } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/registry/agent-registry.ts`);
const { Settings } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts`);
const { z } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/omptype/src/zod.ts`);
import control, { closeControlDb, dispatchAt, openControlDbAt, setControlTestDb } from "../omp/agent/extensions/omp-control.ts";

function experimentRoot() {
	const configured = process.env.OMP_EXPERIMENT_ROOT;
	if (!configured || !path.isAbsolute(configured) || !/^D:[\\/]/i.test(configured)) throw new Error("TASK_GRAPH_RECOVERY_REQUIRES_EXPERIMENT_ROOT");
	const root = fs.realpathSync(path.resolve(configured));
	const marker = path.join(root, ".omp-experiment-root");
	if (!/^D:[\\/]/i.test(root) || !fs.statSync(root).isDirectory() || !fs.statSync(marker).isFile() || fs.readFileSync(marker, "utf8").trim() !== "omp-dependency-lab/v1") {
		throw new Error("TASK_GRAPH_RECOVERY_REQUIRES_EXPERIMENT_ROOT");
	}
	return root;
}

const lab = experimentRoot();
const marker = crypto.randomUUID();
const root = path.join(lab, "worktrees", `omp-graph-recovery-${marker}`);
const target = path.join(root, "target");
const author = path.join(root, "author");
const changed = path.join(root, "changed");
const dirty = path.join(root, "dirty");
const db = path.join(lab, "evidence", `omp-graph-recovery-${marker}.sqlite`);
const settings = Settings.isolated();
const owner = `graph-recovery-${marker}`;
const authorSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" } }, required: ["status"] };
const reconciliationSchema = {
	type: "object", additionalProperties: false,
	properties: {
		status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" }, reconcilesTaskKey: { type: "string" },
		processesStopped: { type: "boolean" }, sideEffectsKnown: { type: "boolean" },
		findings: { type: "array", items: { type: "object", additionalProperties: false, properties: {}, required: [] } },
		evidence: { type: "array", items: { type: "string" } },
	},
	required: ["status", "runId", "generation", "reconcilesTaskKey", "processesStopped", "sideEffectsKnown", "findings", "evidence"],
};
let execute: any;
let subprocess: (options: any) => Promise<any>;

function command(cwd: string, args: string[], fail = true) {
	const result = Bun.spawnSync({ cmd: args, cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } });
	if (fail && result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString().trim()}`);
	return result;
}

function git(cwd: string, ...args: string[]) { return command(cwd, ["git", "-C", cwd, ...args]); }
function head(cwd: string) { return git(cwd, "rev-parse", "HEAD").stdout.toString().trim(); }
function status(cwd: string) { return git(cwd, "status", "--porcelain").stdout.toString().trim(); }
function call(projectId: string, cwd: string, runId: string | undefined, input: Record<string, unknown>) {
	return dispatchAt(db, { projectId, ...(runId ? { runId } : {}), ...input } as never, { sessionId: owner, cwd, settings });
}
function register(cwd: string) { return dispatchAt(db, { action: "project_register", canonicalRoot: cwd } as never, { sessionId: owner, cwd, settings }); }

async function spawn(projectId: string, cwd: string, runId: string, key: string, agent: string, schema: object, input: Record<string, unknown> = {}) {
	const response = await execute(key, {
		action: "project_spawn", projectId, runId, idempotencyKey: key, agent, task: `isolated recovery proof ${key}`, outputSchema: schema, ...input,
	}, new AbortController().signal, () => {}, { cwd, settings, sessionManager: { getSessionId: () => owner, getEntries: () => [] } });
	if (response.isError) {
		const text = response.content?.find((part: any) => part.type === "text")?.text;
		if (typeof text === "string") return JSON.parse(text);
		throw new Error(JSON.stringify(response.content));
	}
	return response.details;
}

function graph(taskId: string, writePath: string) {
	return { targetRef: "main", tasks: [{ id: taskId, writePaths: [writePath], sharedResources: [], dependsOn: [] }] };
}

function writers() { return openControlDbAt(db).query("SELECT token FROM workspace_activity").all(); }
function leases(projectId: string) { return openControlDbAt(db).query("SELECT resource FROM leases WHERE project_id=?").all(projectId); }

beforeAll(() => {
	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(path.dirname(db), { recursive: true });
	fs.mkdirSync(target, { recursive: true });
	git(target, "init", "-b", "main", target);
	git(target, "config", "user.email", "graph-recovery@example.invalid");
	git(target, "config", "user.name", "graph recovery");
	fs.mkdirSync(path.join(target, "src"));
	fs.writeFileSync(path.join(target, ".gitignore"), ".omp/\n");
	fs.writeFileSync(path.join(target, "src", "base.ts"), "export const base = 1;\n");
	git(target, "add", "."); git(target, "commit", "-m", "fixture base");
	for (const [branch, worktree] of [["recovery-author", author], ["recovery-changed", changed], ["recovery-dirty", dirty]] as const) {
		git(target, "worktree", "add", "-b", branch, worktree, "HEAD");
	}
	setControlTestDb(db);
	control({ zod: z, pi: { AgentRegistry, runSubprocess: (options: any) => subprocess(options) }, registerTool: (tool: any) => { execute = tool.execute; }, registerCommand() {} } as never);
});

afterAll(() => { closeControlDb(); setControlTestDb(null); });

test("claimed graph tasks only cancel before dispatch, and interrupted authors need a fresh verifier reconciliation", async () => {
	const targetProject = String((await register(target)).projectId);
	const authorProject = String((await register(author)).projectId);
	const changedProject = String((await register(changed)).projectId);
	const dirtyProject = String((await register(dirty)).projectId);
	const targetRun = String((await call(targetProject, target, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	const authorRun = String((await call(authorProject, author, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	const changedRun = String((await call(changedProject, changed, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	const dirtyRun = String((await call(dirtyProject, dirty, undefined, { action: "run_begin", risk: "mechanical" })).runId);

	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "cancel-clean", graphPlan: graph("cancel", "src/cancel.ts") })).ok).toBe(true);
	const cancelClaim = await call(authorProject, author, authorRun, { action: "task_claim", graphId: "cancel-clean", taskId: "cancel", idempotencyKey: "cancel-author" });
	expect(status(author)).toBe(""); expect(writers()).toHaveLength(0);
	await expect(call(authorProject, author, authorRun, { action: "task_claim_reconcile", graphId: "cancel-clean", taskId: "cancel", claimToken: "wrong-token" })).rejects.toThrow("TASK_CLAIM_REQUIRED");
	expect(await call(authorProject, author, authorRun, { action: "task_claim_reconcile", graphId: "cancel-clean", taskId: "cancel", claimToken: cancelClaim.claimToken })).toMatchObject({ state: "cancelled" });
	expect(writers()).toHaveLength(0); expect(leases(authorProject)).toHaveLength(0);
	const cancelled = await call(targetProject, target, targetRun, { action: "task_graph_status", graphId: "cancel-clean" });
	expect((cancelled.nodes as any[])[0]).toMatchObject({ taskId: "cancel", state: "cancelled" });

	// Reusing the released scope proves cancellation removed the durable occupancy.
	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "changed", graphPlan: graph("changed", "src/cancel.ts") })).ok).toBe(true);
	const changedClaim = await call(changedProject, changed, changedRun, { action: "task_claim", graphId: "changed", taskId: "changed", idempotencyKey: "changed-author" });
	fs.writeFileSync(path.join(changed, "src", "cancel.ts"), "export const changed = true;\n"); git(changed, "add", "src/cancel.ts"); git(changed, "commit", "-m", "changed before dispatch");
	await expect(call(changedProject, changed, changedRun, { action: "task_claim_reconcile", graphId: "changed", taskId: "changed", claimToken: changedClaim.claimToken })).rejects.toThrow("TASK_CHANGED");
	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "dirty", graphPlan: graph("dirty", "src/dirty.ts") })).ok).toBe(true);
	const dirtyClaim = await call(dirtyProject, dirty, dirtyRun, { action: "task_claim", graphId: "dirty", taskId: "dirty", idempotencyKey: "dirty-author" });
	fs.writeFileSync(path.join(dirty, "src", "dirty.ts"), "export const dirty = true;\n");
	await expect(call(dirtyProject, dirty, dirtyRun, { action: "task_claim_reconcile", graphId: "dirty", taskId: "dirty", claimToken: dirtyClaim.claimToken })).rejects.toThrow("DIRTY_WORKTREE");

	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "interrupted", graphPlan: graph("author", "src/author.ts") })).ok).toBe(true);
	const interruptedClaim = await call(authorProject, author, authorRun, { action: "task_claim", graphId: "interrupted", taskId: "author", idempotencyKey: "interrupted-author" });
	subprocess = async (options: any) => {
		expect(path.resolve(options.cwd)).toBe(path.resolve(author));
		fs.writeFileSync(path.join(author, "src", "author.ts"), "export const preservedEvidence = true;\n");
		git(author, "add", "src/author.ts"); git(author, "commit", "-m", "author evidence before failure");
		return { exitCode: 1, aborted: true, structuredOutput: { status: "invalid", data: { status: "FAIL" } } };
	};
	const interruptedAuthor = await spawn(authorProject, author, authorRun, "interrupted-author", "fast-worker", authorSchema, { graphId: "interrupted", taskId: "author", claimToken: interruptedClaim.claimToken });
	expect(interruptedAuthor).toMatchObject({ state: "interrupted" });
	const preservedHead = head(author); expect(status(author)).toBe(""); expect(writers()).toHaveLength(0);
	const generation = String((await call(authorProject, author, authorRun, { action: "generation_get" })).generation);
	await expect(call(authorProject, author, authorRun, { action: "task_claim_reconcile", graphId: "interrupted", taskId: "author", claimToken: interruptedClaim.claimToken })).rejects.toThrow("RECONCILIATION_REQUIRED");
	const proof = (runId: string, proofGeneration: string) => ({ status: "valid", data: {
		status: "PASS", runId, generation: proofGeneration, reconcilesTaskKey: "interrupted-author", processesStopped: true, sideEffectsKnown: true, findings: [], evidence: ["isolated process and side-effect inspection"],
	} });
	const verifier = async (key: string, value: ReturnType<typeof proof>) => {
		subprocess = async (options: any) => { expect(path.resolve(options.cwd)).toBe(path.resolve(author)); return { exitCode: 0, structuredOutput: value }; };
		return spawn(authorProject, author, authorRun, key, "verifier", reconciliationSchema);
	};
	await verifier("recovery-wrong-run", proof("foreign-run", generation));
	await expect(call(authorProject, author, authorRun, { action: "task_reconcile", idempotencyKey: "interrupted-author", evidenceTaskKey: "recovery-wrong-run" })).rejects.toThrow("RECONCILIATION_REQUIRED");
	await verifier("recovery-wrong-generation", proof(authorRun, String(Number(generation) + 1)));
	await expect(call(authorProject, author, authorRun, { action: "task_reconcile", idempotencyKey: "interrupted-author", evidenceTaskKey: "recovery-wrong-generation" })).rejects.toThrow("RECONCILIATION_REQUIRED");
	await verifier("recovery-current", proof(authorRun, generation));
	expect(await call(authorProject, author, authorRun, { action: "task_reconcile", idempotencyKey: "interrupted-author", evidenceTaskKey: "recovery-current" })).toMatchObject({ state: "failed", reconciled: true, requiresNewGeneration: true });
	expect(await call(authorProject, author, authorRun, { action: "task_claim_reconcile", graphId: "interrupted", taskId: "author", claimToken: interruptedClaim.claimToken })).toMatchObject({ state: "interrupted" });
	expect(head(author)).toBe(preservedHead); expect(status(author)).toBe(""); expect(writers()).toHaveLength(0); expect(leases(authorProject)).toHaveLength(0);
	const interrupted = await call(targetProject, target, targetRun, { action: "task_graph_status", graphId: "interrupted" });
	expect((interrupted.nodes as any[])[0]).toMatchObject({ taskId: "author", state: "interrupted" });

	const advanceLease = await call(authorProject, author, authorRun, { action: "lease_acquire", resource: "*" });
	expect(await call(authorProject, author, authorRun, { action: "generation_advance", token: advanceLease.token })).toMatchObject({ generation: Number(generation) + 1 });
	const repairRun = String((await call(authorProject, author, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "repair", graphPlan: graph("repair", "src/repair.ts") })).ok).toBe(true);
	const repairClaim = await call(authorProject, author, repairRun, { action: "task_claim", graphId: "repair", taskId: "repair", idempotencyKey: "repair-author" });
	subprocess = async (options: any) => {
		expect(path.resolve(options.cwd)).toBe(path.resolve(author));
		fs.writeFileSync(path.join(author, "src", "repair.ts"), "export const repair = true;\n");
		git(author, "add", "src/repair.ts"); git(author, "commit", "-m", "repair after recovery");
		return { exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS" } } };
	};
	expect(await spawn(authorProject, author, repairRun, "repair-author", "fast-worker", authorSchema, { graphId: "repair", taskId: "repair", claimToken: repairClaim.claimToken })).toMatchObject({ state: "succeeded" });
}, 60_000);
