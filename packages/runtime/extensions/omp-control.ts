import { guardedSubprocess } from "../lib/task-health.ts";
import { parseTaskGraph, taskNodeId, taskScopesOverlap, TaskGraphError, type DependencyMaturity } from "../lib/task-graph.ts";
import { ambientLabPaths, assertAmbientLabTarget } from "../lib/ambient-lab.ts";
import { loadControlApis, loadDiscoverAgents } from "../lib/host-apis.ts";
import { controlDbFile, reservedTrees, worktreesRoot } from "../lib/paths.ts";
import { sourceFingerprint } from "../lib/source-fingerprint.ts";
import { assertWindowsDirectoryPin, pinWindowsDirectory, releaseWindowsDirectoryPin, type WindowsDirectoryIdentity, type WindowsDirectoryPin } from "../lib/directory-pin.ts";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { Database } from "bun:sqlite";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
const { Settings, resolveAgentModelSelection, SessionManager } = await loadControlApis();
type RuntimeSettings = InstanceType<typeof Settings>;

export const SYSTEM_DB_PATH = controlDbFile();
const WORKTREES_ROOT = worktreesRoot();
const RESERVED_TREES = reservedTrees();
const DEFAULT_TTL_MS = 30_000;
const OUTBOX_CLAIM_MS = 30_000;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

const ACTIONS = [
	"project_register",
	"project_get",
	"run_begin",
	"run_check",
	"baseline_capture",
	"lease_acquire",
	"lease_renew",
	"lease_release",
	"generation_advance",
	"generation_get",
	"safe_write",
	"event_append",
	"outbox_enqueue",
	"outbox_drain",
	"outbox_ack",
	"health",
	"project_spawn",
	"task_get",
	"task_observe",
	"task_reconcile",
	"run_status",
	"run_complete",
	"workspace_status",
	"workspace_prepare",
	"workspace_reconcile",
	"task_graph_create",
	"task_graph_status",
	"task_claim",
	"task_deliver",
	"task_claim_reconcile",
	"merge_enqueue",
	"merge_prepare",
	"merge_verify",
	"merge_apply",
	"merge_reconcile",
	"merge_status",
] as const;

export type ControlAction = (typeof ACTIONS)[number];

export type ControlInput = {
	action: ControlAction | string;
	projectId?: string;
	canonicalRoot?: string;
	resource?: string;
	token?: string;
	ttlMs?: number;
	path?: string;
	content?: string;
	baseSha?: string;
	type?: string;
	payload?: string;
	runId?: string;
	id?: string;
	claimToken?: string;
	idempotencyKey?: string;
	limit?: number;
	version?: string;
	waitMs?: number;
	includeResult?: boolean;
	agent?: string;
	task?: string;
	outputSchema?: unknown;
	risk?: "mechanical" | "standard" | "high";
	executionPolicy?: "integration-v1";
	checkCommand?: string[];
	diagnosticEvidence?: unknown;
	gate?: string;
	evidenceTaskKey?: string;
	graphId?: string;
	taskId?: string;
	graphPlan?: unknown;
	cancel?: boolean;
};
const activeControlTasks = new Set<string>();
const activeMergeOperations = new Set<number>();
const preparedWorkspaceTokens = new Map<string, Set<string>>();
const runtimeInstance = crypto.randomUUID();
const RUN_REQUIRED_ACTIONS = new Set(["baseline_capture", "lease_acquire", "lease_renew", "lease_release", "generation_advance", "safe_write", "event_append", "outbox_enqueue", "outbox_drain", "outbox_ack", "project_spawn", "task_reconcile", "run_complete", "run_status", "run_check", "task_graph_create", "task_claim", "task_deliver", "task_claim_reconcile", "merge_enqueue", "merge_prepare", "merge_verify", "merge_apply", "merge_reconcile"]);
const INTEGRATION_GATE = "integration_check";
const CHECK_TIMEOUT_MS = 1_800_000;
const CHECK_OUTPUT_LIMIT = 64 * 1024;
const CHECK_OUTPUT_HEAD_BYTES = 24 * 1024;
const CHECK_OUTPUT_TAIL_BYTES = CHECK_OUTPUT_LIMIT - CHECK_OUTPUT_HEAD_BYTES;

const GATE_AGENTS: Record<string, string> = {
	verification: "verifier", security: "security-reviewer", data_loss: "security-reviewer",
	critical_production_failure: "security-reviewer", reproduction: "verifier", arbitration: "reviewer",
};
// These roles may inspect an unsettled generation; ownership and occupancy still apply.
const READ_ONLY_CODING_AGENTS = new Set(["verifier", "reviewer", "security-reviewer", "librarian", "scout", "visual-reviewer", "aesthetic-reviewer", "gpt-visual-director"]);
type TaskReceipt = {
	project_id: string; task_key: string; run_id: string | null; generation: number;
	request_sha: string; agent: string; agent_id: string; gate: string | null;
	state: string; result_json: string | null; updated_at: number;
	runtime_id?: string | null; runtime_pid?: number | null; heartbeat_at?: number | null; session_file?: string | null;
};

export class ControlError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
		this.name = "ControlError";
	}
}

type ProjectRow = {
	id: string;
	canonical_root: string;
	allowed_roots: string;
	created_at: number;
	owner: string;
	root_vol: number | null;
	root_index: string | null;
	git_dir: string | null;
	git_dir_vol: number | null;
	git_dir_index: string | null;
	common_dir: string | null;
	common_dir_vol: number | null;
	common_dir_index: string | null;
};
type LeaseRow = {
	run_id: string | null;
	project_id: string;
	resource: string;
	owner: string;
	token: string;
	generation: number;
	expires_at: number;
};
type OutboxRow = {
	run_id: string | null;
	project_id: string;
	id: string;
	payload_sha: string;
	status: string;
	claim_token: string | null;
	attempts: number;
	claimed_at: number | null;
	created_at: number;
};
type LegacyDiagnosticEvidencePolicy = { schema: "omp-check-diagnostic/v1"; root: string };
type BoundDiagnosticEvidencePolicy = { schema: "omp-check-diagnostic/v2"; root: string; identity: WindowsDirectoryIdentity };
type DiagnosticEvidencePolicy = LegacyDiagnosticEvidencePolicy | BoundDiagnosticEvidencePolicy;
type DiagnosticPaths = { root: string; file: string };
type GraphNodeRow = {
	graph_id: string; task_id: string; state: string; write_paths: string; shared_resources: string; dependencies: string;
	project_id: string | null; run_id: string | null; owner: string | null; generation: number | null;
	claim_token: string | null; author_task_key: string | null; branch: string | null; claim_head: string | null;
	target_head: string | null; delivered_head: string | null; delivered_fingerprint: string | null;
};
type MergeQueueRow = {
	id: number; graph_id: string; task_id: string; attempt_id: string; state: string;
	target_project_id: string; target_run_id: string; target_owner: string; target_generation: number;
	common_vol: number; common_index: string; target_ref: string; delivered_head: string;
	claim_token: string; target_base: string | null; candidate_project_id: string | null; candidate_run_id: string | null;
	candidate_owner: string | null; candidate_generation: number | null; candidate_branch: string | null;
	candidate_start: string | null; candidate_head: string | null; candidate_fingerprint: string | null;
	block_code: string | null; operation_runtime: string | null; operation_pid: number | null; created_at: number; updated_at: number;
};
type Walked = { handle: bigint; finalPath: string; vol: number; index: string; links: number; attr: number };

export type SpawnHost = {
    eventBus?: ExtensionAPI["events"];
    parentAgentId?: string;
	cwd?: string;
	runSubprocess?: (options: Record<string, unknown>) => Promise<unknown>;
	signal?: AbortSignal;
	sessionId?: string;
	settings?: RuntimeSettings;
	modelRegistry?: unknown;
	parentActiveModelPattern?: string;
	onProgress?: (progress: unknown) => void;
};

export type ResumeHost = {
	cwd: string;
	sessionId?: string;
	listSessions: (cwd: string) => Promise<Array<{ id: string; path: string; cwd: string }>>;
	switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
};

let cachedDb: Database | null = null;
let cachedDbPath = "";
let cachedReady = false;
let aclStatus = "unknown";


let testAfterPin: (() => void) | null = null;
let testFlushFail = false;
let testBeforeRename: (() => void) | null = null;
let testAfterTmp: ((tmpAbs: string) => void) | null = null;
let testAfterRootOpen: (() => void) | null = null;
let testBeforeMergeAdmission: (() => void) | null = null;
let testDiagnosticWriteFail = false;
let testDiagnosticWritePartialFail = false;
let testDiagnosticStreamFail = false;
let testBeforeDiagnosticCreate: ((file: string) => void) | null = null;
let testBeforeDiagnosticCompletionHash: ((file: string) => void) | null = null;
let testCheckEnvironment: Record<string, string> | undefined;
let testCheckTimeoutMs: number | null = null;
export function setTestAfterPin(fn: (() => void) | null): void {
	testAfterPin = fn;
}
export function setTestFlushFail(v: boolean): void {
	testFlushFail = v;
}
export function setTestBeforeRename(fn: (() => void) | null): void {
	testBeforeRename = fn;
}
export function setTestAfterTmp(fn: ((tmpAbs: string) => void) | null): void {
	testAfterTmp = fn;
}
export function setTestAfterRootOpen(fn: (() => void) | null): void {
	testAfterRootOpen = fn;
}
export function setTestBeforeMergeAdmission(fn: (() => void) | null): void {
	testBeforeMergeAdmission = fn;
}
export function setTestDiagnosticWriteFail(value: boolean): void { testDiagnosticWriteFail = value; }
export function setTestDiagnosticWritePartialFail(value: boolean): void { testDiagnosticWritePartialFail = value; }
export function setTestDiagnosticStreamFail(value: boolean): void { testDiagnosticStreamFail = value; }
/** Test-only synchronization point after directory identity is fixed and before FILE_CREATE. */
export function setTestBeforeDiagnosticCreate(fn: ((file: string) => void) | null): void { testBeforeDiagnosticCreate = fn; }
/** Test-only synchronization point after a no-write completion handle is open and before hashing. */
export function setTestBeforeDiagnosticCompletionHash(fn: ((file: string) => void) | null): void { testBeforeDiagnosticCompletionHash = fn; }
export function setTestCheckEnvironment(value: Record<string, string> | undefined): void { testCheckEnvironment = value; }
/** Controlled-clock seam for isolated process/pipe tests; production always uses 30 minutes. */
export function setTestCheckTimeoutMs(value: number | null): void { testCheckTimeoutMs = value; }
export function sha256(data: Uint8Array | string): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}
export const HASH_CHUNK = 65536;
export function fileSizeFromHighLow(hi: number, lo: number): number {
	if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || lo < 0) fail("INVALID", "size");
	if (hi > 0x1fffff) fail("TOO_LARGE", "file exceeds MAX_SAFE_INTEGER");
	return hi * 0x100000000 + lo;
}
export function hashFromReader(size: number, read: (n: number) => Uint8Array): string {
	if (size > Number.MAX_SAFE_INTEGER) fail("TOO_LARGE", "size");
	if (size < 0 || !Number.isInteger(size)) fail("INVALID", "size");
	if (size === 0) return sha256(Buffer.alloc(0));
	const hash = crypto.createHash("sha256");
	let left = size;
	while (left > 0) {
		const n = Math.min(HASH_CHUNK, left);
		const chunk = read(n);
		if (!chunk.length) fail("TRUNCATED", "hash short read");
		const take = Math.min(chunk.length, n);
		hash.update(chunk.subarray(0, take));
		left -= take;
	}
	return hash.digest("hex");
}

function fail(code: string, message: string): never {
	throw new ControlError(code, message);
}

function need<T>(v: T | undefined | "", name: string): T {
	if (v === undefined || v === "") fail("INVALID", `missing ${name}`);
	return v;
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const JTD_PRIM = new Set([
	"boolean",
	"string",
	"timestamp",
	"float32",
	"float64",
	"int8",
	"int16",
	"int32",
	"uint8",
	"uint16",
	"uint32",
]);
const JSON_OBJECT_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const JSON_ARRAY_KEYS = new Set(["type", "items", "minItems", "maxItems"]);
const JSON_STRING_KEYS = new Set(["type", "enum", "format", "minLength", "maxLength"]);
const JSON_NUMBER_KEYS = new Set(["type", "enum", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const JSON_BOOL_NULL_KEYS = new Set(["type", "enum"]);
const JTD_TYPE_KEYS = new Set(["type"]);
const JTD_ENUM_KEYS = new Set(["enum"]);
const JTD_ELEMENTS_KEYS = new Set(["elements"]);
const JTD_PROPS_KEYS = new Set(["properties", "optionalProperties", "additionalProperties"]);

function onlySchemaKeys(obj: Record<string, unknown>, allowed: Set<string>): void {
	for (const key of Object.keys(obj)) if (!allowed.has(key)) fail("INVALID", "outputSchema open");
}

function assertClosedSchema(schema: unknown, depth: number): void {
	if (depth > 32) fail("INVALID", "outputSchema depth");
	if (schema === null || schema === undefined || schema === true || schema === false) fail("INVALID", "outputSchema");
	if (typeof schema !== "object" || Array.isArray(schema)) fail("INVALID", "outputSchema");
	const obj = schema as Record<string, unknown>;
	if (!Object.keys(obj).length) fail("INVALID", "outputSchema empty");
	if (obj.additionalProperties === true) fail("INVALID", "outputSchema additionalProperties");
	if ("type" in obj && typeof obj.type !== "string") fail("INVALID", "outputSchema type");
	if (obj.type === "object") {
		onlySchemaKeys(obj, JSON_OBJECT_KEYS);
		if (obj.additionalProperties !== false) fail("INVALID", "outputSchema additionalProperties");
		if (!isSchemaRecord(obj.properties)) fail("INVALID", "outputSchema properties");
		if (obj.required !== undefined && (!Array.isArray(obj.required) || obj.required.some(item => typeof item !== "string"))) {
			fail("INVALID", "outputSchema required");
		}
		for (const child of Object.values(obj.properties)) assertClosedSchema(child, depth + 1);
		return;
	}
	if (obj.type === "array") {
		onlySchemaKeys(obj, JSON_ARRAY_KEYS);
		if (!("items" in obj) || Array.isArray(obj.items)) fail("INVALID", "outputSchema items");
		if (obj.minItems !== undefined && (!Number.isInteger(obj.minItems) || (obj.minItems as number) < 0)) fail("INVALID", "outputSchema minItems");
		if (obj.maxItems !== undefined && (!Number.isInteger(obj.maxItems) || (obj.maxItems as number) < 0)) fail("INVALID", "outputSchema maxItems");
		assertClosedSchema(obj.items, depth + 1);
		return;
	}
	if (obj.type === "string") {
		onlySchemaKeys(obj, JSON_STRING_KEYS);
		return;
	}
	if (obj.type === "number" || obj.type === "integer") {
		onlySchemaKeys(obj, JSON_NUMBER_KEYS);
		return;
	}
	if (obj.type === "boolean" || obj.type === "null") {
		onlySchemaKeys(obj, JSON_BOOL_NULL_KEYS);
		return;
	}
	if (typeof obj.type === "string" && JTD_PRIM.has(obj.type)) {
		onlySchemaKeys(obj, JTD_TYPE_KEYS);
		return;
	}
	if ("enum" in obj) {
		onlySchemaKeys(obj, JTD_ENUM_KEYS);
		if (!Array.isArray(obj.enum) || !obj.enum.length) fail("INVALID", "outputSchema enum");
		return;
	}
	if ("elements" in obj) {
		onlySchemaKeys(obj, JTD_ELEMENTS_KEYS);
		assertClosedSchema(obj.elements, depth + 1);
		return;
	}
	if ("properties" in obj || "optionalProperties" in obj) {
		onlySchemaKeys(obj, JTD_PROPS_KEYS);
		if (obj.properties !== undefined) {
			if (!isSchemaRecord(obj.properties)) fail("INVALID", "outputSchema properties");
			for (const child of Object.values(obj.properties)) assertClosedSchema(child, depth + 1);
		}
		if (obj.optionalProperties !== undefined) {
			if (!isSchemaRecord(obj.optionalProperties)) fail("INVALID", "outputSchema optionalProperties");
			for (const child of Object.values(obj.optionalProperties)) assertClosedSchema(child, depth + 1);
		}
		return;
	}
	fail("INVALID", "outputSchema unconstrained");
}

function assertPlainJsonSchema(schema: unknown): void {
	const seen = new Set<unknown>();
	const walk = (value: unknown, depth: number) => {
		if (depth > 32) fail("INVALID", "outputSchema depth");
		if (value !== null && typeof value === "object") {
			if (seen.has(value)) fail("INVALID", "outputSchema cycle");
			seen.add(value);
			if (seen.size > 128) fail("INVALID", "outputSchema size");
			if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
			else for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
		}
	};
	walk(schema, 0);
	assertClosedSchema(schema, 0);
}


function isOpaqueId(id: string): boolean {
	return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id);
}

function requireOpaqueId(id: string, label: string): string {
	if (!isOpaqueId(id)) fail("INVALID", label);
	return id;
}

function assertLiveOpaque(id: string): void {
	if (!isOpaqueId(id)) fail("QUARANTINE", id);
}

function newOpaqueId(): string {
	return crypto.randomUUID();
}


function isAction(value: string): value is ControlAction {
	for (const name of ACTIONS) if (name === value) return true;
	return false;
}

function stripWinPrefix(p: string): string {
	let s = p;
	if (s.startsWith("\\\\?\\")) s = s.slice(4);
	if (s.startsWith("\\??\\")) s = s.slice(4);
	return s;
}
export function decodeFinalPath(n: number, buf: Uint16Array): string {
	if (!n || n >= buf.length) fail("IO", "GetFinalPathNameByHandleW");
	return path.resolve(stripWinPrefix(Buffer.from(buf.buffer, buf.byteOffset, n * 2).toString("utf16le")));
}

function driveOf(p: string): string {
	const m = path.resolve(stripWinPrefix(p)).match(/^([A-Za-z]):/);
	return m ? m[1].toUpperCase() : "";
}

function samePath(a: string, b: string): boolean {
	const na = path.resolve(stripWinPrefix(a));
	const nb = path.resolve(stripWinPrefix(b));
	const strip = (p: string) => (/^[A-Za-z]:[\\/]$/.test(p) ? p : p.replace(/[\\/]+$/, ""));
	return strip(na).toLowerCase() === strip(nb).toLowerCase();
}

function winCanon(p: string): string {
	const n = path.resolve(stripWinPrefix(p));
	const strip = /^[A-Za-z]:[\\/]$/.test(n) ? n : n.replace(/[\\/]+$/, "");
	return strip.normalize("NFC").toLowerCase();
}

function isWorktreeLeaf(p: string): boolean {
	const root = winCanon(WORKTREES_ROOT);
	const cur = winCanon(p);
	const prefix = root.endsWith("\\") ? root : `${root}\\`;
	if (!cur.startsWith(prefix)) return false;
	const rest = cur.slice(prefix.length);
	if (!rest || rest.includes("\\")) return false;
	if (rest === "." || rest === "..") return false;
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(rest)) return false;
	return true;
}

function isDriveRoot(p: string): boolean {
	return /^[a-z]:$/.test(winCanon(p).replace(/\\+$/, ""));
}

function isReservedRoot(p: string): boolean {
	if (isWorktreeLeaf(p)) return false;
	if (isDriveRoot(p)) return true;
	for (const tree of RESERVED_TREES) {
		if (samePath(p, tree) || isStrictNest(p, tree)) return true;
	}
	return false;
}

function assertNotReserved(p: string): void {
	if (isReservedRoot(p)) fail("RESERVED", "root");
}


function isStrictNest(a: string, b: string): boolean {
	const left = winCanon(a);
	const right = winCanon(b);
	if (left === right) return false;
	const leftPrefix = left.endsWith("\\") ? left : `${left}\\`;
	const rightPrefix = right.endsWith("\\") ? right : `${right}\\`;
	return right.startsWith(leftPrefix) || left.startsWith(rightPrefix);
}


function isUnder(root: string, candidate: string): boolean {
	const r = path.resolve(stripWinPrefix(root));
	const c = path.resolve(stripWinPrefix(candidate));
	if (samePath(r, c)) return true;
	const prefix = r.endsWith(path.sep) ? r : r + path.sep;
	return c.toLowerCase().startsWith(prefix.toLowerCase());
}

function requireDLexical(p: string, label: string, cCode: string): string {
	const resolved = path.resolve(p);
	const drive = driveOf(resolved);
	if (drive === "C") fail(cCode, `${label} on C: ${resolved}`);
	if (drive !== "D") fail("NOT_D_ROOT", `${label} must be on D: ${resolved}`);
	return resolved;
}


function sessionOwner(host: SpawnHost): string {
	const id = host.sessionId;
	if (!id || id === "nosession") fail("SESSION_REQUIRED", "session");
	return id;
}
function requireProjectAccess(project: ProjectRow, owner: string, cwd?: string): void {
	if (!project.owner || project.owner === "nosession") fail("QUARANTINE", project.id);
	// projects.owner is historical creator metadata, not a perpetual conversation lock.
	if (cwd) {
		if (!samePath(path.resolve(cwd), project.canonical_root)) fail("ROOT_MISMATCH", project.id);
	} else if (project.owner !== owner) fail("ROOT_CONTEXT_REQUIRED", project.id);
}

function requireRunOwner(db: Database, projectId: string, runId: string, owner: string): void {
	const row = db.query<{ owner: string }, [string, string]>("SELECT owner FROM runs WHERE project_id = ? AND id = ?").get(projectId, runId);
	if (!row) fail("RUN_PROJECT", runId);
	if (row.owner !== owner) fail("RUN_OWNER_MISMATCH", runId);
}

function requireTaskOwner(db: Database, project: ProjectRow, row: TaskReceipt, owner: string): void {
	if (row.run_id) requireRunOwner(db, project.id, row.run_id, owner);
	else if (project.owner !== owner) fail("RUN_OWNER_MISMATCH", "legacy task");
}

function assertNoForeignUnsettled(db: Database, projectId: string, runId: string): void {
	// Legacy receipts have no file scope. Do not guess that their side effects stopped.
	const row = db.query<{ task_key: string }, [string, string]>(
		`SELECT t.task_key FROM control_tasks t LEFT JOIN runs r ON r.id = t.run_id
		 WHERE t.project_id = ? AND t.state IN ('running','interrupted')
		 AND (t.run_id IS NULL OR t.run_id != ?) LIMIT 1`).get(projectId, runId);
	if (row) fail("UNSETTLED_TASK", row.task_key);
}

export function assertNotTruncated(filePath: string, expectedLen: number, expectedSha: string): void {
	const buf = fs.readFileSync(filePath);
	if (buf.length !== expectedLen) fail("TRUNCATED", `len ${buf.length} != ${expectedLen}`);
	const got = sha256(buf);
	if (got !== expectedSha) fail("TRUNCATED", `sha ${got} != ${expectedSha}`);
}

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const DELETE = 0x00010000;
const SYNCHRONIZE = 0x00100000;
const FILE_LIST_DIRECTORY = 0x0001;
const FILE_ADD_FILE = 0x0002;
const FILE_ADD_SUBDIRECTORY = 0x0004;
const FILE_TRAVERSE = 0x0020;
const FILE_READ_ATTRIBUTES = 0x0080;
const FILE_WRITE_ATTRIBUTES = 0x0100;
const DIR_READ_ACCESS = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE;
const DIR_CREATE_ACCESS = DIR_READ_ACCESS | FILE_ADD_SUBDIRECTORY | FILE_ADD_FILE | FILE_WRITE_ATTRIBUTES;
const FILE_RW_DELETE = GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE;
const FILE_SHARE_ALL = 7;
const FILE_SHARE_READ_WRITE = 3;
const FILE_SHARE_READ = 1;
const FILE_SHARE_DELETE = 4;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 0x00000001;
const FILE_NON_DIRECTORY_FILE = 0x00000040;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const FILE_OPEN_REPARSE_POINT = 0x00200000;
const OBJ_CASE_INSENSITIVE = 0x40;
const FileDispositionInformation = 13;
const FileRenameInformationEx = 65;
const FILE_RENAME_REPLACE_IF_EXISTS = 0x00000001;
const FILE_RENAME_POSIX_SEMANTICS = 0x00000002;
type WinApi = {
	k32: ReturnType<typeof dlopen>;
	nt: ReturnType<typeof dlopen>;
	adv: ReturnType<typeof dlopen>;
	shell: ReturnType<typeof dlopen>;
};
let winApi: WinApi | null | undefined;

function win(): WinApi {
	if (winApi) return winApi;
	if (process.platform !== "win32") fail("UNSUPPORTED", "win32 required");
	winApi = {
		k32: dlopen("kernel32.dll", {
			CreateFileW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
				returns: FFIType.ptr,
			},
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetFinalPathNameByHandleW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32],
				returns: FFIType.u32,
			},
			GetFileInformationByHandle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
			WriteFile: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
				returns: FFIType.i32,
			},
			ReadFile: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
				returns: FFIType.i32,
			},
			FlushFileBuffers: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetCurrentProcess: { args: [], returns: FFIType.ptr },
			LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
			GetSystemDirectoryW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
			GetWindowsDirectoryW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
			SetFilePointerEx: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		}),
		shell: dlopen("shell32.dll", {
			SHGetFolderPathW: {
				args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
		}),
		nt: dlopen("ntdll.dll", {
			NtCreateFile: {
				args: [
					FFIType.ptr,
					FFIType.u32,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.ptr,
					FFIType.u32,
				],
				returns: FFIType.i32,
			},
			NtSetInformationFile: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32],
				returns: FFIType.i32,
			},
		}),
		adv: dlopen("advapi32.dll", {
			OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
			GetTokenInformation: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
			ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			GetNamedSecurityInfoW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.u32,
			},
			GetAce: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		}),
	};
	return winApi;
}

function wstr(s: string): Uint16Array {
	const a = new Uint16Array(s.length + 1);
	for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
	return a;
}

function asHandle(v: unknown): bigint {
	if (typeof v === "bigint") return v;
	if (typeof v === "number") return BigInt(v);
	return 0n;
}

function closeHandle(h: bigint): void {
	if (h) win().k32.symbols.CloseHandle(h);
}

function ntCreate(
	root: bigint,
	name: string,
	disposition: number,
	dir: boolean,
	share = FILE_SHARE_ALL,
	access = FILE_RW_DELETE,
): { status: number; h: bigint } {
	const api = win();
	const nameW = wstr(name);
	const us = Buffer.alloc(16);
	us.writeUInt16LE((nameW.length - 1) * 2, 0);
	us.writeUInt16LE(nameW.length * 2, 2);
	us.writeBigUInt64LE(BigInt(ptr(nameW)), 8);
	const oa = Buffer.alloc(48);
	oa.writeUInt32LE(48, 0);
	oa.writeBigUInt64LE(root, 8);
	oa.writeBigUInt64LE(BigInt(ptr(us)), 16);
	oa.writeUInt32LE(OBJ_CASE_INSENSITIVE, 24);
	const handleOut = Buffer.alloc(8);
	const iosb = Buffer.alloc(16);
	const status = api.nt.symbols.NtCreateFile(
		ptr(handleOut),
		access,
		ptr(oa),
		ptr(iosb),
		null,
		FILE_ATTRIBUTE_NORMAL,
		share,
		disposition,
		(dir ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE) | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
		null,
		0,
	);
	return { status, h: handleOut.readBigUInt64LE(0) };
}

function ntStatusFail(name: string, status: number): never {
	const code = status >>> 0;
	if (code === 0xc0000043) fail("SHARE", name);
	fail("JUNCTION", `NtCreateFile ${name} ${code}`);
}

function ntOpen(
	root: bigint,
	name: string,
	disposition: number,
	dir: boolean,
	share = FILE_SHARE_ALL,
	access = FILE_RW_DELETE,
): bigint {
	const { status, h } = ntCreate(root, name, disposition, dir, share, access);
	if (status < 0) ntStatusFail(name, status);
	return h;
}

function tryNtOpen(
	root: bigint,
	name: string,
	disposition: number,
	dir: boolean,
	share = FILE_SHARE_ALL,
	access = FILE_RW_DELETE,
): bigint | null {
	const { status, h } = ntCreate(root, name, disposition, dir, share, access);
	if (status >= 0) return h;
	const code = status >>> 0;
	if (code === 0xc0000034 || code === 0xc000003a) return null;
	ntStatusFail(name, status);
}

function fileInfo(h: bigint): { attr: number; links: number; vol: number; index: string; size: number } {
	const buf = Buffer.alloc(52);
	if (!win().k32.symbols.GetFileInformationByHandle(h, ptr(buf))) fail("IO", "GetFileInformationByHandle");
	const hi = buf.readUInt32LE(32);
	const lo = buf.readUInt32LE(36);
	const size = fileSizeFromHighLow(hi, lo);
	return {
		attr: buf.readUInt32LE(0),
		vol: buf.readUInt32LE(28),
		size,
		links: buf.readUInt32LE(40),
		index: `${buf.readUInt32LE(44)}:${buf.readUInt32LE(48)}`,
	};
}

function rewindHandle(h: bigint): void {
	if (!win().k32.symbols.SetFilePointerEx(h, 0n, null, 0)) fail("IO", "SetFilePointerEx");
}

function hashHandle(h: bigint, size: number): string {
	rewindHandle(h);
	const got = Buffer.alloc(4);
	const chunk = Buffer.alloc(HASH_CHUNK);
	return hashFromReader(size, n => {
		if (!win().k32.symbols.ReadFile(h, ptr(chunk), n, ptr(got), null)) fail("IO", "ReadFile");
		const nread = got.readUInt32LE(0);
		if (nread === 0) return Buffer.alloc(0);
		return chunk.subarray(0, nread);
	});
}

