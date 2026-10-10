import { afterAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
const { AgentRegistry } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/registry/agent-registry.ts`);
const { Settings } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts`);
const { z } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/omptype/src/zod.ts`);
import control, { closeControlDb, dispatchAt, openControlDbAt, setControlTestDb, sourceFingerprint } from "../omp/agent/extensions/omp-control.ts";

const LAB = path.resolve("D:/Labs/omp/omp-automation-lab-20260918");
const MARKER = "omp-automation-lab/v1";
const SCRIPT = path.resolve(import.meta.dir, "../scripts/omp-automation-faults.ts");
const settings = Settings.isolated();
const authorSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" }, evidence: { type: "array", items: { type: "string" } } }, required: ["status", "evidence"] };
const gateSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" }, findings: { type: "array", items: { type: "object", additionalProperties: false, properties: {}, required: [] } }, evidence: { type: "array", items: { type: "string" } } }, required: ["status", "runId", "generation", "findings", "evidence"] };
const taskRecoverySchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" }, reconcilesTaskKey: { type: "string" }, processesStopped: { type: "boolean" }, sideEffectsKnown: { type: "boolean" }, findings: { type: "array", items: { type: "object", additionalProperties: false, properties: {}, required: [] } }, evidence: { type: "array", items: { type: "string" } } }, required: ["status", "runId", "generation", "reconcilesTaskKey", "processesStopped", "sideEffectsKnown", "findings", "evidence"] };
const mergeRecoverySchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" }, reconcilesMergeGraphId: { type: "string" }, reconcilesMergeTaskId: { type: "string" }, reconcilesMergeAttemptId: { type: "string" }, processesStopped: { type: "boolean" }, sideEffectsKnown: { type: "boolean" }, targetHead: { type: "string" }, candidateHead: { type: "string" }, candidateSourceFingerprint: { type: "string" }, findings: { type: "array", items: { type: "object", additionalProperties: false, properties: {}, required: [] } }, evidence: { type: "array", items: { type: "string" } } }, required: ["status", "runId", "generation", "reconcilesMergeGraphId", "reconcilesMergeTaskId", "reconcilesMergeAttemptId", "processesStopped", "sideEffectsKnown", "targetHead", "candidateHead", "candidateSourceFingerprint", "findings", "evidence"] };

function assertLab() {
	const root = fs.realpathSync.native(LAB);
	for (const name of [".omp-experiment-root", ".omp-automation-lab-root"]) {
		if (!/^D:[\\/]/i.test(root) || fs.readFileSync(path.join(root, name), "utf8").trim() !== MARKER) throw new Error("AUTOMATION_LAB_MARKER_INVALID");
	}
	return root;
}
const lab = assertLab();

function write(file: string, value: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); }
function cmd(cwd: string, args: string[], fail = true) { const out = Bun.spawnSync({ cmd: args, cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } }); if (fail && out.exitCode !== 0) throw new Error(`${args.join(" ")}: ${out.stderr.toString()}`); return out; }
function git(cwd: string, ...args: string[]) { return cmd(cwd, ["git", "-C", cwd, ...args]); }
function head(cwd: string) { return git(cwd, "rev-parse", "HEAD").stdout.toString().trim(); }
function status(cwd: string) { return git(cwd, "status", "--porcelain").stdout.toString().trim(); }
function waitFile(file: string, timeout = 15_000): Promise<void> { return (async () => { const deadline = Date.now() + timeout; while (!fs.existsSync(file)) { if (Date.now() > deadline) throw new Error(`CHECKPOINT_TIMEOUT:${file}`); await Bun.sleep(25); } })(); }
async function waitGone(recorded: Identity[], timeout = 15_000): Promise<void> { const deadline = Date.now() + timeout; while (identities(recorded.map(item => item.pid)).some(current => recorded.some(prior => prior.pid === current.pid && prior.creation === current.creation))) { if (Date.now() > deadline) throw new Error(`OWNED_DESCENDANT_DID_NOT_EXIT:${recorded.map(item => item.pid).join(",")}`); await Bun.sleep(100); } }

type Identity = { pid: number; parentPid: number; creation: string; executable: string; commandLine: string };
function identities(pids: number[]): Identity[] {
	const unique = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))]; if (!unique.length) return [];
	const script = `$ids=@(${unique.join(",")}); $rows=Get-CimInstance Win32_Process | Where-Object {$ids -contains [int]$_.ProcessId} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;creation=$_.CreationDate.ToUniversalTime().ToString('o');executable=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}}; $rows|ConvertTo-Json -Compress`;
	const out = Bun.spawnSync({ cmd: ["powershell", "-NoProfile", "-NonInteractive", "-Command", script], stdout: "pipe", stderr: "pipe" });
	if (out.exitCode !== 0) throw new Error(out.stderr.toString()); const text = out.stdout.toString().trim(); if (!text) return []; const parsed = JSON.parse(text) as Identity | Identity[]; return Array.isArray(parsed) ? parsed : [parsed];
}
function processIdentity(pid: number): Identity | null { if (!Number.isInteger(pid) || pid <= 0) throw new Error("PID_INVALID"); return identities([pid])[0] ?? null; }
function descendants(rootPid: number): Identity[] {
	const script = "$all=Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;creation=$_.CreationDate.ToUniversalTime().ToString('o');executable=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}}; $ids=@(" + rootPid + "); $out=@(); do {$next=@($all|Where-Object {$ids -contains $_.parentPid -and $out.pid -notcontains $_.pid}); $out+=$next; $ids=$next.pid} while($next.Count); $out|ConvertTo-Json -Compress";
	const out = Bun.spawnSync({ cmd: ["powershell", "-NoProfile", "-NonInteractive", "-Command", script], stdout: "pipe", stderr: "pipe" }); if (out.exitCode !== 0) throw new Error(out.stderr.toString()); const text = out.stdout.toString().trim(); return text ? (Array.isArray(JSON.parse(text)) ? JSON.parse(text) : [JSON.parse(text)]) : [];
}
function mergeDescendants(f: ReturnType<typeof fixture>, rootPid: number) { const raw = descendants(rootPid); const canonical = (value: string) => value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase(); const fixtureRoot = canonical(f.root); const owned = raw.filter(item => canonical(item.commandLine).includes(fixtureRoot) && (/\\git\.exe$/i.test(item.executable) || /post-merge/.test(item.commandLine))); if (owned.filter(item => /\\git\.exe$/i.test(item.executable)).length < 2 || !owned.some(item => /post-merge/.test(item.commandLine))) throw new Error(`OWNED_GIT_HOOK_CHAIN_INCOMPLETE:${JSON.stringify(raw)}`); return { raw, owned }; }
function assertSame(recorded: Identity, expectedParent: number, expectedCommand: string) {
	const current = processIdentity(recorded.pid); if (!current || current.parentPid !== expectedParent || current.creation !== recorded.creation || current.executable !== recorded.executable || current.commandLine !== recorded.commandLine || !current.commandLine.includes(expectedCommand)) throw new Error(`OWNED_PID_IDENTITY_CHANGED:${recorded.pid}`);
}
function killOwned(recorded: Identity, expectedParent: number, command: string) {
	assertSame(recorded, expectedParent, command);
	const out = Bun.spawnSync({ cmd: ["taskkill", "/PID", String(recorded.pid), "/F"], stdout: "pipe", stderr: "pipe" }); if (out.exitCode !== 0) throw new Error(`OWNED_KILL_FAILED:${out.stderr.toString()}`); return { pid: recorded.pid, tree: false, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
}

let execute: any; let mock: (options: any) => Promise<any> = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "completed", evidence: ["deterministic mock executor"] } } });
function install(db: string) {
	closeControlDb();
	setControlTestDb(db);
	control({ zod: z, pi: { AgentRegistry, runSubprocess: (options: any) => mock(options) }, registerTool: (tool: any) => { execute = tool.execute; }, registerCommand() {} } as never);
}
function call(db: string, owner: string, projectId: string, cwd: string, runId: string | undefined, input: Record<string, unknown>) { return dispatchAt(db, { projectId, ...(runId ? { runId } : {}), ...input } as never, { sessionId: owner, cwd, settings }); }
function register(db: string, owner: string, cwd: string) { return dispatchAt(db, { action: "project_register", canonicalRoot: cwd } as never, { sessionId: owner, cwd, settings }); }
async function writerCount(db: string, owner: string, projectId: string, cwd: string) { return ((await call(db, owner, projectId, cwd, undefined, { action: "workspace_status" })).writers as unknown[]).length; }
async function spawn(db: string, owner: string, cwd: string, key: string, input: Record<string, unknown>) {
	const out = await execute(key, input, new AbortController().signal, () => {}, { cwd, settings, sessionManager: { getSessionId: () => owner, getEntries: () => [] } });
	if (out.isError) throw new Error(JSON.stringify(out.content)); return out.details;
}

function fixture(label: string) {
	const root = path.join(lab, "faults", `${label}-${crypto.randomUUID()}`); const target = path.join(root, "target"); const authorA = path.join(root, "author-a"); const authorB = path.join(root, "author-b"); const db = path.join(root, "controller.sqlite");
	fs.mkdirSync(target, { recursive: true }); git(target, "init", "-b", "main", target); git(target, "config", "user.email", "automation-fault@example.invalid"); git(target, "config", "user.name", "automation fault"); fs.mkdirSync(path.join(target, "src")); fs.writeFileSync(path.join(target, "src", "base.ts"), "export const base = true;\n"); git(target, "add", "."); git(target, "commit", "-m", "base");
	for (const [branch, cwd] of [["fault-a", authorA], ["fault-b", authorB]] as const) git(target, "worktree", "add", "-b", branch, cwd, "HEAD");
	return { root, target, authorA, authorB, db };
}

async function graphClaim(f: ReturnType<typeof fixture>, taskId: string, author: string, owner: string, graphId = "fault") {
	install(f.db); const targetProject = String((await register(f.db, owner, f.target)).projectId); const authorProject = String((await register(f.db, owner, author)).projectId); const targetRun = String((await call(f.db, owner, targetProject, f.target, undefined, { action: "run_begin", risk: "mechanical" })).runId); const authorRun = String((await call(f.db, owner, authorProject, author, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	expect((await call(f.db, owner, targetProject, f.target, targetRun, { action: "task_graph_create", graphId, graphPlan: { targetRef: "main", tasks: [{ id: taskId, writePaths: [`src/${taskId}.ts`], sharedResources: [], dependsOn: [] }] } })).ok).toBe(true);
	const claim = await call(f.db, owner, authorProject, author, authorRun, { action: "task_claim", graphId, taskId, idempotencyKey: `${taskId}-author` });
	return { targetProject, authorProject, targetRun, authorRun, claim, graphId };
}

function host(f: ReturnType<typeof fixture>, label: string, cwd: string, owner: string, input: Record<string, unknown>) {
	const dir = path.join(f.root, "hosts", label); const helper = path.join(dir, "helper.json"); const result = path.join(dir, "result.json"); const config = path.join(dir, "host.json"); const checkpoint = path.join(dir, "helper-ready.json"); const hostReady = path.join(dir, "host-ready.json"); const release = path.join(dir, "release");
	write(helper, { checkpoint, release, taskMarker: label }); write(config, { db: f.db, cwd, owner, taskKey: String(input.idempotencyKey), helper, input, result, hostReady });
	const child = Bun.spawn({ cmd: [process.execPath, SCRIPT, "--spawn-host", config], cwd: dir, stdout: "pipe", stderr: "pipe" }); return { child, checkpoint, hostReady, release, result, config };
}

function recordedProcess(file: string): Identity { if (!fs.existsSync(file)) throw new Error("OWNED_HOST_NOT_READY"); const record = JSON.parse(fs.readFileSync(file, "utf8")); const identity = processIdentity(record.pid); if (!identity || identity.parentPid !== record.parentPid || identity.executable !== record.execPath || !identity.commandLine.includes("omp-automation-faults.ts")) throw new Error("OWNED_HOST_IDENTITY_INVALID"); return identity; }
function recordedHost(h: ReturnType<typeof host>): Identity { return recordedProcess(h.hostReady); }

async function mockTaskRecovery(f: ReturnType<typeof fixture>, context: Awaited<ReturnType<typeof graphClaim>>, owner: string, taskKey: string, key = `${taskKey}-proof`, overrides: Partial<Record<string, unknown>> = {}) {
	const sideEffects = path.join(f.root, "inspections", `${key}.json`); write(sideEffects, { taskKey, deterministicMock: true, authorRoot: f.authorA, gitHead: head(f.authorA), gitStatus: status(f.authorA), ownedHelperPid: null, actualProcessInspection: "owned helper/host intervention recorded separately" });
	const generation = String((await call(f.db, owner, context.authorProject, f.authorA, context.authorRun, { action: "generation_get" })).generation);
	mock = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS", runId: context.authorRun, generation, reconcilesTaskKey: taskKey, processesStopped: true, sideEffectsKnown: true, findings: [], evidence: [sideEffects], ...overrides } } });
	await spawn(f.db, owner, f.authorA, key, { action: "project_spawn", projectId: context.authorProject, runId: context.authorRun, idempotencyKey: key, agent: "verifier", task: "deterministic mock recovery verifier", outputSchema: taskRecoverySchema });
	return call(f.db, owner, context.authorProject, f.authorA, context.authorRun, { action: "task_reconcile", idempotencyKey: taskKey, evidenceTaskKey: key });
}

async function cleanHost(f: ReturnType<typeof fixture>, h: ReturnType<typeof host>, label: string) {
	fs.mkdirSync(path.dirname(h.release), { recursive: true }); fs.writeFileSync(h.release, "release\n");
	let helperStopped = false;
	if (fs.existsSync(h.checkpoint)) {
		const helper = JSON.parse(fs.readFileSync(h.checkpoint, "utf8")); const identity = processIdentity(helper.pid);
		if (identity) { try { await waitGone([identity], 5_000); helperStopped = true; } catch { killOwned(identity, Number(helper.parentPid), "omp-automation-faults.ts"); await waitGone([identity], 5_000); helperStopped = true; } }
	}
	if (fs.existsSync(h.hostReady)) { try { const hostIdentity = recordedHost(h); killOwned(hostIdentity, hostIdentity.parentPid, "omp-automation-faults.ts"); } catch { /* preserved evidence is safer than an unverified kill */ } }
	await Promise.race([h.child.exited, Bun.sleep(5_000)]);
	write(path.join(f.root, "cleanup", `${label}.json`), { releaseWritten: true, helperKnown: fs.existsSync(h.checkpoint), helperStopped, hostLauncherPid: h.child.pid });
}

async function gate(db: string, owner: string, projectId: string, cwd: string, runId: string, key: string) {
	const generation = String((await call(db, owner, projectId, cwd, runId, { action: "generation_get" })).generation);
	mock = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS", runId, generation, findings: [], evidence: ["deterministic mock gate"] } } });
	expect(await spawn(db, owner, cwd, key, { action: "project_spawn", projectId, runId, idempotencyKey: key, agent: "verifier", gate: "verification", task: "deterministic mock gate", outputSchema: gateSchema })).toMatchObject({ state: "succeeded" });
	expect(await call(db, owner, projectId, cwd, runId, { action: "run_complete" })).toMatchObject({ taskComplete: true });
}

function armPostMergeHook(f: ReturnType<typeof fixture>, phase: string, cwd: string) {
	const hooks = path.join(f.root, "hooks"), config = path.join(f.root, `hook-${phase}.env`), checkpoint = path.join(f.root, "checkpoints", `${phase}.ready`), release = path.join(f.root, "checkpoints", `${phase}.release`);
	fs.mkdirSync(hooks, { recursive: true }); fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
	const shell = `#!/bin/sh\nset -eu\nconfig=\"$(git config --get omp.automationfaultfile || true)\"\n[ -n \"$config\" ] || exit 0\n. \"$config\"\ncurrent=\"$(pwd -W 2>/dev/null || pwd)\"\n[ \"$current\" = \"$worktree\" ] || exit 0\nprintf '%s|%s|%s|%s\\n' \"$$\" \"$PPID\" \"$current\" \"$(git rev-parse HEAD)\" > \"$checkpoint\"\nwhile [ ! -f \"$release\" ]; do sleep 1; done\n`;
	fs.writeFileSync(path.join(hooks, "post-merge"), shell, "utf8");
	fs.writeFileSync(config, `worktree=${cwd.replace(/\\/g, "/")}\ncheckpoint=${checkpoint.replace(/\\/g, "/")}\nrelease=${release.replace(/\\/g, "/")}\n`, "utf8");
	git(f.target, "config", "core.hooksPath", hooks); git(f.target, "config", "omp.automationfaultfile", config);
	return { checkpoint, release };
}

