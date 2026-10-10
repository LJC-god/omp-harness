import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const LAB_ROOT = path.resolve("D:/Labs/omp/omp-field-lab-20260918");
const MARKER = path.join(LAB_ROOT, ".omp-experiment-root");
const ENTRY_ROOT = path.join(LAB_ROOT, "cli-entry");
const FIELD_PROJECT = path.join(ENTRY_ROOT, "field-project");
const SESSIONS = path.join(ENTRY_ROOT, "sessions");
const EVIDENCE = path.join(ENTRY_ROOT, "evidence");
const STATE = path.join(ENTRY_ROOT, "state.json");
const CONTROL_DB = path.join(ENTRY_ROOT, "controller.sqlite");
const PROD_DB = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/orchestration.sqlite`;
const DEPLOYED_CONTROL = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/extensions/omp-control.ts`;
const DEPLOYED_TASK_GRAPH = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/lib/task-graph.ts`;
const REPO_CONTROL = path.resolve(import.meta.dir, "../omp/agent/extensions/omp-control.ts");
const REPO_TASK_GRAPH = path.resolve(import.meta.dir, "../omp/agent/lib/task-graph.ts");
const CONFIG = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/config.yml`;
const GLOBAL_CORE = `${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`;
const EXTENSION = path.resolve(import.meta.dir, "omp-cli-lab-extension.ts");
const OMP = `${process.env.HOME ?? process.env.USERPROFILE}/.bun/bin/omp.exe`;
const MODEL = "openai-codex/gpt-5.6-sol";

type FileDigest = { path: string; exists: boolean; bytes?: number; sha256?: string; mtimeMs?: number };

function digest(file: string): FileDigest {
	if (!fs.existsSync(file)) return { path: file, exists: false };
	const stat = fs.statSync(file);
	return { path: file, exists: true, bytes: stat.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), mtimeMs: stat.mtimeMs };
}

function databaseDigest(): FileDigest[] {
	return [PROD_DB, `${PROD_DB}-wal`, `${PROD_DB}-shm`].map(digest);
}

function sameDigests(before: FileDigest[], after: FileDigest[]): boolean {
	return JSON.stringify(before) === JSON.stringify(after);
}

function inside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fail(message: string): never {
	throw new Error(message);
}

function assertLab(): void {
	if (!fs.existsSync(MARKER) || fs.readFileSync(MARKER, "utf8").trim() !== "omp-dependency-lab/v1") fail("OMP_FIELD_LAB_MARKER_INVALID");
	const actualRoot = fs.realpathSync.native(LAB_ROOT);
	if (!/^[dD]:[\\/]/.test(actualRoot)) fail(`OMP_FIELD_LAB_NOT_ON_D: ${actualRoot}`);
	for (const target of [ENTRY_ROOT, FIELD_PROJECT, SESSIONS, EVIDENCE, CONTROL_DB]) {
		const relative = path.relative(actualRoot, path.resolve(target));
		if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`OMP_FIELD_LAB_ESCAPE: ${target}`);
		let existingParent = path.resolve(target);
		while (!fs.existsSync(existingParent)) {
			const next = path.dirname(existingParent);
			if (next === existingParent) fail(`OMP_FIELD_LAB_NO_PARENT: ${target}`);
			existingParent = next;
		}
		if (!inside(fs.realpathSync.native(existingParent), actualRoot)) {
			fail(`OMP_FIELD_LAB_JUNCTION_ESCAPE: ${target}`);
		}
		if (fs.existsSync(target) && !inside(fs.realpathSync.native(target), actualRoot)) {
			fail(`OMP_FIELD_LAB_JUNCTION_ESCAPE: ${target}`);
		}
	}
	if (path.resolve(CONTROL_DB).toLowerCase() === path.resolve(PROD_DB).toLowerCase()) fail("OMP_FIELD_LAB_REFUSES_SYSTEM_DB");
}