function writeHandle(h: bigint, bytes: Buffer): void {
	const got = Buffer.alloc(4);
	if (!win().k32.symbols.WriteFile(h, ptr(bytes), bytes.length, ptr(got), null)) fail("IO", "WriteFile");
	if (got.readUInt32LE(0) !== bytes.length) fail("TRUNCATED", "short write");
	if (testFlushFail || !win().k32.symbols.FlushFileBuffers(h)) fail("IO", "FlushFileBuffers");
}

function finalPath(h: bigint): string {
	const api = win().k32.symbols;
	const needed = api.GetFinalPathNameByHandleW(h, ptr(new Uint16Array(1)), 0, 0);
	if (!needed) fail("IO", "GetFinalPathNameByHandleW");
	const buf = new Uint16Array(needed);
	const n = api.GetFinalPathNameByHandleW(h, ptr(buf), buf.length, 0);
	return decodeFinalPath(n, buf);
}

function openDrive(): bigint {
	const name = wstr("\\\\?\\D:\\");
	const h = asHandle(
		win().k32.symbols.CreateFileW(
			ptr(name),
			DIR_READ_ACCESS,
			FILE_SHARE_READ_WRITE,
			null,
			OPEN_EXISTING,
			FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
			null,
		),
	);
	if (!h || h === 0xffffffffffffffffn || h === -1n) fail("IO", "CreateFileW D:\\");
	const inf = fileInfo(h);
	if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("JUNCTION", "D:");
	if (driveOf(finalPath(h)) !== "D") fail("NOT_D_ROOT", "D:");
	return h;
}

function walkDir(abs: string, create: boolean): Walked {
	const resolved = path.resolve(abs);
	if (driveOf(resolved) !== "D") fail("NOT_D_ROOT", resolved);
	const rel = path.relative("D:\\", resolved);
	const parts = path.resolve(resolved).toLowerCase() === "d:\\" ? [] : rel.split(/[\\/]/).filter(Boolean);
	if (parts.some(part => part === ".." || part === ".")) fail("PATH_ESCAPE", resolved);
	let h = openDrive();
	try {
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			// Deny directory deletion/rename, but allow child updates such as Git's atomic index replacement.
			const share = FILE_SHARE_READ_WRITE;
			const access = create ? DIR_CREATE_ACCESS : DIR_READ_ACCESS;
			let next = tryNtOpen(h, part, FILE_OPEN, true, share, access);
			if (!next) {
				if (!create) fail("NOT_FOUND", part);
				next = ntOpen(h, part, FILE_CREATE, true, share, DIR_CREATE_ACCESS);
			}
			const inf = fileInfo(next);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) {
				closeHandle(next);
				fail("JUNCTION", part);
			}
			const fp = finalPath(next);
			if (driveOf(fp) !== "D") {
				closeHandle(next);
				fail("NOT_D_ROOT", fp);
			}
			closeHandle(h);
			h = next;
		}
		const inf = fileInfo(h);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("JUNCTION", resolved);
		const fp = finalPath(h);
		if (driveOf(fp) !== "D") fail("NOT_D_ROOT", fp);
		return { handle: h, finalPath: fp, vol: inf.vol, index: inf.index, links: inf.links, attr: inf.attr };
	} catch (err) {
		closeHandle(h);
		throw err;
	}
}

function renameReplace(tmpH: bigint, parent: bigint, basename: string): void {
	const nameW = wstr(basename);
	const nameBytes = (nameW.length - 1) * 2;
	const info = Buffer.alloc(20 + nameBytes);
	info.writeUInt32LE(FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS, 0);
	info.writeBigUInt64LE(parent, 8);
	info.writeUInt32LE(nameBytes, 16);
	Buffer.from(nameW.buffer, 0, nameBytes).copy(info, 20);
	const iosb = Buffer.alloc(16);
	const st = win().nt.symbols.NtSetInformationFile(tmpH, ptr(iosb), ptr(info), info.length, FileRenameInformationEx);
	if (st < 0) fail("ATOMIC_REPLACE", `NtSetInformationFile ${st >>> 0}`);
}

function disposeHandle(h: bigint): void {
	const info = Buffer.alloc(1);
	info.writeUInt8(1, 0);
	const iosb = Buffer.alloc(16);
	win().nt.symbols.NtSetInformationFile(h, ptr(iosb), ptr(info), 1, FileDispositionInformation);
}

function verifyUnderRoots(final: string, roots: string[]): void {
	if (driveOf(final) !== "D") fail("PATH_ESCAPE", final);
	if (!roots.some(root => isUnder(root, final))) fail("PATH_ESCAPE", final);
}


function materializeDDir(p: string, label: string): string {
	requireDLexical(p, label, "C_PROJECT_ROOT");
	const walked = walkDir(p, true);
	try {
		if (driveOf(walked.finalPath) !== "D") fail("NOT_D_ROOT", walked.finalPath);
		if (!samePath(walked.finalPath, path.resolve(p))) fail("JUNCTION", `${p} -> ${walked.finalPath}`);
		return walked.finalPath;
	} finally {
		closeHandle(walked.handle);
	}
}

function readIdentity(p: string): { vol: number; index: string; finalPath: string } {
	const walked = walkDir(p, false);
	try {
		if (driveOf(walked.finalPath) !== "D") fail("NOT_D_ROOT", walked.finalPath);
		return { vol: walked.vol, index: walked.index, finalPath: walked.finalPath };
	} finally {
		closeHandle(walked.handle);
	}
}

function pinProject(row: ProjectRow): ProjectRow {
	if (row.root_vol != null && row.root_vol < 0) fail("QUARANTINE", row.id);
	if (row.git_dir_vol != null && row.git_dir_vol < 0) fail("QUARANTINE", row.id);
	const idn = readIdentity(row.canonical_root);
	if (!samePath(idn.finalPath, row.canonical_root)) fail("ROOT_MOVED", row.id);
	if (
		row.root_vol == null ||
		row.root_index == null ||
		row.root_vol !== idn.vol ||
		row.root_index !== idn.index
	) {
		fail("ROOT_IDENTITY", row.id);
	}
	if (
		row.git_dir_vol == null ||
		row.git_dir_index == null ||
		row.common_dir_vol == null ||
		row.common_dir_index == null ||
		row.git_dir_vol < 0 ||
		row.common_dir_vol < 0 ||
		!row.git_dir ||
		!row.common_dir
	) {
		fail("QUARANTINE", row.id);
	}
	const git = inspectGit(idn.finalPath);
	if (!samePath(git.gitDir, row.git_dir) || git.gitVol !== row.git_dir_vol || git.gitIndex !== row.git_dir_index) {
		fail("GIT_IDENTITY", row.id);
	}
	if (!samePath(git.commonDir, row.common_dir) || git.commonVol !== row.common_dir_vol || git.commonIndex !== row.common_dir_index) {
		fail("GIT_IDENTITY", row.id);
	}
	return { ...row, canonical_root: idn.finalPath, git_dir: git.gitDir, common_dir: git.commonDir };
}

function projectRoots(row: ProjectRow): string[] {
	return [row.canonical_root];
}

function assertHeldIdentity(walked: Walked, row: ProjectRow): void {
	if (!samePath(walked.finalPath, row.canonical_root)) fail("ROOT_MOVED", row.id);
	if (row.root_vol == null || row.root_index == null || row.root_vol < 0) fail("ROOT_IDENTITY", row.id);
	if (walked.vol !== row.root_vol || walked.index !== row.root_index) fail("ROOT_IDENTITY", row.id);
	const inf = fileInfo(walked.handle);
	if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("JUNCTION", row.id);
	if (inf.vol !== row.root_vol || inf.index !== row.root_index) fail("ROOT_IDENTITY", row.id);
}

function withRootHandle<T>(row: ProjectRow, fn: (walked: Walked) => T): T {
	const opened: bigint[] = [];
	const take = (walked: Walked): Walked => {
		opened.push(walked.handle);
		return walked;
	};
	try {
		const walked = take(walkDir(row.canonical_root, false));
		if (testAfterRootOpen) testAfterRootOpen();
		const gitH = take(walkDir(need(row.git_dir, "git_dir"), false));
		const commonH = take(walkDir(need(row.common_dir, "common_dir"), false));
		assertHeldIdentity(walked, row);
		assertHeldGit(gitH, row.git_dir as string, row.git_dir_vol as number, row.git_dir_index as string, row.id);
		assertHeldGit(commonH, row.common_dir as string, row.common_dir_vol as number, row.common_dir_index as string, row.id);
		rejectGitPoison(gitH.finalPath);
		rejectGitPoison(commonH.finalPath);
		const result = fn(walked);
		assertHeldIdentity(walked, row);
		assertHeldGit(gitH, row.git_dir as string, row.git_dir_vol as number, row.git_dir_index as string, row.id);
		assertHeldGit(commonH, row.common_dir as string, row.common_dir_vol as number, row.common_dir_index as string, row.id);
		return result;
	} finally {
		for (let i = opened.length - 1; i >= 0; i--) closeHandle(opened[i]);
	}
}

function assertPathIndex(abs: string, vol: number, index: string, code: string, label: string): void {
	const walked = walkDir(abs, false);
	try {
		if (walked.vol !== vol || walked.index !== index) fail(code, label);
		const inf = fileInfo(walked.handle);
		if (inf.vol !== vol || inf.index !== index) fail(code, label);
		if (driveOf(walked.finalPath) !== "D") fail(code, label);
	} finally {
		closeHandle(walked.handle);
	}
}

async function withProjectPin<T>(row: ProjectRow, fn: (root: Walked) => Promise<T> | T): Promise<T> {
	const opened: bigint[] = [];
	const take = (walked: Walked): Walked => {
		opened.push(walked.handle);
		return walked;
	};
	try {
		const root = take(walkDir(row.canonical_root, false));
		if (testAfterRootOpen) testAfterRootOpen();
		const gitH = take(walkDir(need(row.git_dir, "git_dir"), false));
		const commonH = take(walkDir(need(row.common_dir, "common_dir"), false));
		assertHeldIdentity(root, row);
		assertHeldGit(gitH, row.git_dir as string, row.git_dir_vol as number, row.git_dir_index as string, row.id);
		assertHeldGit(commonH, row.common_dir as string, row.common_dir_vol as number, row.common_dir_index as string, row.id);
		rejectGitPoison(gitH.finalPath);
		rejectGitPoison(commonH.finalPath);
		const result = await fn(root);
		assertHeldIdentity(root, row);
		assertHeldGit(gitH, row.git_dir as string, row.git_dir_vol as number, row.git_dir_index as string, row.id);
		assertHeldGit(commonH, row.common_dir as string, row.common_dir_vol as number, row.common_dir_index as string, row.id);
		if (driveOf(root.finalPath) !== "D") fail("NOT_D_ROOT", row.id);
		assertPathIndex(row.canonical_root, row.root_vol as number, row.root_index as string, "ROOT_IDENTITY", row.id);
		assertPathIndex(row.git_dir as string, row.git_dir_vol as number, row.git_dir_index as string, "GIT_IDENTITY", row.id);
		assertPathIndex(row.common_dir as string, row.common_dir_vol as number, row.common_dir_index as string, "GIT_IDENTITY", row.id);
		return result;
	} finally {
		for (let i = opened.length - 1; i >= 0; i--) closeHandle(opened[i]);
	}
}

function coveringRoot(row: ProjectRow, dest: string): string {
	const hit = projectRoots(row).find(r => isUnder(r, dest));
	if (!hit) fail("PATH_ESCAPE", dest);
	return hit;
}

function resolveInProject(row: ProjectRow, relOrAbs: string): string {
	const roots = projectRoots(row);
	const abs = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(row.canonical_root, relOrAbs);
	requireDLexical(abs, "path", "PATH_ESCAPE");
	if (!roots.some(root => isUnder(root, abs))) fail("PATH_ESCAPE", abs);
	return abs;
}

const DEVICE_NAME =
	/^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(\.|$)/i;

function canonicalPart(part: string): string {
	const nfc = part.normalize("NFC");
	if (nfc.includes("\0") || nfc.includes(":")) fail("LEASE_SCOPE", part);
	if (!nfc || nfc === "." || nfc === ".." || /[. ]$/.test(nfc)) fail("LEASE_SCOPE", part);
	const lower = nfc.toLowerCase();
	const base = lower.replace(/\.[^.]*$/, "");
	if (DEVICE_NAME.test(lower) || DEVICE_NAME.test(base) || lower.includes("*")) fail("LEASE_SCOPE", part);
	return lower;
}

function validateWriteRel(root: string, rel: string): void {
	if (rel.includes("\0")) fail("PATH_ESCAPE", rel);
	const nfc = rel.normalize("NFC");
	const abs = path.isAbsolute(nfc) ? path.resolve(nfc) : path.resolve(root, nfc);
	requireDLexical(abs, "path", "PATH_ESCAPE");
	if (!isUnder(root, abs)) fail("PATH_ESCAPE", abs);
	const relative = path.relative(root, abs);
	const parts = relative.split(/[\\/]/).filter(Boolean);
	if (!parts.length || parts.some(part => part === ".." || part === ".")) fail("PATH_ESCAPE", rel);
	for (const part of parts) canonicalPart(part);
}


function normalizeResource(root: string, resource: string): string {
	if (resource === "*") return "*";
	if (resource === undefined || resource === "") fail("LEASE_SCOPE", "empty");
	if (resource.includes("\0")) fail("LEASE_SCOPE", "nul");
	const nfc = resource.normalize("NFC");
	if (nfc === "*" ) return "*";
	if (nfc === "." || nfc === "./" || nfc === ".\\") fail("LEASE_SCOPE", "use * for project lock");
	const abs = path.isAbsolute(nfc) ? path.resolve(nfc) : path.resolve(root, nfc);
	if (samePath(abs, root)) fail("LEASE_SCOPE", "use * for project lock");
	if (!isUnder(root, abs)) fail("LEASE_SCOPE", nfc);
	const rel = path.relative(root, abs);
	const parts = rel.split(/[\\/]/).filter(part => part !== "");
	if (!parts.length || parts.some(part => part === ".." || part === ".")) fail("LEASE_SCOPE", nfc);
	return parts.map(canonicalPart).join("/");
}

