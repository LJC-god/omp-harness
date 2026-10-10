import { afterAll, beforeAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeModule, runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";
import { pinWindowsDirectory, releaseWindowsDirectoryPin } from "../omp/agent/lib/windows-directory-pin.ts";
const { AgentRegistry } = await import(runtimeModule("pi-coding-agent/src/registry/agent-registry.ts"));
const { Settings } = await import(runtimeModule("pi-coding-agent/src/config/settings.ts"));
const { z } = await import(runtimePackageFile("omptype", "src/zod.ts"));
import control, { closeControlDb, dispatchAt, openControlDbAt, setControlTestDb, setTestAfterRootOpen, setTestBeforeDiagnosticCompletionHash, setTestBeforeDiagnosticCreate, setTestCheckEnvironment, setTestCheckTimeoutMs, setTestDiagnosticStreamFail, setTestDiagnosticWriteFail, setTestDiagnosticWritePartialFail } from "../omp/agent/extensions/omp-control.ts";

function experimentRoot() {
	const configured = process.env.OMP_EXPERIMENT_ROOT;
	if (!configured || !path.isAbsolute(configured) || !/^D:[\\/]/i.test(configured)) throw new Error("INTEGRATION_CONTRACT_TEST_REQUIRES_EXPERIMENT_ROOT");
	const root = fs.realpathSync(path.resolve(configured));
	const marker = path.join(root, ".omp-experiment-root");
	if (fs.readFileSync(marker, "utf8").trim() !== "omp-dependency-lab/v1") throw new Error("INTEGRATION_CONTRACT_TEST_REQUIRES_EXPERIMENT_ROOT");
	return root;
}

const lab = experimentRoot();
const nonce = crypto.randomUUID();
const root = path.join(lab, "worktrees", `integration-contract-${nonce}`);
const db = path.join(lab, "evidence", `integration-contract-${nonce}.sqlite`);
const settings = Settings.isolated();
let execute: any;
let registeredTool: any;

function cmd(cwd: string, args: string[]) {
	const result = Bun.spawnSync({ cmd: args, cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
function git(cwd: string, ...args: string[]) { cmd(cwd, ["git", "-C", cwd, ...args]); }
async function register(cwd: string, owner: string) {
	return dispatchAt(db, { action: "project_register", canonicalRoot: cwd } as never, { cwd, sessionId: owner, settings });
}
async function call(projectId: string, cwd: string, runId: string | undefined, owner: string, input: Record<string, unknown>, signal?: AbortSignal) {
	return dispatchAt(db, { projectId, ...(runId ? { runId } : {}), ...input } as never, { cwd, sessionId: owner, settings, signal });
}
function diagnosticPolicy(name: string) { const evidenceRoot = path.join(root, "evidence", `policy-${name}-${crypto.randomUUID()}`); fs.mkdirSync(evidenceRoot, { recursive: true }); return { schema: "omp-check-diagnostic/v1", root: evidenceRoot }; }
async function integrationBegin(projectId: string, cwd: string, owner: string, input: Record<string, unknown>) {
	return call(projectId, cwd, undefined, owner, { ...input, diagnosticEvidence: input.diagnosticEvidence ?? diagnosticPolicy(path.basename(cwd)) });
}
async function fixture(name: string) {
	const cwd = path.join(root, name); const owner = `session-${name}`;
	fs.mkdirSync(cwd, { recursive: true }); git(cwd, "init", "-b", "main", cwd); git(cwd, "config", "user.email", "integration@example.invalid"); git(cwd, "config", "user.name", "integration");
	fs.mkdirSync(path.join(cwd, "src")); fs.writeFileSync(path.join(cwd, "src", "value.ts"), "export const value = 1;\n"); git(cwd, "add", "."); git(cwd, "commit", "-m", "base");
	const projectId = String((await register(cwd, owner)).projectId);
	return { cwd, owner, projectId };
}

beforeAll(() => {
	fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.dirname(db), { recursive: true });
	setControlTestDb(db);
	control({ zod: z, pi: { AgentRegistry, runSubprocess: async () => ({ exitCode: 0 }) }, registerTool: (tool: any) => { registeredTool = tool; execute = tool.execute; }, registerCommand() {} } as never);
});
afterAll(() => { closeControlDb(); setControlTestDb(null); });

test("integration-v1 freezes and executes its real argv while legacy runs retain model gates", async () => {
	const f = await fixture("success");
	const legacy = await call(f.projectId, f.cwd, undefined, f.owner, { action: "run_begin", risk: "standard" });
	expect(await call(f.projectId, f.cwd, String(legacy.runId), f.owner, { action: "run_complete" })).toMatchObject({ taskComplete: false, requiredGates: ["verification", "security"], productComplete: false });
	await expect(call(f.projectId, f.cwd, String(legacy.runId), f.owner, { action: "run_check", idempotencyKey: "legacy-check" })).rejects.toThrow("INTEGRATION_POLICY_REQUIRED");
	const command = [process.execPath, "-e", "console.log('controller check')"];
	await expect(call(f.projectId, f.cwd, undefined, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: command })).rejects.toThrow("DIAGNOSTIC_EVIDENCE_REQUIRED");
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: command });
	expect(begun).toMatchObject({ requiredGates: ["integration_check"], executionPolicy: "integration-v1" });
	const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "success-check" });
	expect(checked).toMatchObject({ ok: true, state: "succeeded", productComplete: false, result: { status: "PASS", command, exitCode: 0, stale: false } });
	expect((await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "success-check" })).duplicate).toBe(true);
	expect(await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_complete" })).toMatchObject({ taskComplete: true, productComplete: false, requiredGates: ["integration_check"] });
	fs.writeFileSync(path.join(f.cwd, "src", "value.ts"), "export const value = 2;\n"); git(f.cwd, "add", "src/value.ts"); git(f.cwd, "commit", "-m", "next source");
	expect(await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_complete" })).toMatchObject({ taskComplete: false, staleGates: ["integration_check"] });
	const next = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: command });
	expect(await call(f.projectId, f.cwd, String(next.runId), f.owner, { action: "run_check", idempotencyKey: "next-source-check" })).toMatchObject({ ok: true, state: "succeeded" });
	const contract = openControlDbAt(db).query<{ execution_policy: string; check_command_json: string }, [string, string]>("SELECT execution_policy,check_command_json FROM control_run_contracts WHERE project_id=? AND run_id=?").get(f.projectId, String(begun.runId));
	expect(contract).toEqual({ execution_policy: "integration-v1", check_command_json: JSON.stringify(command) });
});

