import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const LAB_ROOT = path.resolve("D:/Labs/omp/omp-merge-lab-20260918");
const EXPERIMENT_MARKER = path.join(LAB_ROOT, ".omp-experiment-root");
const PILOT_ROOT = path.join(LAB_ROOT, "pilot-stage5");
const PILOT_MARKER = path.join(PILOT_ROOT, ".pilot-stage5-marker.json");
const REPO = path.join(PILOT_ROOT, "repo");
const WORKTREES = path.join(PILOT_ROOT, "worktrees");
const EVIDENCE = path.join(PILOT_ROOT, "evidence");
const CONTROL_DB = path.join(PILOT_ROOT, "controller.sqlite");
// The lab extension imports this checked-out controller source; capability
// discovery must inspect that exact runtime module, never the installed global
// extension that remains untouched by this pilot.
const CONTROL_SOURCE = path.resolve(import.meta.dir, "../omp/agent/extensions/omp-control.ts");
const TASK_GRAPH_SOURCE = path.resolve(import.meta.dir, "../omp/agent/lib/task-graph.ts");
const EXTENSION = path.join(import.meta.dir, "task-graph-live-extension.ts");
const OMP_SDK = `${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts`;
const PROD_AGENT_DIR = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent`;
const CONTROL_DEPLOYED = path.join(PROD_AGENT_DIR, "extensions", "omp-control.ts");
const TASK_GRAPH_DEPLOYED = path.join(PROD_AGENT_DIR, "lib", "task-graph.ts");
const TERRA = "openai-codex/gpt-5.6-terra:high";

type PilotManifest = {
	schema: "omp-stage5-pilot/v1";
	createdAt: string;
	repo: string;
	target: string;
	authors: Array<{ id: string; path: string; branch: string; scope: string }>;
	frozenTestSha256: string;
	overlay: { task: string; sonic: string; verifier: string };
	graph: { targetRef: string; tasks: unknown[] };
};

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nearestExistingParent(value: string): string {
	let current = value;
	while (!fs.existsSync(current)) {
		const next = path.dirname(current);
		if (next === current) throw new Error(`no existing parent for ${value}`);
		current = next;
	}
	return current;
}

function labPath(value: string): string {
	const resolved = path.resolve(value);
	if (!isInside(resolved, LAB_ROOT)) throw new Error(`outside lab: ${resolved}`);
	const actualLab = fs.realpathSync.native(LAB_ROOT);
	if (!/^[dD]:[\\/]/.test(actualLab)) throw new Error(`lab root resolves outside D: ${actualLab}`);
	const existing = nearestExistingParent(resolved);
	if (!isInside(fs.realpathSync.native(existing), actualLab)) throw new Error(`junction escapes lab: ${resolved}`);
	if (fs.existsSync(resolved) && !isInside(fs.realpathSync.native(resolved), actualLab)) throw new Error(`junction escapes lab: ${resolved}`);
	return resolved;
}

function assertExperimentRoot(): void {
	if (!fs.existsSync(EXPERIMENT_MARKER)) throw new Error("OMP_EXPERIMENT_ROOT_MARKER_MISSING");
	const actualLab = fs.realpathSync.native(LAB_ROOT);
	if (!/^[dD]:[\\/]/.test(actualLab) || fs.readFileSync(EXPERIMENT_MARKER, "utf8").trim() !== "omp-dependency-lab/v1") {
		throw new Error("OMP_EXPERIMENT_ROOT_MARKER_INVALID");
	}
}

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
	return result.stdout.toString().trim();
}

function sha256Tree(directory: string): string {
	const files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter((entry): entry is string => typeof entry === "string")
		.filter(entry => fs.statSync(path.join(directory, entry)).isFile())
		.sort();
	const hash = crypto.createHash("sha256");
	for (const file of files) {
		hash.update(file);
		hash.update("\0");
		// Git may apply core.autocrlf independently to each worktree. Freeze test
		// content rather than its platform line-ending representation.
		hash.update(fs.readFileSync(path.join(directory, file), "utf8").replace(/\r\n/g, "\n"));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function writeFixture(file: string, value: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, value, "utf8");
}

function capabilityReport(): Record<string, unknown> {
	const source = fs.readFileSync(CONTROL_SOURCE, "utf8");
	const requiredNow = ["task_graph_create", "task_claim", "project_spawn", "task_deliver"];
	const expectedMerge = ["merge_enqueue", "merge_prepare", "merge_verify", "merge_apply", "merge_reconcile", "merge_status"];
	const actions = [...source.matchAll(/"([a-z_]+)"/g)].map(match => match[1]);
	const supported = Object.fromEntries(requiredNow.map(action => [action, actions.includes(action)]));
	const merge = Object.fromEntries(expectedMerge.map(action => [action, actions.includes(action)]));
	return {
		schema: "omp-stage5-capability/v1",
		observedAt: new Date().toISOString(),
		controlSource: CONTROL_SOURCE,
		extension: EXTENSION,
		controlDb: CONTROL_DB,
		supported,
		merge,
		readyForRealModelRun: Object.values(supported).every(Boolean) && Object.values(merge).every(Boolean),
		blockedBy: Object.entries(merge).filter(([, present]) => !present).map(([action]) => action),
	};
}

function prepare(): PilotManifest {
	assertExperimentRoot();
	if (fs.existsSync(REPO)) throw new Error(`pilot fixture already exists: ${REPO}`);
	fs.mkdirSync(LAB_ROOT, { recursive: true });
	fs.mkdirSync(labPath(PILOT_ROOT), { recursive: true });
	writeFixture(PILOT_MARKER, JSON.stringify({ schema: "omp-stage5-pilot-marker/v1", labRoot: LAB_ROOT, pilotRoot: PILOT_ROOT }, null, 2));
	git(PILOT_ROOT, ["init", "--initial-branch=main", REPO]);
	git(REPO, ["config", "user.name", "OMP Pilot"]);
	git(REPO, ["config", "user.email", "omp-pilot@local.invalid"]);
	writeFixture(path.join(REPO, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { test: "bun test test" } }, null, 2) + "\n");
	writeFixture(path.join(REPO, "src", "index.ts"), "export { parseTags } from './parse-tags.ts';\nexport { formatDuration } from './format-duration.ts';\n");
	writeFixture(path.join(REPO, "src", "parse-tags.ts"), "export function parseTags() { throw new Error('author task required'); }\n");
	writeFixture(path.join(REPO, "src", "format-duration.ts"), "export function formatDuration() { throw new Error('author task required'); }\n");
	writeFixture(path.join(REPO, "test", "parse-tags.test.ts"), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { parseTags } from '../src/parse-tags.ts';\n\ntest('parseTags normalizes comma separated tags', () => {\n  assert.deepEqual(parseTags(' Beta,alpha, beta ,,ZED '), ['alpha', 'beta', 'zed']);\n  assert.deepEqual(parseTags(''), []);\n  assert.throws(() => parseTags(null), TypeError);\n  assert.throws(() => parseTags(['x']), TypeError);\n});\n`);
	writeFixture(path.join(REPO, "test", "format-duration.test.ts"), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { formatDuration } from '../src/format-duration.ts';\n\ntest('formatDuration formats whole non-negative seconds', () => {\n  assert.equal(formatDuration(0), '00:00:00');\n  assert.equal(formatDuration(59), '00:00:59');\n  assert.equal(formatDuration(3661), '01:01:01');\n  assert.equal(formatDuration(90061), '25:01:01');\n  for (const invalid of [-1, 1.5, Infinity, NaN, '1', null]) assert.throws(() => formatDuration(invalid), RangeError);\n});\n`);
	writeFixture(path.join(REPO, "test", "integration.test.ts"), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { parseTags, formatDuration } from '../src/index.ts';\n\ntest('integrated public API composes both independent modules', () => {\n  assert.deepEqual(parseTags(' B,a '), ['a', 'b']);\n  assert.equal(formatDuration(7322), '02:02:02');\n});\n`);
	git(REPO, ["add", "."]);
	git(REPO, ["commit", "-m", "seed stage5 pilot fixture"]);
	fs.mkdirSync(WORKTREES, { recursive: true });
	const authors = [
		{ id: "parse-tags", branch: "pilot/parse-tags", scope: "src/parse-tags.ts" },
		{ id: "format-duration", branch: "pilot/format-duration", scope: "src/format-duration.ts" },
	];
	const authorPaths = authors.map(author => ({ ...author, path: path.join(WORKTREES, author.id) }));
	for (const author of authorPaths) git(REPO, ["worktree", "add", "-b", author.branch, author.path, "main"]);
	const manifest: PilotManifest = {
		schema: "omp-stage5-pilot/v1",
		createdAt: new Date().toISOString(),
		repo: REPO,
		target: REPO,
		authors: authorPaths,
		frozenTestSha256: sha256Tree(path.join(REPO, "test")),
		overlay: { task: TERRA, sonic: TERRA, verifier: TERRA },
		graph: {
			targetRef: "main",
			tasks: authorPaths.map(author => ({ id: author.id, writePaths: [author.scope], sharedResources: [], dependsOn: [] })),
		},
	};
	fs.mkdirSync(EVIDENCE, { recursive: true });
	writeFixture(path.join(PILOT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2));
	writeFixture(path.join(EVIDENCE, "capability.json"), JSON.stringify(capabilityReport(), null, 2));
	return manifest;
}