async function mergeRecoveryProof(f: ReturnType<typeof fixture>, owner: string, target: { projectId: string; runId: string }, candidate: { cwd: string }, graphId: string, taskId: string, attemptId: string, key: string, overrides: Partial<Record<string, unknown>> = {}) {
	const generation = String((await call(f.db, owner, target.projectId, f.target, target.runId, { action: "generation_get" })).generation);
	const inspection = path.join(f.root, "inspections", `${key}.json`);
	mock = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS", runId: target.runId, generation, reconcilesMergeGraphId: graphId, reconcilesMergeTaskId: taskId, reconcilesMergeAttemptId: attemptId, processesStopped: true, sideEffectsKnown: true, targetHead: head(f.target), candidateHead: head(candidate.cwd), candidateSourceFingerprint: sourceFingerprint(candidate.cwd), findings: [], evidence: [inspection], ...overrides } } });
	write(inspection, { targetHead: head(f.target), candidateHead: head(candidate.cwd), targetStatus: status(f.target), candidateStatus: status(candidate.cwd), deterministicMock: true, labelled: "deterministic mock verifier after actual process/Git inspection" });
	return spawn(f.db, owner, f.target, key, { action: "project_spawn", projectId: target.projectId, runId: target.runId, idempotencyKey: key, agent: "verifier", task: "deterministic mock merge recovery proof", outputSchema: mergeRecoverySchema });
}