test("failed or source-changing checks cannot be retried or bypassed by a fresh integration run", async () => {
	const f = await fixture("failure");
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "standard", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "require('fs').writeFileSync('src/value.ts','changed\\n')"] });
	const failed = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "mutates-source" });
	expect(failed).toMatchObject({ ok: false, state: "failed", productComplete: false, result: { status: "FAIL", stale: true } });
	await expect(call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "different-key" })).rejects.toThrow("CHECK_ALREADY_SETTLED");
	await expect(integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "standard", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] })).rejects.toThrow("INTEGRATION_CHECK_UNRESOLVED");
	await expect(integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "high", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] })).rejects.toThrow("integration-v1 does not permit high risk");
});

test("a failing actual check retains a sanitized immutable diagnostic receipt outside its source tree", async () => {
	const f = await fixture("diagnostic-failure");
	const evidenceRoot = path.join(root, "evidence", `diagnostics-${crypto.randomUUID()}`);
	fs.mkdirSync(evidenceRoot, { recursive: true });
	const begun = await call(f.projectId, f.cwd, undefined, f.owner, {
		action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1",
		checkCommand: [process.execPath, "-e", "console.error('actual assertion failed: expected green');process.exit(1)"],
		diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: evidenceRoot },
	});
	const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "diagnostic-failure" });
	const receipt = (checked.result as { diagnosticEvidence: { path: string } }).diagnosticEvidence;
	const evidencePath = receipt.path as unknown as string;
	expect(checked).toMatchObject({ ok: false, state: "failed", result: { diagnosticEvidence: { status: "available", path: expect.stringContaining("check-") } } });
	expect(typeof evidencePath).toBe("string");
	expect(evidencePath.startsWith(path.resolve(evidenceRoot) + path.sep)).toBe(true);
	expect(fs.existsSync(evidencePath)).toBe(true);
	await expect(call(f.projectId, f.cwd, undefined, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"], diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: f.cwd } })).rejects.toThrow("DIAGNOSTIC_ROOT_ESCAPE");
});

test("a diagnostic directory replacement attempt cannot redirect evidence to its substitute", async () => {
	const f = await fixture("diagnostic-directory-race");
	const parent = path.join(root, "evidence", `diagnostic-race-${crypto.randomUUID()}`);
	const authorized = path.join(parent, "authorized");
	const displaced = `${parent}-displaced`;
	const substitute = path.join(root, "evidence", `diagnostic-substitute-${crypto.randomUUID()}`);
	const substituteMarker = path.join(substitute, "unchanged.txt");
	fs.mkdirSync(authorized, { recursive: true });
	fs.mkdirSync(substitute, { recursive: true }); fs.writeFileSync(substituteMarker, "substitute stays untouched\n");
	let rootReplaceError: unknown, ancestorReplaceError: unknown, replaceAttempted = false;
	setTestAfterRootOpen(() => {
		replaceAttempted = true;
		try { fs.renameSync(authorized, `${authorized}-displaced`); } catch (error) { rootReplaceError = error; }
		try { fs.renameSync(parent, displaced); fs.renameSync(substitute, parent); } catch (error) { ancestorReplaceError = error; }
	});
	try {
		const begun = await call(f.projectId, f.cwd, undefined, f.owner, {
			action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"],
			diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: authorized },
		});
		const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "diagnostic-directory-race" });
		expect(replaceAttempted).toBe(true);
		expect(rootReplaceError).toMatchObject({ code: "EBUSY" });
		expect(ancestorReplaceError).toMatchObject({ code: "EBUSY" });
		expect(checked).toMatchObject({ ok: true, state: "succeeded" });
		const diagnostic = (checked.result as { diagnosticEvidence: { path: string; sha256: string } }).diagnosticEvidence;
		expect(fs.readdirSync(authorized)).toEqual([path.basename(diagnostic.path)]);
		expect(fs.readFileSync(diagnostic.path, "utf8")).toContain(String(begun.runId));
		expect(diagnostic.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(fs.readFileSync(substituteMarker, "utf8")).toBe("substitute stays untouched\n");
		expect(fs.readdirSync(substitute)).toEqual(["unchanged.txt"]);
	} finally { setTestAfterRootOpen(null); }
});

