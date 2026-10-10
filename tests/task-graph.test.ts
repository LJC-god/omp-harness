import { afterAll, beforeAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeModule, runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";
const { AgentRegistry } = await import(runtimeModule("pi-coding-agent/src/registry/agent-registry.ts"));
const { Settings } = await import(runtimeModule("pi-coding-agent/src/config/settings.ts"));
const { z } = await import(runtimePackageFile("omptype", "src/zod.ts"));
import control, { closeControlDb, dispatchAt, openControlDbAt, setControlTestDb } from "../omp/agent/extensions/omp-control.ts";
import { parseTaskGraph, taskScope, taskScopesOverlap } from "../omp/agent/lib/task-graph.ts";

function experimentRoot() {
	const configured = process.env.OMP_EXPERIMENT_ROOT;
	if (!configured || !path.isAbsolute(configured) || !/^D:[\\/]/i.test(configured)) throw new Error("TASK_GRAPH_TEST_REQUIRES_EXPERIMENT_ROOT");
	const root = fs.realpathSync(path.resolve(configured)); const marker = path.join(root, ".omp-experiment-root");
	if (!/^D:[\\/]/i.test(root) || !fs.statSync(root).isDirectory() || !fs.statSync(marker).isFile() || fs.readFileSync(marker, "utf8").trim() !== "omp-dependency-lab/v1") throw new Error("TASK_GRAPH_TEST_REQUIRES_EXPERIMENT_ROOT");
	return root;
}
const lab = experimentRoot();
const marker = crypto.randomUUID(); const root = path.join(lab, "worktrees", `omp-graph-${marker}`);
const target = path.join(root, "target"), a = path.join(root, "a"), b = path.join(root, "b"), c = path.join(root, "c"), d = path.join(root, "d"), e = path.join(root, "e"), f = path.join(root, "f");
const db = path.join(lab, "evidence", `omp-graph-${marker}.sqlite`); const settings = Settings.isolated(); settings.override("task.agentModelOverrides", { "repair-worker": "openai-codex/gpt-5.6-terra:high" }); const hooks = new Map<string, any>(); let execute: any; let subprocess: (o: any) => Promise<any>; let repairInvocation: any;
const authorSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" } }, required: ["status"] };
const verifySchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" }, findings: { type: "array", items: { type: "object", additionalProperties: false, properties: {}, required: [] } }, evidence: { type: "array", items: { type: "string" } } }, required: ["status", "runId", "generation", "findings", "evidence"] };
const cmd = (cwd: string, args: string[], fail = true) => { const r = Bun.spawnSync({ cmd: args, cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } }); if (fail && r.exitCode) throw new Error(`${args.join(" ")}: ${r.stderr}`); return r; };
const git = (cwd: string, ...args: string[]) => cmd(cwd, ["git", "-C", cwd, ...args]);
const head = (cwd: string) => git(cwd, "rev-parse", "HEAD").stdout.toString().trim();
const call = (projectId: string, cwd: string, runId: string | undefined, input: Record<string, unknown>) => dispatchAt(db, { projectId, ...(runId ? { runId } : {}), ...input } as never, { sessionId: `session-${path.basename(cwd)}`, cwd, settings });
async function register(cwd: string) { return dispatchAt(db, { action: "project_register", canonicalRoot: cwd } as never, { sessionId: `session-${path.basename(cwd)}`, cwd, settings }); }
async function spawn(projectId: string, cwd: string, runId: string, key: string, input: Record<string, unknown>) {
	const response = await execute(key, { action: "project_spawn", projectId, runId, idempotencyKey: key, agent: "fast-worker", task: "isolated graph author", outputSchema: authorSchema, ...input }, new AbortController().signal, () => {}, { cwd, settings, sessionManager: { getSessionId: () => `session-${path.basename(cwd)}`, getEntries: () => [] } });
	if (response.isError) throw new Error(JSON.stringify(response.content)); return response.details;
}

beforeAll(() => {
	fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.dirname(db), { recursive: true }); fs.mkdirSync(target, { recursive: true });
	git(target, "init", "-b", "main", target); git(target, "config", "user.email", "graph@example.invalid"); git(target, "config", "user.name", "graph");
	fs.mkdirSync(path.join(target, "src")); fs.writeFileSync(path.join(target, ".gitignore"), ".omp/\n"); fs.writeFileSync(path.join(target, "src", "base.ts"), "export const base = 1;\n"); git(target, "add", "."); git(target, "commit", "-m", "base");
	for (const [branch, tree] of [["task-a", a], ["task-b", b], ["task-c", c], ["task-d", d], ["task-e", e], ["task-f", f]] as const) git(target, "worktree", "add", "-b", branch, tree, "HEAD");
	setControlTestDb(db); control({ zod: z, pi: { AgentRegistry, runSubprocess: (options: any) => subprocess(options) }, on: (name: string, handler: any) => hooks.set(name, handler), registerTool: (tool: any) => { execute = tool.execute; }, registerCommand() {} } as never);
});
afterAll(() => { closeControlDb(); setControlTestDb(null); });