test("cleanup releases a checkpointed detached helper after its verified host is already gone", async () => {
	const f = fixture("cleanup-release"), owner = `owner-${crypto.randomUUID()}`; const a = await graphClaim(f, "cleanup", f.authorA, owner, "cleanup-release");
	const h = host(f, "cleanup", f.authorA, owner, { action: "project_spawn", projectId: a.authorProject, runId: a.authorRun, idempotencyKey: "cleanup-author", agent: "fast-worker", task: "owned helper cleanup release", outputSchema: authorSchema, graphId: a.graphId, taskId: "cleanup", claimToken: a.claim.claimToken });
	try {
		await Promise.all([waitFile(h.hostReady), waitFile(h.checkpoint)]); const helper = JSON.parse(fs.readFileSync(h.checkpoint, "utf8")); const identity = processIdentity(helper.pid)!; const hostIdentity = recordedHost(h); killOwned(hostIdentity, hostIdentity.parentPid, "omp-automation-faults.ts"); await h.child.exited;
		expect(processIdentity(identity.pid)?.creation).toBe(identity.creation); await cleanHost(f, h, "host-gone-release"); expect(processIdentity(identity.pid)).toBeNull(); expect(fs.existsSync(h.release)).toBe(true);
	} finally { await cleanHost(f, h, "host-gone-release-finally"); }
}, 45_000);