test("a new diagnostic policy refuses direct root and ancestor replacements before check", async () => {
	for (const mode of ["root", "ancestor"] as const) {
		const f = await fixture(`diagnostic-before-check-${mode}`);
		const parent = path.join(root, "evidence", `diagnostic-before-check-${mode}-${crypto.randomUUID()}`), authorized = path.join(parent, "authorized");
		const substitute = path.join(root, "evidence", `diagnostic-before-check-${mode}-substitute-${crypto.randomUUID()}`), marker = path.join(substitute, "untouched.txt");
		fs.mkdirSync(authorized, { recursive: true }); fs.mkdirSync(substitute, { recursive: true }); fs.writeFileSync(marker, "substitute stays untouched\n");
		const begun = await call(f.projectId, f.cwd, undefined, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"], diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: authorized } });
		if (mode === "root") { fs.renameSync(authorized, `${authorized}-old`); fs.renameSync(substitute, authorized); }
		else { fs.renameSync(parent, `${parent}-old`); fs.mkdirSync(path.join(substitute, "authorized"), { recursive: true }); fs.renameSync(substitute, parent); }
		await expect(call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: `diagnostic-before-check-${mode}` })).rejects.toThrow("DIAGNOSTIC_ROOT_IDENTITY");
		expect(fs.readFileSync(mode === "root" ? path.join(authorized, "untouched.txt") : path.join(parent, "untouched.txt"), "utf8")).toBe("substitute stays untouched\n");
		expect(fs.readdirSync(mode === "root" ? authorized : path.join(parent, "authorized"))).toEqual(mode === "root" ? ["untouched.txt"] : []);
	}
});

test("completion rejects a copied diagnostic receipt after its directory is replaced", async () => {
	const f = await fixture("diagnostic-completion-race");
	const parent = path.join(root, "evidence", `diagnostic-completion-${crypto.randomUUID()}`);
	const authorized = path.join(parent, "authorized"), displaced = `${parent}-displaced`;
	fs.mkdirSync(authorized, { recursive: true });
	const begun = await call(f.projectId, f.cwd, undefined, f.owner, {
		action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"],
		diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: authorized },
	});
	const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "diagnostic-completion-race" });
	const receipt = (checked.result as { diagnosticEvidence: { path: string; identity: unknown } }).diagnosticEvidence;
	expect(receipt.identity).toEqual({ root: { volume: expect.any(Number), index: expect.any(String) }, file: { volume: expect.any(Number), index: expect.any(String) } });
	const copied = fs.readFileSync(receipt.path);
	fs.renameSync(parent, displaced);
	fs.mkdirSync(authorized, { recursive: true }); fs.writeFileSync(path.join(authorized, path.basename(receipt.path)), copied);
	expect(await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_complete" })).toMatchObject({ taskComplete: false, missingGates: ["integration_check"] });
});

test("new and restored diagnostic policy versions fail closed or preserve their stated compatibility", async () => {
	const f = await fixture("diagnostic-policy-version");
	await expect(call(f.projectId, f.cwd, undefined, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"], diagnosticEvidence: { schema: "omp-check-diagnostic/v2", root: diagnosticPolicy("internal-v2").root, identity: { volume: 1, index: "forged" } } })).rejects.toThrow("INVALID");
	for (const policy of [{ schema: "omp-check-diagnostic/v3", root: diagnosticPolicy("unknown-policy").root }, { schema: "omp-check-diagnostic/v2", root: diagnosticPolicy("missing-policy-identity").root }]) {
		const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] });
		openControlDbAt(db).query("UPDATE control_run_contracts SET diagnostic_evidence_json=? WHERE project_id=? AND run_id=?").run(JSON.stringify(policy), f.projectId, String(begun.runId));
		await expect(call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: policy.schema.endsWith("v3") ? "unknown-version" : "missing-identity" })).rejects.toThrow("INTEGRATION_CONTRACT");
	}
});