function writeEvidence(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parity(): Record<string, { repository: FileDigest; deployed: FileDigest; matches: boolean }> {
	const controller = { repository: digest(REPO_CONTROL), deployed: digest(DEPLOYED_CONTROL) };
	const taskGraph = { repository: digest(REPO_TASK_GRAPH), deployed: digest(DEPLOYED_TASK_GRAPH) };
	return {
		controller: { ...controller, matches: controller.repository.sha256 === controller.deployed.sha256 },
		taskGraph: { ...taskGraph, matches: taskGraph.repository.sha256 === taskGraph.deployed.sha256 },
	};
}

function assertParity(): void {
	const report = parity();
	if (!report.controller.matches || !report.taskGraph.matches) fail("DEPLOYED_CONTROLLER_OR_LIB_PARITY_MISMATCH");
}

function readState(): { projectId: string; sessionId: string; sessionFile: string; cwd: string } {
	if (!fs.existsSync(STATE)) fail("REGISTER_STATE_MISSING");
	const state = readJsonObject(JSON.parse(fs.readFileSync(STATE, "utf8")));
	if (!state || typeof state.projectId !== "string" || typeof state.sessionId !== "string" || typeof state.sessionFile !== "string" || state.cwd !== FIELD_PROJECT) {
		fail("REGISTER_STATE_INVALID");
	}
	return state as { projectId: string; sessionId: string; sessionFile: string; cwd: string };
}

function parseJsonLines(text: string): unknown[] {
	return text.split(/\r?\n/).filter(Boolean).flatMap(line => {
		try { return [JSON.parse(line)]; } catch { return []; }
	});
}

function readJsonObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function ompControlEvidence(events: unknown[], action: string): { calls: Record<string, unknown>[]; results: Record<string, unknown>[]; pairs: Array<Record<string, unknown>> } {
	const calls: Record<string, unknown>[] = [];
	const results: Record<string, unknown>[] = [];
	const scan = (value: unknown): void => {
		const record = readJsonObject(value);
		if (!record) return;
		if (record.type === "toolCall" && record.name === "omp_control" && readJsonObject(record.arguments)?.action === action) calls.push(record);
		if (record.role === "toolResult" && record.toolName === "omp_control") results.push(record);
		for (const child of Object.values(record)) Array.isArray(child) ? child.forEach(scan) : scan(child);
	};
	events.forEach(scan);
	const uniqueCalls = [...new Map(calls.filter(call => typeof call.id === "string").map(call => [String(call.id), call])).values()];
	const uniqueResults = [...new Map(results.filter(result => typeof result.toolCallId === "string").map(result => [String(result.toolCallId), result])).values()];
	return {
		calls: uniqueCalls,
		results: uniqueResults,
		pairs: uniqueCalls.flatMap(call => uniqueResults.filter(result => result.toolCallId === call.id).map(result => ({ call, result }))),
	};
}

function discoverSessionFiles(): Array<{ path: string; header: unknown }> {
	if (!fs.existsSync(SESSIONS)) return [];
	return fs.readdirSync(SESSIONS, { recursive: true, encoding: "utf8" })
		.filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"))
		.map(entry => {
			const file = path.join(SESSIONS, entry);
			const headerLine = fs.readFileSync(file, "utf8").split(/\r?\n/).find(line => {
				try { return JSON.parse(line)?.type === "session"; } catch { return false; }
			});
			try { return { path: file, header: headerLine ? JSON.parse(headerLine) : null }; } catch { return { path: file, header: null }; }
		});
}

function commandPrompt(action: "health" | "project_register" | "project_get"): string {
	const input = action === "health"
		? { action }
		: action === "project_register"
			? { action, canonicalRoot: FIELD_PROJECT }
			: { action, canonicalRoot: FIELD_PROJECT };
	return [
		"This is a lab-control turn.",
		"Call omp_control exactly once with this JSON object and do not use any other tool:",
		JSON.stringify(input),
		"After the tool result, state its JSON result briefly and stop.",
	].join("\n");
}

function sessionEntries(sessionFile: string): Record<string, unknown>[] {
	return fs.readFileSync(sessionFile, "utf8").split(/\r?\n/).filter(Boolean).flatMap(line => {
		try { const entry = JSON.parse(line); return readJsonObject(entry) ? [entry] : []; } catch { return []; }
	});
}

function modelEvidence(sessionFile: string): Record<string, unknown>[] {
	return sessionEntries(sessionFile).filter(entry => {
		if (entry.type === "model_usage") return entry.provider === "openai-codex" && entry.model === "gpt-5.6-sol";
		const message = readJsonObject(entry.message);
		return message?.role === "assistant" && message.provider === "openai-codex" && message.model === "gpt-5.6-sol";
	});
}

function projectIdFromResult(result: Record<string, unknown>): string | undefined {
	const details = readJsonObject(result.details);
	return typeof details?.projectId === "string" ? details.projectId : undefined;
}

function assertArmed(): void {
	if (process.env.OMP_CLI_FIELD_ARM !== "1") fail("REAL_MODEL_RUN_NOT_ARMED: set OMP_CLI_FIELD_ARM=1 after review");
}

function runOne(action: "health" | "project_register" | "project_get", sessionFile?: string): void {
	assertLab();
	assertArmed();
	assertParity();
	if (!fs.existsSync(FIELD_PROJECT)) fail(`FIELD_PROJECT_MISSING: ${FIELD_PROJECT}`);
	const attempt = `${new Date().toISOString().replace(/[:.]/g, "-")}-${action}`;
	const attemptRoot = path.join(EVIDENCE, attempt);
	fs.mkdirSync(attemptRoot, { recursive: true });
	const before = databaseDigest();
	const args = [
		"--cwd", FIELD_PROJECT,
		"--mode", "json",
		"--print",
		"--model", MODEL,
		"--thinking", "high",
		"--session-dir", SESSIONS,
		"--trusted-extension", EXTENSION,
		"--tools", "omp_control",
		"--approval-mode", "yolo",
		...(sessionFile ? ["--resume", sessionFile] : []),
		commandPrompt(action),
	];
	const result = Bun.spawnSync({ cmd: [OMP, ...args], cwd: FIELD_PROJECT, stdout: "pipe", stderr: "pipe" });
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	fs.writeFileSync(path.join(attemptRoot, "stdout.jsonl"), stdout, "utf8");
	fs.writeFileSync(path.join(attemptRoot, "stderr.log"), stderr, "utf8");
	const events = parseJsonLines(stdout);
	const sessions = discoverSessionFiles();
	const resumedHeader = sessionFile ? sessions.find(session => path.resolve(session.path) === path.resolve(sessionFile))?.header as { id?: unknown; cwd?: unknown } | undefined : undefined;
	const after = databaseDigest();
	const tool = ompControlEvidence(events, action);
	const sessionFileAfter = sessions.length === 1 ? sessions[0]!.path : undefined;
	const usage = sessionFileAfter ? modelEvidence(sessionFileAfter) : [];
	writeEvidence(path.join(attemptRoot, "result.json"), {
		schema: "omp-cli-entry/v1",
		action,
		command: [OMP, ...args],
		requestedModel: `${MODEL}:high`,
		exitCode: result.exitCode,
		globalCore: digest(GLOBAL_CORE),
		config: digest(CONFIG),
		parity: parity(),
		loader: digest(EXTENSION),
		controlDb: digest(CONTROL_DB),
		productionDb: { before, after, unchanged: sameDigests(before, after), attribution: sameDigests(before, after) ? "unchanged" : "changed; this lab loader binds omp_control to D: and cannot attribute a concurrent production OMP write" },
		sessions,
		resumedSession: sessionFile ? { file: sessionFile, id: resumedHeader?.id, cwd: resumedHeader?.cwd } : undefined,
		modelUsage: usage,
		ompControl: tool,
	});
	if (result.exitCode !== 0) fail(`OMP_EXIT_${result.exitCode}`);
	if (tool.calls.length !== 1 || tool.results.length !== 1 || tool.pairs.length !== 1) fail("OMP_CONTROL_CALL_RESULT_PAIR_MISSING");
	if (tool.pairs[0]!.result.isError !== false || readJsonObject(tool.pairs[0]!.result.details)?.ok !== true) fail("OMP_CONTROL_RESULT_NOT_OK");
	if (sessions.length !== 1) fail(`EXPECTED_ONE_SESSION_FILE_GOT_${sessions.length}`);
	const header = sessions[0]!.header as { type?: unknown; id?: unknown; cwd?: unknown } | null;
	if (header?.type !== "session" || typeof header.id !== "string" || header.cwd !== FIELD_PROJECT) fail("GENUINE_SESSION_HEADER_MISSING");
	if (sessionFile && (resumedHeader?.id !== header.id || resumedHeader?.cwd !== FIELD_PROJECT)) fail("SESSION_RESUME_IDENTITY_MISMATCH");
	if (usage.length === 0) fail("REAL_SOL_MODEL_USAGE_MISSING");
	const projectId = projectIdFromResult(tool.pairs[0]!.result);
	if (action === "project_register") {
		if (!projectId) fail("REGISTER_PROJECT_ID_MISSING");
		writeEvidence(STATE, { projectId, sessionId: header.id, sessionFile: sessions[0]!.path, cwd: FIELD_PROJECT });
	}
	if (action === "project_get") {
		const registered = readState();
		if (projectId !== registered.projectId || header.id !== registered.sessionId || sessions[0]!.path !== registered.sessionFile || header.cwd !== registered.cwd) {
			fail("PROJECT_OR_SESSION_IDENTITY_MISMATCH");
		}
	}
}

function preflight(): void {
	assertLab();
	const report = {
		schema: "omp-cli-entry-preflight/v1",
		labRoot: LAB_ROOT,
		fieldProject: FIELD_PROJECT,
		controllerDb: CONTROL_DB,
		productionDb: databaseDigest(),
		globalCore: digest(GLOBAL_CORE),
		config: digest(CONFIG),
		parity: parity(),
		loader: digest(EXTENSION),
		omp: digest(OMP),
		readyForModel: fs.existsSync(FIELD_PROJECT) && fs.existsSync(OMP) && fs.existsSync(DEPLOYED_CONTROL) && fs.existsSync(EXTENSION) && Object.values(parity()).every(value => value.matches),
	};
	writeEvidence(path.join(EVIDENCE, "preflight.json"), report);
	console.log(JSON.stringify(report, null, 2));
}

const command = process.argv[2] ?? "--preflight";
if (command === "--preflight") preflight();
else if (command === "--register") {
	if (discoverSessionFiles().length !== 0) fail("REGISTER_REQUIRES_EMPTY_SESSION_DIR");
	runOne("project_register");
} else if (command === "--health") {
	const sessions = discoverSessionFiles();
	if (sessions.length !== 1) fail(`EXPECTED_ONE_SESSION_FILE_GOT_${sessions.length}`);
	runOne("health", sessions[0]!.path);
}
else if (command === "--get") {
	const registered = readState();
	runOne("project_get", registered.sessionFile);
} else fail("usage: --preflight | --health | --register | --get");