function scopesOverlap(a: string, b: string): boolean {
	if (a === "*" || b === "*") return true;
	if (a === b) return true;
	return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function leaseCovers(root: string, lease: LeaseRow, dest: string): void {
	if (lease.resource === "*") return;
	const destRes = normalizeResource(root, dest);
	if (destRes !== lease.resource && !destRes.startsWith(`${lease.resource}/`)) fail("LEASE_SCOPE", dest);
}

function openRelDir(root: Walked, dirAbs: string, create: boolean): { handle: bigint; owned: boolean } {
	const rel = path.relative(root.finalPath, dirAbs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) fail("PATH_ESCAPE", dirAbs);
	if (!rel || rel === ".") return { handle: root.handle, owned: false };
	const parts = rel.split(/[\\/]/).filter(Boolean);
	if (parts.some(part => part === ".." || part === ".")) fail("PATH_ESCAPE", dirAbs);
	let owned: bigint | null = null;
	try {
		let parent = root.handle;
		for (const part of parts) {
			let child = tryNtOpen(parent, part, FILE_OPEN, true, FILE_SHARE_READ_WRITE, DIR_READ_ACCESS);
			if (!child) {
				if (!create) fail("NOT_FOUND", part);
				child = ntOpen(parent, part, FILE_CREATE, true, FILE_SHARE_READ_WRITE, DIR_CREATE_ACCESS);
			}
			try {
				const inf = fileInfo(child);
				if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("JUNCTION", part);
			} catch (err) {
				closeHandle(child);
				throw err;
			}
			if (owned) closeHandle(owned);
			owned = child;
			parent = child;
		}
		const handle = owned;
		owned = null;
		if (!handle) fail("NOT_FOUND", dirAbs);
		return { handle, owned: true };
	} finally {
		if (owned) closeHandle(owned);
	}
}

function replaceViaHandles(
	destAbs: string,
	bytes: Buffer,
	root: Walked,
	expectedBase: string | null,
	beforeRename?: () => void,
): { destReal: string; sha: string } {
	const parentAbs = path.dirname(destAbs);
	const base = path.basename(destAbs);
	const parent = openRelDir(root, parentAbs, true);
	let tmpH: bigint | null = null;
	let destHold: bigint | null = null;
	let renamed = false;
	try {
		verifyUnderRoots(root.finalPath, [root.finalPath]);
		if (!isUnder(root.finalPath, destAbs)) fail("PATH_ESCAPE", destAbs);
		destHold = tryNtOpen(
			parent.handle,
			base,
			FILE_OPEN,
			false,
			FILE_SHARE_READ | FILE_SHARE_DELETE,
			GENERIC_READ | DELETE | SYNCHRONIZE,
		);
		let current = "";
		if (destHold) {
			const inf = fileInfo(destHold);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("JUNCTION", base);
			if (inf.links > 1) fail("HARDLINK", base);
			current = hashHandle(destHold, inf.size);
		}
		if (expectedBase !== null && current !== expectedBase) fail("BASE_SHA_CONFLICT", `${current} != ${expectedBase}`);
		const tmpName = `.omp-tmp-${crypto.randomBytes(8).toString("hex")}`;
		tmpH = ntOpen(parent.handle, tmpName, FILE_CREATE, false, FILE_SHARE_READ, FILE_RW_DELETE);
		writeHandle(tmpH, bytes);
		if (fileInfo(tmpH).size !== bytes.length) fail("TRUNCATED", "tmp size");
		if (testAfterTmp) testAfterTmp(path.join(parentAbs, tmpName));
		const parentAfter = fileInfo(parent.handle);
		if (parentAfter.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("JUNCTION", parentAbs);
		if (testBeforeRename) testBeforeRename();
		if (beforeRename) beforeRename();
		if (destHold) {
			const inf2 = fileInfo(destHold);
			if (hashHandle(destHold, inf2.size) !== current) fail("BASE_SHA_CONFLICT", "dest changed");
			const named = tryNtOpen(
				parent.handle,
				base,
				FILE_OPEN,
				false,
				FILE_SHARE_READ | FILE_SHARE_DELETE,
				GENERIC_READ | SYNCHRONIZE,
			);
			if (!named) fail("NAME_CHANGED", base);
			try {
				const namedInf = fileInfo(named);
				if (namedInf.vol !== inf2.vol || namedInf.index !== inf2.index) fail("NAME_CHANGED", base);
			} finally {
				closeHandle(named);
			}
		} else if (expectedBase !== null && expectedBase !== "") {
			fail("BASE_SHA_CONFLICT", "dest vanished");
		}
		renameReplace(tmpH, parent.handle, base);
		renamed = true;
		if (destHold) {
			closeHandle(destHold);
			destHold = null;
		}
		const destInf = fileInfo(tmpH);
		if (destInf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("JUNCTION", destAbs);
		if (destInf.links > 1) fail("HARDLINK", destAbs);
		const destReal = finalPath(tmpH);
		if (driveOf(destReal) !== "D" || !isUnder(root.finalPath, destReal)) fail("PATH_ESCAPE", destReal);
		if (hashHandle(tmpH, destInf.size) !== sha256(bytes)) fail("TRUNCATED", destReal);
		closeHandle(tmpH);
		tmpH = null;
		return { destReal, sha: sha256(bytes) };
	} catch (err) {
		if (tmpH) {
			if (!renamed) {
				try {
					disposeHandle(tmpH);
				} catch {
					/* fail closed */
				}
			}
			closeHandle(tmpH);
		}
		if (destHold) closeHandle(destHold);
		throw err;
	} finally {
		if (parent.owned) closeHandle(parent.handle);
	}
}


function currentUserSid(): string {
	const api = win();
	const proc = api.k32.symbols.GetCurrentProcess();
	const tokBuf = Buffer.alloc(8);
	if (!api.adv.symbols.OpenProcessToken(proc, 0x0008, ptr(tokBuf))) fail("ACL", "OpenProcessToken");
	const token = tokBuf.readBigUInt64LE(0);
	try {
		const needed = Buffer.alloc(4);
		api.adv.symbols.GetTokenInformation(token, 1, null, 0, ptr(needed));
		const size = Math.max(needed.readUInt32LE(0), 256);
		const info = Buffer.alloc(size);
		if (!api.adv.symbols.GetTokenInformation(token, 1, ptr(info), size, ptr(needed))) fail("ACL", "GetTokenInformation");
		const sidPtr = info.readBigUInt64LE(0);
		const strOut = Buffer.alloc(8);
		if (!api.adv.symbols.ConvertSidToStringSidW(sidPtr, ptr(strOut))) fail("ACL", "ConvertSidToStringSidW");
		const strPtr = strOut.readBigUInt64LE(0);
		try {
			const raw = toArrayBuffer(strPtr, 0, 256);
			const u16 = new Uint16Array(raw);
			let sid = "";
			for (let i = 0; i < u16.length && u16[i]; i++) sid += String.fromCharCode(u16[i]);
			if (!sid.startsWith("S-")) fail("ACL", sid);
			return sid;
		} finally {
			api.k32.symbols.LocalFree(strPtr);
		}
	} finally {
		closeHandle(token);
	}
}

function getSystemDirectory(): string {
	const buf = new Uint16Array(260);
	const n = win().k32.symbols.GetSystemDirectoryW(ptr(buf), 260);
	if (!n) fail("ACL", "GetSystemDirectoryW");
	return Buffer.from(buf.buffer, 0, n * 2).toString("utf16le");
}

function getWindowsDirectory(): string {
	const buf = new Uint16Array(260);
	const n = win().k32.symbols.GetWindowsDirectoryW(ptr(buf), 260);
	if (!n) fail("ACL", "GetWindowsDirectoryW");
	return Buffer.from(buf.buffer, 0, n * 2).toString("utf16le");
}

function system32Exe(exe: string): string {
	const sys = getSystemDirectory();
	const p = path.join(sys, exe);
	let real: string;
	try {
		real = fs.realpathSync.native(p);
	} catch {
		fail("ACL", p);
	}
	if (path.basename(real).toLowerCase() !== exe.toLowerCase()) fail("ACL", real);
	const sysReal = fs.realpathSync.native(sys);
	const prefix = sysReal.endsWith(path.sep) ? sysReal : sysReal + path.sep;
	if (path.dirname(real).toLowerCase() !== sysReal.toLowerCase() && !real.toLowerCase().startsWith(prefix.toLowerCase())) {
		fail("ACL", real);
	}
	return real;
}

function sidToString(sidPtr: bigint): string {
	const strOut = Buffer.alloc(8);
	if (!win().adv.symbols.ConvertSidToStringSidW(sidPtr, ptr(strOut))) fail("ACL", "ConvertSidToStringSidW");
	const strPtr = strOut.readBigUInt64LE(0);
	try {
		const raw = toArrayBuffer(strPtr, 0, 256);
		const u16 = new Uint16Array(raw);
		let sid = "";
		for (let i = 0; i < u16.length && u16[i]; i++) sid += String.fromCharCode(u16[i]);
		if (!sid.startsWith("S-")) fail("ACL", sid);
		return sid;
	} finally {
		win().k32.symbols.LocalFree(strPtr);
	}
}

function allowAceSid(acePtr: bigint): string | null {
	const aceHdr = Buffer.from(toArrayBuffer(acePtr, 0, 12));
	const aceType = aceHdr.readUInt8(0);
	if (
		aceType === 1 ||
		aceType === 2 ||
		aceType === 3 ||
		aceType === 6 ||
		aceType === 7 ||
		aceType === 8 ||
		aceType === 10 ||
		aceType === 12 ||
		aceType === 13 ||
		aceType === 14 ||
		aceType === 15 ||
		aceType === 16 ||
		aceType === 17 ||
		aceType === 18 ||
		aceType === 19
	) {
		return null;
	}
	if (aceType !== 0 && aceType !== 5 && aceType !== 9 && aceType !== 11) {
		fail("ACL", `unsupported ace type ${aceType}`);
	}
	let sidOff = 8;
	if (aceType === 5 || aceType === 11) {
		const flags = aceHdr.readUInt32LE(8);
		sidOff = 12;
		if (flags & 1) sidOff += 16;
		if (flags & 2) sidOff += 16;
	}
	return sidToString(acePtr + BigInt(sidOff));
}

export function verifyControlAcl(target: string): void {
	assertUserDacl(target, currentUserSid());
}

function assertUserDacl(target: string, userSid: string): void {
	const api = win();
	const name = wstr(target);
	const daclBuf = Buffer.alloc(8);
	const sdBuf = Buffer.alloc(8);
	const err = api.adv.symbols.GetNamedSecurityInfoW(ptr(name), 1, 4, null, null, ptr(daclBuf), null, ptr(sdBuf));
	if (err !== 0) fail("ACL", `GetNamedSecurityInfoW ${err}`);
	const sd = sdBuf.readBigUInt64LE(0);
	try {
		const dacl = daclBuf.readBigUInt64LE(0);
		if (!dacl) fail("ACL", "null dacl");
		const required = new Set([userSid, "S-1-5-18", "S-1-5-32-544"]);
		const seen = new Set<string>();
		let i = 0;
		for (;;) {
			const acePtrBuf = Buffer.alloc(8);
			if (!api.adv.symbols.GetAce(dacl, i, ptr(acePtrBuf))) break;
			const acePtr = acePtrBuf.readBigUInt64LE(0);
			const sid = allowAceSid(acePtr);
			if (sid) {
				if (!required.has(sid)) fail("ACL", `unexpected ace ${sid}`);
				seen.add(sid);
			}
			i += 1;
			if (i > 64) fail("ACL", "too many aces");
		}
		if (seen.size !== 3 || !seen.has(userSid) || !seen.has("S-1-5-18") || !seen.has("S-1-5-32-544")) {
			fail("ACL", `missing required ace saw=${[...seen].join(",")}`);
		}
	} finally {
		api.k32.symbols.LocalFree(sd);
	}
}

function restrictAcl(target: string): string {
	if (process.platform !== "win32") {
		fs.chmodSync(target, 0o600);
		return target;
	}
	const sid = currentUserSid();
	const icacls = system32Exe("icacls.exe");
	const sys = getSystemDirectory();
	const winDir = getWindowsDirectory();
	const env = { PATH: sys, SystemRoot: winDir, windir: winDir };
	const run = (args: string[]) => {
		const r = Bun.spawnSync({ cmd: [icacls, ...args], cwd: sys, stdout: "pipe", stderr: "pipe", env });
		if (r.exitCode !== 0) fail("ACL", `${target} ${r.stderr.toString()}`);
	};
	run([target, "/reset"]);
	run([
		target,
		"/inheritance:r",
		"/grant:r",
		`*${sid}:(F)`,
		"/grant:r",
		"*S-1-5-18:(F)",
		"/grant:r",
		"*S-1-5-32-544:(F)",
	]);
	assertUserDacl(target, sid);
	return "user-system-admin";
}

const CODING_AGENTS: Record<string, true> = {
	task: true,
	sonic: true,
	scout: true,
	reviewer: true,
	"security-reviewer": true,
	librarian: true,
	"visual-reviewer": true,
	"aesthetic-reviewer": true,
	"gpt-visual-director": true,
	"baoyu-design-worker": true,
	"sp-research-synthesis": true,
	"sp-research-auditor": true,
	"sp-search-exa": true,
	"sp-search-tavily": true,
	"sp-search-brave": true,
	"sp-search-grok": true,
	"sp-search-x": true,
	"fast-worker": true,
	"frontend-worker": true,
	"repair-worker": true,
	verifier: true,
	"pm-worker": true,
};

function knownFolder(csidl: number): string {
	const buf = new Uint16Array(260);
	const hr = win().shell.symbols.SHGetFolderPathW(null, csidl, null, 0, ptr(buf));
	if (hr !== 0) fail("GIT_UNAVAILABLE", `SHGetFolderPathW ${hr}`);
	let n = 0;
	while (n < 260 && buf[n]) n += 1;
	if (!n) fail("GIT_UNAVAILABLE", "empty known folder");
	return Buffer.from(buf.buffer, 0, n * 2).toString("utf16le");
}

function isTrustedGit(real: string, gitRoots: string[]): boolean {
	if (path.basename(real).toLowerCase() !== "git.exe") return false;
	const low = real.toLowerCase();
	return gitRoots.some(root => {
		const prefix = path.resolve(root).toLowerCase();
		return low === prefix || low.startsWith(prefix.endsWith("\\") ? prefix : `${prefix}\\`);
	});
}

function resolveGit(): string {
	const pf = knownFolder(0x26);
	const pf86 = knownFolder(0x2a);
	const gitRoots = [path.join(pf, "Git"), path.join(pf86, "Git")];
	const cands = gitRoots.flatMap(root => [path.join(root, "cmd", "git.exe"), path.join(root, "bin", "git.exe")]);
	for (const cand of cands) {
		try {
			if (!fs.existsSync(cand)) continue;
			const real = fs.realpathSync.native(cand);
			if (!isTrustedGit(real, gitRoots)) continue;
			return real;
		} catch {
			continue;
		}
	}
	fail("GIT_UNAVAILABLE", "trusted git not found");
}

function gitEnv(git: string): Record<string, string> {
	return { PATH: path.dirname(git), SystemRoot: getWindowsDirectory() };
}

function assertGitToplevel(root: string): void {
	const git = resolveGit();
	const r = Bun.spawnSync({
		cmd: [git, "-C", root, "rev-parse", "--show-toplevel"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
		env: gitEnv(git),
	});
	if (r.exitCode !== 0) fail("NOT_GIT", r.stderr.toString().trim() || root);
	const top = path.resolve(r.stdout.toString().trim());
	if (!samePath(top, root)) fail("NOT_GIT_ROOT", `${top} != ${root}`);
}

function gitRevParse(root: string, flag: string): string {
	const git = resolveGit();
	const r = Bun.spawnSync({
		cmd: [git, "-C", root, "rev-parse", flag],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
		env: gitEnv(git),
	});
	if (r.exitCode !== 0) fail("NOT_GIT", flag);
	const raw = r.stdout.toString().trim();
	if (!raw) fail("NOT_GIT", flag);
	return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
}

function nonemptyFile(p: string): boolean {
	try {
		const st = fs.lstatSync(p);
		return st.isFile() && st.size > 0;
	} catch {
		return false;
	}
}

function hasAnyFiles(dir: string): boolean {
	try {
		const st = fs.lstatSync(dir);
		if (st.isSymbolicLink() || (st.mode & 0xf000) === 0xa000) return true;
		if (st.isFile()) return st.size > 0;
		if (!st.isDirectory()) return true;
		return fs.readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

function rejectGitPoison(gitDir: string): void {
	if (nonemptyFile(path.join(gitDir, "objects", "info", "alternates"))) fail("GIT_ALTERNATES", "alternates");
	if (nonemptyFile(path.join(gitDir, "info", "grafts"))) fail("GIT_GRAFTS", "grafts");
	if (hasAnyFiles(path.join(gitDir, "refs", "replace"))) fail("GIT_REPLACE", "replace");
}

function inspectGit(root: string): {
	gitDir: string;
	commonDir: string;
	gitVol: number;
	gitIndex: string;
	commonVol: number;
	commonIndex: string;
} {
	assertGitToplevel(root);
	const gitDirRaw = gitRevParse(root, "--absolute-git-dir");
	const commonRaw = gitRevParse(root, "--git-common-dir");
	requireDLexical(gitDirRaw, "gitDir", "C_PROJECT_ROOT");
	requireDLexical(commonRaw, "commonDir", "C_PROJECT_ROOT");
	const gitIdn = readIdentity(gitDirRaw);
	const commonIdn = readIdentity(commonRaw);
	rejectGitPoison(gitIdn.finalPath);
	rejectGitPoison(commonIdn.finalPath);
	return {
		gitDir: gitIdn.finalPath,
		commonDir: commonIdn.finalPath,
		gitVol: gitIdn.vol,
		gitIndex: gitIdn.index,
		commonVol: commonIdn.vol,
		commonIndex: commonIdn.index,
	};
}

function assertHeldGit(walked: Walked, storedPath: string, vol: number, index: string, label: string): void {
	if (!samePath(walked.finalPath, storedPath)) fail("GIT_IDENTITY", label);
	if (walked.vol !== vol || walked.index !== index) fail("GIT_IDENTITY", label);
	const inf = fileInfo(walked.handle);
	if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("JUNCTION", label);
	if (inf.vol !== vol || inf.index !== index) fail("GIT_IDENTITY", label);
}

function isCodingAgent(name: string): boolean {
	return CODING_AGENTS[name] === true;
}
async function resolveCodingAgent(cwd: string, name: string) {
	if (!isCodingAgent(name)) fail("AGENT_NOT_ALLOWED", name);
	const shadow = path.join(cwd, ".omp", "agents", `${name}.md`);
	if (fs.existsSync(shadow)) fail("AGENT_SHADOW", name);
	const { discoverAgents } = await loadDiscoverAgents();
	const { agents } = await discoverAgents(cwd);
	if (agents.some(a => a.name === name && a.source === "project")) fail("AGENT_SHADOW", name);
	const agent = agents.find(a => a.name === name && (a.source === "user" || a.source === "bundled"));
	if (!agent) fail("AGENT_NOT_FOUND", name);
	return agent;
}

function safeOutboxId(id: string): string {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) fail("INVALID", "outbox id");
	return id;
}

function tableSql(db: Database, name: string): string {
	const row = db.query<{ sql: string | null }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
	return row?.sql ?? "";
}

function tableCols(db: Database, table: "outbox" | "events"): string[] {
	return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(col => col.name);
}

function sameCols(got: string[], need: string[]): boolean {
	if (got.length !== need.length) return false;
	const set = new Set(got);
	return need.every(col => set.has(col));
}

function hasFk(db: Database, table: "outbox" | "events", parent: string, from: string): boolean {
	return db
		.query<{ table: string; from: string }, []>(`PRAGMA foreign_key_list(${table})`)
		.all()
		.some(fk => fk.table === parent && fk.from === from);
}

function hasPk(db: Database, table: "outbox" | "events", cols: string[]): boolean {
	const pk = db
		.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`)
		.all()
		.filter(col => col.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map(col => col.name);
	return pk.length === cols.length && cols.every((col, i) => pk[i] === col);
}

function hasCompositeFk(db: Database, table: "events", parent: string, cols: string[]): boolean {
	const fks = db.query<{ id: number; table: string; from: string; seq: number }, []>(`PRAGMA foreign_key_list(${table})`).all();
	const groups = new Map<number, string[]>();
	for (const fk of fks) {
		if (fk.table !== parent) continue;
		const list = groups.get(fk.id) ?? [];
		list[fk.seq] = fk.from;
		groups.set(fk.id, list);
	}
	return [...groups.values()].some(froms => froms.length === cols.length && cols.every((col, i) => froms[i] === col));
}

const OUTBOX_COLS = ["project_id", "id", "payload_sha", "status", "claim_token", "attempts", "claimed_at", "created_at"];
const EVENT_COLS = ["id", "project_id", "run_id", "type", "payload_sha", "created_at"];

function migrate(db: Database): void {
	db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_by_project ON runs(project_id, id)");
	const outSql = tableSql(db, "outbox");
	const evSql = tableSql(db, "events");
	const outCols = outSql ? tableCols(db, "outbox") : [];
	const evCols = evSql ? tableCols(db, "events") : [];
	const fkBad = db.query<{ table: string }, []>("PRAGMA foreign_key_check").all();
	let needOut = Boolean(
		outSql &&
			(outCols.includes("payload") ||
				!sameCols(outCols, OUTBOX_COLS) ||
				!outSql.includes("quarantine") ||
				!hasFk(db, "outbox", "projects", "project_id") ||
				!hasPk(db, "outbox", ["project_id", "id"]) ||
				fkBad.some(row => row.table === "outbox")),
	);
	let needEv = Boolean(
		evSql &&
			(evCols.includes("payload") ||
				!sameCols(evCols, EVENT_COLS) ||
				!hasFk(db, "events", "projects", "project_id") ||
				!hasCompositeFk(db, "events", "runs", ["project_id", "run_id"]) ||
				!hasPk(db, "events", ["id"]) ||
				fkBad.some(row => row.table === "events")),
	);
	if (!needOut && !needEv) return;
	db.exec("PRAGMA foreign_keys=OFF");
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec("DROP TABLE IF EXISTS outbox_v2");
			db.exec("DROP TABLE IF EXISTS events_v2");
			if (needOut) {
				const old = db.query<Record<string, unknown>, []>("SELECT * FROM outbox").all();
				db.exec(`
CREATE TABLE outbox_v2 (
	project_id TEXT NOT NULL REFERENCES projects(id),
	id TEXT NOT NULL,
	payload_sha TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending','claimed','acked','quarantine')),
	claim_token TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	claimed_at INTEGER,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, id)
);`);
				const seenOut = new Set<string>();
				for (const row of old) {
					const projectId = String(row.project_id ?? "");
					const id = String(row.id ?? "");
					if (!projectId || !id || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) continue;
					if (!db.query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?").get(projectId)) continue;
					const key = `${projectId}\0${id}`;
					if (seenOut.has(key)) continue;
					seenOut.add(key);
					const hadPayload = Object.prototype.hasOwnProperty.call(row, "payload");
					let sha: string;
					let status = "quarantine";
					if (hadPayload) {
						sha = sha256(String(row.payload ?? ""));
					} else {
						sha = "NOT_MIGRATED";
					}
					const claimedAt = null;
					try {
						db.query(
							"INSERT INTO outbox_v2 (project_id, id, payload_sha, status, claim_token, attempts, claimed_at, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)",
						).run(projectId, id, sha, status, claimedAt, row.created_at ?? Date.now());
					} catch {
						continue;
					}
				}
				db.exec("DROP TABLE outbox; ALTER TABLE outbox_v2 RENAME TO outbox");
			}
			if (needEv) {
				const old = db.query<Record<string, unknown>, []>("SELECT * FROM events").all();
				db.exec(`
CREATE TABLE events_v2 (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id TEXT NOT NULL REFERENCES projects(id),
	run_id TEXT,
	type TEXT NOT NULL,
	payload_sha TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id)
);`);
				const seenEv = new Set<string>();
				for (const row of old) {
					const projectId = String(row.project_id ?? "");
					if (!projectId || !db.query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?").get(projectId)) continue;
					if (row.type == null || String(row.type) === "" || row.created_at == null) continue;
					if (row.id != null) {
						const eid = String(row.id);
						if (seenEv.has(eid)) continue;
						seenEv.add(eid);
					}
					let runId = row.run_id == null || row.run_id === "" ? null : String(row.run_id);
					if (runId && !db.query<{ id: string }, [string, string]>("SELECT id FROM runs WHERE id = ? AND project_id = ?").get(runId, projectId)) {
						runId = null;
					}
					const sha =
						typeof row.payload_sha === "string" && row.payload_sha.length === 64
							? String(row.payload_sha)
							: sha256(String(row.payload ?? ""));
					try {
						db.query(
							"INSERT INTO events_v2 (id, project_id, run_id, type, payload_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						).run(row.id, projectId, runId, row.type, sha, row.created_at);
					} catch {
						continue;
					}
				}
				db.exec("DROP TABLE events; ALTER TABLE events_v2 RENAME TO events");
			}
			const fkBad = db.query("PRAGMA foreign_key_check").all();
			if (fkBad.length) fail("MIGRATE_FK", "foreign_key_check");
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* ignore */
			}
			try {
				db.exec("DROP TABLE IF EXISTS outbox_v2");
			} catch {
				/* ignore */
			}
			try {
				db.exec("DROP TABLE IF EXISTS events_v2");
			} catch {
				/* ignore */
			}
			throw err;
		}
	} finally {
		db.exec("PRAGMA foreign_keys=ON");
	}
	db.exec("PRAGMA secure_delete=ON");
	db.exec("VACUUM");
}

let testDbPath: string | null = null;
const ambientLab = ambientLabPaths();

export function controlDbPath(): string {
	if (testDbPath) return testDbPath;
	return ambientLab ? assertAmbientLabTarget(ambientLab.controllerDb) : SYSTEM_DB_PATH;
}

export function setControlTestDb(file: string | null): void {
	testDbPath = file;
	closeControlDb();
	if (file) openControlDbAt(file);
}
export function openControlDb(): Database {
	return openControlDbAt(controlDbPath());
}

export function ensureControlDb(file: string): Database {
	return openControlDbAt(file);
}

export function openControlDbAt(file: string): Database {
	if (cachedDb && cachedDbPath === file && cachedReady) return cachedDb;
	if (cachedDb) {
		cachedDb.close();
		cachedDb = null;
		cachedReady = false;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new Database(file, { create: true, strict: true });
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = FULL");
	db.run("PRAGMA foreign_keys = ON");
	db.exec(`
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	canonical_root TEXT NOT NULL UNIQUE,
	allowed_roots TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL,
	owner TEXT NOT NULL DEFAULT 'nosession',
	root_vol INTEGER,
	root_index TEXT
);
CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	started_at INTEGER NOT NULL,
	cwd TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_by_project ON runs(project_id, id);
CREATE TABLE IF NOT EXISTS generations (
	project_id TEXT PRIMARY KEY REFERENCES projects(id),
	value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
	project_id TEXT NOT NULL REFERENCES projects(id),
	resource TEXT NOT NULL,
	owner TEXT NOT NULL,
	token TEXT NOT NULL,
	generation INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, resource)
);
CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id TEXT NOT NULL REFERENCES projects(id),
	run_id TEXT,
	type TEXT NOT NULL,
	payload_sha TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id)
);
CREATE TABLE IF NOT EXISTS outbox (
	project_id TEXT NOT NULL REFERENCES projects(id),
	id TEXT NOT NULL,
	payload_sha TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending','claimed','acked','quarantine')),
	claim_token TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	claimed_at INTEGER,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS control_tasks (
	project_id TEXT NOT NULL REFERENCES projects(id), task_key TEXT NOT NULL,
	run_id TEXT, generation INTEGER NOT NULL, request_sha TEXT NOT NULL,
	agent TEXT NOT NULL, agent_id TEXT NOT NULL, gate TEXT,
	state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','interrupted')),
	result_json TEXT, updated_at INTEGER NOT NULL,
	PRIMARY KEY(project_id, task_key),
	FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, id)
);
CREATE TABLE IF NOT EXISTS control_run_contracts (
	project_id TEXT NOT NULL, run_id TEXT NOT NULL, gates_json TEXT NOT NULL,
	execution_policy TEXT, check_command_json TEXT, diagnostic_evidence_json TEXT,
	PRIMARY KEY(project_id, run_id),
	FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, id)
);
CREATE TABLE IF NOT EXISTS workspace_activity (
	root TEXT NOT NULL, token TEXT PRIMARY KEY, owner TEXT NOT NULL,
	runtime_id TEXT NOT NULL, runtime_pid INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_recoveries (
	token TEXT NOT NULL, root TEXT NOT NULL, confirmed_by TEXT NOT NULL,
	evidence TEXT NOT NULL, created_at INTEGER NOT NULL
);
`);
	migrate(db);
	const projectCols = db.query<{ name: string }, []>("PRAGMA table_info(projects)").all();
	if (!projectCols.some(col => col.name === "owner")) {
		db.exec("ALTER TABLE projects ADD COLUMN owner TEXT NOT NULL DEFAULT 'nosession'");
	}
	if (!projectCols.some(col => col.name === "root_vol")) db.exec("ALTER TABLE projects ADD COLUMN root_vol INTEGER");
	if (!projectCols.some(col => col.name === "root_index")) db.exec("ALTER TABLE projects ADD COLUMN root_index TEXT");
	const cols2 = db.query<{ name: string }, []>("PRAGMA table_info(projects)").all();
	if (!cols2.some(col => col.name === "git_dir")) db.exec("ALTER TABLE projects ADD COLUMN git_dir TEXT");
	if (!cols2.some(col => col.name === "git_dir_vol")) db.exec("ALTER TABLE projects ADD COLUMN git_dir_vol INTEGER");
	if (!cols2.some(col => col.name === "git_dir_index")) db.exec("ALTER TABLE projects ADD COLUMN git_dir_index TEXT");
	if (!cols2.some(col => col.name === "common_dir")) db.exec("ALTER TABLE projects ADD COLUMN common_dir TEXT");
	if (!cols2.some(col => col.name === "common_dir_vol")) db.exec("ALTER TABLE projects ADD COLUMN common_dir_vol INTEGER");
	if (!cols2.some(col => col.name === "common_dir_index")) db.exec("ALTER TABLE projects ADD COLUMN common_dir_index TEXT");
	// Additive migration: retain project IDs, creator metadata, all runs and receipts.
	const runCols = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
	if (!runCols.some(col => col.name === "owner")) {
		if (path.resolve(file).toLowerCase() === path.resolve(SYSTEM_DB_PATH).toLowerCase()) {
			const backup = `${file}.before-run-ownership-${Date.now()}-${crypto.randomUUID()}.bak`;
			fs.writeFileSync(backup, db.serialize(), { flag: "wx" });
			restrictAcl(backup);
		}
		db.exec("ALTER TABLE runs ADD COLUMN owner TEXT");
	}
	db.exec("UPDATE runs SET owner = (SELECT owner FROM projects WHERE projects.id = runs.project_id) WHERE owner IS NULL");
	if (!db.query<{ name: string }, []>("PRAGMA table_info(outbox)").all().some(col => col.name === "run_id")) db.exec("ALTER TABLE outbox ADD COLUMN run_id TEXT");
	if (!db.query<{ name: string }, []>("PRAGMA table_info(leases)").all().some(col => col.name === "run_id")) db.exec("ALTER TABLE leases ADD COLUMN run_id TEXT");
	const taskCols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(control_tasks)").all().map(col => col.name));
	for (const [name, type] of [["runtime_id", "TEXT"], ["runtime_pid", "INTEGER"], ["heartbeat_at", "INTEGER"], ["session_file", "TEXT"]]) {
		if (!taskCols.has(name)) db.exec(`ALTER TABLE control_tasks ADD COLUMN ${name} ${type}`);
	}
	// Additive contract migration: existing runs retain their frozen gate-only contract.
	const contractCols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(control_run_contracts)").all().map(col => col.name));
	if (!contractCols.has("execution_policy")) db.exec("ALTER TABLE control_run_contracts ADD COLUMN execution_policy TEXT");
	if (!contractCols.has("check_command_json")) db.exec("ALTER TABLE control_run_contracts ADD COLUMN check_command_json TEXT");
	if (!contractCols.has("diagnostic_evidence_json")) db.exec("ALTER TABLE control_run_contracts ADD COLUMN diagnostic_evidence_json TEXT");
	db.exec(`CREATE TABLE IF NOT EXISTS control_recoveries (
		id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_key TEXT NOT NULL, run_id TEXT,
		confirmed_by TEXT NOT NULL, evidence TEXT NOT NULL, previous_state TEXT NOT NULL,
		previous_runtime_id TEXT, created_at INTEGER NOT NULL, generation INTEGER NOT NULL,
		FOREIGN KEY(project_id, task_key) REFERENCES control_tasks(project_id, task_key)
	)`);
	// Graph rows are additive. Existing projects/runs retain their ordinary controller behavior.
	db.exec(`CREATE TABLE IF NOT EXISTS task_graphs (
		id TEXT PRIMARY KEY, target_project_id TEXT NOT NULL REFERENCES projects(id), target_ref TEXT NOT NULL,
		common_vol INTEGER NOT NULL, common_index TEXT NOT NULL, plan_sha TEXT NOT NULL,
		creator_run_id TEXT NOT NULL, creator_owner TEXT NOT NULL, creator_generation INTEGER NOT NULL, created_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS task_graph_nodes (
		graph_id TEXT NOT NULL REFERENCES task_graphs(id), task_id TEXT NOT NULL,
		write_paths TEXT NOT NULL, shared_resources TEXT NOT NULL, dependencies TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('planned','claimed','running','delivered','failed','interrupted','cancelled')),
		project_id TEXT, run_id TEXT, owner TEXT, generation INTEGER, claim_token TEXT, author_task_key TEXT,
		branch TEXT, claim_head TEXT, target_head TEXT, delivered_head TEXT, delivered_fingerprint TEXT,
		updated_at INTEGER NOT NULL, PRIMARY KEY(graph_id, task_id)
	);
	CREATE INDEX IF NOT EXISTS task_graph_nodes_active ON task_graph_nodes(graph_id,state);
	CREATE UNIQUE INDEX IF NOT EXISTS task_graph_active_project ON task_graph_nodes(project_id)
		WHERE state IN ('claimed','running');`);
	// Queue rows retain every attempt. A cancelled/blocked attempt is evidence, not a
	// uniqueness tombstone for a later explicitly requested attempt.
	db.exec(`CREATE TABLE IF NOT EXISTS merge_queue_items (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		graph_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('queued','preparing','candidate_ready','verified','applying','merged','blocked','cancelled')),
		target_project_id TEXT NOT NULL REFERENCES projects(id), target_run_id TEXT NOT NULL, target_owner TEXT NOT NULL, target_generation INTEGER NOT NULL,
		common_vol INTEGER NOT NULL, common_index TEXT NOT NULL, target_ref TEXT NOT NULL, delivered_head TEXT NOT NULL,
		claim_token TEXT NOT NULL, target_base TEXT, candidate_project_id TEXT, candidate_run_id TEXT, candidate_owner TEXT, candidate_generation INTEGER,
	candidate_branch TEXT, candidate_start TEXT, candidate_head TEXT, candidate_fingerprint TEXT, block_code TEXT,
		operation_runtime TEXT, operation_pid INTEGER,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		UNIQUE(graph_id,task_id,attempt_id),
		FOREIGN KEY(graph_id,task_id) REFERENCES task_graph_nodes(graph_id,task_id)
	);
	CREATE INDEX IF NOT EXISTS merge_queue_fifo ON merge_queue_items(common_vol,common_index,target_ref,state,id);
	CREATE TABLE IF NOT EXISTS merge_integration_locks (
		common_vol INTEGER NOT NULL, common_index TEXT NOT NULL, queue_id INTEGER NOT NULL UNIQUE REFERENCES merge_queue_items(id),
		target_project_id TEXT NOT NULL, target_ref TEXT NOT NULL, owner TEXT NOT NULL, run_id TEXT NOT NULL, created_at INTEGER NOT NULL,
		PRIMARY KEY(common_vol,common_index)
	);`);
	const mergeCols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(merge_queue_items)").all().map(col => col.name));
	for (const [name, type] of [["operation_runtime", "TEXT"], ["operation_pid", "INTEGER"]]) if (!mergeCols.has(name)) db.exec(`ALTER TABLE merge_queue_items ADD COLUMN ${name} ${type}`);
	const graphCols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(task_graphs)").all().map(col => col.name));
	if (!graphCols.has("creator_run_id")) db.exec("ALTER TABLE task_graphs ADD COLUMN creator_run_id TEXT");
	if (!graphCols.has("creator_owner")) db.exec("ALTER TABLE task_graphs ADD COLUMN creator_owner TEXT");
	if (!graphCols.has("creator_generation")) db.exec("ALTER TABLE task_graphs ADD COLUMN creator_generation INTEGER");
	for (const row of db.query<{ id: string; canonical_root: string; root_vol: number | null }, []>(
		"SELECT id, canonical_root, root_vol FROM projects",
	).all()) {
		if (row.root_vol != null) continue;
		try {
			const idn = readIdentity(row.canonical_root);
			db.run("UPDATE projects SET root_vol = ?, root_index = ? WHERE id = ?", [idn.vol, idn.index, row.id]);
		} catch {
			db.run("UPDATE projects SET root_vol = -1, root_index = 'quarantine' WHERE id = ?", [row.id]);
		}
	}
	for (const row of db.query<{ id: string; canonical_root: string; git_dir_vol: number | null }, []>(
		"SELECT id, canonical_root, git_dir_vol FROM projects",
	).all()) {
		if (row.git_dir_vol != null) continue;
		try {
			const git = inspectGit(row.canonical_root);
			db.run(
				"UPDATE projects SET git_dir = ?, git_dir_vol = ?, git_dir_index = ?, common_dir = ?, common_dir_vol = ?, common_dir_index = ? WHERE id = ?",
				[git.gitDir, git.gitVol, git.gitIndex, git.commonDir, git.commonVol, git.commonIndex, row.id],
			);
		} catch {
			db.run(
				"UPDATE projects SET git_dir_vol = -1, git_dir_index = 'quarantine', common_dir_vol = -1, common_dir_index = 'quarantine' WHERE id = ?",
				[row.id],
			);
		}
	}
	quarantineOverlaps(db);
	db.exec("UPDATE projects SET allowed_roots = '[]' WHERE allowed_roots IS NOT NULL AND allowed_roots != '[]'");

	if (testDbPath !== file) {
		aclStatus = restrictAcl(file);
		if (fs.existsSync(`${file}-wal`)) restrictAcl(`${file}-wal`);
		if (fs.existsSync(`${file}-shm`)) restrictAcl(`${file}-shm`);
	} else aclStatus = "test";
	cachedDb = db;
	cachedDbPath = file;
	cachedReady = true;
	return db;
}

export function closeControlDb(): void {
	if (!cachedDb) {
		cachedReady = false;
		cachedDbPath = "";
		return;
	}
	cachedDb.close();
	cachedDb = null;
	cachedDbPath = "";
	cachedReady = false;
}

function isReady(file: string): boolean {
	return cachedDb != null && cachedDbPath === file && cachedReady;
}

function openPreauth(file: string): Database {
	if (!fs.existsSync(file)) fail("UNINITIALIZED", "db");
	const db = new Database(file, { readonly: true, create: false, strict: true });
	db.run("PRAGMA query_only = ON");
	db.run("PRAGMA busy_timeout = 5000");
	return db;
}

function withPreauth<T>(file: string, fn: (db: Database) => T): T {
	if (isReady(file) && cachedDb) return fn(cachedDb);
	const db = openPreauth(file);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

export function withInitializedPreauth<T>(file: string, fn: (db: Database) => T): T {
	if (!isReady(file) || !cachedDb) fail("UNINITIALIZED", "db");
	return fn(cachedDb);
}


function peekProject(db: Database, id: string): ProjectRow {
	try {
		return getProject(db, id);
	} catch (err) {
		if (err instanceof ControlError) throw err;
		fail("NOT_FOUND", id);
	}
}

function peekByRoot(db: Database, requested: string): ProjectRow | undefined {
	try {
		return findProjectByRoot(db, requested);
	} catch (err) {
		if (err instanceof ControlError) throw err;
		fail("UNINITIALIZED", "schema");
	}
}

function peekNested(db: Database, requested: string): ProjectRow | undefined {
	try {
		return findNestedOverlap(db, requested);
	} catch (err) {
		if (err instanceof ControlError) throw err;
		fail("UNINITIALIZED", "schema");
	}
}

function healthSnapshot(db: Database): Record<string, unknown> {
	const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
	const synchronous = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
	const foreignKeys = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
	const journalMode = journal?.journal_mode ?? "";
	const syncVal = synchronous?.synchronous ?? -1;
	const fkVal = foreignKeys?.foreign_keys ?? 0;
	return {
		ok: journalMode.toLowerCase() === "wal" && syncVal === 2 && fkVal === 1,
		storageClass: "C_SYSTEM",
		schema: "omp-control",
	};
}


function txn<T>(db: Database, fn: () => T): T {
	return db.transaction(fn).immediate();
}

const PROJECT_SELECT =
	"SELECT id, canonical_root, allowed_roots, created_at, owner, root_vol, root_index, git_dir, git_dir_vol, git_dir_index, common_dir, common_dir_vol, common_dir_index FROM projects";

function getProject(db: Database, id: string): ProjectRow {
	const row = db.query<ProjectRow, [string]>(`${PROJECT_SELECT} WHERE id = ?`).get(id);
	if (!row) fail("NOT_FOUND", `project ${id}`);
	assertLiveOpaque(row.id);
	return row;
}

function findProjectByRoot(db: Database, requested: string): ProjectRow | undefined {
	const exact = db.query<ProjectRow, [string]>(`${PROJECT_SELECT} WHERE canonical_root = ?`).get(requested);
	if (exact) return exact;
	for (const row of db.query<ProjectRow, []>(PROJECT_SELECT).all()) {
		if (samePath(row.canonical_root, requested)) return row;
	}
	return undefined;
}

function findNestedOverlap(db: Database, requested: string): ProjectRow | undefined {
	for (const row of db.query<ProjectRow, []>(PROJECT_SELECT).all()) {
		if (isStrictNest(row.canonical_root, requested)) return row;
	}
	return undefined;
}

function quarantineOverlaps(db: Database): void {
	const rows = db.query<ProjectRow, []>(PROJECT_SELECT).all();
	const hit = new Set<string>();
	for (let i = 0; i < rows.length; i++) {
		if (isReservedRoot(rows[i].canonical_root)) hit.add(rows[i].id);
		for (let j = i + 1; j < rows.length; j++) {
			if (!isStrictNest(rows[i].canonical_root, rows[j].canonical_root)) continue;
			hit.add(rows[i].id);
			hit.add(rows[j].id);
		}
	}
	for (const id of hit) {
		db.run(
			"UPDATE projects SET root_vol = -1, root_index = 'quarantine', git_dir_vol = -1, git_dir_index = 'quarantine', common_dir_vol = -1, common_dir_index = 'quarantine' WHERE id = ?",
			[id],
		);
	}
}


function claimExistingProject(existing: ProjectRow, owner: string, requestedId?: string, cwd?: string): Record<string, unknown> {
	assertLiveOpaque(existing.id);
	requireProjectAccess(existing, owner, cwd);
	if (requestedId && requestedId !== existing.id) fail("CONFLICT", existing.id);
	const pinned = pinProject(existing);
	return { ok: true, projectId: pinned.id, canonicalRoot: pinned.canonical_root };
}

function genOf(db: Database, projectId: string): number {
	const row = db.query<GenerationRow, [string]>("SELECT value FROM generations WHERE project_id = ?").get(projectId);
	if (!row) fail("NOT_FOUND", `generation ${projectId}`);
	return row.value;
}

function liveLease(row: LeaseRow | null | undefined, gen: number, token: string, owner: string, runId: string): LeaseRow {
	if (!row) fail("LEASE_MISSING", "no lease");
	if (row.generation !== gen) fail("STALE_FENCE", `generation ${row.generation} != ${gen}`);
	if (row.expires_at <= Date.now()) fail("LEASE_EXPIRED", row.resource);
	if (row.token !== token) fail("STALE_FENCE", "token mismatch");
	if (row.owner !== owner) fail("OWNER_MISMATCH", row.owner);
	if (!row.run_id) fail("LEGACY_LEASE", "unbound lease must expire; do not guess its run");
	if (row.run_id !== runId) fail("LEASE_RUN_MISMATCH", row.resource);
	return row;
}

function readLease(db: Database, projectId: string, resource: string): LeaseRow | null {
	return db
		.query<LeaseRow, [string, string]>(
			"SELECT project_id, resource, owner, token, generation, expires_at, run_id FROM leases WHERE project_id = ? AND resource = ?",
		)
		.get(projectId, resource);
}

function listLeases(db: Database, projectId: string): LeaseRow[] {
	return db
		.query<LeaseRow, [string]>(
			"SELECT project_id, resource, owner, token, generation, expires_at, run_id FROM leases WHERE project_id = ?",
		)
		.all(projectId);
}

function isLive(row: LeaseRow, gen: number): boolean {
	return row.generation === gen && row.expires_at > Date.now();
}

function startLeaseHeartbeat(
	db: Database,
	projectId: string,
	owner: string,
	runId: string,
	parentSignal: AbortSignal | undefined,
): { generation: number; signal: AbortSignal; stop: () => void } {
	const generation = genOf(db, projectId);
	const leases = listLeases(db, projectId)
		.filter(lease => lease.owner === owner && lease.run_id === runId && lease.generation === generation && isLive(lease, generation))
		.map(lease => ({ resource: lease.resource, token: lease.token }));
	const controller = new AbortController();
	const abortParent = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) abortParent();
	else parentSignal?.addEventListener("abort", abortParent, { once: true });
	let failure: unknown;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const failHeartbeat = (err: unknown) => {
		if (!failure) {
			failure = err;
			controller.abort(err);
		}
	};
	const assertSnapshotLive = () => {
		if (genOf(db, projectId) !== generation) fail("STALE_FENCE", "generation changed");
		const now = Date.now();
		for (const expected of leases) {
			const lease = readLease(db, projectId, expected.resource);
			if (!lease || lease.owner !== owner || lease.run_id !== runId || lease.token !== expected.token || lease.generation !== generation) {
				fail("STALE_FENCE", expected.resource);
			}
			if (lease.expires_at <= now) fail("LEASE_EXPIRED", lease.resource);
		}
	};
	const renew = () => {
		if (failure) return;
		try {
			assertSnapshotLive();
			const now = Date.now();
			for (const expected of leases) {
				const lease = readLease(db, projectId, expected.resource);
				if (!lease) fail("STALE_FENCE", expected.resource);
				const renewed = db
					.query(
						"UPDATE leases SET expires_at = ? WHERE project_id = ? AND resource = ? AND owner = ? AND token = ? AND generation = ? AND expires_at > ?",
					)
					.run(now + DEFAULT_TTL_MS, projectId, lease.resource, owner, lease.token, generation, now);
				if (Number(renewed.changes) !== 1) fail("STALE_FENCE", lease.resource);
			}
		} catch (err) {
			failHeartbeat(err);
		}
	};
	const schedule = () => {
		if (failure || !leases.length) return;
		try {
			const now = Date.now();
			assertSnapshotLive();
			const nextExpiry = leases.reduce((min, expected) => {
				const lease = readLease(db, projectId, expected.resource);
				if (!lease) fail("STALE_FENCE", expected.resource);
				return Math.min(min, lease.expires_at);
			}, Number.POSITIVE_INFINITY);
			const delay = Number.isFinite(nextExpiry)
				? Math.max(10, Math.min(Math.floor(DEFAULT_TTL_MS / 3), Math.floor((nextExpiry - now) / 3)))
				: Math.floor(DEFAULT_TTL_MS / 3);
			timer = setTimeout(() => {
				renew();
				schedule();
			}, delay);
			if ("unref" in timer && typeof timer.unref === "function") timer.unref();
		} catch (err) {
			failHeartbeat(err);
		}
	};
	schedule();
	return {
		generation,
		signal: controller.signal,
		stop() {
			if (timer) clearTimeout(timer);
			parentSignal?.removeEventListener("abort", abortParent);
			if (!failure) {
				try {
					assertSnapshotLive();
				} catch (err) {
					failHeartbeat(err);
				}
			}
			if (failure) throw failure;
		},
	};
}

function subprocessFailed(result: unknown): boolean {
	if (!result || typeof result !== "object") return true;
	const value = result as { aborted?: unknown; error?: unknown; exitCode?: unknown };
	return value.aborted === true || typeof value.error === "string" || (typeof value.exitCode === "number" && value.exitCode !== 0);
}

function taskReceipt(db: Database, projectId: string, key: string): TaskReceipt | null {
	return db.query<TaskReceipt, [string, string]>("SELECT * FROM control_tasks WHERE project_id = ? AND task_key = ?").get(projectId, key);
}

function projectActivity(db: Database, projectId: string, owner?: string): Record<string, unknown> {
	const unsettled = db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM control_tasks WHERE project_id=? AND state IN ('running','interrupted')").get(projectId)!.count;
	const leased = listLeases(db, projectId).some(lease => isLive(lease, genOf(db, projectId)));
	const root = getProject(db, projectId).canonical_root;
	const writers = workspaceWriters(db, root);
	const foreign = writers.filter(row => row.owner !== owner || row.runtime_id !== runtimeInstance);
	return { unsettledTaskCount: unsettled, hasLiveLease: leased, workspaceWriters: writers,
		directWorkAllowed: unsettled === 0 && !leased && foreign.length === 0 };
}

type WorkspaceWriter = { root: string; token: string; owner: string; runtime_id: string; runtime_pid: number };
function workspaceRoot(cwd: string): string {
	let existing = path.resolve(cwd);
	const missing: string[] = [];
	while (!fs.existsSync(existing)) {
		missing.unshift(path.basename(existing));
		const parent = path.dirname(existing);
		if (parent === existing) fail("ROOT_MISSING", cwd);
		existing = parent;
	}
	let root = path.join(fs.realpathSync(existing), ...missing);
	for (let current = root; ; current = path.dirname(current)) {
		if (fs.existsSync(path.join(current, ".git"))) { root = current; break; }
		if (path.dirname(current) === current) break;
	}
	return path.resolve(root).toLowerCase();
}
function workspaceWriters(db: Database, root: string): WorkspaceWriter[] {
	const target = workspaceRoot(root);
	return db.query<WorkspaceWriter, []>("SELECT * FROM workspace_activity").all().filter(row =>
		row.root === target || row.root.startsWith(target + path.sep) || target.startsWith(row.root + path.sep));
}
// Cooperative OMP occupancy, not an OS sandbox. A dead host alone never proves its children stopped.
export function reserveWorkspace(db: Database, cwd: string, owner: string, token: string, runId?: string): void {
	txn(db, () => {
		const root = workspaceRoot(cwd);
		const foreign = workspaceWriters(db, root).find(row => row.owner !== owner || row.runtime_id !== runtimeInstance);
		if (foreign) fail("WORKSPACE_BUSY", `session=${foreign.owner} token=${foreign.token}; inspect that work; do not terminate its controller`);
		for (const project of db.query<{ id: string; canonical_root: string }, []>("SELECT id, canonical_root FROM projects").all()) {
			const candidate = path.resolve(project.canonical_root).toLowerCase();
			if (candidate !== root && !candidate.startsWith(root + path.sep) && !root.startsWith(candidate + path.sep)) continue;
			const pending = db.query<{ task_key: string }, [string, string]>("SELECT task_key FROM control_tasks WHERE project_id=? AND state IN ('running','interrupted') AND COALESCE(run_id,'') != ? LIMIT 1").get(project.id, runId ?? "");
			if (pending) fail("WORKSPACE_BUSY", `unsettled task=${pending.task_key}`);
			const lease = listLeases(db, project.id).find(row => isLive(row, genOf(db, project.id)) && (row.owner !== owner || row.run_id !== runId));
			if (lease) fail("LEASE_HELD", `owner=${lease.owner}`);
		}
		db.query("INSERT OR IGNORE INTO workspace_activity(root,token,owner,runtime_id,runtime_pid,created_at) VALUES (?,?,?,?,?,?)")
			.run(root, token, owner, runtimeInstance, process.pid, Date.now());
	});
}
export function releaseWorkspace(db: Database, owner: string, token: string): void {
	db.query("DELETE FROM workspace_activity WHERE token=? AND owner=? AND runtime_id=?").run(token, owner, runtimeInstance);
}

function writerProcesses(rows: WorkspaceWriter[]) {
	if (!rows.length) return [];
	// Fixed read-only inventory remains available even when a write-capable shell tool is fenced.
	const shell = path.join(getSystemDirectory(), "WindowsPowerShell", "v1.0", "powershell.exe");
	const result = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"],
		{ stdout: "pipe", stderr: "pipe", timeout: 10000 });
	if (result.exitCode !== 0) fail("PROCESS_INSPECTION", "process inventory unavailable; retain occupancy");
	const data = JSON.parse(result.stdout.toString("utf8").replace(/^\uFEFF/, ""));
	const processes = Array.isArray(data) ? data : [data];
	return rows.map(row => {
		const descendants = new Set<number>([row.runtime_pid]);
		let previous = 0;
		while (previous !== descendants.size) {
			previous = descendants.size;
			for (const item of processes) if (descendants.has(item.ParentProcessId)) descendants.add(item.ProcessId);
		}
		return { token: row.token, controllerAlive: processMayBeAlive(row.runtime_pid),
			processes: processes.filter(item => descendants.has(item.ProcessId)) };
	});
}

function publicReceipt(row: TaskReceipt): Record<string, unknown> {
	return { taskKey: row.task_key, runId: row.run_id, generation: row.generation, agent: row.agent,
		agentId: row.agent_id, gate: row.gate, state: row.state, updatedAt: row.updated_at,
		execution: { runtimeId: row.runtime_id ?? null, pid: row.runtime_pid ?? null, controllerPid: row.runtime_pid ?? null,
			pidKind: "controller", taskActive: row.runtime_id === runtimeInstance ? activeControlTasks.has(row.agent_id) : null,
			heartbeatAt: row.heartbeat_at ?? null, sessionFile: row.session_file ?? null },
		nextAction: row.state === "succeeded" ? "reuse_result" : row.state === "failed" ? "inspect_side_effects_then_continue_in_new_generation" : "inspect_task_then_reconcile",
		...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
		// A running receipt surviving process exit is deliberately not assumed safe to retry.
		 retrySafe: false };
}

// Heartbeats and accounting are liveness signals, not new task progress.
export async function observeTask(read: () => TaskReceipt, input: Pick<ControlInput, "version" | "waitMs" | "includeResult">, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const waitMs = input.waitMs ?? 20000;
	if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) fail("INVALID", "waitMs must be 0..25000");
	const started = Date.now();
	const terminal = (row: TaskReceipt) => ["succeeded", "failed", "interrupted"].includes(row.state);
	for (;;) {
		if (signal?.aborted) throw signal.reason ?? new Error("Observation cancelled");
		const row = read();
		const version = sha256(JSON.stringify([row.task_key, row.run_id, row.generation, row.agent_id, row.state, row.result_json]));
		const changed = input.version !== version;
		if (changed || terminal(row) || Date.now() - started >= waitMs) {
			// Do not parse/echo large stored output on ordinary status checks.
			const receipt = publicReceipt({ ...row, result_json: input.includeResult && terminal(row) ? row.result_json : null });
			return { ok: true, ...receipt, version, changed, terminal: terminal(row), waitedMs: Date.now() - started,
				resultAvailable: !!row.result_json, nextAction: row.state === "running" ? "observe_with_version" : receipt.nextAction };
		}
		await new Promise<void>((resolve, reject) => {
			const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
			const timer = setTimeout(done, Math.min(250, Math.max(1, waitMs - (Date.now() - started))));
			const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Observation cancelled")); };
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}
}

type RunContract = { gates_json: string; execution_policy: string | null; check_command_json: string | null; diagnostic_evidence_json: string | null };

function runContract(db: Database, projectId: string, runId: string): RunContract | undefined {
	return db.query<RunContract, [string, string]>(
		"SELECT gates_json,execution_policy,check_command_json,diagnostic_evidence_json FROM control_run_contracts WHERE project_id=? AND run_id=?",
	).get(projectId, runId);
}

// The small OMP-import-free pin helper holds the D: chain without delete
// sharing; both the controller and smoke launcher use this same primitive.
function pinDiagnosticDirectory(policy: DiagnosticEvidencePolicy, sourceRoot: string): WindowsDirectoryPin {
	const pin = pinWindowsDirectory(policy.root);
	try {
		if (isUnder(sourceRoot, pin.rootPath) || isUnder(pin.rootPath, sourceRoot) || fs.existsSync(path.join(pin.rootPath, ".git"))) fail("DIAGNOSTIC_ROOT_ESCAPE", pin.rootPath);
		if (policy.schema === "omp-check-diagnostic/v2" && (pin.identity.volume !== policy.identity.volume || pin.identity.index !== policy.identity.index)) fail("DIAGNOSTIC_ROOT_IDENTITY", policy.root);
		return pin;
	} catch (error) { releaseWindowsDirectoryPin(pin); throw error; }
}

function releaseDiagnosticPin(pin: WindowsDirectoryPin): void { releaseWindowsDirectoryPin(pin); }

function assertDiagnosticPin(pin: WindowsDirectoryPin, policy: DiagnosticEvidencePolicy): void {
	try { assertWindowsDirectoryPin(pin); }
	catch { fail("DIAGNOSTIC_ROOT_MOVED", policy.root); }
	if (!samePath(pin.rootPath, policy.root) || policy.schema === "omp-check-diagnostic/v2" && (pin.identity.volume !== policy.identity.volume || pin.identity.index !== policy.identity.index)) fail("DIAGNOSTIC_ROOT_IDENTITY", policy.root);
}

function integrationCheckKey(runId: string, key: string): string {
	return `integration.${sha256(`${runId}:${key}`).slice(0, 48)}`;
}

function frozenCheckCommand(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail("INVALID", "checkCommand");
	let size = 0;
	const command = value.map((item, index) => {
		if (typeof item !== "string" || !item || item.includes("\0") || item.length > 4096) fail("INVALID", `checkCommand[${index}]`);
		size += Buffer.byteLength(item, "utf8");
		return item;
	});
	if (size > 16_384) fail("INVALID", "checkCommand size");
	return command;
}

function directDiagnosticRoot(value: string, sourceRoot: string): string {
	if (!path.isAbsolute(value)) fail("INVALID", "diagnosticEvidence.root");
	const root = requireDLexical(value, "diagnosticEvidence.root", "INVALID");
	const stat = fs.lstatSync(root, { throwIfNoEntry: false });
	if (!stat?.isDirectory() || stat.isSymbolicLink()) fail("DIAGNOSTIC_ROOT_INVALID", root);
	const real = fs.realpathSync.native(root);
	if (!samePath(real, root) || isUnder(sourceRoot, real) || isUnder(real, sourceRoot) || fs.existsSync(path.join(real, ".git"))) fail("DIAGNOSTIC_ROOT_ESCAPE", root);
	return real;
}

function frozenDiagnosticEvidence(value: unknown, sourceRoot: string): DiagnosticEvidencePolicy | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID", "diagnosticEvidence");
	const input = value as Record<string, unknown>;
	if (input.schema === "omp-check-diagnostic/v1") {
		if (Object.keys(input).some(key => !["schema", "root"].includes(key)) || typeof input.root !== "string") fail("INVALID", "diagnosticEvidence");
		return { schema: "omp-check-diagnostic/v1", root: directDiagnosticRoot(input.root, sourceRoot) };
	}
	if (input.schema === "omp-check-diagnostic/v2") {
		if (Object.keys(input).some(key => !["schema", "root", "identity"].includes(key)) || typeof input.root !== "string" || !input.identity || typeof input.identity !== "object" || Array.isArray(input.identity)) fail("INTEGRATION_CONTRACT", "diagnosticEvidence");
		const identity = input.identity as Record<string, unknown>;
		if (Object.keys(identity).some(key => key !== "volume" && key !== "index") || !Number.isInteger(identity.volume) || typeof identity.index !== "string" || !identity.index) fail("INTEGRATION_CONTRACT", "diagnosticEvidence identity");
		return { schema: "omp-check-diagnostic/v2", root: requireDLexical(input.root, "diagnosticEvidence.root", "INTEGRATION_CONTRACT"), identity: { volume: identity.volume as number, index: identity.index } };
	}
	fail("INTEGRATION_CONTRACT", "diagnosticEvidence schema");
}

/** Public v1 requests are bound once into the v2 frozen contract. */
function bindDiagnosticEvidence(value: unknown, sourceRoot: string): BoundDiagnosticEvidencePolicy | undefined {
	const requested = frozenDiagnosticEvidence(value, sourceRoot);
	if (!requested) return undefined;
	if (requested.schema !== "omp-check-diagnostic/v1") fail("INVALID", "diagnosticEvidence request schema");
	const pin = pinDiagnosticDirectory(requested, sourceRoot);
	try {
		assertDiagnosticPin(pin, requested);
		return { schema: "omp-check-diagnostic/v2", root: pin.rootPath, identity: { ...pin.identity } };
	} finally { releaseDiagnosticPin(pin); }
}

function frozenDiagnosticPaths(policy: DiagnosticEvidencePolicy, project: ProjectRow, runId: string, generation: number, key: string, requireAbsent = false): DiagnosticPaths {
	const root = policy.schema === "omp-check-diagnostic/v1" ? directDiagnosticRoot(policy.root, project.canonical_root) : policy.root;
	const suffix = sha256(JSON.stringify({ projectId: project.id, runId, generation, key })).slice(0, 48);
	const file = path.join(root, `check-${suffix}.json`);
	// Existence is checked by FILE_CREATE through a pinned directory handle at
	// write time. A pathname precheck would race an attacker and permit neither
	// an overwrite nor a reliable report of who created the file.
	void requireAbsent;
	return { root, file };
}

function integrationEvidence(result: unknown, runId: string, generation: number, source: string | null, command: string[], cwd: string, diagnosticPolicy?: DiagnosticEvidencePolicy): boolean {
	const check = result && typeof result === "object" ? (result as { integrationCheck?: unknown }).integrationCheck : undefined;
	if (!check || typeof check !== "object") return false;
	const data = check as Record<string, unknown>;
	const diagnostic = data.diagnosticEvidence as Record<string, unknown> | undefined;
	const diagnosticComplete = !diagnosticPolicy || !!diagnostic && typeof diagnostic.path === "string" && typeof diagnostic.sha256 === "string" &&
		["available", "truncated"].includes(String(diagnostic.status)) && diagnostic.missing === false;
	return data.status === "PASS" && diagnosticComplete && data.runId === runId && data.generation === generation && data.cwd === cwd && data.exitCode === 0 &&
		data.cancellation === null && data.stale === false && JSON.stringify(data.command) === JSON.stringify(command) &&
		typeof data.beforeFingerprint === "string" && data.beforeFingerprint === source &&
		typeof data.afterFingerprint === "string" && data.afterFingerprint === source &&
		Array.isArray(data.command) && data.command.every(item => typeof item === "string") &&
		data.environment !== null && typeof data.environment === "object";
}

function diagnosticEvidenceCurrent(value: unknown, policy: DiagnosticEvidencePolicy, project: ProjectRow, runId: string, generation: number, key: string): boolean {
	if (!value || typeof value !== "object") return false;
	const diagnostic = value as Record<string, unknown>;
	if (!(["available", "truncated"].includes(String(diagnostic.status))) || typeof diagnostic.path !== "string" || typeof diagnostic.sha256 !== "string" || diagnostic.missing !== false) return false;
	try {
		const expected = frozenDiagnosticPaths(policy, project, runId, generation, key);
		if (!samePath(expected.file, diagnostic.path)) return false;
		const pin = pinDiagnosticDirectory(policy, project.canonical_root);
		let file: bigint | null = null;
		try {
			assertDiagnosticPin(pin, policy);
			file = tryNtOpen(pin.handle, path.basename(expected.file), FILE_OPEN, false, FILE_SHARE_READ, GENERIC_READ | SYNCHRONIZE);
			if (!file) return false;
			const info = fileInfo(file);
			if (info.attr & FILE_ATTRIBUTE_REPARSE_POINT || info.links > 1 || !samePath(finalPath(file), expected.file)) return false;
			if (policy.schema === "omp-check-diagnostic/v2" || "identity" in diagnostic) {
				const identity = diagnostic.identity;
				if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
				const record = identity as Record<string, unknown>, root = record.root, leaf = record.file;
				if (Object.keys(record).some(name => name !== "root" && name !== "file") || !root || !leaf || typeof root !== "object" || typeof leaf !== "object" || Array.isArray(root) || Array.isArray(leaf)) return false;
				const rootRecord = root as Record<string, unknown>, leafRecord = leaf as Record<string, unknown>;
				if (Object.keys(rootRecord).some(name => name !== "volume" && name !== "index") || Object.keys(leafRecord).some(name => name !== "volume" && name !== "index") || rootRecord.volume !== pin.identity.volume || rootRecord.index !== pin.identity.index || leafRecord.volume !== info.vol || leafRecord.index !== info.index) return false;
			}
			if (testBeforeDiagnosticCompletionHash) testBeforeDiagnosticCompletionHash(expected.file);
			const actual = hashHandle(file, info.size);
			const after = fileInfo(file);
			if (after.attr & FILE_ATTRIBUTE_REPARSE_POINT || after.links > 1 || after.vol !== info.vol || after.index !== info.index || after.size !== info.size || !samePath(finalPath(file), expected.file)) return false;
			assertDiagnosticPin(pin, policy);
			return actual === diagnostic.sha256;
		} finally {
			if (file) closeHandle(file);
			releaseDiagnosticPin(pin);
		}
	} catch { return false; }
}

function completionStatus(db: Database, projectId: string, runId: string): Record<string, unknown> {
	const generation = genOf(db, projectId);
	const contract = runContract(db, projectId, runId);
	if (!contract) return { status: "UNASSESSED", taskComplete: false, generation, reason: "Run predates completion contracts" };
	const required = JSON.parse(contract.gates_json) as string[];
	const rows = db.query<TaskReceipt, [string, string]>(
		"SELECT * FROM control_tasks WHERE project_id = ? AND run_id = ? ORDER BY updated_at, rowid").all(projectId, runId);
	// Optional arbitration becomes a gate once explicitly requested for this generation.
	if (!required.includes("arbitration") && rows.some(row => row.generation === generation && row.gate === "arbitration")) required.push("arbitration");
	const unsettled = rows.filter(row => row.state === "running" || row.state === "interrupted").map(row => row.task_key);
	const missing: string[] = [];
	const currentSource = rows.some(row => row.generation === generation && row.gate) ? sourceFingerprint(getProject(db, projectId).canonical_root) : null;
	let integrationCommand: string[] | undefined;
	let diagnosticPolicy: DiagnosticEvidencePolicy | undefined;
	let diagnosticPolicyInvalid = false;
	if (required.includes(INTEGRATION_GATE)) {
		try { integrationCommand = frozenCheckCommand(contract.check_command_json ? JSON.parse(contract.check_command_json) : undefined); }
		catch { integrationCommand = undefined; }
		try { diagnosticPolicy = contract.diagnostic_evidence_json ? frozenDiagnosticEvidence(JSON.parse(contract.diagnostic_evidence_json), getProject(db, projectId).canonical_root) : undefined; }
		catch { diagnosticPolicyInvalid = true; }
	}
	const staleGates: string[] = [];
	for (const gate of required) {
		const row = rows.filter(item => item.generation === generation && item.gate === gate).at(-1);
		const result = row?.result_json ? JSON.parse(row.result_json) : undefined;
		if (gate === INTEGRATION_GATE) {
			if (row && (!result?.sourceFingerprint || result.sourceFingerprint !== currentSource)) staleGates.push(gate);
			if (row?.state !== "succeeded" || !integrationCommand || diagnosticPolicyInvalid || !integrationEvidence(result, runId, generation, currentSource, integrationCommand, getProject(db, projectId).canonical_root, diagnosticPolicy) ||
				(diagnosticPolicy && (!row || !diagnosticEvidenceCurrent(result?.integrationCheck?.diagnosticEvidence, diagnosticPolicy, getProject(db, projectId), runId, generation, row.task_key))) ||
				result?.sourceFingerprint !== currentSource) missing.push(gate);
			continue;
		}
		const structured = result?.structuredOutput;
		const data = structured?.data;
		if (row && (!result?.sourceFingerprint || result.sourceFingerprint !== currentSource)) {
			staleGates.push(gate);
			missing.push(gate);
			continue;
		}
		if (row?.state !== "succeeded" || structured?.status !== "valid" || data?.status !== "PASS" ||
			data?.generation !== String(generation) || data?.runId !== runId || !Array.isArray(data?.findings) ||
			!Array.isArray(data?.evidence) || data.evidence.length === 0 || !data.evidence.every((ref: unknown) => typeof ref === "string" && ref.trim().length > 0) ||
			data.findings.some((finding: unknown) => !finding || typeof finding !== "object" ||
				(finding as { block?: unknown }).block !== false || ["P0", "P1"].includes(String((finding as { severity?: unknown }).severity)) ||
				(finding as { generation?: unknown }).generation !== String(generation) || (finding as { runId?: unknown }).runId !== runId)) {
			missing.push(gate);
		}
	}
	const failed = rows.filter(row => row.generation === generation && row.state === "failed").map(row => row.task_key);
	const blocking = rows.filter(row => {
		if (row.generation !== generation || !row.gate || !row.result_json) return false;
		const findings = JSON.parse(row.result_json)?.structuredOutput?.data?.findings;
		return Array.isArray(findings) && findings.some((finding: { block?: unknown }) => finding?.block === true);
	}).map(row => row.task_key);
	const taskComplete = missing.length === 0 && unsettled.length === 0 && failed.length === 0 && blocking.length === 0;
	return { status: taskComplete ? "COMPLETE" : "INCOMPLETE", taskComplete, productComplete: false, generation, requiredGates: required, missingGates: missing, staleGates, unsettled, failed, blocking };
}

export { sourceFingerprint };

type ProcessOutput = {
	// bytes/sha256 describe the drained raw stream; only sanitized bytes are retained.
	bytes: number; sha256: string; displayLimitBytes: number; exceedsDisplayLimit: boolean; streamError: boolean; contentOmitted: true;
	rawGap: boolean; rawGapBytes: number; sanitizedBytes: number; sanitizedRetainedBytes: number; redactions: number;
	head: Buffer; tail: Buffer; gap: boolean; gapBytes: number;
};

const SENSITIVE_JSON_KEYS = ["token", "access_token", "id_token", "authorization"];
const SENSITIVE_JSON_KEY_PREFIXES = SENSITIVE_JSON_KEYS.map(key => `"${key}`);