function verifyPilotMarker(): void {
	assertExperimentRoot();
	if (!fs.existsSync(PILOT_MARKER)) throw new Error("stage5 pilot marker is absent");
	const marker = JSON.parse(fs.readFileSync(PILOT_MARKER, "utf8")) as { schema?: unknown; labRoot?: unknown; pilotRoot?: unknown };
	if (marker.schema !== "omp-stage5-pilot-marker/v1" || marker.labRoot !== LAB_ROOT || marker.pilotRoot !== PILOT_ROOT) {
		throw new Error("stage5 pilot marker is invalid");
	}
	labPath(PILOT_ROOT);
}

function verifyPreparedFixture(manifest: PilotManifest): void {
	verifyPilotMarker();
	if (sha256Tree(path.join(manifest.target, "test")) !== manifest.frozenTestSha256) throw new Error("frozen acceptance tests changed");
	for (const author of manifest.authors) {
		if (sha256Tree(path.join(author.path, "test")) !== manifest.frozenTestSha256) {
			throw new Error(`frozen acceptance tests changed in ${author.id}`);
		}
	}
}

function readManifest(): PilotManifest {
	const file = path.join(PILOT_ROOT, "manifest.json");
	if (!fs.existsSync(file)) throw new Error("pilot fixture is absent; run --prepare first");
	return JSON.parse(fs.readFileSync(file, "utf8")) as PilotManifest;
}