test("A and S: an owned helper interruption is distinct from the mock receipt and does not settle its sibling", async () => {
	const f = fixture("author-sibling"); const owner = `owner-${crypto.randomUUID()}`; const a = await graphClaim(f, "alpha", f.authorA, owner, "siblings");
	const bProject = String((await register(f.db, owner, f.authorB)).projectId); const bRun = String((await call(f.db, owner, bProject, f.authorB, undefined, { action: "run_begin", risk: "mechanical" })).runId);
	expect((await call(f.db, owner, a.targetProject, f.target, a.targetRun, { action: "task_graph_create", graphId: "siblings-b", graphPlan: { targetRef: "main", tasks: [{ id: "beta", writePaths: ["src/beta.ts"], sharedResources: [], dependsOn: [] }] } })).ok).toBe(true);
	const bClaim = await call(f.db, owner, bProject, f.authorB, bRun, { action: "task_claim", graphId: "siblings-b", taskId: "beta", idempotencyKey: "beta-author" });
	const ah = host(f, "alpha", f.authorA, owner, { action: "project_spawn", projectId: a.authorProject, runId: a.authorRun, idempotencyKey: "alpha-author", agent: "fast-worker", task: "owned helper author alpha", outputSchema: authorSchema, graphId: a.graphId, taskId: "alpha", claimToken: a.claim.claimToken });
	const bh = host(f, "beta", f.authorB, owner, { action: "project_spawn", projectId: bProject, runId: bRun, idempotencyKey: "beta-author", agent: "fast-worker", task: "owned helper author beta", outputSchema: authorSchema, graphId: "siblings-b", taskId: "beta", claimToken: bClaim.claimToken });
	try {
		await Promise.all([waitFile(ah.checkpoint), waitFile(bh.checkpoint)]); const ar = JSON.parse(fs.readFileSync(ah.checkpoint, "utf8")); const br = JSON.parse(fs.readFileSync(bh.checkpoint, "utf8")); const ai = processIdentity(ar.pid)!; const bi = processIdentity(br.pid)!;
		const alphaHost = recordedHost(ah); write(path.join(f.root, "intervention-alpha.json"), { host: alphaHost, helper: ai, siblingHelper: bi, action: killOwned(ai, alphaHost.pid, "omp-automation-faults.ts") }); await ah.child.exited;
		expect(openControlDbAt(f.db).query<any, [string, string]>("SELECT state FROM control_tasks WHERE project_id=? AND task_key=?").get(a.authorProject, "alpha-author").state).toBe("interrupted");
		expect(openControlDbAt(f.db).query<any, [string, string]>("SELECT state FROM control_tasks WHERE project_id=? AND task_key=?").get(bProject, "beta-author").state).toBe("running"); expect(await writerCount(f.db, owner, bProject, f.authorB)).toBe(1);
		await expect(call(f.db, owner, a.authorProject, f.authorA, a.authorRun, { action: "task_claim_reconcile", graphId: a.graphId, taskId: "alpha", claimToken: a.claim.claimToken })).rejects.toThrow("RECONCILIATION_REQUIRED");
		await expect(mockTaskRecovery(f, a, owner, "alpha-author", "alpha-wrong-run", { runId: "foreign-run" })).rejects.toThrow("RECONCILIATION_REQUIRED");
		expect(await mockTaskRecovery(f, a, owner, "alpha-author")).toMatchObject({ state: "failed", requiresNewGeneration: true }); expect(await call(f.db, owner, a.authorProject, f.authorA, a.authorRun, { action: "task_claim_reconcile", graphId: a.graphId, taskId: "alpha", claimToken: a.claim.claimToken })).toMatchObject({ state: "interrupted" });
		expect(await writerCount(f.db, owner, bProject, f.authorB)).toBe(1);
		fs.writeFileSync(bh.release, "release\n"); await bh.child.exited;
		fs.writeFileSync(path.join(f.authorB, "src", "beta.ts"), "export const beta = true;\n"); git(f.authorB, "add", "src/beta.ts"); git(f.authorB, "commit", "-m", "beta sibling completed"); await gate(f.db, owner, bProject, f.authorB, bRun, "beta-gate");
		expect(await call(f.db, owner, bProject, f.authorB, bRun, { action: "task_deliver", graphId: "siblings-b", taskId: "beta", claimToken: bClaim.claimToken })).toMatchObject({ state: "delivered" });
		expect(await writerCount(f.db, owner, bProject, f.authorB)).toBe(0); const betaGraph = await call(f.db, owner, a.targetProject, f.target, a.targetRun, { action: "task_graph_status", graphId: "siblings-b" }); expect((betaGraph.nodes as any[])[0]).toMatchObject({ state: "delivered" });
	} finally { await cleanHost(f, ah, "alpha"); await cleanHost(f, bh, "beta"); }
}, 90_000);