class JsonFieldRedactor {
	private mode: "normal" | "json_key_candidate" | "json_quoted" | "json_after_key" | "json_value" | "json_secret" = "normal";
	private pending = "";
	private backslashes = 0;
	redactions = 0;

	write(text: string, emit: (text: string) => void): void { this.consume(text, emit); }
	finish(emit: (text: string) => void): void {
		if (this.mode === "json_key_candidate" && this.pending) emit(this.pending);
		this.pending = "";
	}

	private consume(text: string, emit: (text: string) => void): void {
		let output: string[] = [];
		const flush = () => { if (output.length) { emit(output.join("")); output = []; } };
		const put = (value: string) => { output.push(value); if (output.length >= 1024) flush(); };
		const again = (char: string) => this.char(char, put, again);
		for (const char of text) again(char);
		flush();
	}

	private trackBackslashes(char: string): void { this.backslashes = char === "\\" ? this.backslashes + 1 : 0; }
	private keyCandidate(): boolean { return SENSITIVE_JSON_KEY_PREFIXES.some(key => key.startsWith(this.pending.toLowerCase())); }

	private char(char: string, put: (value: string) => void, again: (char: string) => void): void {
		if (this.mode === "json_secret") {
			const closes = char === '"' && this.backslashes % 2 === 0;
			this.trackBackslashes(char);
			if (closes) { put(char); this.mode = "normal"; }
			return;
		}
		if (this.mode === "json_quoted") {
			const closes = char === '"' && this.backslashes % 2 === 0;
			put(char); this.trackBackslashes(char);
			if (closes) this.mode = "normal";
			return;
		}
		if (this.mode === "json_key_candidate") {
			const closes = char === '"' && this.backslashes % 2 === 0;
			this.pending += char; this.trackBackslashes(char);
			if (closes) {
				const key = this.pending.slice(1, -1).toLowerCase(); put(this.pending); this.pending = "";
				this.mode = SENSITIVE_JSON_KEYS.includes(key) ? "json_after_key" : "normal";
				return;
			}
			if (!this.keyCandidate()) { put(this.pending); this.pending = ""; this.mode = "json_quoted"; }
			return;
		}
		if (this.mode === "json_after_key") {
			if (/\s/.test(char)) { put(char); return; }
			if (char === ":") { put(char); this.mode = "json_value"; return; }
			this.mode = "normal"; again(char); return;
		}
		if (this.mode === "json_value") {
			if (/\s/.test(char)) { put(char); return; }
			if (char === '"') { put(char); put("[REDACTED]"); this.redactions++; this.backslashes = 0; this.mode = "json_secret"; return; }
			this.mode = "normal"; again(char); return;
		}
		if (char === '"') { this.pending = char; this.backslashes = 0; this.mode = "json_key_candidate"; return; }
		put(char);
	}
}

class BearerRedactor {
	private mode: "normal" | "bearer_word" | "bearer_space" | "bearer_value" | "bearer_secret" = "normal";
	private pending = "";
	redactions = 0;

	write(text: string, emit: (text: string) => void): void { this.consume(text, emit); }
	finish(emit: (text: string) => void): void {
		if (["bearer_word", "bearer_space"].includes(this.mode) && this.pending) emit(this.pending);
		this.pending = "";
	}

	private consume(text: string, emit: (text: string) => void): void {
		let output: string[] = [];
		const flush = () => { if (output.length) { emit(output.join("")); output = []; } };
		const put = (value: string) => { output.push(value); if (output.length >= 1024) flush(); };
		const again = (char: string) => this.char(char, put, again);
		for (const char of text) again(char);
		flush();
	}

	private char(char: string, put: (value: string) => void, again: (char: string) => void): void {
		if (this.mode === "bearer_secret") {
			if (/[A-Za-z0-9._~+\/=:-]/.test(char)) return;
			this.mode = "normal"; again(char); return;
		}
		if (this.mode === "bearer_space") {
			if (/\s/.test(char)) { put(this.pending); put(char); this.pending = ""; this.mode = "bearer_value"; return; }
			put(this.pending); this.pending = ""; this.mode = "normal"; again(char); return;
		}
		if (this.mode === "bearer_value") {
			if (/\s/.test(char)) { put(char); return; }
			if (/[A-Za-z0-9._~+\/=:-]/.test(char)) { put("[REDACTED]"); this.redactions++; this.mode = "bearer_secret"; return; }
			this.mode = "normal"; again(char); return;
		}
		if (this.mode === "bearer_word") {
			const expected = "bearer"[this.pending.length];
			if (expected && char.toLowerCase() === expected) { this.pending += char; if (this.pending.length === 6) this.mode = "bearer_space"; return; }
			put(this.pending); this.pending = ""; this.mode = "normal"; again(char); return;
		}
		if (char.toLowerCase() === "b") { this.pending = char; this.mode = "bearer_word"; return; }
		put(char);
	}
}

