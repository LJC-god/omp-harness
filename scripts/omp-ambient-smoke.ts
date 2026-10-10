import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeModule, runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";
const { createAgentSession } = await import(runtimeModule("pi-coding-agent/src/sdk.ts"));
const { Settings } = await import(runtimeModule("pi-coding-agent/src/config/settings.ts"));
const { SessionManager } = await import(runtimeModule("pi-coding-agent/src/session/session-manager.ts"));
const { quit } = await import(runtimePackageFile("pi-utils", "src/postmortem.ts"));
import { ambientLabPaths, assertAmbientLabTarget } from "../omp/agent/lib/ambient-lab.ts";

const lab = ambientLabPaths();
if (!lab) throw new Error("OMP_AMBIENT_LAB_ROOT is required");
const workspace = assertAmbientLabTarget(path.join(lab.root, "ambient", "workspace"));
const evidenceRoot = assertAmbientLabTarget(path.join(lab.root, "ambient", "evidence"));
const prodDb = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/orchestration.sqlite`;
// Session store. Observed to change during a no-model probe on 2026-09-19 (see
// notes/optimize-global-config-20260919.md); reported separately so the blind spot is visible,
// but not a hard gate because the SDK session store is not pinned by the lab root.
const prodSessionDb = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/agent.db`;
const deployedRoot = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent`;
const repoRoot = path.resolve(import.meta.dir, "../omp/agent");
const ambientExtensions = ["omp-control.ts", "run-archiver.ts", "session-continuity.ts", "task-health.ts", "task-usage.ts", "web-research-tools.ts"];

function digest(file: string) {
	if (!fs.existsSync(file)) return { path: file, exists: false };
	const body = fs.readFileSync(file);
	return { path: file, exists: true, bytes: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") };
}

function productionDigest() {
	return [prodDb, `${prodDb}-wal`, `${prodDb}-shm`].map(digest);
}

function productionSessionDigest() {
	return [prodSessionDb, `${prodSessionDb}-wal`, `${prodSessionDb}-shm`].map(digest);
}

function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function parity() {
	return Object.fromEntries([
		["ambient-lab.ts", path.join(repoRoot, "lib", "ambient-lab.ts"), path.join(deployedRoot, "lib", "ambient-lab.ts")],
		["omp-runtime.ts", path.join(repoRoot, "lib", "omp-runtime.ts"), path.join(deployedRoot, "lib", "omp-runtime.ts")],
		...ambientExtensions.map(name => [name, path.join(repoRoot, "extensions", name), path.join(deployedRoot, "extensions", name)]),
	].map(([name, repo, deployed]) => {
		const repository = digest(String(repo)), installed = digest(String(deployed));
		return [name, { repository, installed, matches: repository.sha256 === installed.sha256 }];
	}));
}

function assertReady() {
	if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`AMBIENT_WORKSPACE_MISSING: ${workspace}`);
	if (!fs.existsSync(path.join(workspace, ".git"))) throw new Error(`AMBIENT_WORKSPACE_GIT_MISSING: ${workspace}`);
	const report = parity();
	if (!Object.values(report).every((item: any) => item.matches)) throw new Error("DEPLOYED_AMBIENT_SOURCE_PARITY_MISMATCH");
	return report;
}

function writeEvidence(name: string, value: unknown) {
	fs.mkdirSync(evidenceRoot, { recursive: true });
	fs.writeFileSync(path.join(evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function attemptName(mode: "probe" | "run" | "reconcile-first-orphan") {
	return `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`;
}

function assertArmed() {
	if (process.env.OMP_AMBIENT_LAB_ARM !== "1") throw new Error("REAL_MODEL_RUN_NOT_ARMED");
}

function filesUnder(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((entry): entry is string => typeof entry === "string")
		.map(entry => path.join(root, entry)).filter(file => fs.statSync(file).isFile());
}

function parseTranscript(file: string): any[] {
	return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function controlToolResults(entries: any[]) {
	const callIds = new Set(entries.flatMap(entry => {
		const message = entry?.type === "message" ? entry.message : undefined;
		return message?.role === "assistant" && Array.isArray(message.content) ? message.content
			.filter((part: any) => part?.type === "toolCall" && part.name === "write" && part.arguments?.path === "xd://omp_control" && typeof part.id === "string")
			.map((part: any) => part.id) : [];
	}));
	return entries.map(entry => entry?.type === "message" ? entry.message : undefined)
		.filter(message => message?.role === "toolResult" && typeof message.toolCallId === "string" && callIds.has(message.toolCallId) && message.details?.xdev?.tool === "omp_control")
		.map(message => ({ action: String(message.details.xdev.args?.action ?? ""), inner: message.details.xdev.inner ?? {} }));
}

function transcriptEvidence(file: string | undefined) {
	if (!file || !fs.existsSync(file)) return { file: file ?? null, entries: 0, rootHealth: 0, taskCalls: 0, childFiles: [] as string[], childHealth: 0, childForbidden: 0, controlActions: [] as string[] };
	const entries = parseTranscript(file);
	const results = entries.map(entry => entry?.type === "message" ? entry.message : undefined).filter(message => message?.role === "toolResult");
	const taskResults = results.filter(message => message.toolName === "task");
	const deliveredChildFiles = taskResults.flatMap(message => Array.isArray(message.details?.results)
		? message.details.results.map((result: any) => result?.outputPath).filter((value: unknown): value is string => typeof value === "string") : []);
	const childDir = file.replace(/\.jsonl$/i, "");
	const childFiles = [...new Set([...deliveredChildFiles, ...filesUnder(childDir).filter(candidate => candidate.endsWith(".jsonl"))])];
	const rootControl = controlToolResults(entries);
	const rootHealth = rootControl.filter(result => result.inner.ok === true && result.inner.schema === "omp-control").length;
	const childEntries = childFiles.flatMap(parseTranscript);
	const childControl = controlToolResults(childEntries);
	const childHealth = childControl.filter(result => result.inner.ok === true && result.inner.schema === "omp-control").length;
	const childForbidden = childControl.filter(result => result.inner.code === "SUBAGENT_FORBIDDEN").length;
	return { file, entries: entries.length, rootHealth, taskCalls: taskResults.length, childFiles, childHealth, childForbidden,
		controlActions: rootControl.map(result => result.action),
		hasRootModel: entries.some(entry => entry?.type === "model_change" && entry.model === "openai-codex/gpt-5.6-sol"),
		hasHigh: entries.some(entry => entry?.type === "thinking_level_change" && entry.thinkingLevel === "high"),
		hasChildTerraHigh: childEntries.some(entry => entry?.type === "model_change" && entry.model === "openai-codex/gpt-5.6-terra") && childEntries.some(entry => entry?.type === "thinking_level_change" && entry.thinkingLevel === "high") };
}

async function start(mode: "probe" | "run" | "reconcile-first-orphan") {
	const before = productionDigest();
	const sessionBefore = productionSessionDigest();
	const evidenceName = attemptName(mode);
	let report: Record<string, unknown> = { schema: "omp-ambient-smoke/v1", mode, evidenceName, lab, workspace };
	let failure: unknown;
	let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
	let manager: InstanceType<typeof SessionManager> | undefined;
	try {
		const sourceParity = assertReady();
		report = { ...report, sourceParity };
		const settings = await Settings.loadReadOnly({ cwd: workspace });
		const existingOverrides = settings.get("task.agentModelOverrides") as Record<string, string | string[]>;
		settings.override("task.agentModelOverrides", { ...existingOverrides, verifier: "openai-codex/gpt-5.6-terra:high" });
		manager = SessionManager.create(workspace, assertAmbientLabTarget(lab.sessionsRoot));
		created = await createAgentSession({
			cwd: workspace,
			sessionManager: manager,
			modelPattern: "openai-codex/gpt-5.6-sol",
			thinkingLevel: "high",
			settings,
			autoApprove: true,
			// Intentionally omit all discovery, extension, MCP, and tool restriction overrides.
		});
		const discovered = created.extensionsResult.extensions.map((extension: any) => String(extension.path));
		if (created.extensionsResult.errors.length) throw new Error(`AMBIENT_EXTENSION_LOAD_ERRORS: ${JSON.stringify(created.extensionsResult.errors)}`);
		const missing = ambientExtensions.filter(name => !discovered.some(file => path.basename(file).toLowerCase() === name));
		if (missing.length) throw new Error(`AMBIENT_EXTENSION_MISSING: ${missing.join(",")}`);
		if (mode === "run") {
			assertArmed();
			await created.session.prompt([
				"This is an isolated ambient-extension verification.",
				"Use the normal discovered extension routes only. Do not use shell commands or direct database access.",
				"First call omp_control project_register with canonicalRoot D:/Labs/omp/omp-automation-lab-20260918/ambient/workspace. Retain its projectId.",
				"Second call omp_control run_begin with that projectId and risk mechanical. Retain its runId.",
				"Third call omp_archive prepare with that projectId, runId, and the same cwd. This must remain local; do not supply archiveRepo or publish.",
				"Then call omp_control once with {\"action\":\"health\"}.",
				"Then use the native task tool exactly once with agent verifier (the temporary Terra/high lab role). Tell that child to call omp_control health exactly once, then call omp_control project_get exactly once with projectId 0de0dff9-0917-494d-a335-21477ebf9c50; it must report the returned SUBAGENT_FORBIDDEN code. No other child tool calls.",
				"Do not publish, supply archiveRepo, write repository files, or use any other tool.",
			].join("\n"));
			await created.session.waitForIdle();
			while (created.session.hasPendingAsyncWork()) await created.session.settleAsyncWork();
		}
		if (mode === "reconcile-first-orphan") {
			assertArmed();
			await created.session.prompt([
				"This is the one-off recovery of the retained first ambient-lab orphan through the normal discovered extension route.",
				"First call omp_control workspace_status and inspect the exact stale writer token 01a0b3d8-b91e-7286-a37d-5c65246953f5:d:\\omp-automation-lab-20260918\\ambient\\workspace.",
				"Only if that status shows the exact token and no surviving controller or descendant process, call omp_control workspace_reconcile exactly once with that token and payload {\"processesStopped\":true,\"sideEffectsKnown\":true,\"evidence\":[\"first ambient root session and verifier transcript preserved under D:/Labs/omp/omp-automation-lab-20260918/ambient/sessions\",\"the stale controller PID 15652 and its descendants were inspected and are absent\",\"the lab controller has no control_tasks for that owner; the verifier made health and forbidden project_get calls only\"]}.",
				"Do not register a project, start a run, spawn a task, write repository files, publish, or use any other tool.",
			].join("\n"));
			await created.session.waitForIdle();
		}
		report = { ...report, extensions: discovered,
			mcp: created.mcpManager ? { known: created.mcpManager.getAllServerNames(), connected: created.mcpManager.getConnectedServers() } : { known: [], connected: [] },
			sessionFile: manager.getSessionFile(), transcript: transcriptEvidence(manager.getSessionFile()), archiveFilesBeforeDispose: filesUnder(lab.archiveRoot) };
		if (mode === "run") {
			const transcript = report.transcript as ReturnType<typeof transcriptEvidence>;
			if (transcript.rootHealth < 1 || transcript.taskCalls < 1 || transcript.childFiles.length < 1 || transcript.childHealth < 1 || transcript.childForbidden < 1 || !transcript.hasRootModel || !transcript.hasHigh || !transcript.hasChildTerraHigh) {
				throw new Error("ROOT_OR_NATIVE_TASK_EVIDENCE_MISSING");
			}
		}
		if (mode === "reconcile-first-orphan") {
			const transcript = report.transcript as ReturnType<typeof transcriptEvidence>;
			if (!transcript.controlActions.includes("workspace_status") || !transcript.controlActions.includes("workspace_reconcile")) throw new Error("WORKSPACE_RECONCILE_EVIDENCE_MISSING");
		}
	} catch (error) {
		failure = error;
	} finally {
		if (created) {
			try {
				while (created.session.hasPendingAsyncWork()) await created.session.settleAsyncWork();
			} catch (settleError) {
				failure ??= settleError;
			}
			try {
				await created.session.dispose();
			} catch (disposeError) {
				failure ??= disposeError;
			}
		}
		const after = productionDigest();
		const sessionAfter = productionSessionDigest();
		report = { ...report, archiveFilesAfterDispose: filesUnder(lab.archiveRoot), productionDb: { before, after, unchanged: equal(before, after) },
			productionSessionDb: { before: sessionBefore, after: sessionAfter, unchanged: equal(sessionBefore, sessionAfter) },
			...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) };
		writeEvidence(evidenceName, report);
	}
	if (!((report.productionDb as any).unchanged)) throw new Error("PRODUCTION_CONTROL_DB_CHANGED");
	if (!((report.productionSessionDb as any).unchanged)) console.error("WARNING: production agent.db (session store) changed during this run; see productionSessionDb in the evidence file");
	console.log(JSON.stringify(report, null, 2));
	if (failure) throw failure;
}

const command = process.argv[2] ?? "--preflight";
if (command === "--preflight") {
	const report = { schema: "omp-ambient-preflight/v1", lab, workspace, sourceParity: assertReady(), productionDb: productionDigest(), productionSessionDb: productionSessionDigest() };
	writeEvidence("preflight.json", report);
	console.log(JSON.stringify(report, null, 2));
} else if (command === "--probe") await start("probe");
else if (command === "--run") await start("run");
else if (command === "--reconcile-first-orphan") await start("reconcile-first-orphan");
else if (command === "--inspect-transcript") {
	const file = process.argv[3];
	if (!file) throw new Error("usage: --inspect-transcript <D:/ambient/session.jsonl>");
	console.log(JSON.stringify(transcriptEvidence(assertAmbientLabTarget(path.resolve(file))), null, 2));
} else throw new Error("usage: --preflight | --probe | --reconcile-first-orphan | --run | --inspect-transcript <file>");

// This standalone host owns process-global SDK resources as well as its session.
await quit();