test("new diagnostic policies require their controller-created receipt identity while saved v1 remains readable", async () => {
	const fresh = await fixture("diagnostic-missing-new-identity");
	const begun = await integrationBegin(fresh.projectId, fresh.cwd, fresh.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] });
	const checked = await call(fresh.projectId, fresh.cwd, String(begun.runId), fresh.owner, { action: "run_check", idempotencyKey: "diagnostic-missing-new-identity" });
	const row = openControlDbAt(db).query<{ result_json: string }, [string, string]>("SELECT result_json FROM control_tasks WHERE project_id=? AND task_key=?").get(fresh.projectId, String(checked.taskKey));
	const result = JSON.parse(String(row?.result_json)); delete result.integrationCheck.diagnosticEvidence.identity;
	openControlDbAt(db).query("UPDATE control_tasks SET result_json=? WHERE project_id=? AND task_key=?").run(JSON.stringify(result), fresh.projectId, String(checked.taskKey));
	expect(await call(fresh.projectId, fresh.cwd, String(begun.runId), fresh.owner, { action: "run_complete" })).toMatchObject({ taskComplete: false, missingGates: ["integration_check"] });
	const legacy = await fixture("diagnostic-saved-v1");
	const legacyRoot = diagnosticPolicy("saved-v1").root;
	const legacyBegin = await call(legacy.projectId, legacy.cwd, undefined, legacy.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"], diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: legacyRoot } });
	openControlDbAt(db).query("UPDATE control_run_contracts SET diagnostic_evidence_json=? WHERE project_id=? AND run_id=?").run(JSON.stringify({ schema: "omp-check-diagnostic/v1", root: legacyRoot }), legacy.projectId, String(legacyBegin.runId));
	const legacyChecked = await call(legacy.projectId, legacy.cwd, String(legacyBegin.runId), legacy.owner, { action: "run_check", idempotencyKey: "diagnostic-saved-v1" }); // gitleaks:allow (test idempotency key, not a secret)
	const legacyRow = openControlDbAt(db).query<{ result_json: string }, [string, string]>("SELECT result_json FROM control_tasks WHERE project_id=? AND task_key=?").get(legacy.projectId, String(legacyChecked.taskKey));
	const legacyResult = JSON.parse(String(legacyRow?.result_json)); delete legacyResult.integrationCheck.diagnosticEvidence.identity;
	openControlDbAt(db).query("UPDATE control_tasks SET result_json=? WHERE project_id=? AND task_key=?").run(JSON.stringify(legacyResult), legacy.projectId, String(legacyChecked.taskKey));
	expect(await call(legacy.projectId, legacy.cwd, String(legacyBegin.runId), legacy.owner, { action: "run_complete" })).toMatchObject({ taskComplete: true });
});

test("check output is digested without persisting JSON tokens or Authorization values", async () => {
	const f = await fixture("output-privacy"); const envName = "OMP_INTEGRATION_CONTRACT_OUTPUT_MARKER";
	const previous = process.env[envName]; const marker = `marker-${crypto.randomUUID()}`, evidenceRoot = path.join(root, "evidence", `privacy-${crypto.randomUUID()}`); process.env[envName] = marker; setTestCheckEnvironment({ [envName]: marker }); fs.mkdirSync(evidenceRoot, { recursive: true });
	try {
		const script = `process.stdout.write('{"token"\\n : \\n "');process.stdout.write(process.env.${envName});process.stdout.write('"}\\n');process.stdout.write('x'.repeat(65537));console.error('Authorization: Bearer '+process.env.${envName});setTimeout(()=>process.exit(0),20)`;
		const begun = await call(f.projectId, f.cwd, undefined, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", script], diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: evidenceRoot } });
		const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "output-privacy" });
		const diagnosticPath = String((checked.result as { diagnosticEvidence: { path: string } }).diagnosticEvidence.path);
		expect(checked).toMatchObject({ ok: true, result: { stdout: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), contentOmitted: true }, stderr: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), contentOmitted: true } } });
		expect(JSON.stringify(checked)).not.toContain(marker);
		const row = openControlDbAt(db).query<{ result_json: string }, [string, string]>("SELECT result_json FROM control_tasks WHERE project_id=? AND task_key=?").get(f.projectId, String(checked.taskKey));
		expect(row?.result_json).not.toContain(marker);
		const persisted = JSON.parse(String(row?.result_json)).integrationCheck;
		for (const output of [persisted.stdout, persisted.stderr, (checked.result as { stdout: unknown; stderr: unknown }).stdout, (checked.result as { stdout: unknown; stderr: unknown }).stderr]) {
			expect(Object.keys(output as object)).not.toContain("head");
			expect(Object.keys(output as object)).not.toContain("tail");
		}
		const diagnostic = fs.readFileSync(diagnosticPath, "utf8");
		expect(diagnostic).not.toContain(marker);
		expect(diagnostic).toContain("[REDACTED]");
		expect(diagnostic).toContain('"truncated": true');
	} finally {
		if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
		setTestCheckEnvironment(undefined);
	}
});

test("ordinary quoted JSON content still passes through streaming Bearer redaction", async () => {
	const f = await fixture("quoted-json-bearer-privacy"); const envName = "OMP_INTEGRATION_CONTRACT_QUOTED_JSON_MARKER";
	const previous = process.env[envName], marker = `marker-${crypto.randomUUID()}`; process.env[envName] = marker; setTestCheckEnvironment({ [envName]: marker });
	try {
		const script = `const base=process.env.${envName};const tick=()=>new Promise(r=>setImmediate(r));const chunks=['{"message":"Authorization: Bea','rer '+base+'-split"}\\n',JSON.stringify({message:'Authorization: Bearer '+base+'-long'+'x'.repeat(160)})+'\\n','{"message":"Authorization: Bearer '+base+'-eof'];(async()=>{for(const chunk of chunks){process.stderr.write(chunk);await tick();}process.exit(1)})().catch(error=>{console.error(error);process.exitCode=1})`;
		const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", script] });
		const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "quoted-json-bearer-privacy" });
		const row = openControlDbAt(db).query<{ result_json: string }, [string, string]>("SELECT result_json FROM control_tasks WHERE project_id=? AND task_key=?").get(f.projectId, String(checked.taskKey));
		const diagnosticPath = String((checked.result as { diagnosticEvidence: { path: string } }).diagnosticEvidence.path);
		const stored = `${JSON.stringify(checked)}${row?.result_json ?? ""}${fs.readFileSync(diagnosticPath, "utf8")}`;
		for (const markerCase of ["-split", "-long", "-eof"]) {
			const secret = marker + markerCase;
			expect(stored).not.toContain(secret);
		}
	} finally {
		if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
		setTestCheckEnvironment(undefined);
	}
});