class DiagnosticSanitizer {
	private readonly decoder = new TextDecoder("utf-8");
	private readonly json = new JsonFieldRedactor();
	private readonly bearer = new BearerRedactor();
	get redactions(): number { return this.json.redactions + this.bearer.redactions; }

	write(chunk: Uint8Array, emit: (text: string) => void): void { this.json.write(this.decoder.decode(chunk, { stream: true }), text => this.bearer.write(text, emit)); }
	finish(emit: (text: string) => void): void {
		this.json.write(this.decoder.decode(), text => this.bearer.write(text, emit));
		this.json.finish(text => this.bearer.write(text, emit));
		this.bearer.finish(emit);
	}
}

async function boundedProcessOutput(stream: unknown, limit: number, onCancel: (cancel: () => void) => void): Promise<ProcessOutput> {
	const reader = (stream as ReadableStream<Uint8Array> | undefined)?.getReader?.();
	if (!reader) return { bytes: 0, sha256: sha256(""), displayLimitBytes: limit, exceedsDisplayLimit: false, streamError: false, contentOmitted: true, rawGap: false, rawGapBytes: 0, sanitizedBytes: 0, sanitizedRetainedBytes: 0, redactions: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0), gap: false, gapBytes: 0 };
	onCancel(() => { void reader.cancel(); });
	const hash = crypto.createHash("sha256"), sanitizer = new DiagnosticSanitizer();
	let bytes = 0, headed = 0, sanitizedBytes = 0, tail = Buffer.alloc(0);
	const head: Buffer[] = [];
	const retain = (text: string) => {
		if (!text) return;
		const chunk = Buffer.from(text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " "), "utf8");
		sanitizedBytes += chunk.length;
		if (headed < CHECK_OUTPUT_HEAD_BYTES) { const take = chunk.subarray(0, Math.min(chunk.length, CHECK_OUTPUT_HEAD_BYTES - headed)); head.push(take); headed += take.length; }
		if (chunk.length >= CHECK_OUTPUT_TAIL_BYTES) tail = chunk.subarray(chunk.length - CHECK_OUTPUT_TAIL_BYTES);
		else if (tail.length + chunk.length > CHECK_OUTPUT_TAIL_BYTES) tail = Buffer.concat([tail, chunk]).subarray(tail.length + chunk.length - CHECK_OUTPUT_TAIL_BYTES);
		else tail = Buffer.concat([tail, chunk]);
	};
	let streamError = false;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			const chunk = Buffer.from(next.value);
			bytes += chunk.length;
			hash.update(chunk);
			sanitizer.write(chunk, retain);
		}
	} catch { streamError = true; /* A timed-out/cancelled command may close its pipe asynchronously. */ }
	sanitizer.finish(retain);
	const rawGapBytes = Math.max(0, bytes - limit), gapBytes = Math.max(0, sanitizedBytes - limit);
	return { bytes, sha256: hash.digest("hex"), displayLimitBytes: limit, exceedsDisplayLimit: bytes > limit, streamError, contentOmitted: true,
		rawGap: rawGapBytes > 0, rawGapBytes, sanitizedBytes, sanitizedRetainedBytes: Math.min(sanitizedBytes, limit), redactions: sanitizer.redactions,
		head: Buffer.concat(head), tail, gap: gapBytes > 0, gapBytes };
}

function outputMetadata(output: ProcessOutput): Omit<ProcessOutput, "head" | "tail"> {
	const { head: _head, tail: _tail, ...metadata } = output;
	return metadata;
}

function sanitizedOutputSummary(output: ProcessOutput): { text: string; redactions: number; truncated: boolean; gap: boolean; gapBytes: number; rawGap: boolean; rawGapBytes: number; tailBoundaryOmittedBytes: number } {
	const tailStart = output.sanitizedBytes - output.tail.length;
	const tail = output.tail.subarray(Math.max(0, output.head.length - tailStart)).toString("utf8");
	const gap = output.gap ? `\n[... ${output.gapBytes} sanitized bytes omitted ...]\n` : "";
	return { text: `${output.head.toString("utf8")}${gap}${tail}`, redactions: output.redactions, truncated: output.gap,
		gap: output.gap, gapBytes: output.gapBytes, rawGap: output.rawGap, rawGapBytes: output.rawGapBytes, tailBoundaryOmittedBytes: 0 };
}

function writeDiagnosticEvidence(pin: WindowsDirectoryPin, policy: DiagnosticEvidencePolicy, paths: DiagnosticPaths, data: Record<string, unknown>, streams: { stdout: ProcessOutput; stderr: ProcessOutput }): { status: "available" | "truncated" | "write_failed" | "stream_error"; path: string | null; attemptedPath: string; sha256: string | null; truncated: boolean; gap: boolean; missing: boolean; identity?: { root: { volume: number; index: string }; file: { volume: number; index: string } } } {
	const streamError = streams.stdout.streamError || streams.stderr.streamError || testDiagnosticStreamFail;
	const truncated = streams.stdout.gap || streams.stderr.gap;
	const gap = streams.stdout.gap || streams.stderr.gap;
	let file: bigint | null = null;
	let created = false;
	try {
		const body = JSON.stringify(data, null, 2);
		if (testDiagnosticWriteFail) throw new Error("TEST_DIAGNOSTIC_WRITE_FAIL");
		assertDiagnosticPin(pin, policy);
		if (testBeforeDiagnosticCreate) testBeforeDiagnosticCreate(paths.file);
		assertDiagnosticPin(pin, policy);
		file = ntOpen(pin.handle, path.basename(paths.file), FILE_CREATE, false, FILE_SHARE_READ, FILE_RW_DELETE);
		created = true;
		if (testDiagnosticWritePartialFail) { writeHandle(file, Buffer.from(body.slice(0, Math.max(1, Math.floor(body.length / 2))), "utf8")); throw new Error("TEST_DIAGNOSTIC_WRITE_PARTIAL_FAIL"); }
		writeHandle(file, Buffer.from(body, "utf8"));
		const info = fileInfo(file);
		if (info.attr & FILE_ATTRIBUTE_REPARSE_POINT || info.links > 1 || !samePath(finalPath(file), paths.file)) fail("DIAGNOSTIC_REPORT_INVALID", paths.file);
		const actualHash = hashHandle(file, info.size);
		assertDiagnosticPin(pin, policy);
		if (actualHash !== sha256(body)) throw new Error("DIAGNOSTIC_REPORT_HASH_MISMATCH");
		return { status: streamError ? "stream_error" : truncated ? "truncated" : "available", path: paths.file, attemptedPath: paths.file, sha256: actualHash, truncated, gap, missing: false,
			identity: { root: { ...pin.identity }, file: { volume: info.vol, index: info.index } } };
	} catch {
		if (!created || !file) return { status: "write_failed", path: null, attemptedPath: paths.file, sha256: null, truncated, gap, missing: true };
		try {
			assertDiagnosticPin(pin, policy);
			const info = fileInfo(file);
			if (info.attr & FILE_ATTRIBUTE_REPARSE_POINT || info.links > 1 || !samePath(finalPath(file), paths.file)) throw new Error("DIAGNOSTIC_REPORT_INVALID");
			return { status: "write_failed", path: paths.file, attemptedPath: paths.file, sha256: hashHandle(file, info.size), truncated, gap, missing: false };
		} catch { return { status: "write_failed", path: null, attemptedPath: paths.file, sha256: null, truncated, gap, missing: true }; }
	} finally {
		if (file) closeHandle(file);
	}
}

function checkEnvironment(cwd: string, command: string[]): Record<string, unknown> {
	return {
		cwd, platform: process.platform, arch: process.arch, bunVersion: typeof Bun.version === "string" ? Bun.version : null,
		executable: command[0], pathConfigured: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
	};
}

function launchFailure(error: unknown): { category: "launch"; name: string; code: string | null } {
	const value = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
	return { category: "launch", name: typeof value.name === "string" ? value.name.slice(0, 64) : "Error",
		code: typeof value.code === "string" ? value.code.slice(0, 64) : null };
}

function failedIntegrationCheck(db: Database, projectId: string): string | undefined {
	const generation = genOf(db, projectId);
	const row = db.query<{ run_id: string }, [string, number, string]>(
		`SELECT t.run_id FROM control_tasks t JOIN control_run_contracts c ON c.project_id=t.project_id AND c.run_id=t.run_id
		 WHERE t.project_id=? AND t.generation=? AND t.gate=? AND c.execution_policy='integration-v1'
		 AND t.state IN ('failed','interrupted','running') ORDER BY t.updated_at DESC,t.rowid DESC LIMIT 1`,
	).get(projectId, generation, INTEGRATION_GATE);
	return row?.run_id;
}

function isIntegrationRun(db: Database, projectId: string, runId: string | null): boolean {
	return !!runId && runContract(db, projectId, runId)?.execution_policy === "integration-v1";
}

function integrationClaimConflict(db: Database, commonVol: number, commonIndex: string): string | undefined {
	const rows = db.query<{ project_id: string; task_key: string; run_id: string | null; state: string; agent: string; gate: string | null }, [number, string]>(
		`SELECT t.project_id,t.task_key,t.run_id,t.state,t.agent,t.gate FROM control_tasks t JOIN projects p ON p.id=t.project_id
		 WHERE p.common_dir_vol=? AND p.common_dir_index=? AND t.state IN ('running','interrupted')`,
	).all(commonVol, commonIndex);
	for (const row of rows) {
		if (row.state !== "running" || !isIntegrationRun(db, row.project_id, row.run_id)) return row.task_key;
		if (row.agent === "controller" && row.gate === INTEGRATION_GATE) continue;
		const node = db.query<GraphNodeRow, [string, string]>(
			"SELECT * FROM task_graph_nodes WHERE project_id=? AND author_task_key=? AND state='running' LIMIT 1",
		).get(row.project_id, row.task_key);
		if (!node || node.run_id !== row.run_id) return row.task_key;
	}
	return undefined;
}

async function effectiveSpawnSettings(host: SpawnHost, cwd: string): Promise<RuntimeSettings> {
	return host.settings ?? (await Settings.loadReadOnly({ cwd }));
}

export async function resumeProjectAt(dbFile: string, projectIdArg: string | undefined, host: ResumeHost): Promise<{ ok: true; projectId: string; switched: boolean }> {
	const requestedRoot = requireDLexical(host.cwd, "cwd", "C_PROJECT_ROOT");
	assertNotReserved(requestedRoot);
	const canonicalRoot = readIdentity(requestedRoot).finalPath;
	inspectGit(canonicalRoot);
	const project = withPreauth(dbFile, db => {
		const row = projectIdArg
			? peekProject(db, requireOpaqueId(projectIdArg, "projectId"))
			: peekByRoot(db, canonicalRoot);
		if (!row) fail("NOT_FOUND", projectIdArg ?? canonicalRoot);
		if (!samePath(row.canonical_root, canonicalRoot)) fail("ROOT_MISMATCH", row.id);
		return row;
	});
	if (!project.owner || project.owner === "nosession") fail("QUARANTINE", project.id);
	if (!host.sessionId || host.sessionId === "nosession") fail("SESSION_REQUIRED", "session");
	const pinned = pinProject(project);
	if (host.sessionId === pinned.owner) return { ok: true, projectId: pinned.id, switched: false };
	const ownerSession = (await host.listSessions(pinned.canonical_root)).find(
		session => session.id === pinned.owner && samePath(session.cwd, pinned.canonical_root),
	);
	if (!ownerSession) fail("OWNER_SESSION_NOT_FOUND", pinned.id);
	const switched = await host.switchSession(ownerSession.path);
	if (switched.cancelled) fail("SESSION_SWITCH_CANCELLED", pinned.id);
	return { ok: true, projectId: pinned.id, switched: true };
}


export async function dispatch(input: ControlInput, host: SpawnHost = {}): Promise<Record<string, unknown>> {
	return dispatchAt(controlDbPath(), input, host);
}

function processMayBeAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return true;
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as { code?: string }).code !== "ESRCH"; }
}

function taskMayBeActive(row: TaskReceipt): boolean {
	if (activeControlTasks.has(row.agent_id)) return true;
	// The stored PID identifies the host, not an individual task or its shell children.
	// Only this runtime can distinguish its returned executors from its active ones.
	if (row.runtime_id === runtimeInstance || row.state === "failed" || row.state === "succeeded") return false;
	return row.runtime_pid != null && processMayBeAlive(row.runtime_pid);
}

