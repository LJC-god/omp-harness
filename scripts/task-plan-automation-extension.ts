import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { runtimeModule } from "../omp/agent/lib/omp-runtime.ts";
const { Settings } = await import(runtimeModule("pi-coding-agent/src/config/settings.ts"));
import control, { dispatchAt, setControlTestDb, type ControlInput } from "../omp/agent/extensions/omp-control.ts";

const MODE = process.env.OMP_AUTOMATION_MODE;
const LAB_ROOT = process.env.OMP_AUTOMATION_LAB_ROOT;
const CONTROL_DB = process.env.OMP_AUTOMATION_CONTROL_DB;
const EVIDENCE_ROOT = process.env.OMP_AUTOMATION_EVIDENCE_ROOT;
const TERRA = "openai-codex/gpt-5.6-terra:high";
const SYSTEM_DB = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/orchestration.sqlite`;

if (MODE !== "lab" && MODE !== "normal") throw new Error("OMP_AUTOMATION_MODE_REQUIRED");
if (!CONTROL_DB || !EVIDENCE_ROOT) throw new Error("OMP_AUTOMATION_PATHS_REQUIRED");

function inside(child: string, parent: string): boolean { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function existingParent(value: string): string { let current = value; while (!fs.existsSync(current)) { const next = path.dirname(current); if (next === current) throw new Error(`NO_EXISTING_PARENT:${value}`); current = next; } return current; }
function dPath(value: string, label: string): string { const resolved = path.resolve(value); const parent = fs.realpathSync.native(existingParent(resolved)); if (!/^D:[\\/]/i.test(parent)) throw new Error(`${label}:D_DRIVE_REQUIRED`); return resolved; }
function under(value: string, root: string, label: string): string { const resolved = dPath(value, label), actual = fs.realpathSync.native(existingParent(resolved)), rootActual = fs.realpathSync.native(root); if (!inside(actual, rootActual) || (fs.existsSync(resolved) && !inside(fs.realpathSync.native(resolved), rootActual))) throw new Error(`${label}:OUTSIDE_ROOT`); return resolved; }
function lab(): string {
	if (MODE !== "lab") throw new Error("LAB_MODE_REQUIRED");
	if (!LAB_ROOT || !path.isAbsolute(LAB_ROOT)) throw new Error("OMP_AUTOMATION_LAB_ROOT_REQUIRED");
	const root = fs.realpathSync.native(LAB_ROOT), marker = path.join(root, ".omp-automation-lab-root");
	if (!/^D:[\\/]/i.test(root) || fs.readFileSync(marker, "utf8").replace(/\r\n/g, "\n") !== "omp-automation-lab/v1\n") throw new Error("OMP_AUTOMATION_LAB_MARKER_INVALID");
	return root;
}
function boundary(value: string, label: string): string { return MODE === "lab" ? under(value, lab(), label) : dPath(value, label); }
function redact(error: unknown): { name: string; message: string } { const value = error instanceof Error ? error : new Error(String(error)); return { name: value.name, message: value.message.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]").replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]") }; }
function parse(value: string): { input: ControlInput; evidenceFile: string } { let raw: unknown; try { raw = JSON.parse(value); } catch { throw new Error("automation-plan expects JSON"); } if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("automation-plan payload"); const record = raw as { input?: unknown; evidenceFile?: unknown }; if (!record.input || typeof record.input !== "object" || Array.isArray(record.input) || typeof record.evidenceFile !== "string") throw new Error("automation-plan fields"); return { input: record.input as ControlInput, evidenceFile: boundary(record.evidenceFile, "evidenceFile") }; }
async function settings(cwd: string): Promise<InstanceType<typeof Settings>> { const value = await Settings.loadReadOnly({ cwd }); if (MODE === "lab") value.override("task.agentModelOverrides", { ...value.get("task.agentModelOverrides"), task: TERRA, sonic: TERRA, verifier: TERRA, "security-reviewer": TERRA }); return value; }

export default function automationExtension(pi: ExtensionAPI): void {
	const evidenceRoot = boundary(EVIDENCE_ROOT!, "evidenceRoot"); const db = MODE === "lab" ? boundary(CONTROL_DB!, "controllerDb") : path.resolve(CONTROL_DB!); if (MODE === "normal" && db !== path.resolve(SYSTEM_DB)) throw new Error("OMP_AUTOMATION_NORMAL_DB_REQUIRED"); if (MODE === "lab") setControlTestDb(db); control(pi);
	pi.registerCommand("automation-plan", {
		description: "Dispatch one plan-automation controller command from a root session.",
		async handler(args, ctx) {
			const { input, evidenceFile } = parse(args); boundary(ctx.cwd, "cwd"); const startedAt = Date.now(); const progress: unknown[] = []; let result: unknown; let failure: { name: string; message: string } | undefined;
			try {
				const sessionId = ctx.sessionManager.getSessionId(); const parentAgentId = pi.pi.AgentRegistry.global().list().find(ref => ref.kind === "main" && ref.session?.sessionManager.getSessionId() === sessionId)?.id;
				result = await dispatchAt(db, input, { cwd: ctx.cwd, sessionId, settings: await settings(ctx.cwd), modelRegistry: ctx.modelRegistry, parentActiveModelPattern: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, parentAgentId, eventBus: pi.events, runSubprocess: async options => await pi.pi.runSubprocess({ ...options, preloadedExtensionPaths: [], preloadedPreparedExtensions: [], preloadedCustomToolPaths: [], enableMCP: false, enableIrc: false, enableLsp: false }), onProgress: update => progress.push(update) });
			} catch (error) { failure = redact(error); throw error; }
			finally { fs.mkdirSync(path.dirname(evidenceFile), { recursive: true }); fs.writeFileSync(evidenceFile, JSON.stringify({ schema: "omp-plan-automation-command/v1", mode: MODE, controllerDb: db, evidenceFile, startedAt, elapsedMs: Date.now() - startedAt, rootSessionId: ctx.sessionManager.getSessionId(), rootSessionFile: ctx.sessionManager.getSessionFile(), overlay: MODE === "lab" ? { task: TERRA, sonic: TERRA, verifier: TERRA, "security-reviewer": TERRA } : null, input, result, failure, progress }, null, 2)); }
		},
	});
	fs.mkdirSync(evidenceRoot, { recursive: true }); fs.appendFileSync(path.join(evidenceRoot, "extension-registrations.jsonl"), `${JSON.stringify({ schema: "omp-plan-automation-registration/v1", mode: MODE, command: "automation-plan", pid: process.pid, registeredAt: Date.now() })}\n`);
}