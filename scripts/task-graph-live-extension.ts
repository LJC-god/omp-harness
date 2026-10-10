import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
const { Settings } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts`);
import control, {
	dispatchAt,
	setControlTestDb,
	type ControlInput,
} from "../omp/agent/extensions/omp-control.ts";

const LAB_ROOT = "D:/Labs/omp/omp-merge-lab-20260918";
const LAB_ROOT_RESOLVED = path.resolve(LAB_ROOT);
const EXPERIMENT_MARKER = path.join(LAB_ROOT_RESOLVED, ".omp-experiment-root");
const PILOT_ROOT = path.join(LAB_ROOT_RESOLVED, "pilot-stage5");
const PILOT_MARKER = path.join(PILOT_ROOT, ".pilot-stage5-marker.json");
const CONTROL_DB = process.env.PILOT_CONTROL_DB ?? `${LAB_ROOT}/pilot-stage5/controller.sqlite`;
const TERRA = "openai-codex/gpt-5.6-terra:high";

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

function labPath(value: string, label: string): string {
	const resolved = path.resolve(value);
	if (!isInside(resolved, LAB_ROOT_RESOLVED)) throw new Error(`${label} must stay under ${LAB_ROOT_RESOLVED}`);
	const actualLab = fs.realpathSync.native(LAB_ROOT_RESOLVED);
	if (!/^[dD]:[\\/]/.test(actualLab)) throw new Error(`lab root resolves outside D: ${actualLab}`);
	const existing = nearestExistingParent(resolved);
	if (!isInside(fs.realpathSync.native(existing), actualLab)) throw new Error(`${label} resolves outside lab through a junction`);
	if (fs.existsSync(resolved) && !isInside(fs.realpathSync.native(resolved), actualLab)) throw new Error(`${label} resolves outside lab through a junction`);
	return resolved;
}

function assertExperimentRoot(): void {
	if (!fs.existsSync(EXPERIMENT_MARKER)) throw new Error("OMP_EXPERIMENT_ROOT_MARKER_MISSING");
	const actualLab = fs.realpathSync.native(LAB_ROOT_RESOLVED);
	if (!/^[dD]:[\\/]/.test(actualLab) || fs.readFileSync(EXPERIMENT_MARKER, "utf8").trim() !== "omp-dependency-lab/v1") {
		throw new Error("OMP_EXPERIMENT_ROOT_MARKER_INVALID");
	}
}

function assertPilotMarker(cwd: string): void {
	assertExperimentRoot();
	const marker = JSON.parse(fs.readFileSync(PILOT_MARKER, "utf8")) as { schema?: unknown; labRoot?: unknown; pilotRoot?: unknown };
	if (marker.schema !== "omp-stage5-pilot-marker/v1" || marker.labRoot !== LAB_ROOT_RESOLVED || marker.pilotRoot !== PILOT_ROOT) {
		throw new Error("invalid stage5 pilot marker");
	}
	labPath(PILOT_ROOT, "pilotRoot");
	labPath(cwd, "root session cwd");
}

function parseCommand(value: string): { input: ControlInput; evidenceFile: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("pilot-stage5 expects one JSON object");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("pilot-stage5 payload");
	const record = parsed as { input?: unknown; evidenceFile?: unknown };
	if (!record.input || typeof record.input !== "object" || Array.isArray(record.input)) throw new Error("pilot-stage5 input");
	if (typeof record.evidenceFile !== "string") throw new Error("pilot-stage5 evidenceFile");
	return { input: record.input as ControlInput, evidenceFile: labPath(record.evidenceFile, "evidenceFile") };
}

function safeFailure(error: unknown): { name: string; message: string } {
	const value = error instanceof Error ? error : new Error(String(error));
	return {
		name: value.name,
		message: value.message
			.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
			.replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]"),
	};
}

async function pilotSettings(cwd: string): Promise<Settings> {
	const settings = await Settings.loadReadOnly({ cwd });
	settings.override("task.agentModelOverrides", {
		...settings.get("task.agentModelOverrides"),
		task: TERRA,
		sonic: TERRA,
		verifier: TERRA,
	});
	return settings;
}

export default function taskGraphLiveExtension(pi: ExtensionAPI): void {
	assertPilotMarker(PILOT_ROOT);
	setControlTestDb(labPath(CONTROL_DB, "PILOT_CONTROL_DB"));
	control(pi);
	pi.registerCommand("pilot-stage5", {
		description: "Run one lab-only stage-5 controller action from a real root session.",
		async handler(args, ctx) {
			const { input, evidenceFile } = parseCommand(args);
			assertPilotMarker(ctx.cwd);
			const startedAt = Date.now();
			const progress: unknown[] = [];
			const sessionId = ctx.sessionManager.getSessionId();
			let result: unknown;
			let failure: { name: string; message: string } | undefined;
			try {
				const settings = await pilotSettings(ctx.cwd);
				const model = ctx.model;
				const parentAgentId = pi.pi.AgentRegistry.global()
					.list()
					.find(ref => ref.kind === "main" && ref.session?.sessionManager.getSessionId() === sessionId)?.id;
				result = await dispatchAt(CONTROL_DB, input, {
					cwd: ctx.cwd,
					sessionId,
					settings,
					modelRegistry: ctx.modelRegistry,
					parentActiveModelPattern: model ? `${model.provider}/${model.id}` : undefined,
					parentAgentId,
					eventBus: pi.events,
					runSubprocess: async options =>
						await pi.pi.runSubprocess({
							...options,
							preloadedExtensionPaths: [],
							preloadedPreparedExtensions: [],
							preloadedCustomToolPaths: [],
							enableMCP: false,
							enableIrc: false,
							enableLsp: false,
						}),
					onProgress: update => progress.push(update),
				});
			} catch (error) {
				failure = safeFailure(error);
				throw error;
			} finally {
				fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
				fs.writeFileSync(
					evidenceFile,
					JSON.stringify({
						schema: "omp-stage5-command/v1",
						evidenceFile,
						startedAt,
						elapsedMs: Date.now() - startedAt,
						rootSessionId: sessionId,
						rootSessionFile: ctx.sessionManager.getSessionFile(),
						overlay: { task: TERRA, sonic: TERRA, verifier: TERRA },
						input,
						result,
						failure,
						progress,
					}, null, 2),
					"utf8",
				);
			}
			ctx.ui.notify(`pilot evidence: ${evidenceFile}`, "info");
		},
	});
	const registrationFile = path.join(PILOT_ROOT, "evidence", "extension-registrations.jsonl");
	const registrationSessionId = pi.pi.AgentRegistry.global().list().find(ref => ref.kind === "main")?.session?.sessionManager.getSessionId();
	fs.mkdirSync(path.dirname(registrationFile), { recursive: true });
	fs.appendFileSync(registrationFile, `${JSON.stringify({ schema: "omp-stage5-extension-registration/v1", registeredAt: Date.now(), pid: process.pid, command: "pilot-stage5", rootSessionId: registrationSessionId })}\n`, "utf8");
}