test("escaped-backslash JSON strings do not desynchronize later sensitive keys", async () => {
	const f = await fixture("escaped-json-key-privacy"); const envName = "OMP_INTEGRATION_CONTRACT_ESCAPED_JSON_MARKER";
	const previous = process.env[envName], marker = `marker-${crypto.randomUUID()}`; process.env[envName] = marker; setTestCheckEnvironment({ [envName]: marker });
	try {
		const script = `const value=process.env.${envName};process.stderr.write(JSON.stringify({message:'C\\\\',token:value}));process.exit(1)`;
		const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", script] });
		const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "escaped-json-key-privacy" });
		const row = openControlDbAt(db).query<{ result_json: string }, [string, string]>("SELECT result_json FROM control_tasks WHERE project_id=? AND task_key=?").get(f.projectId, String(checked.taskKey));
		const diagnosticPath = String((checked.result as { diagnosticEvidence: { path: string } }).diagnosticEvidence.path);
		const stored = `${JSON.stringify(checked)}${row?.result_json ?? ""}${fs.readFileSync(diagnosticPath, "utf8")}`;
		expect(stored).not.toContain(marker);
	} finally {
		if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
		setTestCheckEnvironment(undefined);
	}
});

test("tail boundaries redact exact Bearer and JSON values whose prefixes end at the retained cut", async () => {
	const f = await fixture("tail-boundary-privacy"); const envName = "OMP_INTEGRATION_CONTRACT_TAIL_MARKER";
	const previous = process.env[envName]; const marker = `marker-${crypto.randomUUID()}`; process.env[envName] = marker; setTestCheckEnvironment({ [envName]: marker });
	try {
		const script = `const value=process.env.${envName};const emit=(stream,prefix,suffix)=>{stream.write('x'.repeat(70000));stream.write(prefix);stream.write(value);stream.write(suffix(value));};emit(process.stdout,'Authorization: Bearer ',value=>' '.repeat(32768-value.length));emit(process.stderr,'{"token":"',value=>'"'+' '.repeat(32767-value.length));process.exit(1)`;
		const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", script] });
		const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "tail-boundary-privacy" });
		const diagnosticPath = String((checked.result as { diagnosticEvidence: { path: string } }).diagnosticEvidence.path);
		expect(checked).toMatchObject({ ok: false, state: "failed", result: { exitCode: 1, diagnosticEvidence: { truncated: true, gap: true } } });
		expect(JSON.stringify(checked)).not.toContain(marker);
		const row = openControlDbAt(db).query<{ result_json: string }, [string, string]>("SELECT result_json FROM control_tasks WHERE project_id=? AND task_key=?").get(f.projectId, String(checked.taskKey));
		expect(row?.result_json).not.toContain(marker);
		const diagnostic = fs.readFileSync(diagnosticPath, "utf8");
		expect(diagnostic).not.toContain(marker);
		expect(diagnostic).toContain("[REDACTED]");
	} finally {
		if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
		setTestCheckEnvironment(undefined);
	}
});

test("streamed recognized secrets keep their raw and sanitized retention metrics distinct", async () => {
	const f = await fixture("streamed-output-privacy"); const envName = "OMP_INTEGRATION_CONTRACT_STREAMED_MARKER";
	const previous = process.env[envName]; const marker = `marker-${crypto.randomUUID()}`; process.env[envName] = marker; setTestCheckEnvironment({ [envName]: marker });
	try {
		const script = `const v=process.env.${envName}+'a'.repeat(100000)+'\\\\"continued';const tick=()=>new Promise(r=>setImmediate(r));(async()=>{process.stdout.write('Auth');await tick();process.stdout.write('orization: Bea');await tick();process.stdout.write('rer'+' '.repeat(16384));await tick();process.stdout.write(v+'\\n');process.stderr.write('{"access_');await tick();process.stderr.write('token"\\n : \\n "');await tick();process.stderr.write(v+'"');})().catch(e=>{console.error(e);process.exitCode=1})`;
		const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", script] });
		const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "streamed-output-privacy" });
		const diagnosticPath = String((checked.result as { diagnosticEvidence: { path: string } }).diagnosticEvidence.path);
		expect(checked).toMatchObject({ ok: true, result: { diagnosticEvidence: { status: "available", truncated: false, gap: false }, stdout: { rawGap: true, gap: false, gapBytes: 0, exceedsDisplayLimit: true }, stderr: { rawGap: true, gap: false, gapBytes: 0, exceedsDisplayLimit: true } } });
		for (const output of [(checked.result as { stdout: { sanitizedBytes: number; sanitizedRetainedBytes: number }; stderr: { sanitizedBytes: number; sanitizedRetainedBytes: number } }).stdout, (checked.result as { stdout: { sanitizedBytes: number; sanitizedRetainedBytes: number }; stderr: { sanitizedBytes: number; sanitizedRetainedBytes: number } }).stderr]) {
			expect(output.sanitizedBytes).toBeLessThan(65_536); expect(output.sanitizedRetainedBytes).toBe(output.sanitizedBytes);
		}
		const row = openControlDbAt(db).query<{ result_json: string }, [string, string]>("SELECT result_json FROM control_tasks WHERE project_id=? AND task_key=?").get(f.projectId, String(checked.taskKey));
		expect(JSON.stringify(checked)).not.toContain(marker); expect(row?.result_json).not.toContain(marker); expect(fs.readFileSync(diagnosticPath, "utf8")).not.toContain(marker);
	} finally {
		if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
		setTestCheckEnvironment(undefined);
	}
});