function print(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function writeEvidence(name: string, value: unknown): void {
	writeFixture(path.join(EVIDENCE, name), JSON.stringify(value, null, 2));
}

function sha256File(file: string): string {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runtimeParity(): Record<string, unknown> {
	const files = [
		["controller", CONTROL_SOURCE, CONTROL_DEPLOYED],
		["taskGraph", TASK_GRAPH_SOURCE, TASK_GRAPH_DEPLOYED],
	] as const;
	const pairs = Object.fromEntries(files.map(([name, source, deployed]) => [name, {
		source,
		deployed,
		sourceSha256: fs.existsSync(source) ? sha256File(source) : null,
		deployedSha256: fs.existsSync(deployed) ? sha256File(deployed) : null,
		matches: fs.existsSync(source) && fs.existsSync(deployed) && sha256File(source) === sha256File(deployed),
	}]));
	const coreSha256 = fs.existsSync(OMP_SDK) ? sha256File(OMP_SDK) : null;
	return {
		schema: "omp-stage5-runtime-parity/v1",
		observedAt: new Date().toISOString(),
		core: { sdk: OMP_SDK, sha256: coreSha256, present: coreSha256 !== null },
		pairs,
		ready: coreSha256 !== null && Object.values(pairs).every(pair => (pair as { matches: boolean }).matches),
	};
}

async function sdkProbe(): Promise<Record<string, unknown>> {
	assertExperimentRoot();
	// Import validation only: do not create a session, resolve credentials, or prompt a model.
	const sdk = await import(OMP_SDK);
	const required = ["createAgentSession", "discoverAuthStorage", "AgentRegistry"];
	const available = Object.fromEntries(required.map(name => [name, name in sdk]));
	const report = {
		schema: "omp-stage5-sdk-probe/v1",
		observedAt: new Date().toISOString(),
		sdk: OMP_SDK,
		agentDirForRuntimeAuthOnly: PROD_AGENT_DIR,
		required: available,
		noSessionCreated: true,
		noAuthStorageOpened: true,
		noModelPrompted: true,
	};
	writeEvidence("sdk-probe.json", report);
	return report;
}

async function sessionSmoke(): Promise<Record<string, unknown>> {
	const manifest = readManifest();
	verifyPreparedFixture(manifest);
	const startedAt = Date.now();
	const attemptId = crypto.randomUUID();
	let session: { prompt: (input: string) => Promise<unknown>; dispose: () => Promise<void> } | undefined;
	let authStorage: { close?: () => Promise<void> | void } | undefined;
	let sessionId: string | undefined;
	let sessionFile: string | undefined;
	let failure: { name: string; message: string } | undefined;
	let commandInterception: Record<string, unknown> | undefined;
	try {
		const sdk = await import(OMP_SDK) as any;
		const { SessionManager } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts`);
		const { ModelRegistry } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-registry.ts`);
		const settings = await sdk.Settings.loadReadOnly({ cwd: manifest.target, agentDir: PROD_AGENT_DIR });
		settings.override("task.agentModelOverrides", {
			...settings.get("task.agentModelOverrides"),
			task: TERRA,
			sonic: TERRA,
			verifier: TERRA,
		});
		authStorage = await sdk.discoverAuthStorage(PROD_AGENT_DIR);
		const registry = new ModelRegistry(authStorage, path.join(PROD_AGENT_DIR, "models.yml"), {
			settings,
			cacheDbPath: path.join(PILOT_ROOT, "model-cache.sqlite"),
		});
		const manager = SessionManager.create(manifest.target, path.join(PILOT_ROOT, "sessions", "root-smoke"));
		sessionId = manager.getSessionId();
		sessionFile = manager.getSessionFile();
		const created = await sdk.createAgentSession({
			cwd: manifest.target,
			agentDir: PROD_AGENT_DIR,
			settings,
			authStorage,
			modelRegistry: registry,
			sessionManager: manager,
			modelPattern: "openai-codex/gpt-5.6-sol",
			thinkingLevel: "high",
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [EXTENSION],
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		});
		session = created.session;
		const extensionLoaded = created.extensionsResult.extensions.some(extension => path.resolve(extension.resolvedPath) === path.resolve(EXTENSION));
		const registrationFile = path.join(EVIDENCE, "extension-registrations.jsonl");
		const registered = fs.existsSync(registrationFile) && fs.readFileSync(registrationFile, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map(line => JSON.parse(line) as { command?: unknown; registeredAt?: unknown; pid?: unknown })
			.some(record => record.command === "pilot-stage5" && record.pid === process.pid && typeof record.registeredAt === "number" && record.registeredAt >= startedAt);
		if (!extensionLoaded || created.extensionsResult.errors.length !== 0 || !registered) {
			throw new Error("pilot-stage5 command was not registered; refusing a prompt that could reach the root model");
		}
		const command = async (input: Record<string, unknown>, file: string) =>
			await session!.prompt(`/pilot-stage5 ${JSON.stringify({ input, evidenceFile: path.join(EVIDENCE, file) })}`);
		await command({ action: "health" }, `smoke-${attemptId}-health-before.json`);
		await command({ action: "project_register", projectId: "stage5-smoke", canonicalRoot: manifest.target }, `smoke-${attemptId}-register.json`);
		await command({ action: "health" }, `smoke-${attemptId}-health-after.json`);
		const entries = manager.getEntries() as Array<{ type?: unknown; message?: { role?: unknown } }>;
		const modelUsageEntries = entries.filter(entry => entry.type === "model_usage" || (entry.type === "message" && entry.message?.role === "assistant"));
		const usage = manager.getUsageStatistics();
		if (modelUsageEntries.length !== 0 || usage.totalTokens !== 0 || usage.cost !== 0) {
			throw new Error("smoke observed model-usage entries after slash command interception");
		}
		commandInterception = { extensionLoaded, registrationRecorded: registered, sessionEntries: entries.length, modelUsageEntries: 0, usage };
		return {
			schema: "omp-stage5-session-smoke/v1",
			attemptId,
			rootSessionId: sessionId,
			rootSessionFile: sessionFile,
			controllerDb: CONTROL_DB,
			rootModel: "openai-codex/gpt-5.6-sol:high",
			overlay: { task: TERRA, sonic: TERRA, verifier: TERRA },
			providerRequests: 0,
			commandInterception,
		};
	} catch (error) {
		failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
		throw error;
	} finally {
		try {
			await session?.dispose();
		} finally {
			await authStorage?.close?.();
			writeEvidence(`session-smoke-${attemptId}.json`, {
				schema: "omp-stage5-session-smoke/v1",
				attemptId,
				startedAt,
				elapsedMs: Date.now() - startedAt,
				rootSessionId: sessionId,
				rootSessionFile: sessionFile,
				controllerDb: CONTROL_DB,
				commandInterception,
				failure,
			});
		}
	}
}

type WorkerPlan = { schema: "omp-stage5-worker/v1"; cwd: string; sessionFile?: string; sessionDir: string; rootModel: string; commands: Array<{ input: Record<string, unknown>; evidenceFile: string }> };
type WorkerResult = { ok: boolean; rootSessionId?: string; rootSessionFile?: string; sessionDir: string; commands: number; results: Array<Record<string, any>>; usage?: unknown; failure?: { name: string; message: string }; stderr?: string };

const authorSchema = {
	type: "object", additionalProperties: false,
	properties: { status: { type: "string" }, evidence: { type: "array", items: { type: "string" } } },
	required: ["status", "evidence"],
};
const gateSchema = {
	type: "object", additionalProperties: false,
	properties: {
		status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" },
		findings: {
			type: "array",
			items: {
				type: "object", additionalProperties: false,
				properties: { block: { type: "boolean" }, severity: { type: "string" }, summary: { type: "string" }, runId: { type: "string" }, generation: { type: "string" } },
				required: ["block", "severity", "summary", "runId", "generation"],
			},
		},
		evidence: { type: "array", items: { type: "string" } },
	},
	required: ["status", "runId", "generation", "findings", "evidence"],
};

function workerPlan(attemptRoot: string, name: string, cwd: string, commands: Array<Record<string, unknown>>, sessionFile?: string, sessionDir?: string): string {
	const root = path.join(attemptRoot, "workers", name);
	const file = path.join(root, "plan.json");
	writeFixture(file, JSON.stringify({ schema: "omp-stage5-worker/v1", cwd, sessionFile, sessionDir: sessionDir ?? path.join(root, "session"), rootModel: "openai-codex/gpt-5.6-sol", commands: commands.map((input, index) => ({ input, evidenceFile: path.join(root, `command-${index}.json`) })) } satisfies WorkerPlan, null, 2));
	return file;
}

async function invokeWorker(planFile: string): Promise<WorkerResult> {
	const workerProcess = Bun.spawn({ cmd: [process.execPath, import.meta.path, "--worker", planFile], cwd: path.dirname(planFile), stdout: "pipe", stderr: "pipe", env: { ...process.env } });
	const [exitCode, stdout, stderr] = await Promise.all([workerProcess.exited, new Response(workerProcess.stdout).text(), new Response(workerProcess.stderr).text()]);
	writeFixture(path.join(path.dirname(planFile), "process.json"), JSON.stringify({ schema: "omp-stage5-worker-process/v1", pid: workerProcess.pid, exitCode, stdout, stderr }, null, 2));
	const resultFile = path.join(path.dirname(planFile), "result.json");
	if (!fs.existsSync(resultFile)) throw new Error(`worker ${planFile}: ${stderr.trim()}`);
	const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8")) as WorkerResult;
	if (exitCode !== 0) parsed.stderr = stderr.trim();
	return parsed;
}

function commandResult(worker: WorkerResult, index = 0): Record<string, any> {
	if (!worker.ok) throw new Error(`worker failed: ${worker.failure?.message ?? worker.stderr ?? "unknown failure"}`);
	const command = worker.results[index];
	if (!command || command.failure) throw new Error(`controller command failed: ${command?.failure?.message ?? "missing evidence"}`);
	if (!command.result || typeof command.result !== "object") throw new Error("controller command did not record a result");
	return command.result as Record<string, any>;
}

function appendModelEvidence(attemptRoot: string, worker: WorkerResult): void {
	const file = path.join(attemptRoot, "model-calls.jsonl");
	const records: Record<string, unknown>[] = [];
	for (const command of worker.results) {
		const input = command.input as Record<string, unknown> | undefined;
		if (input?.action !== "project_spawn") continue;
		const result = command.result as Record<string, any> | undefined;
		const native = result?.result as Record<string, any> | undefined;
		records.push({
			schema: "omp-stage5-model-call/v1", observedAt: new Date().toISOString(), evidenceFile: command.evidenceFile ?? null,
			rootSessionId: command.rootSessionId ?? worker.rootSessionId ?? null, agent: input.agent ?? null,
			resolvedModel: native?.resolvedModel ?? null, resolvedModelIdentity: native?.resolvedModelIdentity ?? null,
			resolvedEffort: native?.resolvedThinkingLevel ?? null,
			usage: native?.usage ?? null, tokens: native?.tokens ?? null, requests: native?.requests ?? null,
			elapsedMs: native?.durationMs ?? command.elapsedMs ?? null,
			result: native ?? result,
		});
	}
	if (records.length) fs.appendFileSync(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function verifyModelEvidence(attemptRoot: string): Record<string, unknown> {
	const file = path.join(attemptRoot, "model-calls.jsonl");
	if (!fs.existsSync(file)) throw new Error("MODEL_EVIDENCE_MISSING");
	const records = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
	if (records.length !== 7) throw new Error(`MODEL_EVIDENCE_COUNT: expected 7, got ${records.length}`);
	const totalUsage: Record<string, number> = {};
	let totalRequests = 0;
	for (const [index, record] of records.entries()) {
		if (record.resolvedModel?.split(":")[0] !== "openai-codex/gpt-5.6-terra" || record.resolvedEffort !== "high") {
			throw new Error(`MODEL_EVIDENCE_IDENTITY: record ${index}`);
		}
		if (!Number.isInteger(record.requests) || record.requests <= 0) throw new Error(`MODEL_EVIDENCE_REQUESTS: record ${index}`);
		if (!Number.isFinite(record.elapsedMs) || record.elapsedMs <= 0 || !record.usage || typeof record.usage !== "object") throw new Error(`MODEL_EVIDENCE_USAGE: record ${index}`);
		totalRequests += record.requests;
		for (const [name, value] of Object.entries(record.usage as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isFinite(value)) totalUsage[name] = (totalUsage[name] ?? 0) + value;
		}
	}
	const verified = { schema: "omp-stage5-model-evidence/v1", expectedCalls: 7, records, totalRequests, totalUsage };
	writeFixture(path.join(attemptRoot, "model-evidence.json"), JSON.stringify(verified, null, 2));
	return verified;
}

async function runStep(attemptRoot: string, plan: string): Promise<WorkerResult> {
	const worker = await invokeWorker(plan);
	appendModelEvidence(attemptRoot, worker);
	commandResult(worker);
	return worker;
}

function commandInput(action: string, fields: Record<string, unknown>): Record<string, unknown> {
	return { action, ...fields };
}

function sessionDirFor(attemptRoot: string, name: string): string {
	return path.join(attemptRoot, "workers", name, "session");
}

function requireSessionResume(worker: WorkerResult, expected: string, label: string): void {
	if (!worker.rootSessionFile || path.resolve(worker.rootSessionFile) !== path.resolve(expected)) {
		throw new Error(`${label} did not resume the recorded root session`);
	}
}

function authorTask(author: PilotManifest["authors"][number]): string {
	return `Implement only ${author.scope} in this fixture. Run the frozen focused test for this task and return the requested JSON. Do not run any Git command, commit, stage, edit tests, edit package metadata, or edit any other source file. The runner alone validates and commits the owned source file.`;
}

function runnerCommitAuthor(author: PilotManifest["authors"][number], claimHead: string): string {
	if (git(author.path, ["rev-parse", "HEAD"]) !== claimHead) throw new Error(`${author.id} changed Git history before runner commit`);
	const tracked = git(author.path, ["diff", "--name-only", "HEAD"]).split(/\r?\n/).filter(Boolean);
	const untracked = git(author.path, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean);
	const changed = [...new Set([...tracked, ...untracked])];
	if (changed.length !== 1 || changed[0] !== author.scope) throw new Error(`${author.id} changed outside owned source: ${changed.join(", ") || "none"}`);
	git(author.path, ["add", "--", author.scope]);
	git(author.path, ["commit", "-m", `pilot: implement ${author.id}`]);
	if (git(author.path, ["status", "--porcelain"]) !== "") throw new Error(`${author.id} left a dirty worktree after runner commit`);
	return git(author.path, ["rev-parse", "HEAD"]);
}

function gateTask(command: string, scope: string): string {
	return `Independently verify the current ${scope}. Do not edit any source, tests, configuration, or Git state. Run exactly: ${command}. Return the requested gate JSON using the injected runId and generation. PASS only if the command passes and findings is empty; evidence must name the command and its observed result.`;
}

function createCandidate(manifest: PilotManifest, attemptRoot: string, attemptId: string, taskId: string): { path: string; branch: string } {
	const candidate = labPath(path.join(attemptRoot, "candidates", taskId));
	if (fs.existsSync(candidate)) throw new Error(`candidate already exists: ${candidate}`);
	const branch = `pilot/candidate-${attemptId}-${taskId}`;
	git(manifest.target, ["worktree", "add", "-b", branch, candidate, "HEAD"]);
	return { path: candidate, branch };
}

async function runLivePilot(manifest: PilotManifest, attemptRoot: string, attemptId: string): Promise<Record<string, unknown>> {
	const graphId = `stage5-${attemptId}`;
	const targetName = "target";
	const targetSessionDir = sessionDirFor(attemptRoot, targetName);
	const targetRegister = await runStep(attemptRoot, workerPlan(attemptRoot, "target-register", manifest.target, [commandInput("project_register", { canonicalRoot: manifest.target })], undefined, targetSessionDir));
	const targetProjectId = String(commandResult(targetRegister).projectId);
	const targetSessionFile = String(targetRegister.rootSessionFile);
	const targetRun = await runStep(attemptRoot, workerPlan(attemptRoot, "target-run", manifest.target, [commandInput("run_begin", { projectId: targetProjectId, risk: "mechanical" })], targetSessionFile, targetSessionDir));
	requireSessionResume(targetRun, targetSessionFile, "target run");
	const targetRunId = String(commandResult(targetRun).runId);
	const graphCreated = await runStep(attemptRoot, workerPlan(attemptRoot, "target-graph", manifest.target, [commandInput("task_graph_create", { projectId: targetProjectId, runId: targetRunId, graphId, graphPlan: manifest.graph })], String(targetRun.rootSessionFile), targetSessionDir));
	requireSessionResume(graphCreated, targetSessionFile, "target graph");

	const authorContexts = await Promise.all(manifest.authors.map(async author => {
		const name = `author-${author.id}`;
		const sessionDir = sessionDirFor(attemptRoot, name);
		const registered = await runStep(attemptRoot, workerPlan(attemptRoot, `${name}-register`, author.path, [commandInput("project_register", { canonicalRoot: author.path })], undefined, sessionDir));
		const projectId = String(commandResult(registered).projectId);
		const sessionFile = String(registered.rootSessionFile);
		const begun = await runStep(attemptRoot, workerPlan(attemptRoot, `${name}-run`, author.path, [commandInput("run_begin", { projectId, risk: "mechanical" })], sessionFile, sessionDir));
		const runId = String(commandResult(begun).runId);
		const claimed = await runStep(attemptRoot, workerPlan(attemptRoot, `${name}-claim`, author.path, [commandInput("task_claim", { projectId, runId, graphId, taskId: author.id, idempotencyKey: `${author.id}-author` })], String(begun.rootSessionFile), sessionDir));
		const claim = commandResult(claimed);
		const claimToken = String(claim.claimToken);
		const claimHead = String(claim.claimHead);
		return { author, name, sessionDir, projectId, runId, claimToken, claimHead, sessionFile: String(claimed.rootSessionFile) };
	}));
	const authorWindows: Array<{ author: string; workerStartedAt: number; workerFinishedAt: number; commandStartedAt: number; commandFinishedAt: number; commandElapsedMs: number; nativeDurationMs: number | null }> = [];
	const authored = await Promise.all(authorContexts.map(async context => {
		const workerStartedAt = Date.now();
		const spawned = await runStep(attemptRoot, workerPlan(attemptRoot, `${context.name}-author`, context.author.path, [commandInput("project_spawn", { projectId: context.projectId, runId: context.runId, graphId, taskId: context.author.id, claimToken: context.claimToken, idempotencyKey: `${context.author.id}-author`, agent: "task", task: authorTask(context.author), outputSchema: authorSchema })], context.sessionFile, context.sessionDir));
		requireSessionResume(spawned, context.sessionFile, `${context.author.id} author`);
		const workerFinishedAt = Date.now();
		const command = spawned.results[0];
		const commandStartedAt = Number(command?.startedAt);
		const commandElapsedMs = Number(command?.elapsedMs);
		if (!Number.isFinite(commandStartedAt) || !Number.isFinite(commandElapsedMs) || commandElapsedMs < 0) throw new Error(`${context.author.id} author command timing is absent`);
		const nativeDurationMs = typeof command?.result?.result?.durationMs === "number" ? command.result.result.durationMs : null;
		authorWindows.push({ author: context.author.id, workerStartedAt, workerFinishedAt, commandStartedAt, commandFinishedAt: commandStartedAt + commandElapsedMs, commandElapsedMs, nativeDurationMs });
		commandResult(spawned);
		const committed = runnerCommitAuthor(context.author, context.claimHead);
		writeFixture(path.join(attemptRoot, "runner-commits", `${context.author.id}.json`), JSON.stringify({ schema: "omp-stage5-runner-commit/v1", taskId: context.author.id, claimHead: context.claimHead, committed }, null, 2));
		verifyPreparedFixture(manifest);
		const gated = await runStep(attemptRoot, workerPlan(attemptRoot, `${context.name}-gate`, context.author.path, [commandInput("project_spawn", { projectId: context.projectId, runId: context.runId, idempotencyKey: `${context.author.id}-verification`, agent: "verifier", gate: "verification", task: gateTask(`bun test test/${context.author.id}.test.ts`, context.author.scope), outputSchema: gateSchema })], String(spawned.rootSessionFile), context.sessionDir));
		requireSessionResume(gated, context.sessionFile, `${context.author.id} verifier`);
		commandResult(gated);
		const delivered = await runStep(attemptRoot, workerPlan(attemptRoot, `${context.name}-deliver`, context.author.path, [commandInput("task_deliver", { projectId: context.projectId, runId: context.runId, graphId, taskId: context.author.id, claimToken: context.claimToken })], String(gated.rootSessionFile), context.sessionDir));
		requireSessionResume(delivered, context.sessionFile, `${context.author.id} delivery`);
		return { ...context.author, projectId: context.projectId, runId: context.runId, claimToken: context.claimToken, rootSessionFile: delivered.rootSessionFile, delivered: commandResult(delivered) };
	}));
	const overlapMs = Math.min(...authorWindows.map(window => window.commandFinishedAt)) - Math.max(...authorWindows.map(window => window.commandStartedAt));
	writeFixture(path.join(attemptRoot, "author-overlap.json"), JSON.stringify({ schema: "omp-stage5-author-overlap/v1", windows: authorWindows, overlapMs, concurrent: overlapMs > 0, timingSource: "project_spawn command startedAt/elapsedMs with native duration retained" }, null, 2));
	if (overlapMs <= 0) throw new Error("author project_spawn command intervals did not overlap");
	const authors = authored;

	for (const [index, author] of authors.entries()) {
		const attemptKey = `${attemptId}-${author.id}`;
		const enqueued = await runStep(attemptRoot, workerPlan(attemptRoot, `target-enqueue-${author.id}`, manifest.target, [commandInput("merge_enqueue", { projectId: targetProjectId, runId: targetRunId, graphId, taskId: author.id, idempotencyKey: attemptKey })], targetSessionFile, targetSessionDir));
		requireSessionResume(enqueued, targetSessionFile, "target enqueue");
		const queue = commandResult(enqueued);
		const claimToken = String(queue.claimToken);
		const candidate = createCandidate(manifest, attemptRoot, attemptId, author.id);
		if (sha256Tree(path.join(candidate.path, "test")) !== manifest.frozenTestSha256) throw new Error(`frozen acceptance tests changed in candidate ${author.id}`);
		const candidateName = `candidate-${author.id}`;
		const candidateSessionDir = sessionDirFor(attemptRoot, candidateName);
		const candidateRegistered = await runStep(attemptRoot, workerPlan(attemptRoot, `${candidateName}-register`, candidate.path, [commandInput("project_register", { canonicalRoot: candidate.path })], undefined, candidateSessionDir));
		const candidateProjectId = String(commandResult(candidateRegistered).projectId);
		const candidateSessionFile = String(candidateRegistered.rootSessionFile);
		const candidateRun = await runStep(attemptRoot, workerPlan(attemptRoot, `${candidateName}-run`, candidate.path, [commandInput("run_begin", { projectId: candidateProjectId, risk: "mechanical" })], candidateSessionFile, candidateSessionDir));
		const candidateRunId = String(commandResult(candidateRun).runId);
		const prepared = await runStep(attemptRoot, workerPlan(attemptRoot, `${candidateName}-prepare`, candidate.path, [commandInput("merge_prepare", { projectId: candidateProjectId, runId: candidateRunId, graphId, taskId: author.id, idempotencyKey: attemptKey, claimToken })], String(candidateRun.rootSessionFile), candidateSessionDir));
		const prepare = commandResult(prepared);
		if (prepare.state !== "candidate_ready") throw new Error(`candidate did not become ready for ${author.id}: ${prepare.state}`);
		const candidateCommand = index === 0 ? `bun test test/${author.id}.test.ts` : "bun test";
		const candidateGate = await runStep(attemptRoot, workerPlan(attemptRoot, `${candidateName}-gate`, candidate.path, [commandInput("project_spawn", { projectId: candidateProjectId, runId: candidateRunId, idempotencyKey: `${attemptKey}-verification`, agent: "verifier", gate: "verification", task: gateTask(candidateCommand, `merge candidate for ${author.scope}`), outputSchema: gateSchema })], String(prepared.rootSessionFile), candidateSessionDir));
		commandResult(candidateGate);
		if (sha256Tree(path.join(candidate.path, "test")) !== manifest.frozenTestSha256) throw new Error(`frozen acceptance tests changed by candidate verifier ${author.id}`);
		const verified = await runStep(attemptRoot, workerPlan(attemptRoot, `${candidateName}-verify`, candidate.path, [commandInput("merge_verify", { projectId: candidateProjectId, runId: candidateRunId, graphId, taskId: author.id, idempotencyKey: attemptKey, claimToken })], String(candidateGate.rootSessionFile), candidateSessionDir));
		if (commandResult(verified).state !== "verified") throw new Error(`candidate verification did not settle for ${author.id}`);
		const applied = await runStep(attemptRoot, workerPlan(attemptRoot, `target-apply-${author.id}`, manifest.target, [commandInput("merge_apply", { projectId: targetProjectId, runId: targetRunId, graphId, taskId: author.id, idempotencyKey: attemptKey, claimToken })], targetSessionFile, targetSessionDir));
		requireSessionResume(applied, targetSessionFile, "target apply");
		if (commandResult(applied).state !== "merged") throw new Error(`merge did not settle for ${author.id}`);
		if (sha256Tree(path.join(manifest.target, "test")) !== manifest.frozenTestSha256) throw new Error("frozen acceptance tests changed after merge");
	}

	const finalGate = await runStep(attemptRoot, workerPlan(attemptRoot, "target-final-gate", manifest.target, [commandInput("project_spawn", { projectId: targetProjectId, runId: targetRunId, idempotencyKey: `${attemptId}-target-verification`, agent: "verifier", gate: "verification", task: gateTask("bun test", "final target source and frozen full acceptance suite"), outputSchema: gateSchema })], targetSessionFile, targetSessionDir));
	requireSessionResume(finalGate, targetSessionFile, "target final verifier");
	commandResult(finalGate);
	const completed = await runStep(attemptRoot, workerPlan(attemptRoot, "target-complete", manifest.target, [commandInput("run_complete", { projectId: targetProjectId, runId: targetRunId })], String(finalGate.rootSessionFile), targetSessionDir));
	const completion = commandResult(completed);
	if (completion.taskComplete !== true) throw new Error("final target gate did not complete the run");
	verifyPreparedFixture(manifest);
	const modelEvidence = verifyModelEvidence(attemptRoot);
	return { graphId, targetProjectId, targetRunId, authors, completion, modelEvidence };
}

async function runWorker(planFile: string): Promise<void> {
	assertExperimentRoot();
	const plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as WorkerPlan;
	if (plan.schema !== "omp-stage5-worker/v1") throw new Error("invalid worker plan");
	labPath(plan.cwd); labPath(plan.sessionDir); labPath(planFile);
	for (const command of plan.commands) labPath(command.evidenceFile);
	const sdk = await import(OMP_SDK) as any;
	const { SessionManager } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts`);
	const { ModelRegistry } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-registry.ts`);
	const settings = await sdk.Settings.loadReadOnly({ cwd: plan.cwd, agentDir: PROD_AGENT_DIR });
	settings.override("task.agentModelOverrides", { ...settings.get("task.agentModelOverrides"), task: TERRA, sonic: TERRA, verifier: TERRA });
	const authStorage = await sdk.discoverAuthStorage(PROD_AGENT_DIR);
	let session: { prompt: (text: string) => Promise<unknown>; dispose: () => Promise<void> } | undefined;
	let manager: any;
	const results: Array<Record<string, any>> = [];
	let failure: { name: string; message: string } | undefined;
	try {
		const registry = new ModelRegistry(authStorage, path.join(PROD_AGENT_DIR, "models.yml"), { settings, cacheDbPath: path.join(PILOT_ROOT, "model-cache.sqlite") });
		manager = plan.sessionFile
			? await SessionManager.open(labPath(plan.sessionFile), plan.sessionDir, undefined, { throwIfMissing: true })
			: SessionManager.create(plan.cwd, plan.sessionDir);
		// Command-only root turns do not otherwise materialize the lazy JSONL,
		// which would make the recorded session path impossible to resume.
		await manager.ensureOnDisk();
		const extensionStartedAt = Date.now();
		const created = await sdk.createAgentSession({ cwd: plan.cwd, agentDir: PROD_AGENT_DIR, settings, authStorage, modelRegistry: registry, sessionManager: manager, modelPattern: plan.rootModel, thinkingLevel: "high", disableExtensionDiscovery: true, additionalExtensionPaths: [EXTENSION], enableMCP: false, enableLsp: false, enableIrc: false });
		const registrationFile = path.join(PILOT_ROOT, "evidence", "extension-registrations.jsonl");
		const registered = fs.existsSync(registrationFile) && fs.readFileSync(registrationFile, "utf8")
			.split(/\r?\n/).filter(Boolean)
			.map(line => JSON.parse(line) as { command?: unknown; registeredAt?: unknown; pid?: unknown })
			.some(record => record.command === "pilot-stage5" && record.pid === process.pid && typeof record.registeredAt === "number" && record.registeredAt >= extensionStartedAt);
		if (!created.extensionsResult.extensions.some((extension: any) => path.resolve(extension.resolvedPath) === path.resolve(EXTENSION)) || created.extensionsResult.errors.length || !registered) {
			throw new Error("pilot-stage5 command was not registered; refusing a prompt that could reach the root model");
		}
		session = created.session;
		for (const command of plan.commands) {
			await session!.prompt(`/pilot-stage5 ${JSON.stringify(command)}`);
			results.push(JSON.parse(fs.readFileSync(command.evidenceFile, "utf8")));
		}
	} catch (error) {
		failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
		throw error;
	} finally {
		try {
			await session?.dispose();
		} finally {
			await authStorage.close?.();
			for (const command of plan.commands) {
				if (fs.existsSync(command.evidenceFile) && !results.some(result => result.evidenceFile === command.evidenceFile)) {
					results.push(JSON.parse(fs.readFileSync(command.evidenceFile, "utf8")));
				}
			}
			writeFixture(path.join(path.dirname(planFile), "result.json"), JSON.stringify({ ok: !failure, rootSessionId: manager?.getSessionId?.(), rootSessionFile: manager?.getSessionFile?.(), sessionDir: plan.sessionDir, commands: plan.commands.length, results, usage: manager?.getUsageStatistics?.(), failure }, null, 2));
		}
	}
}

async function main(): Promise<void> {
	const command = process.argv[2] ?? "--probe";
	if (command === "--probe") {
		print(capabilityReport());
	} else if (command === "--runtime-parity") {
		print(runtimeParity());
	} else if (command === "--sdk-probe") {
		print(await sdkProbe());
	} else if (command === "--session-smoke") {
		print(await sessionSmoke());
	} else if (command === "--worker") {
		const planFile = process.argv[3];
		if (!planFile) throw new Error("worker plan path required");
		await runWorker(planFile);
	} else if (command === "--prepare") {
		print({ prepared: prepare(), capability: capabilityReport() });
	} else if (command === "--verify-fixture") {
		const manifest = readManifest();
		verifyPreparedFixture(manifest);
		print({ ok: true, manifest, capability: capabilityReport() });
	} else if (command === "--run") {
		const startedAt = Date.now();
		const attemptId = crypto.randomUUID();
		const attemptRoot = labPath(path.join(PILOT_ROOT, "attempts", attemptId));
		const attemptDb = path.join(attemptRoot, "controller.sqlite");
		try {
			const manifest = readManifest();
			verifyPreparedFixture(manifest);
			const capability = capabilityReport();
			const parity = runtimeParity();
			if (capability.readyForRealModelRun !== true) {
				throw new Error(`MERGE_API_UNAVAILABLE: ${(capability.blockedBy as string[]).join(", ")}`);
			}
			if (parity.ready !== true) throw new Error("DEPLOYED_CORE_SOURCE_HASH_MISMATCH");
			if (fs.existsSync(attemptDb)) throw new Error(`attempt database already exists: ${attemptDb}`);
			fs.mkdirSync(attemptRoot, { recursive: true });
			process.env.PILOT_CONTROL_DB = attemptDb;
			writeFixture(path.join(attemptRoot, "attempt.json"), JSON.stringify({
				schema: "omp-stage5-real-attempt/v1", attemptId, startedAt, controllerDb: attemptDb,
				rootModel: "openai-codex/gpt-5.6-sol:high", overlay: { task: TERRA, sonic: TERRA, verifier: TERRA }, capability, parity,
			}, null, 2));
			if (process.env.PILOT_ALLOW_REAL_MODEL !== "1") throw new Error(`REAL_MODEL_RUN_NOT_ARMED: ${attemptId}`);
			const completed = await runLivePilot(manifest, attemptRoot, attemptId);
			writeFixture(path.join(attemptRoot, "completed.json"), JSON.stringify({ schema: "omp-stage5-completed/v1", attemptId, startedAt, elapsedMs: Date.now() - startedAt, ...completed }, null, 2));
			print({ ok: true, attemptId, attemptRoot, ...completed });
		} catch (error) {
			writeFixture(path.join(attemptRoot, "failure.json"), JSON.stringify({
				schema: "omp-stage5-runtime-entry/v1",
				attemptId,
				controllerDb: attemptDb,
				startedAt,
				elapsedMs: Date.now() - startedAt,
				failure: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
			}, null, 2));
			throw error;
		}
	} else {
		throw new Error("usage: --probe | --runtime-parity | --sdk-probe | --session-smoke | --prepare | --verify-fixture | --run");
	}
}

await main();