test("R: host-only loss leaves its verified helper alive and blocks recovery until that owned child is separately stopped", async () => {
	const f = fixture("root-interruption"); const owner = `owner-${crypto.randomUUID()}`; const a = await graphClaim(f, "rootstop", f.authorA, owner);
	const h = host(f, "rootstop", f.authorA, owner, { action: "project_spawn", projectId: a.authorProject, runId: a.authorRun, idempotencyKey: "rootstop-author", agent: "fast-worker", task: "owned helper root interruption", outputSchema: authorSchema, graphId: a.graphId, taskId: "rootstop", claimToken: a.claim.claimToken });
	try {
		await Promise.all([waitFile(h.hostReady), waitFile(h.checkpoint)]); const helper = JSON.parse(fs.readFileSync(h.checkpoint, "utf8")); const hostIdentity = recordedHost(h); const helperIdentity = processIdentity(helper.pid)!; const tree = descendants(hostIdentity.pid); if (!tree.some(item => item.pid === helperIdentity.pid)) throw new Error("OWNED_HELPER_NOT_DESCENDANT");
		write(path.join(f.root, "intervention-root-host-only.json"), { host: hostIdentity, descendants: tree, action: killOwned(hostIdentity, hostIdentity.parentPid, "omp-automation-faults.ts") }); await h.child.exited;
		expect(openControlDbAt(f.db).query<any, [string, string]>("SELECT state FROM control_tasks WHERE project_id=? AND task_key=?").get(a.authorProject, "rootstop-author").state).toBe("running"); expect(processIdentity(helperIdentity.pid)?.creation).toBe(helperIdentity.creation);
		const workspace = await call(f.db, owner, a.authorProject, f.authorA, undefined, { action: "workspace_status" }); const token = String((workspace.writers as any[])[0].token);
		await expect(call(f.db, owner, a.authorProject, f.authorA, undefined, { action: "workspace_reconcile", token, payload: JSON.stringify({ processesStopped: true, sideEffectsKnown: true, evidence: ["cannot override live owned helper"] }) })).rejects.toThrow("TASK_ACTIVE");
		write(path.join(f.root, "intervention-root-helper.json"), { helper: helperIdentity, action: killOwned(helperIdentity, hostIdentity.pid, "omp-automation-faults.ts") }); await waitGone([helperIdentity]);
		const workspaceInspection = path.join(f.root, "inspections", "rootstop-workspace.json"); write(workspaceInspection, { hostPid: hostIdentity.pid, helperPid: helperIdentity.pid, helperStopped: true, authorHead: head(f.authorA), authorStatus: status(f.authorA) });
		expect(await call(f.db, owner, a.authorProject, f.authorA, undefined, { action: "workspace_reconcile", token, payload: JSON.stringify({ processesStopped: true, sideEffectsKnown: true, evidence: [workspaceInspection] }) })).toMatchObject({ reconciled: true }); expect(await writerCount(f.db, owner, a.authorProject, f.authorA)).toBe(0);
		await expect(mockTaskRecovery(f, a, owner, "rootstop-author", "rootstop-wrong-run", { runId: "foreign-run" })).rejects.toThrow("RECONCILIATION_REQUIRED");
		expect(await mockTaskRecovery(f, a, owner, "rootstop-author")).toMatchObject({ state: "failed" }); expect(await call(f.db, owner, a.authorProject, f.authorA, a.authorRun, { action: "task_claim_reconcile", graphId: a.graphId, taskId: "rootstop", claimToken: a.claim.claimToken })).toMatchObject({ state: "interrupted" });
	} finally { await cleanHost(f, h, "rootstop"); }
}, 90_000);