// User-command-only recovery. Never expose confirmation as a model-settable tool argument.
export async function recoverTaskAt(dbFile: string, projectId: string, taskKey: string, host: {
	cwd: string; sessionId: string;
	confirm: (summary: string) => Promise<{ confirmed: boolean; evidence: string }>;
}): Promise<Record<string, unknown>> {
	requireOpaqueId(projectId, "projectId"); safeOutboxId(taskKey); sessionOwner(host);
	const db = openControlDbAt(dbFile);
	const project = pinProject(getProject(db, projectId));
	requireProjectAccess(project, host.sessionId, host.cwd);
	const existing = taskReceipt(db, projectId, taskKey);
	if (existing) requireTaskOwner(db, project, existing, host.sessionId);
	if (existing?.state === "failed" && !taskMayBeActive(existing)) {
		return { ok: true, taskKey, state: "failed", alreadySettled: true, requiresNewGeneration: true,
			taskComplete: false, nextAction: "inspect_side_effects_then_continue_in_new_generation" };
	}
	const inspect = () => {
		const row = taskReceipt(db, projectId, taskKey);
		if (!row || !["running", "interrupted"].includes(row.state)) fail("TASK_SETTLED", taskKey);
		if (taskMayBeActive(row)) fail("TASK_ACTIVE", "Inspect the task in its owning runtime; controller PID alone is not a worker PID. Do not terminate the host to recover a task.");
		if (row.runtime_id !== runtimeInstance && row.heartbeat_at != null && Date.now() - row.heartbeat_at < 30000) fail("TASK_ACTIVE", "recent heartbeat");
		if (listLeases(db, projectId).some(lease => isLive(lease, genOf(db, projectId)))) fail("LEASE_HELD", projectId);
		return row;
	};
	const prior = inspect();
	const fingerprint = (row: TaskReceipt) => JSON.stringify([row.state, row.updated_at, row.runtime_id, row.heartbeat_at]);
	const answer = await host.confirm(`Task ${taskKey}, run ${prior.run_id ?? "legacy"}, state ${prior.state}. ${prior.runtime_id === runtimeInstance ? "The task executor returned in this runtime." : "No active controller was established."} This does NOT prove shell children stopped. Confirm task-owned workers stopped and working-tree side effects reviewed. This records FAILED, never success, and never transfers run ownership.`);
	if (!answer.confirmed) return { ok: false, cancelled: true };
	if (!answer.evidence.trim() || answer.evidence.length > 8192) fail("EVIDENCE_REQUIRED", "provide bounded recovery evidence without credentials");
	return txn(db, () => {
		pinProject(getProject(db, projectId));
		const row = inspect();
		if (fingerprint(row) !== fingerprint(prior)) fail("TASK_CHANGED", taskKey);
		const id = crypto.randomUUID();
		db.query("INSERT INTO control_recoveries(id,project_id,task_key,run_id,confirmed_by,evidence,previous_state,previous_runtime_id,created_at,generation) VALUES(?,?,?,?,?,?,?,?,?,?)")
			.run(id, projectId, taskKey, row.run_id, host.sessionId, answer.evidence.trim(), row.state, row.runtime_id ?? null, Date.now(), genOf(db, projectId));
		const result = { ...(row.result_json ? JSON.parse(row.result_json) : {}), recovery: { id, confirmedBy: host.sessionId, requiresNewGeneration: true } };
		db.query("UPDATE control_tasks SET state='failed', result_json=?, updated_at=? WHERE project_id=? AND task_key=?")
			.run(JSON.stringify(result), Date.now(), projectId, taskKey);
		db.query("INSERT INTO events(project_id,run_id,type,payload_sha,created_at) VALUES(?,?,'task_recovered',?,?)")
			.run(projectId, row.run_id, sha256(JSON.stringify({ id, taskKey, evidence: answer.evidence })), Date.now());
		return { ok: true, taskKey, recoveryId: id, state: "failed", requiresNewGeneration: true, taskComplete: false };
	});
}
function graphFail(error: unknown): never {
	if (error instanceof TaskGraphError) fail(error.code, error.message);
	throw error;
}
function graphRef(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) || value.includes("..") || value.endsWith("/") || value.startsWith("/")) fail("TASK_GRAPH_REF", value);
	return value;
}
function gitRaw(root: string, args: string[], optional = false, raw = false): string {
	const git = resolveGit();
	const result = Bun.spawnSync({ cmd: [git, "-C", root, ...args], cwd: root, env: gitEnv(git), stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0 && !optional) fail("GIT_STATE", `${args[0]} ${result.stderr.toString().trim()}`);
	return result.exitCode === 0 ? (raw ? result.stdout.toString("utf8") : result.stdout.toString("utf8").trim()) : "";
}
function gitHead(root: string, ref = "HEAD"): string {
	const out = gitRaw(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
	if (!/^[0-9a-f]{40}$/i.test(out)) fail("GIT_STATE", ref);
	return out.toLowerCase();
}
function gitBranch(root: string): string {
	const out = gitRaw(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
	if (!out || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(out)) fail("TASK_GRAPH_BRANCH", "detached or invalid branch");
	return out;
}
function gitClean(root: string): void { if (gitRaw(root, ["status", "--porcelain=v1", "-z"])) fail("DIRTY_WORKTREE", root); }
function gitAncestor(root: string, ancestor: string, descendant: string, code: string): void {
	const git = resolveGit();
	const result = Bun.spawnSync({ cmd: [git, "-C", root, "merge-base", "--is-ancestor", ancestor, descendant], cwd: root, env: gitEnv(git), stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) fail(code, `${ancestor} !<= ${descendant}`);
}
function gitIsAncestor(root: string, ancestor: string, descendant: string): boolean {
	const git = resolveGit();
	return Bun.spawnSync({ cmd: [git, "-C", root, "merge-base", "--is-ancestor", ancestor, descendant], cwd: root, env: gitEnv(git), stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}
function graphNode(db: Database, graphId: string, taskId: string): GraphNodeRow {
	const row = db.query<GraphNodeRow, [string, string]>("SELECT * FROM task_graph_nodes WHERE graph_id=? AND task_id=?").get(graphId, taskId);
	if (!row) fail("NOT_FOUND", `graph task ${taskId}`);
	return row;
}
function graphRow(db: Database, graphId: string) {
	const row = db.query<{ id: string; target_project_id: string; target_ref: string; common_vol: number; common_index: string; plan_sha: string; creator_run_id: string | null; creator_owner: string | null; creator_generation: number | null }, [string]>("SELECT id,target_project_id,target_ref,common_vol,common_index,plan_sha,creator_run_id,creator_owner,creator_generation FROM task_graphs WHERE id=?").get(graphId);
	if (!row) fail("NOT_FOUND", `graph ${graphId}`);
	return row;
}
function graphNodeStatus(row: GraphNodeRow): Record<string, unknown> {
	return { taskId: row.task_id, state: row.state, projectId: row.project_id, runId: row.run_id,
		generation: row.generation, branch: row.branch, claimHead: row.claim_head, targetHead: row.target_head, deliveredHead: row.delivered_head };
}
function activeGraphBinding(db: Database, projectId: string): GraphNodeRow | undefined {
	return db.query<GraphNodeRow, [string]>("SELECT * FROM task_graph_nodes WHERE project_id=? AND state IN ('claimed','running') LIMIT 1").get(projectId);
}
function activeGraphByCommon(db: Database, commonVol: number, commonIndex: string): GraphNodeRow | undefined {
	return db.query<GraphNodeRow, [number, string]>("SELECT n.* FROM task_graph_nodes n JOIN task_graphs g ON g.id=n.graph_id WHERE g.common_vol=? AND g.common_index=? AND n.state IN ('claimed','running') LIMIT 1").get(commonVol, commonIndex);
}
function activeGraphInRepository(db: Database, project: ProjectRow): GraphNodeRow | undefined {
	return activeGraphByCommon(db, project.common_dir_vol!, project.common_dir_index!);
}
function projectForGitPath(db: Database, candidate: string): ProjectRow | undefined {
	try { return findProjectByRoot(db, path.resolve(gitRaw(workspaceRoot(candidate), ["rev-parse", "--show-toplevel"]))); }
	catch { return undefined; }
}
function graphForGitPath(db: Database, candidate: string): { graph: GraphNodeRow; project?: ProjectRow } | undefined {
	try {
		const project = projectForGitPath(db, candidate); if (!project) return undefined;
		const graph = activeGraphByCommon(db, project.common_dir_vol!, project.common_dir_index!);
		return graph ? { graph, project } : undefined;
	} catch { return undefined; }
}
function graphPaths(row: GraphNodeRow): string[] { return JSON.parse(row.write_paths) as string[]; }
function graphResources(row: GraphNodeRow): string[] { return JSON.parse(row.shared_resources) as string[]; }
function graphDependencies(row: GraphNodeRow): Array<{ taskId: string; maturity: DependencyMaturity }> { return JSON.parse(row.dependencies) as Array<{ taskId: string; maturity: DependencyMaturity }>; }
function graphChangedPaths(root: string, base: string, head: string): string[] {
	gitAncestor(root, base, head, "TASK_GRAPH_BASE");
	const raw = gitRaw(root, ["diff", "--no-renames", "--name-only", "-z", `${base}..${head}`], false, true);
	return raw ? raw.split("\0").filter(Boolean).map(name => {
		try { return parseTaskGraph({ targetRef: "x", tasks: [{ id: "x", writePaths: [name], sharedResources: [], dependsOn: [] }] }).tasks[0].writePaths[0]; }
		catch (error) { return graphFail(error); }
	}) : [];
}
function mergeQueueRow(db: Database, graphId: string, taskId: string, attemptId: string): MergeQueueRow {
	const row = db.query<MergeQueueRow, [string, string, string]>("SELECT * FROM merge_queue_items WHERE graph_id=? AND task_id=? AND attempt_id=?").get(graphId, taskId, attemptId);
	if (!row) fail("NOT_FOUND", `merge attempt ${attemptId}`);
	return row;
}
function mergeQueueLock(db: Database, commonVol: number, commonIndex: string): { queue_id: number; target_project_id: string; target_ref: string; owner: string; run_id: string } | undefined {
	return db.query<{ queue_id: number; target_project_id: string; target_ref: string; owner: string; run_id: string }, [number, string]>("SELECT queue_id,target_project_id,target_ref,owner,run_id FROM merge_integration_locks WHERE common_vol=? AND common_index=?").get(commonVol, commonIndex);
}
function mergeLockForProject(db: Database, projectId: string): MergeQueueRow | undefined {
	return db.query<MergeQueueRow, [string, string]>(`SELECT q.* FROM merge_queue_items q JOIN merge_integration_locks l ON l.queue_id=q.id
		WHERE q.target_project_id=? OR q.candidate_project_id=? LIMIT 1`).get(projectId, projectId);
}
function mergeQueueToken(row: MergeQueueRow, input: ControlInput): void {
	if (need(input.claimToken, "claimToken") !== row.claim_token) fail("STALE_CLAIM", row.attempt_id);
}
function blockMergeQueue(db: Database, row: MergeQueueRow, code: string): Record<string, unknown> {
	db.query("UPDATE merge_queue_items SET state='blocked',block_code=?,operation_runtime=NULL,operation_pid=NULL,updated_at=? WHERE id=? AND state NOT IN ('merged','cancelled')").run(code, Date.now(), row.id);
	return { ok: false, graphId: row.graph_id, taskId: row.task_id, attemptId: row.attempt_id, state: "blocked", reason: code, claimToken: row.claim_token };
}
function queueMergeParents(root: string, candidate: string, base: string, delivered: string): boolean {
	const parents = gitRaw(root, ["rev-list", "--parents", "-n", "1", candidate], true).split(/\s+/).filter(Boolean);
	return parents.length === 3 && parents[0] === candidate && parents[1] === base && parents[2] === delivered;
}
function queueResponse(row: MergeQueueRow, includeToken = true): Record<string, unknown> {
	return { graphId: row.graph_id, taskId: row.task_id, attemptId: row.attempt_id, ...(includeToken ? { claimToken: row.claim_token } : {}), state: row.state,
		deliveredHead: row.delivered_head, targetBase: row.target_base, candidateHead: row.candidate_head, blockCode: row.block_code };
}
function queueHasActiveWork(db: Database, projectId: string, root: string): boolean {
	return workspaceWriters(db, root).length > 0 || !!db.query("SELECT task_key FROM control_tasks WHERE project_id=? AND state IN ('running','interrupted') LIMIT 1").get(projectId);
}
function mergeOperationMayBeActive(row: MergeQueueRow): boolean {
	if (!['preparing', 'applying'].includes(row.state)) return false;
	if (row.operation_runtime === runtimeInstance) return activeMergeOperations.has(row.id);
	return row.operation_pid != null && processMayBeAlive(row.operation_pid);
}
function requireMergeRecoveryEvidence(db: Database, row: MergeQueueRow, target: ProjectRow, evidenceKey: string | undefined): void {
	if (!evidenceKey) fail("MERGE_RECOVERY_EVIDENCE", row.attempt_id);
	const key = safeOutboxId(evidenceKey); const evidence = taskReceipt(db, target.id, key);
	const candidate = row.candidate_project_id ? pinProject(getProject(db, row.candidate_project_id)) : undefined;
	if (!evidence || !candidate || !row.candidate_branch) fail("MERGE_RECOVERY_EVIDENCE", row.attempt_id);
	const result = evidence.result_json ? JSON.parse(evidence.result_json) : undefined; const data = result?.structuredOutput?.data;
	const targetHead = gitHead(target.canonical_root); const candidateHead = gitHead(candidate.canonical_root); const candidateFingerprint = sourceFingerprint(candidate.canonical_root);
	if (evidence.agent !== "verifier" || evidence.state !== "succeeded" || evidence.run_id !== row.target_run_id || evidence.generation !== row.target_generation ||
		result?.structuredOutput?.status !== "valid" || result?.sourceFingerprint !== sourceFingerprint(target.canonical_root) || data?.status !== "PASS" ||
		data?.runId !== row.target_run_id || data?.generation !== String(row.target_generation) || data?.reconcilesMergeGraphId !== row.graph_id ||
		data?.reconcilesMergeTaskId !== row.task_id || data?.reconcilesMergeAttemptId !== row.attempt_id || data?.processesStopped !== true || data?.sideEffectsKnown !== true ||
		data?.targetHead !== targetHead || data?.candidateHead !== candidateHead || data?.candidateSourceFingerprint !== candidateFingerprint ||
		gitBranch(candidate.canonical_root) !== row.candidate_branch || !Array.isArray(data?.findings) || data.findings.length !== 0 ||
		!Array.isArray(data?.evidence) || data.evidence.length === 0 || !data.evidence.every((item: unknown) => typeof item === "string" && item.trim())) fail("MERGE_RECOVERY_EVIDENCE", row.attempt_id);
}

export async function dispatchAt(dbFile: string, input: ControlInput, host: SpawnHost = {}): Promise<Record<string, unknown>> {
	const action = input.action;
	if (!isAction(action)) fail("INVALID", `unknown action ${action}`);
	// An explicit project root is execution context, not the shell's startup directory.
	// Project identity and run ownership are still checked below against this root.
	if (input.canonicalRoot) host = { ...host, cwd: requireDLexical(input.canonicalRoot, "canonicalRoot", "C_PROJECT_ROOT") };
	if (action === "health") {
		if (isReady(dbFile) && cachedDb) return healthSnapshot(cachedDb);
		if (!fs.existsSync(dbFile)) {
			return { ok: false, storageClass: "C_SYSTEM", schema: "omp-control" };
		}
		const db = openPreauth(dbFile);
		try {
			return healthSnapshot(db);
		} finally {
			db.close();
		}
	}
	const owner = sessionOwner(host);
	if (action === "workspace_prepare") {
		const requested = requireDLexical(need(input.canonicalRoot, "canonicalRoot"), "canonicalRoot", "C_PROJECT_ROOT");
		assertNotReserved(requested);
		const db = openControlDbAt(dbFile);
		const token = `${owner}:${workspaceRoot(requested)}`;
		const root = txn(db, () => {
			reserveWorkspace(db, requested, owner, token);
			return materializeDDir(requested, "canonicalRoot");
		});
		const tokens = preparedWorkspaceTokens.get(owner) ?? new Set<string>();
		tokens.add(token); preparedWorkspaceTokens.set(owner, tokens);
		return { ok: true, canonicalRoot: root, token, nextAction: "Use this exact root as command cwd and canonicalRoot on control calls, and absolute paths for file tools; establish/reuse its Git baseline. Session cwd is unchanged; no new conversation is needed." };
	}
	if (action === "workspace_status" || action === "workspace_reconcile") {
		const root = workspaceRoot(need(host.cwd, "cwd"));
		const db = openControlDbAt(dbFile);
		if (action === "workspace_status") {
			const writers = workspaceWriters(db, root);
			return { ok: true, root, writers, processInventory: writerProcesses(writers),
				nextAction: "Read affected files to inspect side effects. Recover only a stopped controller with no surviving descendants; do not terminate a controller to unlock work." };
		}
		const token = need(input.token, "token");
		const proof = JSON.parse(need(input.payload, "payload"));
		if (proof.processesStopped !== true || proof.sideEffectsKnown !== true || !Array.isArray(proof.evidence) || !proof.evidence.length || !proof.evidence.every((v: unknown) => typeof v === "string" && v.trim())) fail("RECONCILIATION_REQUIRED", "inspect all former writer processes and workspace side effects");
		return txn(db, () => {
			const row = workspaceWriters(db, root).find(row => row.token === token);
			if (!row) return { ok: true, alreadySettled: true };
			if (processMayBeAlive(row.runtime_pid)) fail("TASK_ACTIVE", "controller remains alive; inspect its tasks without terminating it");
			if (writerProcesses([row])[0].processes.length) fail("TASK_ACTIVE", "surviving writer descendants; retain occupancy");
			db.query("INSERT INTO workspace_recoveries(token,root,confirmed_by,evidence,created_at) VALUES (?,?,?,?,?)").run(token, row.root, owner, JSON.stringify(proof), Date.now());
			db.query("DELETE FROM workspace_activity WHERE token=?").run(token);
			return { ok: true, reconciled: true, taskComplete: false };
		});
	}
	if (RUN_REQUIRED_ACTIONS.has(action)) {
		if (!input.runId) fail("RUN_REQUIRED", action);
		requireOpaqueId(input.runId, "runId");
	}

	if (action === "project_register") {
		const requested = requireDLexical(need(input.canonicalRoot, "canonicalRoot"), "canonicalRoot", "C_PROJECT_ROOT");
		assertNotReserved(requested);
		if (isReady(dbFile) || fs.existsSync(dbFile)) {
			const prior = withPreauth(dbFile, db => peekByRoot(db, requested));
			if (prior) {
				requireProjectAccess(prior, owner, host.cwd);
				const db = openControlDbAt(dbFile);
				return txn(db, () => {
					const existing = findProjectByRoot(db, requested) ?? prior;
					return claimExistingProject(existing, owner, input.projectId, host.cwd);
				});
			}
			const nested = withPreauth(dbFile, db => peekNested(db, requested));
			if (nested) fail("CONFLICT", nested.id);
		}
		const db = openControlDbAt(dbFile);
		return txn(db, () => {
			const existing = findProjectByRoot(db, requested);
			if (existing) return claimExistingProject(existing, owner, input.projectId, host.cwd);
			const nest = findNestedOverlap(db, requested);
			if (nest) fail("CONFLICT", nest.id);
			assertNotReserved(requested);
			const canonicalRoot = materializeDDir(requested, "canonicalRoot");
			assertNotReserved(canonicalRoot);
			const nestAfter = findNestedOverlap(db, canonicalRoot);
			if (nestAfter) fail("CONFLICT", nestAfter.id);
			const raced = findProjectByRoot(db, canonicalRoot);
			if (raced) return claimExistingProject(raced, owner, input.projectId, host.cwd);
			const git = inspectGit(canonicalRoot);
			const id = input.projectId ? requireOpaqueId(input.projectId, "projectId") : newOpaqueId();
			if (db.query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?").get(id)) fail("CONFLICT", id);
			const ts = Date.now();
			const idn = readIdentity(canonicalRoot);
			db.query(
				"INSERT INTO projects (id, canonical_root, allowed_roots, created_at, owner, root_vol, root_index, git_dir, git_dir_vol, git_dir_index, common_dir, common_dir_vol, common_dir_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				id,
				canonicalRoot,
				"[]",
				ts,
				owner,
				idn.vol,
				idn.index,
				git.gitDir,
				git.gitVol,
				git.gitIndex,
				git.commonDir,
				git.commonVol,
				git.commonIndex,
			);
			db.query("INSERT INTO generations (project_id, value) VALUES (?, 1)").run(id);
			return { ok: true, projectId: id, canonicalRoot };
		});
	}

	if (action === "project_get") {
		if (!isReady(dbFile) && !fs.existsSync(dbFile)) fail("NOT_FOUND", String(input.projectId ?? input.canonicalRoot ?? ""));
		if (input.projectId) {
			const row = withPreauth(dbFile, db => peekProject(db, requireOpaqueId(input.projectId as string, "projectId")));
			requireProjectAccess(row, owner, host.cwd);
			const db = openControlDbAt(dbFile);
			const pinned = pinProject(getProject(db, row.id));
			return { ok: true, projectId: pinned.id, canonicalRoot: pinned.canonical_root, ...projectActivity(db, pinned.id, owner) };
		}
		const requested = requireDLexical(need(input.canonicalRoot, "canonicalRoot"), "canonicalRoot", "C_PROJECT_ROOT");
		const row = withPreauth(dbFile, db => {
			const found = peekByRoot(db, requested);
			if (!found) fail("NOT_FOUND", requested);
			return found;
		});
		assertLiveOpaque(row.id);
		requireProjectAccess(row, owner, host.cwd);
		const db = openControlDbAt(dbFile);
		const pinned = pinProject(getProject(db, row.id));
		return { ok: true, projectId: pinned.id, canonicalRoot: pinned.canonical_root, ...projectActivity(db, pinned.id, owner) };
	}

	const projectId = requireOpaqueId(need(input.projectId, "projectId"), "projectId");
	if (!isReady(dbFile) && !fs.existsSync(dbFile)) fail("NOT_FOUND", projectId);
	const loaded = withPreauth(dbFile, db => peekProject(db, projectId));
	// Reject foreign-run access on the read-only connection before mutable/bootstrap work.
	if (input.runId && action !== "run_begin") withPreauth(dbFile, db => requireRunOwner(db, projectId, requireOpaqueId(input.runId!, "runId"), owner));
	requireProjectAccess(loaded, owner, host.cwd ?? (input.runId && action !== "run_begin" ? loaded.canonical_root : undefined));
	if ((action === "task_get" || action === "task_observe" || action === "task_reconcile") && input.idempotencyKey) {
		withPreauth(dbFile, db => {
			for (const key of [input.idempotencyKey, ...(action === "task_reconcile" ? [input.evidenceTaskKey] : [])]) {
				if (!key) continue;
				const receipt = taskReceipt(db, projectId, safeOutboxId(key));
				if (!receipt) fail("NOT_FOUND", "task");
				requireTaskOwner(db, loaded, receipt, owner);
			}
		});
	}
	const db = openControlDbAt(dbFile);
	const project = pinProject(getProject(db, projectId));
	const repositoryGraph = activeGraphInRepository(db, project);
	const projectGraph = activeGraphBinding(db, projectId);
	// Other sibling worktrees must still prepare/register/baseline before their own claim.
	// A bound project cannot replace its reserved leases or generation through a legacy action.
	if ((repositoryGraph && action === "safe_write") || (projectGraph && ["baseline_capture", "lease_acquire", "lease_renew", "lease_release", "generation_advance"].includes(action))) {
		fail("TASK_CLAIM_REQUIRED", `active graph task ${(repositoryGraph ?? projectGraph)!.task_id}`);
	}
	const mergeLock = mergeLockForProject(db, projectId);
	if (mergeLock && (action === "safe_write" || action === "baseline_capture" || (action === "project_spawn" && !READ_ONLY_CODING_AGENTS.has(input.agent ?? "")))) {
		fail("MERGE_LOCKED", mergeLock.attempt_id);
	}

	if (action === "task_graph_create") {
		const graphId = input.graphId ? safeOutboxId(input.graphId) : newOpaqueId();
		let plan: ReturnType<typeof parseTaskGraph>;
		try { plan = parseTaskGraph(need(input.graphPlan, "graphPlan")); } catch (error) { graphFail(error); }
		const targetRef = graphRef(plan.targetRef);
		const planSha = sha256(JSON.stringify(plan));
		gitHead(project.canonical_root, `refs/heads/${targetRef}`);
		return txn(db, () => {
			assertNoForeignUnsettled(db, projectId, input.runId!);
			const prior = db.query<{ plan_sha: string; target_project_id: string; common_vol: number; common_index: string; creator_run_id: string | null; creator_owner: string | null; creator_generation: number | null }, [string]>("SELECT plan_sha,target_project_id,common_vol,common_index,creator_run_id,creator_owner,creator_generation FROM task_graphs WHERE id=?").get(graphId);
			if (prior) {
				if (prior.plan_sha !== planSha || prior.target_project_id !== projectId || prior.common_vol !== project.common_dir_vol || prior.common_index !== project.common_dir_index || prior.creator_run_id !== input.runId || prior.creator_owner !== owner || prior.creator_generation !== genOf(db, projectId)) fail("TASK_CONFLICT", graphId);
				return { ok: true, graphId, duplicate: true };
			}
			db.query("INSERT INTO task_graphs(id,target_project_id,target_ref,common_vol,common_index,plan_sha,creator_run_id,creator_owner,creator_generation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
				.run(graphId, projectId, targetRef, project.common_dir_vol!, project.common_dir_index!, planSha, input.runId, owner, genOf(db, projectId), Date.now());
			for (const node of plan.tasks) db.query("INSERT INTO task_graph_nodes(graph_id,task_id,write_paths,shared_resources,dependencies,state,updated_at) VALUES(?,?,?,?,?,'planned',?)")
				.run(graphId, node.id, JSON.stringify(node.writePaths), JSON.stringify(node.sharedResources), JSON.stringify(node.dependsOn), Date.now());
			return { ok: true, graphId, duplicate: false, taskCount: plan.tasks.length, targetRef };
		});
	}

	if (action === "task_graph_status") {
		const graph = graphRow(db, safeOutboxId(need(input.graphId, "graphId")));
		if (graph.common_vol !== project.common_dir_vol || graph.common_index !== project.common_dir_index) fail("GIT_IDENTITY", "graph repository");
		const nodes = db.query<GraphNodeRow, [string]>("SELECT * FROM task_graph_nodes WHERE graph_id=? ORDER BY task_id").all(graph.id);
		return { ok: true, graphId: graph.id, targetRef: graph.target_ref, nodes: nodes.map(row => ({ ...graphNodeStatus(row),
			blocking: row.state === "planned" ? graphDependencies(row).filter(dep => graphNode(db, graph.id, dep.taskId).state !== "delivered").map(dep => dep.taskId) : [] })) };
	}

	if (action === "task_claim") {
		const graphId = safeOutboxId(need(input.graphId, "graphId")); let taskId: string;
		try { taskId = taskNodeId(need(input.taskId, "taskId")); } catch (error) { graphFail(error); }
		const authorTaskKey = safeOutboxId(need(input.idempotencyKey, "idempotencyKey"));
		return txn(db, () => {
			assertNoForeignUnsettled(db, projectId, input.runId!);
			if (workspaceWriters(db, project.canonical_root).some(row => row.owner !== owner || row.runtime_id !== runtimeInstance)) fail("WORKSPACE_BUSY", projectId);
			const graph = graphRow(db, graphId); const node = graphNode(db, graphId, taskId);
			if (graph.common_vol !== project.common_dir_vol || graph.common_index !== project.common_dir_index || graph.target_project_id === projectId) fail("GIT_IDENTITY", "task worktree");
			const target = pinProject(getProject(db, graph.target_project_id));
			const currentHead = gitHead(project.canonical_root); const targetHead = gitHead(target.canonical_root, `refs/heads/${graph.target_ref}`);
			const branch = gitBranch(project.canonical_root); if (branch === graph.target_ref) fail("TASK_GRAPH_BRANCH", "target branch");
			gitClean(project.canonical_root); gitAncestor(project.canonical_root, targetHead, currentHead, "STALE_TASK_BASE");
			if (node.state === "claimed" && node.project_id === projectId && node.run_id === input.runId && node.owner === owner && node.author_task_key === authorTaskKey && node.branch === branch && node.claim_head === currentHead) {
				const expiresAt = Date.now() + DEFAULT_TTL_MS;
				for (const scope of graphPaths(node)) db.query("UPDATE leases SET expires_at=? WHERE project_id=? AND resource=? AND token=?").run(expiresAt, projectId, scope, node.claim_token);
				return { ok: true, graphId, taskId, duplicate: true, claimToken: node.claim_token, authorTaskKey, expiresAt };
			}
			if (node.state !== "planned") fail("TASK_CLAIMED", taskId);
			if (activeGraphBinding(db, projectId)) fail("TASK_CLAIMED", "worktree already bound");
			if (taskReceipt(db, projectId, authorTaskKey)) fail("TASK_CONFLICT", authorTaskKey);
			if (isIntegrationRun(db, projectId, input.runId!)) {
				const conflict = integrationClaimConflict(db, graph.common_vol, graph.common_index);
				if (conflict) fail("UNSETTLED_TASK", conflict);
			} else {
				const legacy = db.query<{ task_key: string }, [number, string]>("SELECT t.task_key FROM control_tasks t JOIN projects p ON p.id=t.project_id WHERE p.common_dir_vol=? AND p.common_dir_index=? AND t.state IN ('running','interrupted') LIMIT 1").get(graph.common_vol, graph.common_index);
				if (legacy) fail("UNSETTLED_TASK", legacy.task_key);
			}
			for (const dep of graphDependencies(node)) {
				const upstream = graphNode(db, graphId, dep.taskId);
				if (upstream.state !== "delivered" || !upstream.delivered_head) fail("TASK_NOT_READY", dep.taskId);
				gitAncestor(project.canonical_root, upstream.delivered_head, currentHead, "UPSTREAM_COMMIT_REQUIRED");
				if (dep.maturity === "integrated") gitAncestor(target.canonical_root, upstream.delivered_head, targetHead, "UPSTREAM_NOT_INTEGRATED");
			}
			const active = db.query<GraphNodeRow, [number, string]>("SELECT n.* FROM task_graph_nodes n JOIN task_graphs g ON g.id=n.graph_id WHERE g.common_vol=? AND g.common_index=? AND n.state IN ('claimed','running')").all(graph.common_vol, graph.common_index);
			for (const other of active) {
				if (graphPaths(node).some(a => graphPaths(other).some(b => taskScopesOverlap(a, b))) || graphResources(node).some(a => graphResources(other).includes(a))) fail("TASK_SCOPE_CONFLICT", other.task_id);
			}
			for (const lease of listLeases(db, projectId).filter(row => isLive(row, genOf(db, projectId)))) if (graphPaths(node).some(scope => scopesOverlap(scope, lease.resource))) fail("LEASE_HELD", lease.resource);
			const token = crypto.randomBytes(16).toString("hex"); const expiresAt = Date.now() + DEFAULT_TTL_MS; const generation = genOf(db, projectId);
			for (const scope of graphPaths(node)) db.query("INSERT INTO leases(project_id,resource,owner,token,generation,expires_at,run_id) VALUES(?,?,?,?,?,?,?)").run(projectId, scope, owner, token, generation, expiresAt, input.runId);
			db.query("UPDATE task_graph_nodes SET state='claimed',project_id=?,run_id=?,owner=?,generation=?,claim_token=?,author_task_key=?,branch=?,claim_head=?,target_head=?,updated_at=? WHERE graph_id=? AND task_id=? AND state='planned'")
				.run(projectId, input.runId, owner, generation, token, authorTaskKey, branch, currentHead, targetHead, Date.now(), graphId, taskId);
			return { ok: true, graphId, taskId, claimToken: token, authorTaskKey, branch, claimHead: currentHead, targetHead, expiresAt };
		});
	}

	if (action === "task_deliver") {
		const graphId = safeOutboxId(need(input.graphId, "graphId")); let taskId: string;
		try { taskId = taskNodeId(need(input.taskId, "taskId")); } catch (error) { graphFail(error); }
		const token = need(input.claimToken, "claimToken");
		return txn(db, () => {
			const node = graphNode(db, graphId, taskId);
			if (node.state !== "running" || node.project_id !== projectId || node.run_id !== input.runId || node.owner !== owner || node.claim_token !== token || node.generation !== genOf(db, projectId)) fail("TASK_CLAIM_REQUIRED", taskId);
			const receipt = node.author_task_key ? taskReceipt(db, projectId, node.author_task_key) : null;
			if (!receipt || receipt.state !== "succeeded" || receipt.run_id !== input.runId || receipt.generation !== node.generation) fail("TASK_AUTHOR_REQUIRED", taskId);
			const completion = completionStatus(db, projectId, input.runId!); if (completion.taskComplete !== true) fail("TASK_GATES_REQUIRED", taskId);
			const branch = gitBranch(project.canonical_root); if (branch !== node.branch) fail("TASK_GRAPH_BRANCH", taskId);
			gitClean(project.canonical_root); const head = gitHead(project.canonical_root); gitAncestor(project.canonical_root, node.claim_head!, head, "TASK_GRAPH_BASE");
			for (const changed of graphChangedPaths(project.canonical_root, node.claim_head!, head)) if (!graphPaths(node).some(scope => changed === scope || changed.startsWith(`${scope}/`))) fail("TASK_SCOPE_VIOLATION", changed);
			if (head === node.claim_head) fail("TASK_NO_COMMIT", taskId);
			const fingerprint = sourceFingerprint(project.canonical_root);
			db.query("UPDATE task_graph_nodes SET state='delivered',delivered_head=?,delivered_fingerprint=?,updated_at=? WHERE graph_id=? AND task_id=? AND state='running'").run(head, fingerprint, Date.now(), graphId, taskId);
			for (const scope of graphPaths(node)) db.query("DELETE FROM leases WHERE project_id=? AND resource=? AND token=?").run(projectId, scope, token);
			return { ok: true, graphId, taskId, state: "delivered", verifiedCommit: head, sourceFingerprint: fingerprint, integrated: false, productComplete: false };
		});
	}

	if (action === "task_claim_reconcile") {
		const graphId = safeOutboxId(need(input.graphId, "graphId")); let taskId: string;
		try { taskId = taskNodeId(need(input.taskId, "taskId")); } catch (error) { graphFail(error); }
		const token = need(input.claimToken, "claimToken");
		return txn(db, () => {
			const node = graphNode(db, graphId, taskId);
			if (!['claimed','running'].includes(node.state) || node.project_id !== projectId || node.run_id !== input.runId || node.owner !== owner || node.claim_token !== token) fail("TASK_CLAIM_REQUIRED", taskId);
			if (!node.author_task_key) fail("RECONCILIATION_REQUIRED", taskId);
			const receipt = taskReceipt(db, projectId, node.author_task_key);
			if (!receipt && node.state === "claimed") {
				if (workspaceWriters(db, project.canonical_root).length) fail("TASK_ACTIVE", taskId);
				if (gitBranch(project.canonical_root) !== node.branch || gitHead(project.canonical_root) !== node.claim_head) fail("TASK_CHANGED", taskId);
				gitClean(project.canonical_root);
				db.query("UPDATE task_graph_nodes SET state='cancelled',updated_at=? WHERE graph_id=? AND task_id=? AND state='claimed'").run(Date.now(), graphId, taskId);
				for (const scope of graphPaths(node)) db.query("DELETE FROM leases WHERE project_id=? AND resource=? AND token=?").run(projectId, scope, token);
				return { ok: true, graphId, taskId, state: "cancelled", retryable: false };
			}
			if (receipt?.state === "succeeded" && receipt.run_id === node.run_id && receipt.generation === node.generation) {
				if (workspaceWriters(db, project.canonical_root).length || taskMayBeActive(receipt)) fail("TASK_ACTIVE", taskId);
				if (gitBranch(project.canonical_root) !== node.branch || !node.claim_head) fail("TASK_CHANGED", taskId);
				gitAncestor(project.canonical_root, node.claim_head, gitHead(project.canonical_root), "TASK_CHANGED");
				gitClean(project.canonical_root);
				db.query("UPDATE task_graph_nodes SET state='failed',updated_at=? WHERE graph_id=? AND task_id=?").run(Date.now(), graphId, taskId);
				for (const scope of graphPaths(node)) db.query("DELETE FROM leases WHERE project_id=? AND resource=? AND token=?").run(projectId, scope, token);
				return { ok: true, graphId, taskId, state: "failed", retryable: false, nextAction: "preserve branch evidence; create a new graph task for the repair" };
			}
			const recovered = db.query<{ id: string }, [string, string, string, number]>("SELECT id FROM control_recoveries WHERE project_id=? AND task_key=? AND run_id=? AND generation=? LIMIT 1").get(projectId, node.author_task_key, node.run_id!, node.generation!);
			if (!receipt || receipt.state !== "failed" || receipt.run_id !== node.run_id || receipt.generation !== node.generation || !recovered) fail("RECONCILIATION_REQUIRED", taskId);
			db.query("UPDATE task_graph_nodes SET state='interrupted',updated_at=? WHERE graph_id=? AND task_id=?").run(Date.now(), graphId, taskId);
			for (const scope of graphPaths(node)) db.query("DELETE FROM leases WHERE project_id=? AND resource=? AND token=?").run(projectId, scope, token);
			return { ok: true, graphId, taskId, state: "interrupted", retryable: false };
		});
	}

	if (action === "merge_status") {
		const rows = db.query<MergeQueueRow, [number, string]>("SELECT * FROM merge_queue_items WHERE common_vol=? AND common_index=? ORDER BY id").all(project.common_dir_vol!, project.common_dir_index!);
		const lock = mergeQueueLock(db, project.common_dir_vol!, project.common_dir_index!);
		return { ok: true, items: rows.map(row => queueResponse(row, false)), lock: lock ? { queueId: lock.queue_id, targetProjectId: lock.target_project_id, targetRef: lock.target_ref, runId: lock.run_id } : null };
	}

	if (action === "merge_enqueue") {
		const graphId = safeOutboxId(need(input.graphId, "graphId")); let taskId: string;
		try { taskId = taskNodeId(need(input.taskId, "taskId")); } catch (error) { graphFail(error); }
		const attemptId = safeOutboxId(need(input.idempotencyKey, "idempotencyKey"));
		return txn(db, () => {
			assertNoForeignUnsettled(db, projectId, input.runId!);
			const graph = graphRow(db, graphId); const node = graphNode(db, graphId, taskId);
			if (graph.target_project_id !== projectId || graph.common_vol !== project.common_dir_vol || graph.common_index !== project.common_dir_index) fail("GIT_IDENTITY", "merge target");
			if (node.state !== "delivered" || !node.delivered_head) fail("TASK_NOT_READY", taskId);
			const prior = db.query<MergeQueueRow, [string, string, string]>("SELECT * FROM merge_queue_items WHERE graph_id=? AND task_id=? AND attempt_id=?").get(graphId, taskId, attemptId);
			if (prior) {
				if (prior.target_project_id !== projectId || prior.target_run_id !== input.runId || prior.target_owner !== owner || prior.target_generation !== genOf(db, projectId) || prior.delivered_head !== node.delivered_head) fail("TASK_CONFLICT", attemptId);
				return { ok: true, duplicate: true, ...queueResponse(prior) };
			}
			const now = Date.now(); const token = crypto.randomBytes(16).toString("hex");
			db.query("INSERT INTO merge_queue_items(graph_id,task_id,attempt_id,state,target_project_id,target_run_id,target_owner,target_generation,common_vol,common_index,target_ref,delivered_head,claim_token,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?)")
				.run(graphId, taskId, attemptId, projectId, input.runId, owner, genOf(db, projectId), graph.common_vol, graph.common_index, graph.target_ref, node.delivered_head, token, now, now);
			const row = mergeQueueRow(db, graphId, taskId, attemptId);
			return { ok: true, duplicate: false, ...queueResponse(row) };
		});
	}

	if (action === "merge_prepare") {
		const graphId = safeOutboxId(need(input.graphId, "graphId")); let taskId: string;
		try { taskId = taskNodeId(need(input.taskId, "taskId")); } catch (error) { graphFail(error); }
		const attemptId = safeOutboxId(need(input.idempotencyKey, "idempotencyKey"));
		let row = mergeQueueRow(db, graphId, taskId, attemptId); mergeQueueToken(row, input);
		if (row.state !== "queued") {
			if (row.candidate_project_id !== projectId || row.candidate_run_id !== input.runId || row.candidate_owner !== owner || row.candidate_generation !== genOf(db, projectId)) fail("MERGE_CANDIDATE_CONTEXT", attemptId);
			return { ok: row.state === "candidate_ready", duplicate: true, ...queueResponse(row) };
		}
		const target = pinProject(getProject(db, row.target_project_id));
		try {
			requireRunOwner(db, row.target_project_id, row.target_run_id, row.target_owner);
			if (genOf(db, row.target_project_id) !== row.target_generation) fail("MERGE_TARGET_GENERATION", attemptId);
			if (row.common_vol !== project.common_dir_vol || row.common_index !== project.common_dir_index || row.common_vol !== target.common_dir_vol || row.common_index !== target.common_dir_index) fail("GIT_IDENTITY", "merge repository");
			if (projectId === row.target_project_id || projectId === graphNode(db, graphId, taskId).project_id) fail("MERGE_CANDIDATE_ROOT", "candidate must be isolated");
			assertNoForeignUnsettled(db, projectId, input.runId!);
			if (activeGraphBinding(db, projectId)) fail("TASK_CLAIM_REQUIRED", "candidate graph binding");
			const targetHead = gitHead(target.canonical_root, `refs/heads/${row.target_ref}`);
			if (gitBranch(target.canonical_root) !== row.target_ref || gitHead(target.canonical_root) !== targetHead) fail("MERGE_TARGET_STATE", row.target_ref);
			gitClean(target.canonical_root); gitClean(project.canonical_root);
			if (gitIsAncestor(target.canonical_root, row.delivered_head, targetHead)) {
				return txn(db, () => { const current = mergeQueueRow(db, graphId, taskId, attemptId); if (current.state !== "queued") return { ok: current.state === "merged", duplicate: true, ...queueResponse(current) };
					db.query("UPDATE merge_queue_items SET state='merged',target_base=?,candidate_head=?,updated_at=? WHERE id=?").run(targetHead, targetHead, Date.now(), current.id);
					return { ok: true, alreadyIntegrated: true, ...queueResponse(mergeQueueRow(db, graphId, taskId, attemptId)) };
				});
			}
			const branch = gitBranch(project.canonical_root); if (branch === row.target_ref) fail("MERGE_CANDIDATE_BRANCH", branch);
			const candidateStart = gitHead(project.canonical_root); if (candidateStart !== targetHead) fail("MERGE_CANDIDATE_BASE", candidateStart);
			const locked = txn(db, () => {
				const current = mergeQueueRow(db, graphId, taskId, attemptId); if (current.state !== "queued") return { row: current, acquired: false };
				if (mergeQueueLock(db, row.common_vol, row.common_index)) fail("MERGE_LOCKED", "commonDir");
				const first = db.query<MergeQueueRow, [number, string, string]>("SELECT * FROM merge_queue_items WHERE common_vol=? AND common_index=? AND target_ref=? AND state='queued' ORDER BY id LIMIT 1").get(row.common_vol, row.common_index, row.target_ref);
				if (!first || first.id !== current.id) fail("MERGE_FIFO", current.attempt_id);
				if (queueHasActiveWork(db, row.target_project_id, target.canonical_root) || queueHasActiveWork(db, projectId, project.canonical_root) || activeGraphBinding(db, projectId)) fail("WORKSPACE_BUSY", "merge writer");
				db.query("UPDATE merge_queue_items SET state='preparing',target_base=?,candidate_project_id=?,candidate_run_id=?,candidate_owner=?,candidate_generation=?,candidate_branch=?,candidate_start=?,operation_runtime=?,operation_pid=?,updated_at=? WHERE id=?")
					.run(targetHead, projectId, input.runId, owner, genOf(db, projectId), branch, candidateStart, runtimeInstance, process.pid, Date.now(), current.id);
				db.query("INSERT INTO merge_integration_locks(common_vol,common_index,queue_id,target_project_id,target_ref,owner,run_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
					.run(row.common_vol, row.common_index, current.id, row.target_project_id, row.target_ref, row.target_owner, row.target_run_id, Date.now());
				return { row: mergeQueueRow(db, graphId, taskId, attemptId), acquired: true };
			});
			row = locked.row; if (!locked.acquired) return { ok: row.state === "candidate_ready", duplicate: true, ...queueResponse(row) };
			try { if (gitHead(target.canonical_root) !== targetHead || gitHead(project.canonical_root) !== candidateStart) fail("MERGE_PREPARE_MOVED", attemptId); gitClean(project.canonical_root); }
			catch { return txn(db, () => blockMergeQueue(db, mergeQueueRow(db, graphId, taskId, attemptId), "MERGE_PREPARE_MOVED")); }
			activeMergeOperations.add(row.id); try { gitRaw(project.canonical_root, ["merge", "--no-ff", "--no-edit", row.delivered_head], true); } finally { activeMergeOperations.delete(row.id); }
			return txn(db, () => {
				const current = mergeQueueRow(db, graphId, taskId, attemptId);
				if (current.state !== "preparing") return { ok: current.state === "candidate_ready", duplicate: true, ...queueResponse(current) };
				let candidate = ""; let clean = false; try { candidate = gitHead(project.canonical_root); gitClean(project.canonical_root); clean = true; } catch { /* inspected below */ }
				if (clean && gitHead(target.canonical_root) === targetHead && queueMergeParents(project.canonical_root, candidate, targetHead, current.delivered_head)) {
					db.query("UPDATE merge_queue_items SET state='candidate_ready',candidate_head=?,operation_runtime=NULL,operation_pid=NULL,updated_at=? WHERE id=?").run(candidate, Date.now(), current.id);
					return { ok: true, ...queueResponse(mergeQueueRow(db, graphId, taskId, attemptId)) };
				}
				return blockMergeQueue(db, current, "MERGE_PREPARE_FAILED");
			});
		} catch (error) {
			const current = mergeQueueRow(db, graphId, taskId, attemptId); const lock = mergeQueueLock(db, current.common_vol, current.common_index);
			if (current.state === "preparing" && lock?.queue_id === current.id) return txn(db, () => blockMergeQueue(db, mergeQueueRow(db, graphId, taskId, attemptId), error instanceof ControlError ? error.code : "MERGE_PREPARE_FAILED"));
			throw error;
		}
	}

	if (action === "merge_verify") {
		const graphId = safeOutboxId(need(input.graphId, "graphId")); let taskId: string;
		try { taskId = taskNodeId(need(input.taskId, "taskId")); } catch (error) { graphFail(error); }
		const attemptId = safeOutboxId(need(input.idempotencyKey, "idempotencyKey")); const row = mergeQueueRow(db, graphId, taskId, attemptId); mergeQueueToken(row, input);
		if (row.candidate_project_id !== projectId || row.candidate_run_id !== input.runId || row.candidate_owner !== owner || row.candidate_generation !== genOf(db, projectId)) fail("MERGE_CANDIDATE_CONTEXT", attemptId);
		if (row.state !== "candidate_ready") return { ok: row.state === "verified", duplicate: true, ...queueResponse(row) };
		try {
			gitClean(project.canonical_root); if (gitBranch(project.canonical_root) !== row.candidate_branch || gitHead(project.canonical_root) !== row.candidate_head) fail("MERGE_CANDIDATE_CHANGED", attemptId);
			const completion = completionStatus(db, projectId, input.runId!); if (completion.taskComplete !== true) fail("TASK_GATES_REQUIRED", attemptId);
			const fingerprint = sourceFingerprint(project.canonical_root);
			return txn(db, () => { const current = mergeQueueRow(db, graphId, taskId, attemptId); if (current.state !== "candidate_ready") return { ok: current.state === "verified", duplicate: true, ...queueResponse(current) };
				db.query("UPDATE merge_queue_items SET state='verified',candidate_fingerprint=?,updated_at=? WHERE id=?").run(fingerprint, Date.now(), current.id);
				return { ok: true, ...queueResponse(mergeQueueRow(db, graphId, taskId, attemptId)) };
			});
		} catch (error) { return txn(db, () => blockMergeQueue(db, mergeQueueRow(db, graphId, taskId, attemptId), error instanceof ControlError ? error.code : "MERGE_VERIFY_FAILED")); }
	}

	if (action === "merge_apply") {
		const graphId = safeOutboxId(need(input.graphId, "graphId")); let taskId: string;
		try { taskId = taskNodeId(need(input.taskId, "taskId")); } catch (error) { graphFail(error); }
		const attemptId = safeOutboxId(need(input.idempotencyKey, "idempotencyKey")); let row = mergeQueueRow(db, graphId, taskId, attemptId); mergeQueueToken(row, input);
		if (row.target_project_id !== projectId || row.target_run_id !== input.runId || row.target_owner !== owner || row.target_generation !== genOf(db, projectId)) fail("MERGE_TARGET_CONTEXT", attemptId);
		if (row.state !== "verified") return { ok: row.state === "merged", duplicate: true, ...queueResponse(row) };
		try {
			const candidate = pinProject(getProject(db, row.candidate_project_id!));
			if (candidate.common_dir_vol !== project.common_dir_vol || candidate.common_dir_index !== project.common_dir_index) fail("GIT_IDENTITY", "candidate repository");
			gitClean(project.canonical_root); gitClean(candidate.canonical_root);
			if (gitBranch(project.canonical_root) !== row.target_ref || gitHead(project.canonical_root) !== row.target_base) fail("MERGE_TARGET_MOVED", attemptId);
			if (gitBranch(candidate.canonical_root) !== row.candidate_branch || gitHead(candidate.canonical_root) !== row.candidate_head || sourceFingerprint(candidate.canonical_root) !== row.candidate_fingerprint) fail("MERGE_CANDIDATE_CHANGED", attemptId);
			if (completionStatus(db, candidate.id, row.candidate_run_id!).taskComplete !== true) fail("TASK_GATES_REQUIRED", attemptId);
			if (!queueMergeParents(candidate.canonical_root, row.candidate_head!, row.target_base!, row.delivered_head)) fail("MERGE_CANDIDATE_ANCESTRY", attemptId);
			const applying = txn(db, () => { const current = mergeQueueRow(db, graphId, taskId, attemptId); if (current.state !== "verified") return { row: current, acquired: false }; const lock = mergeQueueLock(db, current.common_vol, current.common_index); if (!lock || lock.queue_id !== current.id) fail("MERGE_LOCKED", attemptId);
				if (queueHasActiveWork(db, projectId, project.canonical_root) || queueHasActiveWork(db, candidate.id, candidate.canonical_root)) fail("WORKSPACE_BUSY", "merge writer");
				db.query("UPDATE merge_queue_items SET state='applying',operation_runtime=?,operation_pid=?,updated_at=? WHERE id=?").run(runtimeInstance, process.pid, Date.now(), current.id); return { row: mergeQueueRow(db, graphId, taskId, attemptId), acquired: true }; });
			row = applying.row;
			if (!applying.acquired) return { ok: row.state === "merged", duplicate: true, ...queueResponse(row) };
			activeMergeOperations.add(row.id); try { gitRaw(project.canonical_root, ["merge", "--ff-only", row.candidate_head!], true); } finally { activeMergeOperations.delete(row.id); }
			return txn(db, () => { const current = mergeQueueRow(db, graphId, taskId, attemptId); if (gitHead(project.canonical_root) === current.candidate_head) {
				db.query("UPDATE merge_queue_items SET state='merged',operation_runtime=NULL,operation_pid=NULL,updated_at=? WHERE id=?").run(Date.now(), current.id); db.query("DELETE FROM merge_integration_locks WHERE queue_id=?").run(current.id);
				return { ok: true, ...queueResponse(mergeQueueRow(db, graphId, taskId, attemptId)) };
			} return blockMergeQueue(db, current, "MERGE_APPLY_FAILED"); });
		} catch (error) { return txn(db, () => blockMergeQueue(db, mergeQueueRow(db, graphId, taskId, attemptId), error instanceof ControlError ? error.code : "MERGE_APPLY_FAILED")); }
	}

	if (action === "merge_reconcile") {
		const graphId = safeOutboxId(need(input.graphId, "graphId")); let taskId: string;
		try { taskId = taskNodeId(need(input.taskId, "taskId")); } catch (error) { graphFail(error); }
		const attemptId = safeOutboxId(need(input.idempotencyKey, "idempotencyKey"));
		return txn(db, () => {
			const row = mergeQueueRow(db, graphId, taskId, attemptId); mergeQueueToken(row, input);
			if (row.target_project_id !== projectId || row.target_run_id !== input.runId || row.target_owner !== owner) fail("MERGE_TARGET_CONTEXT", attemptId);
			if (input.cancel) {
				if (mergeOperationMayBeActive(row)) fail("TASK_ACTIVE", attemptId);
				if (!['queued', 'blocked'].includes(row.state)) fail("MERGE_RECOVERY_REQUIRED", attemptId);
				const candidateBusy = row.candidate_project_id && (workspaceWriters(db, getProject(db, row.candidate_project_id).canonical_root).length || db.query("SELECT task_key FROM control_tasks WHERE project_id=? AND state IN ('running','interrupted') LIMIT 1").get(row.candidate_project_id));
				if (row.state === 'blocked' && (mergeOperationMayBeActive(row) || workspaceWriters(db, project.canonical_root).length || candidateBusy)) fail("TASK_ACTIVE", attemptId);
				db.query("UPDATE merge_queue_items SET state='cancelled',updated_at=? WHERE id=?").run(Date.now(), row.id); db.query("DELETE FROM merge_integration_locks WHERE queue_id=?").run(row.id);
				return { ok: true, cancelled: true, ...queueResponse(mergeQueueRow(db, graphId, taskId, attemptId)) };
			}
			if (row.target_generation !== genOf(db, projectId)) fail("MERGE_TARGET_GENERATION", attemptId);
			const lock = mergeQueueLock(db, row.common_vol, row.common_index); if (row.state !== "merged" && row.state !== "cancelled" && (!lock || lock.queue_id !== row.id)) fail("MERGE_LOCKED", attemptId);
			if (mergeOperationMayBeActive(row)) fail("TASK_ACTIVE", attemptId);
			if (row.state === "merged" || row.state === "cancelled") return { ok: true, duplicate: true, ...queueResponse(row) };
			const target = pinProject(project); const candidate = row.candidate_project_id ? pinProject(getProject(db, row.candidate_project_id)) : undefined;
			if (['preparing', 'applying'].includes(row.state) && row.operation_runtime !== runtimeInstance) requireMergeRecoveryEvidence(db, row, target, input.evidenceTaskKey);
			if (row.state === "applying" && row.candidate_head && gitHead(target.canonical_root) === row.candidate_head) {
				db.query("UPDATE merge_queue_items SET state='merged',operation_runtime=NULL,operation_pid=NULL,updated_at=? WHERE id=?").run(Date.now(), row.id); db.query("DELETE FROM merge_integration_locks WHERE queue_id=?").run(row.id); return { ok: true, recovered: true, ...queueResponse(mergeQueueRow(db, graphId, taskId, attemptId)) };
			}
			if (row.state === "preparing" && candidate && row.target_base && row.candidate_head === null) {
				let candidateHead = ""; try { candidateHead = gitHead(candidate.canonical_root); gitClean(candidate.canonical_root); } catch { return blockMergeQueue(db, row, "MERGE_RECOVERY_UNKNOWN"); }
				if (gitHead(target.canonical_root) === row.target_base && queueMergeParents(candidate.canonical_root, candidateHead, row.target_base, row.delivered_head)) {
					db.query("UPDATE merge_queue_items SET state='candidate_ready',candidate_head=?,operation_runtime=NULL,operation_pid=NULL,updated_at=? WHERE id=?").run(candidateHead, Date.now(), row.id); return { ok: true, recovered: true, ...queueResponse(mergeQueueRow(db, graphId, taskId, attemptId)) };
				}
			}
			return blockMergeQueue(db, row, "MERGE_RECOVERY_UNKNOWN");
		});
	}


	if (action === "run_begin") {
		const id = newOpaqueId();
		const risk = input.risk ?? "standard";
		if (!["mechanical", "standard", "high"].includes(risk)) fail("INVALID", "risk");
		const policy = input.executionPolicy;
		if (policy !== undefined && policy !== "integration-v1") fail("INVALID", "executionPolicy");
		if (!policy && input.checkCommand !== undefined) fail("INVALID", "checkCommand requires integration-v1");
		if (!policy && input.diagnosticEvidence !== undefined) fail("INVALID", "diagnosticEvidence requires integration-v1");
		if (policy && risk === "high") fail("INVALID", "integration-v1 does not permit high risk");
		const command = policy ? frozenCheckCommand(input.checkCommand) : undefined;
		if (policy && input.diagnosticEvidence === undefined) fail("DIAGNOSTIC_EVIDENCE_REQUIRED", "integration-v1 new runs require an authorized diagnostic root");
		const diagnosticEvidence = policy ? bindDiagnosticEvidence(input.diagnosticEvidence, project.canonical_root) : undefined;
		const gates = policy ? [INTEGRATION_GATE] : risk === "mechanical" ? ["verification"] : risk === "high"
			? ["verification", "security", "data_loss", "critical_production_failure", "reproduction"]
			: ["verification", "security"];
		return txn(db, () => {
			if (policy) {
				const failed = failedIntegrationCheck(db, projectId);
				if (failed) fail("INTEGRATION_CHECK_UNRESOLVED", failed);
				const legacyActive = db.query<{ task_key: string }, [string]>(
					"SELECT task_key FROM control_tasks WHERE project_id=? AND state IN ('running','interrupted') LIMIT 1",
				).get(projectId);
				if (legacyActive) fail("UNSETTLED_TASK", legacyActive.task_key);
			}
		db.query("INSERT INTO runs (id, project_id, started_at, cwd, owner) VALUES (?, ?, ?, ?, ?)").run(
			id,
			projectId,
			Date.now(),
			project.canonical_root,
			owner,
		);
		db.query("INSERT INTO control_run_contracts (project_id, run_id, gates_json, execution_policy, check_command_json, diagnostic_evidence_json) VALUES (?, ?, ?, ?, ?, ?)")
			.run(projectId, id, JSON.stringify(gates), policy ?? null, command ? JSON.stringify(command) : null, diagnosticEvidence ? JSON.stringify(diagnosticEvidence) : null);
		return { ok: true, runId: id, projectId, cwd: project.canonical_root, requiredGates: gates, ...(policy ? { executionPolicy: policy, checkCommand: command, ...(diagnosticEvidence ? { diagnosticEvidence } : {}) } : {}) };
		});
	}

	if (action === "run_check") {
		const runId = requireOpaqueId(need(input.runId, "runId"), "runId");
		const idempotencyKey = safeOutboxId(need(input.idempotencyKey, "idempotencyKey"));
		const contract = runContract(db, projectId, runId);
		if (!contract || contract.execution_policy !== "integration-v1" || !contract.check_command_json) fail("INTEGRATION_POLICY_REQUIRED", runId);
		let command: string[];
		try { command = frozenCheckCommand(JSON.parse(contract.check_command_json)); } catch (error) { if (error instanceof ControlError) throw error; fail("INTEGRATION_CONTRACT", runId); }
		const generation = genOf(db, projectId);
		let diagnosticPolicy: DiagnosticEvidencePolicy | undefined;
		try { diagnosticPolicy = contract.diagnostic_evidence_json ? frozenDiagnosticEvidence(JSON.parse(contract.diagnostic_evidence_json), project.canonical_root) : undefined; }
		catch (error) { if (error instanceof ControlError) throw error; fail("INTEGRATION_CONTRACT", runId); }
		const key = integrationCheckKey(runId, idempotencyKey);
		const requestSha = sha256(JSON.stringify({ runId, generation, idempotencyKey, command }));
		const prior = taskReceipt(db, projectId, key);
		if (prior) {
			if (prior.request_sha !== requestSha) fail("TASK_CONFLICT", idempotencyKey);
			return { ok: prior.state === "succeeded", duplicate: true, productComplete: false, ...publicReceipt(prior) };
		}
		const diagnosticPaths = diagnosticPolicy ? frozenDiagnosticPaths(diagnosticPolicy, project, runId, generation, key, true) : undefined;
		const diagnosticPin = diagnosticPolicy ? pinDiagnosticDirectory(diagnosticPolicy, project.canonical_root) : undefined;
		try {
		const existing = db.query<TaskReceipt, [string, string, number, string]>(
			"SELECT * FROM control_tasks WHERE project_id=? AND run_id=? AND generation=? AND gate=? ORDER BY updated_at DESC,rowid DESC LIMIT 1",
		).get(projectId, runId, generation, INTEGRATION_GATE);
		if (existing) fail("CHECK_ALREADY_SETTLED", runId);
		const lock = mergeLockForProject(db, projectId);
		if (lock && !(lock.state === "candidate_ready" && lock.candidate_project_id === projectId && lock.candidate_run_id === runId && lock.candidate_owner === owner && lock.candidate_generation === generation)) {
			fail("MERGE_LOCKED", lock.attempt_id);
		}
		const unsettled = db.query<{ task_key: string }, [string]>("SELECT task_key FROM control_tasks WHERE project_id=? AND state IN ('running','interrupted') LIMIT 1").get(projectId);
		if (unsettled) fail("UNSETTLED_TASK", unsettled.task_key);
		if (host.signal?.aborted) fail("ABORTED", "run_check cancelled before launch");
		gitClean(project.canonical_root);
		const beforeFingerprint = sourceFingerprint(project.canonical_root);
		const token = `integration-check-${key}`;
		reserveWorkspace(db, project.canonical_root, owner, token, runId);
		try {
			txn(db, () => {
				if (genOf(db, projectId) !== generation || sourceFingerprint(project.canonical_root) !== beforeFingerprint) fail("STALE_FENCE", runId);
				if (taskReceipt(db, projectId, key)) fail("TASK_CONFLICT", idempotencyKey);
				db.query("INSERT INTO control_tasks (project_id,task_key,run_id,generation,request_sha,agent,agent_id,gate,state,updated_at,runtime_id,runtime_pid,heartbeat_at) VALUES (?,?,?,?,?,?,?,?,'running',?,?,?,?)")
					.run(projectId, key, runId, generation, requestSha, "controller", key, INTEGRATION_GATE, Date.now(), runtimeInstance, process.pid, Date.now());
			});
		} catch (error) { releaseWorkspace(db, owner, token); throw error; }

		let cancellation: "cancelled" | "timeout" | undefined;
		let cancelOutput = () => {};
		let proc: ReturnType<typeof Bun.spawn> | undefined;
		const startedAt = Date.now();
		const cancel = (reason: "cancelled" | "timeout") => {
			if (cancellation) return;
			cancellation = reason;
			cancelOutput();
			try { proc?.kill(); } catch { /* The process may already have exited. */ }
		};
		const abort = () => cancel("cancelled");
		host.signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(() => cancel("timeout"), testCheckTimeoutMs ?? CHECK_TIMEOUT_MS);
		timeout.unref();
		let exitCode: number | null = null;
		let stdout: ProcessOutput = { bytes: 0, sha256: sha256(""), displayLimitBytes: CHECK_OUTPUT_LIMIT, exceedsDisplayLimit: false, streamError: false, contentOmitted: true, rawGap: false, rawGapBytes: 0, sanitizedBytes: 0, sanitizedRetainedBytes: 0, redactions: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0), gap: false, gapBytes: 0 };
		let stderr: ProcessOutput = { bytes: 0, sha256: sha256(""), displayLimitBytes: CHECK_OUTPUT_LIMIT, exceedsDisplayLimit: false, streamError: false, contentOmitted: true, rawGap: false, rawGapBytes: 0, sanitizedBytes: 0, sanitizedRetainedBytes: 0, redactions: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0), gap: false, gapBytes: 0 };
		let launchError: { category: "launch"; name: string; code: string | null } | undefined;
		try {
			await withProjectPin(project, async root => {
				assertHeldIdentity(root, project);
				if (cancellation || host.signal?.aborted) { cancel("cancelled"); return; }
				const child = Bun.spawn({ cmd: command, cwd: root.finalPath, stdout: "pipe", stderr: "pipe", ...(testCheckEnvironment ? { env: { ...process.env, ...testCheckEnvironment } } : {}) });
				proc = child;
				if (cancellation) { try { child.kill(); } catch { /* The child may already have exited. */ } }
				const outputs = [
					boundedProcessOutput(child.stdout, CHECK_OUTPUT_LIMIT, fn => { cancelOutput = fn; }),
					boundedProcessOutput(child.stderr, CHECK_OUTPUT_LIMIT, fn => { const earlier = cancelOutput; cancelOutput = () => { earlier(); fn(); }; }),
				];
				exitCode = await child.exited;
				[stdout, stderr] = await Promise.all(outputs);
			});
		} catch (error) {
			launchError = launchFailure(error);
		} finally {
			clearTimeout(timeout);
			host.signal?.removeEventListener("abort", abort);
		}
		let afterFingerprint: string | null = null;
		let stale = false;
		try { afterFingerprint = sourceFingerprint(project.canonical_root); stale = afterFingerprint !== beforeFingerprint || genOf(db, projectId) !== generation; } catch { stale = true; }
		const processPassed = !cancellation && !launchError && exitCode === 0 && !stale;
		const diagnosticEvidence = diagnosticPaths && diagnosticPin && diagnosticPolicy ? writeDiagnosticEvidence(diagnosticPin, diagnosticPolicy, diagnosticPaths, {
			schema: "omp-check-diagnostic/v1", runId, generation, taskKey: key, commandSha256: sha256(JSON.stringify(command)), cwd: project.canonical_root,
			beforeFingerprint, afterFingerprint, process: { exitCode, cancellation: cancellation ?? null, stale, launchError: launchError ?? null },
			outputs: { stdout: outputMetadata(stdout), stderr: outputMetadata(stderr) },
			sanitizedSummary: { stdout: sanitizedOutputSummary(stdout), stderr: sanitizedOutputSummary(stderr) },
		}, { stdout, stderr }) : undefined;
		const evidenceComplete = !diagnosticPolicy || !!diagnosticEvidence && ["available", "truncated"].includes(diagnosticEvidence.status) && !diagnosticEvidence.missing &&
			!stdout.streamError && !stderr.streamError;
		const passed = processPassed && evidenceComplete;
		const result = {
			integrationCheck: {
				status: passed ? "PASS" : "FAIL", runId, generation, command, cwd: project.canonical_root,
				beforeFingerprint, afterFingerprint, exitCode, cancellation: cancellation ?? null, stale,
				startedAt, finishedAt: Date.now(), environment: checkEnvironment(project.canonical_root, command),
				process: { status: processPassed ? "passed" : cancellation ? "interrupted" : "failed", exitCode, cancellation: cancellation ?? null, stale, ...(launchError ? { launchError } : {}) },
				stdout: outputMetadata(stdout), stderr: outputMetadata(stderr), ...(diagnosticEvidence ? { diagnosticEvidence } : {}), ...(launchError ? { launchError } : {}),
			},
			sourceFingerprint: passed ? beforeFingerprint : null,
		};
		const state = passed ? "succeeded" : cancellation ? "interrupted" : "failed";
		txn(db, () => {
			db.query("UPDATE control_tasks SET state=?,result_json=?,updated_at=?,heartbeat_at=? WHERE project_id=? AND task_key=? AND state='running' AND runtime_id=?")
				.run(state, JSON.stringify(result), Date.now(), Date.now(), projectId, key, runtimeInstance);
			db.query("INSERT INTO events(project_id,run_id,type,payload_sha,created_at) VALUES (?,?,'integration_check',?,?)")
				.run(projectId, runId, sha256(JSON.stringify(result.integrationCheck)), Date.now());
		});
		// Cancellation/timeout cannot establish that spawned descendants have stopped. Keep
		// cooperative occupancy until explicit reconciliation instead of permitting a retry.
		if (!cancellation) releaseWorkspace(db, owner, token);
		return { ok: passed, taskKey: key, runId, generation, state, productComplete: false, result: result.integrationCheck };
		} finally {
			if (diagnosticPin) releaseDiagnosticPin(diagnosticPin);
		}
	}

	if (["baseline_capture", "lease_acquire", "safe_write", "generation_advance"].includes(action)) {
		assertNoForeignUnsettled(db, projectId, input.runId!);
		if (workspaceWriters(db, project.canonical_root).some(row => row.owner !== owner || row.runtime_id !== runtimeInstance)) fail("WORKSPACE_BUSY", projectId);
	}
	if (["baseline_capture", "safe_write"].includes(action) || (action === "project_spawn" && !READ_ONLY_CODING_AGENTS.has(input.agent ?? ""))) {
		if (db.query("SELECT id FROM control_recoveries WHERE project_id=? AND generation=? LIMIT 1").get(projectId, genOf(db, projectId))) fail("RECOVERY_GENERATION_REQUIRED", projectId);
	}

	if (action === "task_observe") {
		const key = safeOutboxId(need(input.idempotencyKey, "idempotencyKey"));
		return observeTask(() => {
			const row = taskReceipt(db, projectId, key);
			if (!row) fail("NOT_FOUND", "task");
			requireTaskOwner(db, project, row, owner);
			return row;
		}, input, host.signal);
	}
	if (action === "task_get") {
		if (input.idempotencyKey) {
			const row = taskReceipt(db, projectId, safeOutboxId(input.idempotencyKey));
			if (!row) fail("NOT_FOUND", "task");
			requireTaskOwner(db, project, row, owner);
			return { ok: true, ...publicReceipt(row) };
		}
		const runId = requireOpaqueId(need(input.runId, "runId"), "runId");
		requireRunOwner(db, projectId, runId, owner);
		const rows = db.query<TaskReceipt, [string, string, number]>(
			"SELECT * FROM control_tasks WHERE project_id = ? AND run_id = ? ORDER BY updated_at DESC LIMIT ?").all(projectId, runId, Math.min(input.limit ?? 20, 100));
		return { ok: true, tasks: rows.map(publicReceipt) };
	}
	if (action === "task_reconcile") {
		const key = safeOutboxId(need(input.idempotencyKey, "idempotencyKey"));
		const evidenceKey = safeOutboxId(need(input.evidenceTaskKey, "evidenceTaskKey"));
		return txn(db, () => {
			const target = taskReceipt(db, projectId, key);
			const evidence = taskReceipt(db, projectId, evidenceKey);
			if (!target || !evidence) fail("NOT_FOUND", "task receipt");
			requireTaskOwner(db, project, target, owner);
			requireTaskOwner(db, project, evidence, owner);
			if (target.run_id !== input.runId) fail("RUN_PROJECT", input.runId!);
			if (taskMayBeActive(target)) fail("TASK_ACTIVE", key);
			if (!["running", "interrupted", "failed"].includes(target.state)) fail("INVALID", "task is already settled");
			const targetResult = target.result_json ? JSON.parse(target.result_json) : {};
			const priorRecoveryId = targetResult?.reconciliation?.id;
			const priorRecovery = typeof priorRecoveryId === "string"
				? db.query<{ id: string; generation: number }, [string, string, string, string]>("SELECT id,generation FROM control_recoveries WHERE id=? AND project_id=? AND task_key=? AND run_id=?").get(priorRecoveryId, projectId, key, target.run_id ?? "")
				: undefined;
			if (priorRecovery) {
				return { ok: true, taskKey: key, recoveryId: priorRecovery.id, state: "failed", reconciled: true, alreadySettled: true, taskComplete: false, requiresNewGeneration: priorRecovery.generation === genOf(db, projectId) };
			}
			const evidenceResult = evidence.result_json ? JSON.parse(evidence.result_json) : undefined;
			const proof = evidenceResult?.structuredOutput;
			const data = proof?.data;
			const currentSource = sourceFingerprint(project.canonical_root);
			if (evidence.agent !== "verifier" || evidence.state !== "succeeded" || evidence.run_id !== target.run_id || !target.run_id ||
				evidence.generation !== genOf(db, projectId) || proof?.status !== "valid" || data?.status !== "PASS" ||
				data?.generation !== String(evidence.generation) || data?.runId !== target.run_id ||
				data?.reconcilesTaskKey !== key || data?.processesStopped !== true || data?.sideEffectsKnown !== true ||
				!Array.isArray(data?.findings) || data.findings.length !== 0 || !Array.isArray(data?.evidence) || data.evidence.length === 0 ||
				!data.evidence.every((ref: unknown) => typeof ref === "string" && ref.trim().length > 0) ||
				!evidenceResult?.sourceFingerprint || evidenceResult.sourceFingerprint !== currentSource) {
				fail("RECONCILIATION_REQUIRED", key);
			}
			const recoveryId = crypto.randomUUID();
			const recoveryEvidence = JSON.stringify({ evidenceTaskKey: evidenceKey, sourceFingerprint: currentSource });
			db.query("INSERT INTO control_recoveries(id,project_id,task_key,run_id,confirmed_by,evidence,previous_state,previous_runtime_id,created_at,generation) VALUES(?,?,?,?,?,?,?,?,?,?)")
				.run(recoveryId, projectId, key, target.run_id, owner, recoveryEvidence, target.state, target.runtime_id ?? null, Date.now(), genOf(db, projectId));
			const result = { ...targetResult, reconciliation: { id: recoveryId, evidenceTaskKey: evidenceKey, generation: evidence.generation, sourceFingerprint: currentSource } };
			db.query("UPDATE control_tasks SET state = 'failed', result_json = ?, updated_at = ? WHERE project_id = ? AND task_key = ?")
				.run(JSON.stringify(result), Date.now(), projectId, key);
			return { ok: true, taskKey: key, recoveryId, state: "failed", reconciled: true, taskComplete: false, requiresNewGeneration: true };
		});
	}
	if (action === "run_status" || action === "run_complete") {
		const runId = requireOpaqueId(need(input.runId, "runId"), "runId");
		if (!db.query("SELECT id FROM runs WHERE project_id = ? AND id = ?").get(projectId, runId)) fail("RUN_PROJECT", runId);
		const completion = completionStatus(db, projectId, runId);
		return { ok: action === "run_status" || completion.taskComplete === true, projectId, runId, ...completion };
	}

	if (action === "baseline_capture") {
		if (listLeases(db, projectId).some(row => isLive(row, genOf(db, projectId)) && (row.owner !== owner || row.run_id !== input.runId))) fail("LEASE_HELD", projectId);
		const dest = path.join(project.canonical_root, ".omp", "baseline.json");
		const body = Buffer.from(
			JSON.stringify({
				schema: "omp-control-baseline/v1",
				capturedAt: new Date().toISOString(),
				projectId,
				canonicalRoot: project.canonical_root,
				generation: genOf(db, projectId),
			}),
			"utf8",
		);
		return txn(db, () => {
			if (mergeLockForProject(db, projectId)) fail("MERGE_LOCKED", projectId);
			if (testAfterPin) testAfterPin();
			return withRootHandle(project, root => {
				const wrote = replaceViaHandles(dest, body, root, null);
				return { ok: true, path: wrote.destReal, sha: wrote.sha };
			});
		});
	}

	if (action === "generation_get") {
		return { ok: true, projectId, generation: genOf(db, projectId) };
	}


	if (action === "generation_advance") {
		const token = need(input.token, "token");
		return txn(db, () => {
			const gen = genOf(db, projectId);
			liveLease(readLease(db, projectId, "*"), gen, token, owner, input.runId!);
			if (db.query("SELECT task_key FROM control_tasks WHERE project_id = ? AND state IN ('running','interrupted') LIMIT 1").get(projectId)) fail("UNSETTLED_TASK", "generation advance requires all executions settled");
			const next = gen + 1;
			db.query("UPDATE generations SET value = ? WHERE project_id = ?").run(next, projectId);
			db.query("DELETE FROM leases WHERE project_id = ? AND resource = ?").run(projectId, "*");
			return { ok: true, projectId, generation: next };
		});
	}

	if (action === "lease_acquire") {
		const resource = normalizeResource(project.canonical_root, input.resource === undefined ? "*" : input.resource);
		const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS;
		return txn(db, () => {
			const gen = genOf(db, projectId);
			assertNoForeignUnsettled(db, projectId, input.runId!);
			const live = listLeases(db, projectId).filter(row => isLive(row, gen));
			const hit = live.find(row => scopesOverlap(row.resource, resource));
			if (hit) fail("LEASE_HELD", `owner=${hit.owner} resource=${hit.resource}`);
			const token = crypto.randomBytes(16).toString("hex");
			const expiresAt = Date.now() + ttlMs;
			db.query(
				`INSERT INTO leases (project_id, resource, owner, token, generation, expires_at, run_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(project_id, resource) DO UPDATE SET
				 	owner = excluded.owner,
				 	token = excluded.token,
				 	generation = excluded.generation,
				 	expires_at = excluded.expires_at, run_id = excluded.run_id`,
			).run(projectId, resource, owner, token, gen, expiresAt, input.runId!);
			return { ok: true, projectId, resource, owner, token, generation: gen, expiresAt };
		});
	}

	if (action === "lease_renew") {
		const resource = normalizeResource(project.canonical_root, need(input.resource, "resource"));
		const token = need(input.token, "token");
		const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS;
		return txn(db, () => {
			const gen = genOf(db, projectId);
			liveLease(readLease(db, projectId, resource), gen, token, owner, input.runId!);
			const expiresAt = Date.now() + ttlMs;
			db.query("UPDATE leases SET expires_at = ? WHERE project_id = ? AND resource = ?").run(expiresAt, projectId, resource);
			return { ok: true, projectId, resource, generation: gen, expiresAt };
		});
	}

	if (action === "lease_release") {
		const resource = normalizeResource(project.canonical_root, need(input.resource, "resource"));
		const token = need(input.token, "token");
		return txn(db, () => {
			const gen = genOf(db, projectId);
			liveLease(readLease(db, projectId, resource), gen, token, owner, input.runId!);
			db.query("DELETE FROM leases WHERE project_id = ? AND resource = ?").run(projectId, resource);
			return { ok: true, projectId, resource };
		});
	}

	if (action === "safe_write") {
		const rel = need(input.path, "path");
		const token = need(input.token, "token");
		if (input.baseSha === undefined) fail("INVALID", "missing baseSha");
		const bytes = Buffer.from(input.content ?? "", "utf8");
		return txn(db, () => {
			if (mergeLockForProject(db, projectId)) fail("MERGE_LOCKED", projectId);
			const pinned = pinProject(getProject(db, projectId));
			validateWriteRel(pinned.canonical_root, rel);
			const dest = resolveInProject(pinned, rel);

			const resource = normalizeResource(
				pinned.canonical_root,
				input.resource === undefined ? "*" : input.resource,
			);
			const gen = genOf(db, projectId);
			const lease = liveLease(readLease(db, projectId, resource), gen, token, owner, input.runId!);
			leaseCovers(pinned.canonical_root, lease, dest);
			if (testAfterPin) testAfterPin();
			return withRootHandle(pinned, root => {
				const wrote = replaceViaHandles(dest, bytes, root, input.baseSha, () => {
					const gen2 = genOf(db, projectId);
					liveLease(readLease(db, projectId, resource), gen2, token, owner, input.runId!);
					if (gen2 !== gen) fail("STALE_FENCE", "generation changed");
				});
				return { ok: true, path: wrote.destReal, sha: wrote.sha };
			});
		});
	}

	if (action === "event_append") {
		const type = need(input.type, "type");
		const payloadSha = sha256(input.payload ?? "");
		if (input.runId) {
			const runId = requireOpaqueId(input.runId, "runId");
			const run = db
				.query<{ id: string }, [string, string]>("SELECT id FROM runs WHERE id = ? AND project_id = ?")
				.get(runId, projectId);
			if (!run) fail("RUN_PROJECT", runId);
		}
		const info = db
			.query("INSERT INTO events (project_id, run_id, type, payload_sha, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(projectId, input.runId ?? null, type, payloadSha, Date.now());
		return { ok: true, eventId: Number(info.lastInsertRowid), projectId, payloadSha };
	}

	if (action === "outbox_enqueue") {
		const id = safeOutboxId(need(input.id, "id"));
		const body = input.payload ?? "";
		const payloadSha = sha256(body);
		return txn(db, () => {
			const existing = db
				.query<OutboxRow, [string, string]>(
					"SELECT project_id, id, run_id, payload_sha, status, claim_token, attempts, claimed_at, created_at FROM outbox WHERE project_id = ? AND id = ?",
				)
				.get(projectId, id);
			if (existing) {
				if (existing.run_id ? existing.run_id !== input.runId : project.owner !== owner) fail("RUN_OWNER_MISMATCH", id);
				if (existing.payload_sha !== payloadSha) fail("OUTBOX_CONFLICT", id);
				return { ok: true, id, duplicate: true, status: existing.status, payloadSha };
			}
			db.query(
				"INSERT INTO outbox (project_id, id, payload_sha, status, attempts, created_at, run_id) VALUES (?, ?, ?, 'pending', 0, ?, ?)",
			).run(projectId, id, payloadSha, Date.now(), input.runId!);
			return { ok: true, id, duplicate: false, status: "pending", payloadSha };
		});
	}

	if (action === "outbox_drain") {
		const limit = input.limit && input.limit > 0 ? input.limit : 10;
		const key = input.idempotencyKey || input.id;
		return txn(db, () => {
			const staleBefore = Date.now() - OUTBOX_CLAIM_MS;
			const rows = key
				? db
						.query<OutboxRow, [string, string, number]>(
							`SELECT project_id, id, run_id, payload_sha, status, claim_token, attempts, claimed_at, created_at FROM outbox
							 WHERE project_id = ? AND id = ? AND status != 'quarantine' AND (status = 'pending' OR (status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?))`,
						)
						.all(projectId, safeOutboxId(key), staleBefore)
				: db
						.query<OutboxRow, [string, number, string, number, number]>(
							`SELECT project_id, id, run_id, payload_sha, status, claim_token, attempts, claimed_at, created_at FROM outbox
							 WHERE project_id = ? AND status != 'quarantine' AND (status = 'pending' OR (status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?))
							 AND (run_id = ? OR (run_id IS NULL AND ? = 1))
							 ORDER BY created_at ASC LIMIT ?`,
						)
						.all(projectId, staleBefore, input.runId!, project.owner === owner ? 1 : 0, limit);
			const claimedAt = Date.now();
			const items = [];
			for (const row of rows) {
				if (row.run_id ? row.run_id !== input.runId : project.owner !== owner) continue;
				const claimToken = crypto.randomBytes(16).toString("hex");
				db.query(
					"UPDATE outbox SET status = 'claimed', claim_token = ?, claimed_at = ?, attempts = attempts + 1 WHERE project_id = ? AND id = ?",
				).run(claimToken, claimedAt, projectId, row.id);
				items.push({ id: row.id, claimToken, attempts: row.attempts + 1, payloadSha: row.payload_sha });
			}
			return { ok: true, items };
		});
	}

	if (action === "outbox_ack") {
		const id = need(input.id, "id");
		const claimToken = need(input.claimToken, "claimToken");
		return txn(db, () => {
			const row = db
				.query<OutboxRow, [string, string]>(
					"SELECT project_id, id, run_id, payload_sha, status, claim_token, attempts, claimed_at, created_at FROM outbox WHERE project_id = ? AND id = ?",
				)
				.get(projectId, id);
			if (!row) fail("NOT_FOUND", id);
			if (row.run_id ? row.run_id !== input.runId : project.owner !== owner) fail("RUN_OWNER_MISMATCH", id);
			if (row.status === "quarantine" || row.payload_sha === "NOT_MIGRATED") fail("NOT_MIGRATED", id);
			if (row.status === "pending") fail("NOT_CLAIMED", id);
			if (row.claim_token !== claimToken) fail("STALE_CLAIM", id);
			if (row.status === "acked") return { ok: true, id, duplicate: true, status: "acked" };
			db.query("UPDATE outbox SET status = 'acked' WHERE project_id = ? AND id = ?").run(projectId, id);
			return { ok: true, id, duplicate: false, status: "acked" };
		});
	}

	if (action === "project_spawn") {
		if (!READ_ONLY_CODING_AGENTS.has(input.agent ?? "")) assertNoForeignUnsettled(db, projectId, input.runId!);
		if (host.signal?.aborted) fail("ABORTED", "project_spawn cancelled before start");
		const task = need(input.task, "task");
		const agentName = need(input.agent, "agent");
		assertPlainJsonSchema(input.outputSchema);
		const agent = await resolveCodingAgent(project.canonical_root, agentName);
		const runId = input.runId ? requireOpaqueId(input.runId, "runId") : undefined;
		if (runId && !db.query<{ id: string }, [string, string]>("SELECT id FROM runs WHERE id = ? AND project_id = ?").get(runId, projectId)) {
			fail("RUN_PROJECT", runId);
		}
		if (input.gate && (!runId || GATE_AGENTS[input.gate] !== agentName)) fail("INVALID", "gate agent/run");
		const taskKey = safeOutboxId(input.idempotencyKey ?? crypto.randomUUID());
		const generation = genOf(db, projectId);
		const binding = !READ_ONLY_CODING_AGENTS.has(agentName) ? activeGraphBinding(db, projectId) : undefined;
		const repositoryBinding = !READ_ONLY_CODING_AGENTS.has(agentName) ? activeGraphInRepository(db, project) : undefined;
		if (binding) {
			if (input.graphId !== binding.graph_id || input.taskId !== binding.task_id || input.claimToken !== binding.claim_token ||
				binding.run_id !== runId || binding.owner !== owner || binding.generation !== generation || binding.author_task_key !== taskKey) fail("TASK_CLAIM_REQUIRED", taskKey);
			if (binding.state !== "claimed") fail("TASK_CLAIMED", binding.task_id);
			if (gitBranch(project.canonical_root) !== binding.branch || gitHead(project.canonical_root) !== binding.claim_head) fail("TASK_GRAPH_BRANCH", binding.task_id);
			gitClean(project.canonical_root);
			for (const scope of graphPaths(binding)) liveLease(readLease(db, projectId, scope), generation, binding.claim_token!, owner, runId!);
		} else if (!READ_ONLY_CODING_AGENTS.has(agentName) && (repositoryBinding || input.graphId || input.taskId || input.claimToken)) {
			fail("TASK_CLAIM_REQUIRED", taskKey);
		}
		const requestSha = sha256(JSON.stringify({ task, agentName, runId, generation, gate: input.gate, schema: input.outputSchema, graphId: input.graphId, taskId: input.taskId }));
		const prior = taskReceipt(db, projectId, taskKey);
		if (prior) {
			requireTaskOwner(db, project, prior, owner);
			if (prior.request_sha !== requestSha) fail("TASK_CONFLICT", taskKey);
			return { ok: prior.state === "succeeded", duplicate: true, ...publicReceipt(prior) };
		}
		const agentId = crypto.randomUUID();
		const reviewedSource = input.gate || agentName === "verifier" ? sourceFingerprint(project.canonical_root) : undefined;
		const assignedTask = `${task}\n\n# Control-provided execution context\n${JSON.stringify({
			projectId, runId, generation: String(generation), taskId: taskKey, attemptId: agentId,
			contractVersion: "omp-task/v1", controllerPid: process.pid,
		})}\nUse these exact identifiers in the requested output schema. Do not call root-only control tools to rediscover them. The controller PID belongs to OMP, not a task worker; never use it as proof that a worker is alive or as a process-termination target.\n`;
		const artifactsDir = path.join(path.dirname(dbFile), "sessions", "control", projectId, runId ?? "unbound");
		const sessionFile = path.join(artifactsDir, `${agentId}.jsonl`);
			txn(db, () => {
			if (!READ_ONLY_CODING_AGENTS.has(agentName)) testBeforeMergeAdmission?.();
			if (!READ_ONLY_CODING_AGENTS.has(agentName) && mergeLockForProject(db, projectId)) fail("MERGE_LOCKED", taskKey);
			if (!READ_ONLY_CODING_AGENTS.has(agentName)) assertNoForeignUnsettled(db, projectId, input.runId!);
			if (!READ_ONLY_CODING_AGENTS.has(agentName)) {
				const nowBinding = activeGraphBinding(db, projectId);
				const nowRepositoryBinding = activeGraphInRepository(db, project);
				if (binding) {
					if (!nowBinding || nowBinding.graph_id !== binding.graph_id || nowBinding.task_id !== binding.task_id || nowBinding.state !== "claimed" || nowBinding.claim_token !== binding.claim_token || nowBinding.author_task_key !== taskKey) fail("TASK_CLAIM_REQUIRED", taskKey);
				} else if (nowRepositoryBinding) fail("TASK_CLAIM_REQUIRED", taskKey);
			}
			if (binding) {
				const moved = db.query("UPDATE task_graph_nodes SET state='running',updated_at=? WHERE graph_id=? AND task_id=? AND state='claimed' AND claim_token=? AND project_id=? AND run_id=? AND generation=?")
					.run(Date.now(), binding.graph_id, binding.task_id, binding.claim_token, projectId, runId, generation);
				if (Number(moved.changes) !== 1) fail("TASK_CLAIMED", binding.task_id);
			}
			reserveWorkspace(db, project.canonical_root, owner, agentId, runId);
			db.query("INSERT INTO control_tasks (project_id, task_key, run_id, generation, request_sha, agent, agent_id, gate, state, updated_at, runtime_id, runtime_pid, heartbeat_at, session_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
				.run(projectId, taskKey, runId ?? null, generation, requestSha, agentName, agentId, input.gate ?? null, Date.now(), runtimeInstance, process.pid, Date.now(), sessionFile);
		});
		const executionHeartbeat = setInterval(() => {
			try { db.query("UPDATE control_tasks SET heartbeat_at=? WHERE project_id=? AND task_key=? AND runtime_id=? AND state='running'").run(Date.now(), projectId, taskKey, runtimeInstance); }
			catch { /* An unavailable DB is not evidence that execution stopped. */ }
		}, 5000);
		executionHeartbeat.unref();
		let finalResult: unknown;
		let state = "interrupted";
		activeControlTasks.add(agentId);
		try {
		if (testAfterPin) testAfterPin();
		const outcome = await withProjectPin(project, async root => {
			if (driveOf(root.finalPath) !== "D") fail("NOT_D_ROOT", project.id);
			assertHeldIdentity(root, project);
			if (!host.runSubprocess) fail("NO_SUBPROCESS", "runSubprocess unavailable");
			const heartbeat = startLeaseHeartbeat(db, projectId, owner, runId!, host.signal);
			try {
				const settings = await effectiveSpawnSettings(host, root.finalPath);
				if (heartbeat.signal.aborted) fail("ABORTED", "project_spawn cancelled before launch");
				const overrides = (settings.get("task.agentModelOverrides") ?? {}) as Record<string, string | string[] | undefined>;
				const selection = resolveAgentModelSelection({
					settingsOverride: overrides[agent.name],
					agentModel: agent.model,
					settings,
					activeModelPattern: host.parentActiveModelPattern,
				});
				const result = await guardedSubprocess(async options => {
                    const result = await host.runSubprocess!(options);
                    if (!result || typeof result !== "object") throw new Error("Invalid native subprocess result");
                    return result;
                }, {
					cwd: root.finalPath,
					agent,
					task: assignedTask,
					outputSchema: input.outputSchema,
					outputSchemaMode: "strict",
					index: 0,
					id: agentId,
                    eventBus: host.eventBus,
                    parentAgentId: host.parentAgentId,
					// Persist at the runtime's official session location, never a temporary in-memory session.
					artifactsDir,
					settings,
					modelOverride: selection.patterns,
					modelRole: selection.role,
					thinkingLevel: agent.thinkingLevel,
					modelRegistry: host.modelRegistry,
					parentActiveModelPattern: host.parentActiveModelPattern,
						signal: heartbeat.signal,
					onProgress: host.onProgress,
				});
				finalResult = result;
				if (heartbeat.signal.aborted) fail("ABORTED", "project_spawn cancelled during execution");
				if (subprocessFailed(result)) return { ok: false, cwd: root.finalPath, runId, generation: heartbeat.generation, result };
				return { ok: true, cwd: root.finalPath, runId, generation: heartbeat.generation, result };
			} finally {
				heartbeat.stop();
			}
		});
		state = outcome.ok ? "succeeded" : (finalResult as { aborted?: boolean } | undefined)?.aborted ? "interrupted" : "failed";
		return { ...outcome, taskKey, agentId, state };
		} finally {
			clearInterval(executionHeartbeat);
			activeControlTasks.delete(agentId);
			// Store before returning to the agent loop, which may suppress the tool result on steering.
			// Keep structured completion once, not duplicated raw transcript/thinking or tool arguments.
			const result = finalResult && typeof finalResult === "object" ? finalResult as Record<string, unknown> : {};
			let acceptedSource: string | undefined;
			try { if (reviewedSource && reviewedSource === sourceFingerprint(project.canonical_root)) acceptedSource = reviewedSource; } catch { /* Persist failure/staleness even when the source disappears. */ }
			const compact = JSON.stringify({ exitCode: result.exitCode, aborted: result.aborted,
				taskHealth: result.taskHealth, structuredOutput: result.structuredOutput, sessionFile, sessionRetained: fs.existsSync(sessionFile), requests: result.requests,
				sourceFingerprint: acceptedSource });
			const receipt = Buffer.byteLength(compact) <= 524288 ? compact : JSON.stringify({ receiptTruncated: true, sessionFile });
			const saved = db.query("UPDATE control_tasks SET state = ?, result_json = ?, updated_at = ?, heartbeat_at = ? WHERE project_id = ? AND task_key = ? AND runtime_id = ? AND state = 'running'")
				.run(state, receipt, Date.now(), Date.now(), projectId, taskKey, runtimeInstance);
			if (Number(saved.changes) !== 1) fail("TASK_SUPERSEDED", taskKey);
			releaseWorkspace(db, owner, agentId);
		}
	}

	fail("INVALID", action);
}

export default function ompControl(pi: ExtensionAPI) {
	openControlDbAt(controlDbPath());
	const held = new Map<string, Set<string>>();
	const isChild = (ctx: any) => ctx.sessionManager.getEntries().some((entry: any) => entry.type === "session_init");
	// Hold the workspace across a root turn and any background jobs; reads remain available on conflict.
	pi.on?.("tool_call", (event, ctx) => {
		if (isChild(ctx) || ["read", "grep", "glob", "find", "ls", "todo", "ask", "web_search", "web_fetch", "web_research_v1", "omp_research_evidence", "omp_control", "omp_checkpoint", "omp_archive", "hub"].includes(event.toolName)) return;
		if (event.toolName === "write" && typeof event.input.path === "string" && event.input.path.startsWith("xd://")) return;
		// Exempt only literal version probes; never treat arbitrary shell as read-only.
		if (event.toolName === "bash" && typeof event.input.command === "string" &&
			/^(?:node --version|pnpm --version|git --version|docker --version|docker version --format \{\{\.Server\.Version\}\})(?:\s*&&\s*(?:node --version|pnpm --version|git --version|docker --version|docker version --format \{\{\.Server\.Version\}\}))*$/.test(event.input.command.trim())) return;
		const owner = ctx.sessionManager.getSessionId();
		const targets = new Set<string>();
		const values = [event.input.path, event.input.file_path, ...(Array.isArray(event.input.paths) ? event.input.paths : [])];
		for (const value of values) {
			if (typeof value === "string" && !value.includes("://")) {
				const resolved = path.resolve(ctx.cwd, value);
				targets.add(path.dirname(resolved));
			}
		}
		if (!["edit", "write"].includes(event.toolName) || !targets.size) targets.add(typeof event.input.cwd === "string" ? path.resolve(ctx.cwd, event.input.cwd) : ctx.cwd);
		try {
			const db = openControlDbAt(controlDbPath());
				txn(db, () => {
				const graphContext = [ctx.cwd, ...targets].map(target => graphForGitPath(db, target)).find(Boolean);
				if (graphContext) {
					const own = graphForGitPath(db, ctx.cwd)?.project;
					const ownBinding = own ? activeGraphBinding(db, own.id) : undefined;
					const ownBoundRoot = !!ownBinding && ownBinding.owner === owner && ownBinding.state === "running";
					const ownReceipt = ownBinding?.author_task_key && own ? taskReceipt(db, own.id, ownBinding.author_task_key) : undefined;
					const ownSettled = ownReceipt?.state === "succeeded" && !!own && workspaceWriters(db, own.canonical_root).length === 0;
					const eventRoot = graphForGitPath(db, typeof event.input.cwd === "string" ? path.resolve(ctx.cwd, event.input.cwd) : ctx.cwd)?.project;
					const targetsStayInOwnRoot = !!own && [...targets].every(target => graphForGitPath(db, target)?.project?.id === own.id);
					const shell = typeof event.input.command === "string" ? event.input.command.trim() : "";
					// Only same-cwd Git staging, commit and inspection commands are useful to the claimed author.
					// No chaining, redirection or alternate Git/worktree path is accepted here.
					const ownerGit = ownBoundRoot && ownSettled && eventRoot?.id === own?.id && targetsStayInOwnRoot && event.toolName === "bash" && /^(?:git|git\.exe)\s+(?:add|commit|status|diff|log|rev-parse)\b/i.test(shell) && !/[;&|`$<>\r\n]/.test(shell) && !/(?:\s|^)(?:-C|--git-dir|--work-tree)\b/i.test(shell);
					if (!ownerGit) fail("TASK_CLAIM_REQUIRED", `active graph task ${graphContext.graph.task_id}`);
					return;
				}
				const mergeProject = [ctx.cwd, ...targets].map(target => projectForGitPath(db, target)).find(Boolean);
				const mergeLock = mergeProject ? mergeLockForProject(db, mergeProject.id) : undefined;
				if (mergeLock) fail("MERGE_LOCKED", mergeLock.attempt_id);
				for (const target of targets) {
					const token = `${owner}:${workspaceRoot(target)}`;
					reserveWorkspace(db, target, owner, token);
					const tokens = held.get(owner) ?? new Set<string>(); tokens.add(token); held.set(owner, tokens);
				}
			});
		} catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
	});
	const finishWorkspace = (_event: unknown, ctx: any) => {
		if (isChild(ctx) || ctx.getAsyncJobSnapshot?.()?.running?.length) return;
		const owner = ctx.sessionManager.getSessionId();
		const db = openControlDbAt(controlDbPath());
		for (const token of held.get(owner) ?? []) releaseWorkspace(db, owner, token);
		for (const token of preparedWorkspaceTokens.get(owner) ?? []) releaseWorkspace(db, owner, token);
		preparedWorkspaceTokens.delete(owner);
		held.delete(owner);
	};
	pi.on?.("agent_end", (event, ctx) => { if (!event.willContinue) finishWorkspace(event, ctx); });
	pi.on?.("session_before_switch", (event, ctx) => { if (ctx.isIdle()) finishWorkspace(event, ctx); });
	pi.on?.("session_shutdown", finishWorkspace);
	const z = pi.zod;
	const parameters = z
		.object({
			action: z.enum(ACTIONS).describe("omp_control action"),
			projectId: z.string().min(1).optional(),
			canonicalRoot: z.string().min(1).optional(),
			resource: z.string().min(1).optional(),
			token: z.string().min(1).optional(),
			ttlMs: z.number().int().positive().optional(),
			path: z.string().min(1).optional(),
			content: z.string().optional(),
			baseSha: z.string().optional(),
			type: z.string().min(1).optional(),
			payload: z.string().optional(),
			runId: z.string().min(1).optional(),
			id: z.string().min(1).optional(),
			claimToken: z.string().min(1).optional(),
			idempotencyKey: z.string().min(1).optional(),
			limit: z.number().int().positive().optional(),
			version: z.string().max(64).optional(),
			waitMs: z.number().int().min(0).max(25000).optional(),
			includeResult: z.boolean().optional(),
			agent: z.string().min(1).optional(),
			task: z.string().min(1).optional(),
			outputSchema: z.unknown().optional(),
			risk: z.enum(["mechanical", "standard", "high"]).optional(),
			executionPolicy: z.literal("integration-v1").optional(),
			checkCommand: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
			diagnosticEvidence: z.object({ schema: z.literal("omp-check-diagnostic/v1"), root: z.string().min(1) }).strict().optional(),
			gate: z.enum(Object.keys(GATE_AGENTS) as [string, ...string[]]).optional(),
			evidenceTaskKey: z.string().min(1).optional(),
			graphId: z.string().min(1).optional(),
			taskId: z.string().min(1).optional(),
			graphPlan: z.unknown().optional(),
			cancel: z.boolean().optional(),
		})
		.strict()
		.refine(
			(val: { action: string; id?: string }) =>
				val.id === undefined ||
				val.action === "outbox_enqueue" ||
				val.action === "outbox_drain" ||
				val.action === "outbox_ack",
			{ message: "id not allowed" },
		);


	pi.registerTool({
		name: "omp_control",
		label: "OMP Control",
		description:
			"Unified control plane: project/run/lease/generation, project_spawn, task_get, task_observe (versioned bounded wait; terminal includeResult is repeatable), workspace_status/reconcile, completion and outbox",
		parameters,
		strict: true,
		approval: "write",
		async execute(_id, params, signal, onUpdate, ctx) {
			try {
				const sessionManager = ctx?.sessionManager;
				if (params.action !== "health" && (!sessionManager || typeof sessionManager.getSessionId !== "function")) {
					fail("SESSION_REQUIRED", "session");
				}
				// CustomToolContext deliberately exposes no taskDepth. A task executor
				// always records session_init before its tools run, so this stable
				// session evidence keeps project_spawn root-only instead of forging 0.
				if (params.action !== "health") {
					if (!sessionManager || typeof sessionManager.getEntries !== "function") fail("SESSION_REQUIRED", "session root evidence");
					if (sessionManager.getEntries().some(entry => entry.type === "session_init")) {
						fail("SUBAGENT_FORBIDDEN", "project control is only available to a root session");
					}
				}
				const hostPi = pi.pi;
				const runSubprocess =
					hostPi && typeof hostPi === "object" && "runSubprocess" in hostPi && typeof hostPi.runSubprocess === "function"
						? hostPi.runSubprocess.bind(hostPi)
						: undefined;
				let sessionId: string | undefined;
				if (sessionManager && typeof sessionManager.getSessionId === "function") {
					const raw = String(sessionManager.getSessionId());
					if (raw && raw !== "nosession") sessionId = raw;
				}
				const context = ctx as
					| {
					settings?: RuntimeSettings;
					cwd?: string;
					modelRegistry?: unknown;
					model?: { provider?: unknown; id?: unknown };
				  }
					| undefined;
				const provider = typeof context?.model?.provider === "string" ? context.model.provider : undefined;
				const modelId = typeof context?.model?.id === "string" ? context.model.id : undefined;
				const parentActiveModelPattern = provider && modelId ? `${provider}/${modelId}` : undefined;
				const result = await dispatchAt(controlDbPath(), params, {
					runSubprocess,
                    eventBus: pi.events,
                    parentAgentId: pi.pi.AgentRegistry.global().list().find(ref => ref.kind === "main" && ref.session?.sessionManager.getSessionId() === sessionId)?.id,
					signal,
					sessionId,
					cwd: context?.cwd,
					settings: context?.settings,
					modelRegistry: context?.modelRegistry,
					parentActiveModelPattern,
					onProgress: progress => {
						// Executor progress is not an AgentToolResult. Both direct and XD
						// calls pass updates through the same content-array validator.
						const value = progress as { id?: unknown; status?: unknown; requests?: unknown };
						onUpdate?.({
							content: [{ type: "text", text: `Project agent ${String(value.id ?? "")}: ${String(value.status ?? "running")} (${Number(value.requests ?? 0)} requests)` }],
							details: { progress },
						});
					},
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					details: result,
					...(result.ok === false ? { isError: true } : {}),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const code = err instanceof ControlError ? err.code : "ERROR";
				return {
					content: [{ type: "text" as const, text: message }],
					isError: true,
					details: { error: message, code },
				};
			}
		},
	});

	pi.registerCommand("omp-resume-project", {
		description: "Resume this D: Git project's owning OMP session.",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length > 1) fail("INVALID", "usage: /omp-resume-project [projectId]");
			const sessionId = ctx.sessionManager.getSessionId();
			const resumed = await resumeProjectAt(controlDbPath(), parts[0], {
				cwd: ctx.cwd,
				sessionId: sessionId && sessionId !== "nosession" ? sessionId : undefined,
				listSessions: cwd => SessionManager.list(cwd),
				switchSession: sessionPath => ctx.switchSession(sessionPath),
			});
			ctx.ui.notify(resumed.switched ? `Resumed project ${resumed.projectId}.` : `Already in project ${resumed.projectId}'s owning session.`, "info");
		},
	});
	pi.registerCommand("omp-recover-task", {
		description: "User-confirmed recovery of a stopped task; records failure with audit evidence, never transfers ownership.",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/);
			if (parts.length !== 2) fail("INVALID", "usage: /omp-recover-task <projectId> <taskKey>");
			if (!ctx.hasUI || ctx.sessionManager.getEntries().some(entry => entry.type === "session_init")) fail("USER_CONFIRMATION_REQUIRED", "root interactive session only");
			const result = await recoverTaskAt(controlDbPath(), parts[0], parts[1], {
				cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(),
				confirm: async summary => {
					const confirmed = await ctx.ui.confirm("确认异常任务恢复", summary);
					const evidence = confirmed ? await ctx.ui.input("填写已停止全部 worker、已核对工作区副作用的证据；不要填写凭据") : "";
					return { confirmed: confirmed && evidence !== undefined, evidence: evidence ?? "" };
				},
			});
			ctx.ui.notify(result.cancelled ? "恢复已取消，未更改任务。" : result.alreadySettled
				? "任务已结束，无需再次恢复；核对工作区副作用后继续剩余工作。"
				: "已记录为失败并保存审计；重新核对工作区后推进 generation，再开始写入。", "info");
		},
	});
}
