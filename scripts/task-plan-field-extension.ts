import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
const { Settings } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts`);
import control, { dispatchAt, setControlTestDb, type ControlInput } from "../omp/agent/extensions/omp-control.ts";

const LAB_ROOT = path.resolve("D:/Labs/omp/omp-field-lab-20260918");
const EXPERIMENT_MARKER = path.join(LAB_ROOT, ".omp-experiment-root");
const ROOT = path.join(LAB_ROOT, "field-project");
const MARKER = path.join(ROOT, ".field-project-marker.json");
const CONTROL_DB = process.env.FIELD_CONTROL_DB;
const TERRA = "openai-codex/gpt-5.6-terra:high";

if (!CONTROL_DB) throw new Error("FIELD_CONTROL_DB_REQUIRED");

function inside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingParent(value: string): string {
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
	if (!inside(resolved, LAB_ROOT)) throw new Error(`${label} must stay under ${LAB_ROOT}`);
	const lab = fs.realpathSync.native(LAB_ROOT);
	if (!/^[dD]:[\\/]/.test(lab) || !inside(fs.realpathSync.native(existingParent(resolved)), lab)) throw new Error(`${label} resolves outside lab`);
	if (fs.existsSync(resolved) && !inside(fs.realpathSync.native(resolved), lab)) throw new Error(`${label} resolves outside lab`);
	return resolved;
}

function experimentRoot(): void {
	if (!fs.existsSync(EXPERIMENT_MARKER)) throw new Error("OMP_EXPERIMENT_ROOT_MARKER_MISSING");
	const actual = fs.realpathSync.native(LAB_ROOT);
	if (!/^[dD]:[\\/]/.test(actual) || fs.readFileSync(EXPERIMENT_MARKER, "utf8").trim() !== "omp-dependency-lab/v1" || !inside(fs.realpathSync.native(EXPERIMENT_MARKER), actual)) throw new Error("OMP_EXPERIMENT_ROOT_MARKER_INVALID");
}

function assertFixture(cwd: string): void {
	experimentRoot();
	const marker = JSON.parse(fs.readFileSync(MARKER, "utf8")) as { schema?: unknown; root?: unknown };
	if (marker.schema !== "omp-field-task-plan/v1" || marker.root !== ROOT) throw new Error("FIELD_FIXTURE_MARKER_INVALID");
	labPath(ROOT, "field root");
	labPath(cwd, "root session cwd");
}

function command(value: string): { input: ControlInput; evidenceFile: string } {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new Error("field-plan expects one JSON object"); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("field-plan payload");
	const record = parsed as { input?: unknown; evidenceFile?: unknown };
	if (!record.input || typeof record.input !== "object" || Array.isArray(record.input) || typeof record.evidenceFile !== "string") throw new Error("field-plan input");
	return { input: record.input as ControlInput, evidenceFile: labPath(record.evidenceFile, "evidenceFile") };
}

function failure(error: unknown): { name: string; message: string } {
	const value = error instanceof Error ? error : new Error(String(error));
	return { name: value.name, message: value.message.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]").replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]") };
}

async function settings(cwd: string): Promise<Settings> {
	const value = await Settings.loadReadOnly({ cwd });
	value.override("task.agentModelOverrides", { ...value.get("task.agentModelOverrides"), task: TERRA, sonic: TERRA, verifier: TERRA, "security-reviewer": TERRA });
	return value;
}

export default function fieldPlanExtension(pi: ExtensionAPI): void {
	assertFixture(ROOT);
	setControlTestDb(labPath(CONTROL_DB, "FIELD_CONTROL_DB"));
	control(pi);
	pi.registerCommand("field-plan", {
		description: "Run one isolated field task-plan controller action from a root session.",
		async handler(args, ctx) {
			const { input, evidenceFile } = command(args);
			assertFixture(ctx.cwd);
			const startedAt = Date.now();
			const progress: unknown[] = [];
			let result: unknown;
			let caught: { name: string; message: string } | undefined;
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const parentAgentId = pi.pi.AgentRegistry.global().list().find(ref => ref.kind === "main" && ref.session?.sessionManager.getSessionId() === sessionId)?.id;
				result = await dispatchAt(CONTROL_DB, input, {
					cwd: ctx.cwd, sessionId, settings: await settings(ctx.cwd), modelRegistry: ctx.modelRegistry,
					parentActiveModelPattern: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, parentAgentId, eventBus: pi.events,
					runSubprocess: async options => await pi.pi.runSubprocess({ ...options, preloadedExtensionPaths: [], preloadedPreparedExtensions: [], preloadedCustomToolPaths: [], enableMCP: false, enableIrc: false, enableLsp: false }),
					onProgress: update => progress.push(update),
				});
			} catch (error) { caught = failure(error); throw error; }
			finally {
				fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
				fs.writeFileSync(evidenceFile, JSON.stringify({ schema: "omp-field-task-plan-command/v1", evidenceFile, controllerDb: path.resolve(CONTROL_DB), startedAt, elapsedMs: Date.now() - startedAt, rootSessionId: ctx.sessionManager.getSessionId(), rootSessionFile: ctx.sessionManager.getSessionFile(), overlay: { task: TERRA, sonic: TERRA, verifier: TERRA, "security-reviewer": TERRA }, input, result, failure: caught, progress }, null, 2));
			}
		},
	});
	const registration = path.join(ROOT, "evidence", "extension-registrations.jsonl");
	fs.mkdirSync(path.dirname(registration), { recursive: true });
	fs.appendFileSync(registration, `${JSON.stringify({ schema: "omp-field-task-plan-registration/v1", registeredAt: Date.now(), pid: process.pid, command: "field-plan" })}\n`);
}