test("noisy checks retain only digest metadata without imposing a 64KiB execution cap", async () => {
	const f = await fixture("output-volume");
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.stdout.write('x'.repeat(65537))"] });
	const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "output-volume" });
	expect(checked).toMatchObject({ ok: true, state: "succeeded", result: { status: "PASS", stdout: { contentOmitted: true, exceedsDisplayLimit: true, displayLimitBytes: 65_536 }, diagnosticEvidence: { status: "truncated", truncated: true, gap: true } } });
	expect(Number((checked.result as { stdout: { bytes: number } }).stdout.bytes)).toBeGreaterThan(65_536);
});

test("a noisy actual check retains a bounded late failing assertion", async () => {
	const f = await fixture("late-diagnostic");
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.stderr.write('x'.repeat(65537)+'\\nLATE_ASSERTION\\n');process.exit(1)"] });
	const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "late-assertion" });
	const diagnostic = (checked.result as { diagnosticEvidence: { path: string; truncated: boolean; gap: boolean } }).diagnosticEvidence;
	expect(checked).toMatchObject({ ok: false, state: "failed", result: { exitCode: 1, diagnosticEvidence: { status: "truncated", truncated: true, gap: true } } });
	expect(JSON.parse(fs.readFileSync(diagnostic.path, "utf8")).sanitizedSummary.stderr.text).toContain("LATE_ASSERTION");
});

test("diagnostic write or stream evidence failure cannot convert a passing process into a complete check", async () => {
	for (const [name, setFailure] of [["write", setTestDiagnosticWriteFail], ["stream", setTestDiagnosticStreamFail]] as const) {
		const f = await fixture(`diagnostic-${name}`);
		const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] });
		setFailure(true);
		try {
			const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: `diagnostic-${name}` });
			expect(checked).toMatchObject({ ok: false, state: "failed", result: { process: { status: "passed", exitCode: 0 }, diagnosticEvidence: { status: name === "write" ? "write_failed" : "stream_error" } } });
			if (name === "write") {
				const diagnostic = (checked.result as { diagnosticEvidence: { path: string | null; attemptedPath: string; missing: boolean; sha256: string | null } }).diagnosticEvidence;
				expect(diagnostic).toMatchObject({ path: null, missing: true, sha256: null, attemptedPath: expect.stringContaining("check-") });
				expect(fs.existsSync(diagnostic.attemptedPath)).toBe(false);
			}
			expect(await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_complete" })).toMatchObject({ taskComplete: false, missingGates: ["integration_check"] });
		} finally { setFailure(false); }
	}
});

test("a partial diagnostic write reports its actual unusable artifact", async () => {
	const f = await fixture("diagnostic-partial-write");
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] });
	setTestDiagnosticWritePartialFail(true);
	try {
		const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "partial-write" });
		const diagnostic = (checked.result as { diagnosticEvidence: { path: string | null; attemptedPath: string; sha256: string | null; missing: boolean } }).diagnosticEvidence;
		expect(checked).toMatchObject({ ok: false, state: "failed", result: { process: { status: "passed", exitCode: 0 }, diagnosticEvidence: { status: "write_failed", missing: false } } });
		expect(diagnostic.path).toBe(diagnostic.attemptedPath);
		expect(diagnostic.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(diagnostic.path && fs.existsSync(diagnostic.path)).toBe(true);
	} finally { setTestDiagnosticWritePartialFail(false); }
});

test("an existing diagnostic filename is not overwritten or attributed to this check", async () => {
	const f = await fixture("diagnostic-preexisting");
	const evidenceRoot = path.join(root, "evidence", `diagnostic-preexisting-${crypto.randomUUID()}`), prior = "not this receipt\n";
	fs.mkdirSync(evidenceRoot, { recursive: true });
	setTestBeforeDiagnosticCreate(file => fs.writeFileSync(file, prior));
	try {
		const begun = await call(f.projectId, f.cwd, undefined, f.owner, {
			action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"],
			diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: evidenceRoot },
		});
		const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "diagnostic-preexisting" });
		const diagnostic = (checked.result as { diagnosticEvidence: { path: string | null; attemptedPath: string; missing: boolean; sha256: string | null } }).diagnosticEvidence;
		expect(checked).toMatchObject({ ok: false, state: "failed", result: { process: { status: "passed", exitCode: 0 }, diagnosticEvidence: { status: "write_failed", path: null, missing: true, sha256: null } } });
		expect(fs.readFileSync(diagnostic.attemptedPath, "utf8")).toBe(prior);
	} finally { setTestBeforeDiagnosticCreate(null); }
});