test("graph validation and real-worktree claim/delivery boundary", async () => {
	expect(taskScope("src\\api")).toBe("src/api"); expect(taskScopesOverlap("src", "src/a")).toBe(true);
	expect(() => parseTaskGraph({ targetRef: "main", tasks: [{ id: "a", writePaths: [".git/x"], sharedResources: [], dependsOn: [] }] })).toThrow(".git/x");
	expect(() => taskScope("src/COM¹.txt")).toThrow("COM¹.txt");
	expect(() => parseTaskGraph({ targetRef: "main", tasks: [{ id: "a", writePaths: ["a"], sharedResources: [], dependsOn: [{ taskId: "b", maturity: "verified_commit" }] }, { id: "b", writePaths: ["b"], sharedResources: [], dependsOn: [{ taskId: "a", maturity: "verified_commit" }] }] })).toThrow("a");
	const targetProject = String((await register(target)).projectId), aProject = String((await register(a)).projectId), bProject = String((await register(b)).projectId), cProject = String((await register(c)).projectId), dProject = String((await register(d)).projectId), eProject = String((await register(e)).projectId), fProject = String((await register(f)).projectId);
	const targetRun = String((await call(targetProject, target, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	const plan = { targetRef: "main", tasks: [
		{ id: "a", writePaths: ["src/a.ts"], sharedResources: [], dependsOn: [] },
		{ id: "b", writePaths: ["src/b.ts"], sharedResources: ["schema:shared"], dependsOn: [] },
		{ id: "c", writePaths: ["src/c.ts"], sharedResources: [], dependsOn: [{ taskId: "a", maturity: "verified_commit" }] },
		{ id: "d", writePaths: ["src/d.ts"], sharedResources: [], dependsOn: [{ taskId: "a", maturity: "integrated" }] },
	] };
	const created = await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "graph-main", graphPlan: plan }); expect(created).toMatchObject({ ok: true, graphId: "graph-main" });
	expect(await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "graph-main", graphPlan: plan })).toMatchObject({ duplicate: true });
	const aRun = String((await call(aProject, a, undefined, { action: "run_begin", risk: "mechanical" })).runId), bRun = String((await call(bProject, b, undefined, { action: "run_begin", risk: "mechanical" })).runId), cRun = String((await call(cProject, c, undefined, { action: "run_begin", risk: "mechanical" })).runId), dRun = String((await call(dProject, d, undefined, { action: "run_begin", risk: "mechanical" })).runId), eRun = String((await call(eProject, e, undefined, { action: "run_begin", risk: "mechanical" })).runId), fRun = String((await call(fProject, f, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	// Isolated DB fixture: emulate a pre-graph legacy running writer, then settle it; no production DB is opened.
	const fixtureDb = openControlDbAt(db); fixtureDb.query("INSERT INTO control_tasks(project_id,task_key,run_id,generation,request_sha,agent,agent_id,gate,state,updated_at) VALUES(?,?,?,?,?,?,?,?,'running',?)").run(cProject, "legacy-writer", cRun, 1, "fixture", "fast-worker", "fixture", null, Date.now());
	await expect(call(aProject, a, aRun, { action: "task_claim", graphId: "graph-main", taskId: "a", idempotencyKey: "a-author" })).rejects.toThrow("UNSETTLED_TASK");
	fixtureDb.query("UPDATE control_tasks SET state='failed',updated_at=? WHERE project_id=? AND task_key=?").run(Date.now(), cProject, "legacy-writer");
	const aClaim = await call(aProject, a, aRun, { action: "task_claim", graphId: "graph-main", taskId: "a", idempotencyKey: "a-author" });
	const bClaim = await call(bProject, b, bRun, { action: "task_claim", graphId: "graph-main", taskId: "b", idempotencyKey: "b-author" });
	expect(aClaim.ok).toBe(true); expect(bClaim.ok).toBe(true);
	const blockNative = hooks.get("tool_call")({ toolName: "task", input: {} }, { cwd: c, sessionManager: { getEntries: () => [], getSessionId: () => "session-c" } }); expect(blockNative.block).toBe(true);
	const blockMissingNative = hooks.get("tool_call")({ toolName: "task", input: { cwd: "missing/nested" } }, { cwd: c, sessionManager: { getEntries: () => [], getSessionId: () => "session-c" } }); expect(blockMissingNative.block).toBe(true);
	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "race", graphPlan: { targetRef: "main", tasks: [{ id: "r", writePaths: ["src/race.ts"], sharedResources: [], dependsOn: [] }] } })).ok).toBe(true);
	const race = async (projectId: string, cwd: string, runId: string, key: string) => { const payload = JSON.stringify({ db, projectId, cwd, runId, sessionId: `session-${path.basename(cwd)}`, graphId: "race", taskId: "r", key }); const p = Bun.spawn({ cmd: ["bun", path.join(import.meta.dir, "task-graph-racer.ts")], env: { ...process.env, OMP_GRAPH_RACER_INPUT: payload }, stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(); const err = await new Response(p.stderr).text(); await p.exited; if (!out) throw new Error(err); return JSON.parse(out) as { ok: boolean }; };
	const raced = await Promise.all([race(eProject, e, eRun, "race-e"), race(fProject, f, fRun, "race-f")]); expect(raced.filter(item => item.ok).length).toBe(1);
	await expect(call(cProject, c, cRun, { action: "task_claim", graphId: "graph-main", taskId: "c", idempotencyKey: "c-author" })).rejects.toThrow("TASK_NOT_READY");
	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "conflict", graphPlan: { targetRef: "main", tasks: [{ id: "x", writePaths: ["src/x.ts"], sharedResources: ["schema:shared"], dependsOn: [] }] } })).ok).toBe(true);
	await expect(call(cProject, c, cRun, { action: "task_claim", graphId: "conflict", taskId: "x", idempotencyKey: "x-author" })).rejects.toThrow("TASK_SCOPE_CONFLICT");
	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "path-conflict", graphPlan: { targetRef: "main", tasks: [{ id: "y", writePaths: ["src/a.ts"], sharedResources: [], dependsOn: [] }] } })).ok).toBe(true);
	await expect(call(cProject, c, cRun, { action: "task_claim", graphId: "path-conflict", taskId: "y", idempotencyKey: "y-author" })).rejects.toThrow("TASK_SCOPE_CONFLICT");
	subprocess = async (options: any) => { repairInvocation = options; expect(path.resolve(options.cwd)).toBe(path.resolve(a)); fs.writeFileSync(path.join(a, "src", "a.ts"), "export const a = 1;\n"); git(a, "add", "src/a.ts"); git(a, "commit", "-m", "a"); return { exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS" } } }; };
	await expect(spawn(aProject, a, aRun, "wrong", { agent: "repair-worker" })).rejects.toThrow("TASK_CLAIM_REQUIRED");
	expect(await spawn(aProject, a, aRun, "a-author", { agent: "repair-worker", graphId: "graph-main", taskId: "a", claimToken: aClaim.claimToken })).toMatchObject({ state: "succeeded", taskKey: "a-author" });
	expect(repairInvocation.agent.name).toBe("repair-worker"); expect(repairInvocation.modelOverride).toEqual(["openai-codex/gpt-5.6-terra:high"]);
	expect(hooks.get("tool_call")({ toolName: "bash", input: { command: "git status --porcelain" } }, { cwd: a, sessionManager: { getEntries: () => [], getSessionId: () => "session-a" } })).toBeUndefined();
	expect(hooks.get("tool_call")({ toolName: "bash", input: { cwd: "../b", command: "git status --porcelain" } }, { cwd: a, sessionManager: { getEntries: () => [], getSessionId: () => "session-a" } })).toMatchObject({ block: true });
	const gen = String((await call(aProject, a, aRun, { action: "generation_get" })).generation);
	subprocess = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS", runId: aRun, generation: gen, findings: [], evidence: ["lab gate"] } } });
	const gate = await execute("a-verification", { action: "project_spawn", projectId: aProject, runId: aRun, idempotencyKey: "a-verification", agent: "verifier", gate: "verification", task: "verify", outputSchema: verifySchema }, new AbortController().signal, () => {}, { cwd: a, settings, sessionManager: { getSessionId: () => "session-a", getEntries: () => [] } }); expect(gate.details.state).toBe("succeeded");
	fs.writeFileSync(path.join(a, "src", "a.ts"), "export const a = 2;\n"); git(a, "add", "src/a.ts"); git(a, "commit", "-m", "stale gate source");
	await expect(call(aProject, a, aRun, { action: "task_deliver", graphId: "graph-main", taskId: "a", claimToken: aClaim.claimToken })).rejects.toThrow("TASK_GATES_REQUIRED");
	const refreshedGate = await execute("a-reverification", { action: "project_spawn", projectId: aProject, runId: aRun, idempotencyKey: "a-reverification", agent: "verifier", gate: "verification", task: "verify", outputSchema: verifySchema }, new AbortController().signal, () => {}, { cwd: a, settings, sessionManager: { getSessionId: () => "session-a", getEntries: () => [] } }); expect(refreshedGate.details.state).toBe("succeeded");
	expect(await call(aProject, a, aRun, { action: "task_deliver", graphId: "graph-main", taskId: "a", claimToken: aClaim.claimToken })).toMatchObject({ state: "delivered", integrated: false });
	await expect(call(cProject, c, cRun, { action: "task_claim", graphId: "graph-main", taskId: "c", idempotencyKey: "c-author" })).rejects.toThrow("UPSTREAM_COMMIT_REQUIRED");
	git(c, "merge", "--no-edit", head(a)); git(d, "merge", "--no-edit", head(a));
	expect((await call(cProject, c, cRun, { action: "task_claim", graphId: "graph-main", taskId: "c", idempotencyKey: "c-author" })).ok).toBe(true);
	await expect(call(dProject, d, dRun, { action: "task_claim", graphId: "graph-main", taskId: "d", idempotencyKey: "d-author" })).rejects.toThrow("UPSTREAM_NOT_INTEGRATED");
	git(target, "merge", "--ff-only", head(a)); expect((await call(dProject, d, dRun, { action: "task_claim", graphId: "graph-main", taskId: "d", idempotencyKey: "d-author" })).ok).toBe(true);
	subprocess = async () => { git(b, "mv", "src/base.ts", "src/b.ts"); git(b, "commit", "-m", "out of scope rename"); return { exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS" } } }; };
	expect(await spawn(bProject, b, bRun, "b-author", { graphId: "graph-main", taskId: "b", claimToken: bClaim.claimToken })).toMatchObject({ state: "succeeded" });
	const bGen = String((await call(bProject, b, bRun, { action: "generation_get" })).generation);
	subprocess = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS", runId: bRun, generation: bGen, findings: [], evidence: ["lab gate"] } } });
	await execute("b-verification", { action: "project_spawn", projectId: bProject, runId: bRun, idempotencyKey: "b-verification", agent: "verifier", gate: "verification", task: "verify", outputSchema: verifySchema }, new AbortController().signal, () => {}, { cwd: b, settings, sessionManager: { getSessionId: () => "session-b", getEntries: () => [] } });
	await expect(call(bProject, b, bRun, { action: "task_deliver", graphId: "graph-main", taskId: "b", claimToken: bClaim.claimToken })).rejects.toThrow("TASK_SCOPE_VIOLATION");
	expect(await call(bProject, b, bRun, { action: "task_claim_reconcile", graphId: "graph-main", taskId: "b", claimToken: bClaim.claimToken })).toMatchObject({ state: "failed" });
	const space = path.join(root, "leading-space"); git(target, "worktree", "add", "-b", "task-leading-space", space, "HEAD");
	const spaceProject = String((await register(space)).projectId), spaceRun = String((await call(spaceProject, space, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	expect((await call(targetProject, target, targetRun, { action: "task_graph_create", graphId: "leading-space", graphPlan: { targetRef: "main", tasks: [{ id: "space", writePaths: ["outside.ts"], sharedResources: [], dependsOn: [] }] } })).ok).toBe(true);
	const spaceClaim = await call(spaceProject, space, spaceRun, { action: "task_claim", graphId: "leading-space", taskId: "space", idempotencyKey: "space-author" });
	subprocess = async () => { fs.writeFileSync(path.join(space, " outside.ts"), "export const leading = true;\n"); git(space, "add", "--", " outside.ts"); git(space, "commit", "-m", "leading path"); return { exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS" } } }; };
	await spawn(spaceProject, space, spaceRun, "space-author", { graphId: "leading-space", taskId: "space", claimToken: spaceClaim.claimToken });
	const spaceGen = String((await call(spaceProject, space, spaceRun, { action: "generation_get" })).generation);
	subprocess = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS", runId: spaceRun, generation: spaceGen, findings: [], evidence: ["lab gate"] } } });
	await execute("space-verification", { action: "project_spawn", projectId: spaceProject, runId: spaceRun, idempotencyKey: "space-verification", agent: "verifier", gate: "verification", task: "verify", outputSchema: verifySchema }, new AbortController().signal, () => {}, { cwd: space, settings, sessionManager: { getSessionId: () => "session-leading-space", getEntries: () => [] } });
	await expect(call(spaceProject, space, spaceRun, { action: "task_deliver", graphId: "leading-space", taskId: "space", claimToken: spaceClaim.claimToken })).rejects.toThrow("TASK_SCOPE_VIOLATION");
}, 30_000);