test("M: post-merge checkpoints preserve real prepare and apply Git facts across owned-host loss without database phase mutation", async () => {
	const f = fixture("merge-lost-response"), owner = `owner-${crypto.randomUUID()}`, graphId = "merge-fault", taskId = "deliver"; const initial = await graphClaim(f, taskId, f.authorA, owner, graphId);
	mock = async () => ({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "completed", evidence: ["deterministic mock author"] } } });
	expect(await spawn(f.db, owner, f.authorA, "deliver-author", { action: "project_spawn", projectId: initial.authorProject, runId: initial.authorRun, idempotencyKey: "deliver-author", agent: "fast-worker", task: "deterministic author before real Git merge", outputSchema: authorSchema, graphId, taskId, claimToken: initial.claim.claimToken })).toMatchObject({ state: "succeeded" });
	fs.writeFileSync(path.join(f.authorA, "src", "deliver.ts"), "export const delivered = true;\n"); git(f.authorA, "add", "src/deliver.ts"); git(f.authorA, "commit", "-m", "deliver"); await gate(f.db, owner, initial.authorProject, f.authorA, initial.authorRun, "deliver-gate");
	expect(await call(f.db, owner, initial.authorProject, f.authorA, initial.authorRun, { action: "task_deliver", graphId, taskId, claimToken: initial.claim.claimToken })).toMatchObject({ state: "delivered" });
	const candidate = path.join(f.root, "candidate"); git(f.target, "worktree", "add", "-b", "merge-candidate", candidate, "HEAD"); const candidateProject = String((await register(f.db, owner, candidate)).projectId); const candidateRun = String((await call(f.db, owner, candidateProject, candidate, undefined, { action: "run_begin", risk: "mechanical" })).runId); const target = { projectId: initial.targetProject, runId: initial.targetRun };
	const queued = await call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_enqueue", graphId, taskId, idempotencyKey: "lost" }); const token = String(queued.claimToken); const prepareHook = armPostMergeHook(f, "prepare", candidate);
	const prepareConfig = path.join(f.root, "hosts", "prepare", "host.json"), prepareReady = path.join(f.root, "hosts", "prepare", "host-ready.json"); write(prepareConfig, { db: f.db, cwd: candidate, owner, input: { action: "merge_prepare", projectId: candidateProject, runId: candidateRun, graphId, taskId, idempotencyKey: "lost", claimToken: token }, result: path.join(f.root, "hosts", "prepare", "result.json"), hostReady: prepareReady }); const prepareHost = Bun.spawn({ cmd: [process.execPath, SCRIPT, "--merge-host", prepareConfig], cwd: path.dirname(prepareConfig), stdout: "pipe", stderr: "pipe" });
	let applyHost: Bun.Subprocess | undefined; let applyHook: ReturnType<typeof armPostMergeHook> | undefined;
	try {
		await Promise.all([waitFile(prepareReady), waitFile(prepareHook.checkpoint)]); const prepareHostIdentity = recordedProcess(prepareReady); const prepareHead = head(candidate); expect(prepareHead).not.toBe(head(f.target)); const preparing = openControlDbAt(f.db).query<any, [string, string, string]>("SELECT state,candidate_head,operation_pid FROM merge_queue_items WHERE graph_id=? AND task_id=? AND attempt_id=?").get(graphId, taskId, "lost"); expect(preparing).toMatchObject({ state: "preparing", candidate_head: null, operation_pid: prepareHostIdentity.pid });
		await expect(call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_reconcile", graphId, taskId, idempotencyKey: "lost", claimToken: token })).rejects.toThrow("TASK_ACTIVE");
		const prepareCheckpoint = fs.readFileSync(prepareHook.checkpoint, "utf8"); const prepareInventory = mergeDescendants(f, prepareHostIdentity.pid); write(path.join(f.root, "intervention-prepare-host-only.json"), { host: prepareHostIdentity, rawDescendants: prepareInventory.raw, ownedGitAndHookDescendants: prepareInventory.owned, hookCheckpoint: prepareCheckpoint, action: killOwned(prepareHostIdentity, prepareHostIdentity.parentPid, "omp-automation-faults.ts"), observedCandidateHead: prepareHead }); await prepareHost.exited;
		fs.writeFileSync(prepareHook.release, "release\n"); await waitGone(prepareInventory.owned); write(path.join(f.root, "intervention-prepare-settled.json"), { releasedCheckpoint: prepareHook.release, checkedOwnedDescendants: prepareInventory.owned.map(item => ({ pid: item.pid, creation: item.creation, alive: identities([item.pid]).some(current => current.creation === item.creation) })) });
		await expect(call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_reconcile", graphId, taskId, idempotencyKey: "lost", claimToken: token })).rejects.toThrow("MERGE_RECOVERY_EVIDENCE"); await mergeRecoveryProof(f, owner, target, { cwd: candidate }, graphId, taskId, "lost", "prepare-wrong", { runId: "foreign-run" }); await expect(call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_reconcile", graphId, taskId, idempotencyKey: "lost", claimToken: token, evidenceTaskKey: "prepare-wrong" })).rejects.toThrow("MERGE_RECOVERY_EVIDENCE");
		await mergeRecoveryProof(f, owner, target, { cwd: candidate }, graphId, taskId, "lost", "prepare-proof"); expect(await call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_reconcile", graphId, taskId, idempotencyKey: "lost", claimToken: token, evidenceTaskKey: "prepare-proof" })).toMatchObject({ state: "candidate_ready", recovered: true, candidateHead: prepareHead });
		await gate(f.db, owner, candidateProject, candidate, candidateRun, "candidate-gate"); expect(await call(f.db, owner, candidateProject, candidate, candidateRun, { action: "merge_verify", graphId, taskId, idempotencyKey: "lost", claimToken: token })).toMatchObject({ state: "verified" });
		applyHook = armPostMergeHook(f, "apply", f.target); const applyConfig = path.join(f.root, "hosts", "apply", "host.json"), applyReady = path.join(f.root, "hosts", "apply", "host-ready.json"); write(applyConfig, { db: f.db, cwd: f.target, owner, input: { action: "merge_apply", projectId: target.projectId, runId: target.runId, graphId, taskId, idempotencyKey: "lost", claimToken: token }, result: path.join(f.root, "hosts", "apply", "result.json"), hostReady: applyReady }); applyHost = Bun.spawn({ cmd: [process.execPath, SCRIPT, "--merge-host", applyConfig], cwd: path.dirname(applyConfig), stdout: "pipe", stderr: "pipe" });
		await Promise.all([waitFile(applyReady), waitFile(applyHook.checkpoint)]); const applyHostIdentity = recordedProcess(applyReady); expect(head(f.target)).toBe(prepareHead); const applying = openControlDbAt(f.db).query<any, [string, string, string]>("SELECT state,operation_pid FROM merge_queue_items WHERE graph_id=? AND task_id=? AND attempt_id=?").get(graphId, taskId, "lost"); expect(applying).toMatchObject({ state: "applying", operation_pid: applyHostIdentity.pid });
		await expect(call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_reconcile", graphId, taskId, idempotencyKey: "lost", claimToken: token })).rejects.toThrow("TASK_ACTIVE");
		const applyCheckpoint = fs.readFileSync(applyHook.checkpoint, "utf8"); const applyInventory = mergeDescendants(f, applyHostIdentity.pid); write(path.join(f.root, "intervention-apply-host-only.json"), { host: applyHostIdentity, rawDescendants: applyInventory.raw, ownedGitAndHookDescendants: applyInventory.owned, hookCheckpoint: applyCheckpoint, action: killOwned(applyHostIdentity, applyHostIdentity.parentPid, "omp-automation-faults.ts"), observedTargetHead: head(f.target) }); await applyHost.exited;
		fs.writeFileSync(applyHook.release, "release\n"); await waitGone(applyInventory.owned); write(path.join(f.root, "intervention-apply-settled.json"), { releasedCheckpoint: applyHook.release, checkedOwnedDescendants: applyInventory.owned.map(item => ({ pid: item.pid, creation: item.creation, alive: identities([item.pid]).some(current => current.creation === item.creation) })) });
		await expect(call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_reconcile", graphId, taskId, idempotencyKey: "lost", claimToken: token })).rejects.toThrow("MERGE_RECOVERY_EVIDENCE"); await mergeRecoveryProof(f, owner, target, { cwd: candidate }, graphId, taskId, "lost", "apply-wrong", { generation: "999" }); await expect(call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_reconcile", graphId, taskId, idempotencyKey: "lost", claimToken: token, evidenceTaskKey: "apply-wrong" })).rejects.toThrow("MERGE_RECOVERY_EVIDENCE");
		await mergeRecoveryProof(f, owner, target, { cwd: candidate }, graphId, taskId, "lost", "apply-proof"); expect(await call(f.db, owner, target.projectId, f.target, target.runId, { action: "merge_reconcile", graphId, taskId, idempotencyKey: "lost", claimToken: token, evidenceTaskKey: "apply-proof" })).toMatchObject({ state: "merged", recovered: true, candidateHead: prepareHead }); expect(head(f.target)).toBe(prepareHead); expect(openControlDbAt(f.db).query("SELECT * FROM merge_integration_locks").all()).toHaveLength(0);
	} finally {
		fs.writeFileSync(prepareHook.release, "release\n");
		if (applyHook) fs.writeFileSync(applyHook.release, "release\n");
		for (const [label, child, ready] of [["prepare", prepareHost, prepareReady], ["apply", applyHost, path.join(f.root, "hosts", "apply", "host-ready.json")]] as const) { if (!child) continue; if (fs.existsSync(ready)) { try { const identity = recordedProcess(ready); killOwned(identity, identity.parentPid, "omp-automation-faults.ts"); } catch { /* only verified host PIDs are ever stopped */ } } await Promise.race([child.exited, Bun.sleep(5_000)]); write(path.join(f.root, "cleanup", `${label}.json`), { launcherPid: child.pid, hostReady: ready, releaseWritten: true }); }
	}
}, 120_000);

afterAll(() => { closeControlDb(); setControlTestDb(null); });