test("existing hardlinks and symlinks are neither followed nor overwritten as diagnostic receipts", async () => {
	for (const kind of ["hardlink", "symlink"] as const) {
		const f = await fixture(`diagnostic-${kind}-leaf`);
		const evidenceRoot = path.join(root, "evidence", `diagnostic-${kind}-${crypto.randomUUID()}`), target = path.join(root, "evidence", `diagnostic-${kind}-target-${crypto.randomUUID()}.txt`), prior = `${kind} target stays untouched\n`;
		fs.mkdirSync(evidenceRoot, { recursive: true }); fs.writeFileSync(target, prior);
		setTestBeforeDiagnosticCreate(file => { if (kind === "hardlink") fs.linkSync(target, file); else fs.symlinkSync(target, file, "file"); });
		try {
			const begun = await call(f.projectId, f.cwd, undefined, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"], diagnosticEvidence: { schema: "omp-check-diagnostic/v1", root: evidenceRoot } });
			const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: `diagnostic-${kind}-leaf` });
			const diagnostic = (checked.result as { diagnosticEvidence: { attemptedPath: string } }).diagnosticEvidence;
			expect(checked).toMatchObject({ ok: false, state: "failed", result: { diagnosticEvidence: { status: "write_failed", missing: true } } });
			expect(fs.readFileSync(target, "utf8")).toBe(prior);
			if (kind === "symlink") expect(fs.lstatSync(diagnostic.attemptedPath).isSymbolicLink()).toBe(true);
		} finally { setTestBeforeDiagnosticCreate(null); }
	}
});

test("a completion receipt is held without write sharing throughout hashing", async () => {
	const f = await fixture("diagnostic-completion-no-write-share");
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] });
	const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "diagnostic-completion-no-write-share" });
	const receipt = String((checked.result as { diagnosticEvidence: { path: string } }).diagnosticEvidence.path);
	let writerError: unknown;
	setTestBeforeDiagnosticCompletionHash(file => { try { fs.writeFileSync(file, "external rewrite"); } catch (error) { writerError = error; } });
	try {
		expect(await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_complete" })).toMatchObject({ taskComplete: true });
		expect(writerError).toMatchObject({ code: "EBUSY" });
		expect(fs.readFileSync(receipt, "utf8")).toContain(String(begun.runId));
	} finally { setTestBeforeDiagnosticCompletionHash(null); }
});

test("the shared pin helper rejects a reparse child, releases it, and holds root and ancestor renames", () => {
	const parent = path.join(root, "evidence", `pin-helper-${crypto.randomUUID()}`), authorized = path.join(parent, "authorized"), target = path.join(root, "evidence", `pin-helper-target-${crypto.randomUUID()}`), reparse = path.join(parent, "reparse");
	fs.mkdirSync(authorized, { recursive: true }); fs.mkdirSync(target, { recursive: true }); fs.symlinkSync(target, reparse, "junction");
	expect(() => pinWindowsDirectory(reparse)).toThrow("WINDOWS_DIRECTORY_PIN_REPARSE");
	const movedReparse = `${reparse}-moved`; fs.renameSync(reparse, movedReparse);
	const pin = pinWindowsDirectory(authorized);
	try {
		let rootError: unknown, ancestorError: unknown;
		try { fs.renameSync(authorized, `${authorized}-moved`); } catch (error) { rootError = error; }
		try { fs.renameSync(parent, `${parent}-moved`); } catch (error) { ancestorError = error; }
		expect(rootError).toMatchObject({ code: "EBUSY" }); expect(ancestorError).toMatchObject({ code: "EBUSY" });
	} finally { releaseWindowsDirectoryPin(pin); }
	fs.renameSync(authorized, `${authorized}-released`);
});

test("a frozen integration-v1 contract with a NULL diagnostic policy retains legacy completion semantics", async () => {
	const f = await fixture("frozen-null-diagnostic-policy");
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] });
	openControlDbAt(db).query("UPDATE control_run_contracts SET diagnostic_evidence_json=NULL WHERE project_id=? AND run_id=?").run(f.projectId, String(begun.runId));
	const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "frozen-null" });
	expect(checked).toMatchObject({ ok: true, state: "succeeded", result: { status: "PASS", exitCode: 0 } });
	expect((checked.result as { diagnosticEvidence?: unknown }).diagnosticEvidence).toBeUndefined();
	expect(await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_complete" })).toMatchObject({ taskComplete: true, requiredGates: ["integration_check"] });
});

test("diagnostic evidence tampering and controlled timeout preserve the original process outcome separately", async () => {
	const f = await fixture("diagnostic-tamper");
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"] });
	const checked = await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "diagnostic-tamper" });
	const evidencePath = String((checked.result as { diagnosticEvidence: { path: string } }).diagnosticEvidence.path);
	expect(checked).toMatchObject({ ok: true, result: { process: { status: "passed", exitCode: 0 } } });
	fs.unlinkSync(evidencePath);
	expect(await call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_complete" })).toMatchObject({ taskComplete: false, missingGates: ["integration_check"] });
	const timeout = await fixture("diagnostic-timeout");
	const timed = await integrationBegin(timeout.projectId, timeout.cwd, timeout.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
	setTestCheckTimeoutMs(25);
	try {
		const interrupted = await call(timeout.projectId, timeout.cwd, String(timed.runId), timeout.owner, { action: "run_check", idempotencyKey: "diagnostic-timeout" });
		expect(interrupted).toMatchObject({ ok: false, state: "interrupted", result: { process: { status: "interrupted", cancellation: "timeout" }, diagnosticEvidence: { status: expect.any(String) } } });
	} finally { setTestCheckTimeoutMs(null); }
});

test("cancelled check is interrupted, retains uncertainty, and the root-only tool exposes the frozen API", async () => {
	const f = await fixture("cancel");
	const pidFile = path.join(root, "evidence", `cancelled-check-${crypto.randomUUID()}.pid`); fs.mkdirSync(path.dirname(pidFile), { recursive: true });
	const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(() => {}, 1000)`;
	const begun = await integrationBegin(f.projectId, f.cwd, f.owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", script] });
	const aborter = new AbortController();
	const checking = call(f.projectId, f.cwd, String(begun.runId), f.owner, { action: "run_check", idempotencyKey: "cancelled" }, aborter.signal);
	const deadline = Date.now() + 2_000; while (!fs.existsSync(pidFile)) { if (Date.now() > deadline) throw new Error("CANCELLED_CHECK_NOT_STARTED"); await Bun.sleep(10); }
	aborter.abort(new Error("test cancellation"));
	const cancelled = await checking;
	expect(cancelled).toMatchObject({ ok: false, state: "interrupted", productComplete: false, result: { status: "FAIL", cancellation: "cancelled" } });
	const pid = Number(fs.readFileSync(pidFile, "utf8")); await Bun.sleep(50); expect(() => process.kill(pid, 0)).toThrow();
	const child = await execute("child", { action: "run_check", projectId: f.projectId, runId: begun.runId, idempotencyKey: "forbidden" }, new AbortController().signal, () => {}, { cwd: f.cwd, settings, sessionManager: { getSessionId: () => f.owner, getEntries: () => [{ type: "session_init" }] } });
	expect(child).toMatchObject({ isError: true, details: { code: "SUBAGENT_FORBIDDEN" } });
	expect(registeredTool.parameters.parse({ action: "run_begin", projectId: f.projectId, risk: "mechanical", executionPolicy: "integration-v1", checkCommand: [process.execPath, "-e", "process.exit(0)"], diagnosticEvidence: diagnosticPolicy("schema") })).toMatchObject({ action: "run_begin", executionPolicy: "integration-v1" });
	expect(registeredTool.parameters.parse({ action: "run_check", projectId: f.projectId, runId: begun.runId, idempotencyKey: "schema-check" })).toMatchObject({ action: "run_check" });
});

test("integration-v1 admits a disjoint claim while its known graph author is actually running", async () => {
	const target = path.join(root, "refill-target"), a = path.join(root, "refill-a"), b = path.join(root, "refill-b");
	fs.mkdirSync(target, { recursive: true }); git(target, "init", "-b", "main", target); git(target, "config", "user.email", "integration@example.invalid"); git(target, "config", "user.name", "integration");
	fs.mkdirSync(path.join(target, "src")); fs.writeFileSync(path.join(target, "src", "base.ts"), "export const base = true;\n"); git(target, "add", "."); git(target, "commit", "-m", "base");
	git(target, "worktree", "add", "-b", "refill-a", a, "HEAD"); git(target, "worktree", "add", "-b", "refill-b", b, "HEAD");
	const owner = "session-refill";
	const targetProject = String((await register(target, owner)).projectId), aProject = String((await register(a, owner)).projectId), bProject = String((await register(b, owner)).projectId);
	const command = [process.execPath, "-e", "process.exit(0)"];
	const targetRun = String((await integrationBegin(targetProject, target, owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: command })).runId);
	expect((await call(targetProject, target, targetRun, owner, { action: "task_graph_create", graphId: "refill", graphPlan: { targetRef: "main", tasks: [
		{ id: "a", writePaths: ["src/a.ts"], sharedResources: [], dependsOn: [] }, { id: "b", writePaths: ["src/b.ts"], sharedResources: [], dependsOn: [] },
	] } })).ok).toBe(true);
	const aRun = String((await integrationBegin(aProject, a, owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: command })).runId);
	const bRun = String((await integrationBegin(bProject, b, owner, { action: "run_begin", risk: "mechanical", executionPolicy: "integration-v1", checkCommand: command })).runId);
	const aClaim = await call(aProject, a, aRun, owner, { action: "task_claim", graphId: "refill", taskId: "a", idempotencyKey: "a-author" });
	let release: (() => void) | undefined; let started: (() => void) | undefined;
	const running = dispatchAt(db, { action: "project_spawn", projectId: aProject, runId: aRun, graphId: "refill", taskId: "a", claimToken: aClaim.claimToken, idempotencyKey: "a-author", agent: "fast-worker", task: "hold running for refill admission", outputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string" } }, required: ["status"] } } as never, {
		cwd: a, sessionId: owner, settings, runSubprocess: async () => await new Promise(resolve => { started = () => resolve({ exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS" } } }); release = started; }),
	});
	await new Promise<void>(resolve => { const wait = () => started ? resolve() : setTimeout(wait, 5); wait(); });
	const bClaim = await call(bProject, b, bRun, owner, { action: "task_claim", graphId: "refill", taskId: "b", idempotencyKey: "b-author" });
	expect(bClaim).toMatchObject({ ok: true, taskId: "b" });
	release?.(); await running;
});
