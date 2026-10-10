import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	closeControlDb,
	ControlError,
	controlDbPath,
	dispatchAt,
	openControlDb as openProductionControlDb,
	openControlDbAt,
	setControlTestDb,
	sha256,
	SYSTEM_DB_PATH,
	withInitializedPreauth,
} from "./omp-control.ts";
import { ambientLabPaths, assertAmbientLabTarget } from "../lib/ambient-lab.ts";


import { Database } from "bun:sqlite";


export { closeControlDb, SYSTEM_DB_PATH };

type ArchiveTestAdapter = {
	file: string;
	bootstrap?: boolean;
	ghUnavailable?: "missing" | "reparse";
	ghExe?: string;
	sentinelSize?: { sizeHigh: number; sizeLow: number };
	forceGitTextSize?: { sizeHigh: number; sizeLow: number };
};

let testAdapter: ArchiveTestAdapter | null = null;
const ambientLab = ambientLabPaths();
export function setArchiveTestAdapter(adapter: ArchiveTestAdapter | null): void {
	if (adapter && path.resolve(adapter.file).toLowerCase() === path.resolve(SYSTEM_DB_PATH).toLowerCase()) {
		fail("PATH_ESCAPE", "test-db");
	}
	testAdapter = adapter;
	if (!adapter) {
		setControlTestDb(null);
		return;
	}
	if (adapter.bootstrap !== false) setControlTestDb(adapter.file);
}
function archiveDbPath(): string {
	return testAdapter?.file ?? controlDbPath();
}
function openControlDb(): Database {
	if (testAdapter) return openControlDbAt(testAdapter.file);
	return openProductionControlDb();
}
function withMemoryPreauth<T>(bytes: Uint8Array, fn: (db: Database) => T): T {
	const db = new Database(bytes, { readonly: true, strict: true });
	try {
		db.run("PRAGMA query_only = ON");
		return fn(db);
	} finally {
		db.close();
	}
}
function withPreauth<T>(fn: (db: Database) => T): T {
	const file = archiveDbPath();
	try {
		return withInitializedPreauth(file, fn);
	} catch (err) {
		const code = err instanceof ControlError || err instanceof ArchiveError ? (err as { code: string }).code : "";
		if (code !== "UNINITIALIZED") throw err;
		if (testAdapter?.bootstrap !== false || !fs.existsSync(file)) fail("UNINITIALIZED", "db");
		return withMemoryPreauth(fs.readFileSync(file), fn);
	}
}



async function dispatchControl(
	input: Parameters<typeof dispatchAt>[1],
	host?: { sessionId?: string },
): Promise<Record<string, unknown>> {
	return dispatchAt(archiveDbPath(), input, host);
}



export const ACTIONS = ["prepare", "verify", "publish", "status"] as const;
export type ArchiveAction = (typeof ACTIONS)[number];

export const CENTRAL_INDEX = "LJC-god/omp-archive-index";
export const DEFAULT_ARCHIVE_ROOT = "D:/OMPData/archives";
export const DEFAULT_INDEX_DIR = "D:/OMPData/github/omp-archive-index";
export const INDEX_ORIGIN_HTTPS = `https://github.com/${CENTRAL_INDEX}.git`;
export const GIT_STDOUT_META_CAP = 1024 * 1024;
export const GIT_STDOUT_PATH_CAP = 16 * 1024 * 1024;
export const GIT_STDOUT_PATCH_CAP = 64 * 1024 * 1024;
export const GIT_STDERR_CAP = 1024 * 1024;
export const GIT_PATH_ENTRY_CAP = 262144;
export const GIT_META_ENTRY_CAP = 65536;
export type GitOutputLimits = {
	stdoutCap: number;
	stderrCap: number;
	entryCap: number;
	sep: number;
};
export function gitOutputLimits(args: string[]): GitOutputLimits {
	const cmd = args[0] || "";
	const z = args.includes("-z");
	const sep = z ? 0 : 10;
	if (cmd === "diff" && args.includes("--binary")) {
		return { stdoutCap: GIT_STDOUT_PATCH_CAP, stderrCap: GIT_STDERR_CAP, entryCap: 0, sep };
	}
	const pathList =
		cmd === "ls-files" ||
		cmd === "ls-tree" ||
		cmd === "grep" ||
		((cmd === "diff" || cmd === "diff-index" || cmd === "diff-files") &&
			(args.includes("--name-only") || args.includes("--name-status") || args.includes("-z")));
	if (pathList) {
		return { stdoutCap: GIT_STDOUT_PATH_CAP, stderrCap: GIT_STDERR_CAP, entryCap: GIT_PATH_ENTRY_CAP, sep };
	}

	return { stdoutCap: GIT_STDOUT_META_CAP, stderrCap: GIT_STDERR_CAP, entryCap: GIT_META_ENTRY_CAP, sep };
}

export function indexMutexName(): string {
	return `Local\\omp-arch-idx-${sha256(INDEX_ORIGIN_HTTPS).slice(0, 24)}`;
}
const WORK_ROOT = path.join(ambientLab?.workRoot ?? "D:/OMPData/worktrees", `run-archiver-${crypto.randomUUID()}`);


const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const GITHUB_OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USERINFO_ANY = /(https?:\/\/)[^@/]+@/gi;
const DENY_NAME =
	/(^|[\\/])(\.env(?:\..+)?|.+\.env|credentials?(?:\.[^\\/]+)?|Cookies|Login Data|passwords?(?:\.[^\\/]+)?|User Data|Profiles?)([\\/]|$)/i;
const LOCAL_PATH_RE = /(?:[A-Za-z]:[\\/]|\/(?:home|Users|root)\/|\\\\[A-Za-z0-9._-]+[\\/])/g;
const SECRET_TEXT =
	/(-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|(?:password|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,})/i;
const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const REMOTE_STATUS = new Set(["PASS", "FAIL"]);
export const REMOTE_MANIFEST_SCHEMA = "omp-remote-archive/v1";
export const REMOTE_MANIFEST_FIELDS = [
	"schema",
	"projectId",
	"runId",
	"gitHead",
	"status",
	"createdAt",
	"changedCount",
	"untrackedCount",
	"baselineSha",
] as const;
const ARCHIVE_REPO_NAME = /^omp-archive-[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

export type ArchiveInput = {
	action: ArchiveAction | string;
	projectId?: string;
	runId?: string;
	cwd?: string;
	archiveRepo?: string;
	sessionId?: string;
};

export type ArchiveHost = {
	exec?: (
		cmd: string[],
		opts?: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: Buffer | string },
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	ghAuth?: () => Promise<boolean>;
	ghRepoPrivate?: (repo: string) => Promise<boolean | undefined>;
	now?: () => number;
};

export type RemoteClass =
	| { kind: "github"; fullName: string; url: string }
	| { kind: "forbidden"; reason: string };

export class ArchiveError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
		this.name = "ArchiveError";
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
	git_dir?: string | null;
	git_dir_vol?: number | null;
	git_dir_index?: string | null;
	common_dir?: string | null;
	common_dir_vol?: number | null;
	common_dir_index?: string | null;
};
type Binding = { archiveRepo: string; private: boolean; url: string; boundAt: number };
type GitSnap = {
	head: string;
	branch: string;
	dirty: boolean;
	status: string;
	diffStat: string;
	untracked: string[];
	changed: string[];
};

function fail(code: string, message: string): never {
	throw new ArchiveError(code, message);
}

function need<T>(v: T | undefined | "", name: string): T {
	if (v === undefined || v === "") fail("INVALID", `missing ${name}`);
	return v;
}

function driveOf(p: string): string {
	const m = path.resolve(p).match(/^([A-Za-z]):/);
	return m ? m[1].toUpperCase() : "";
}

function isUnder(root: string, candidate: string): boolean {
	const r = path.resolve(root);
	const c = path.resolve(candidate);
	if (r.toLowerCase() === c.toLowerCase()) return true;
	const prefix = r.endsWith(path.sep) ? r : r + path.sep;
	return c.toLowerCase().startsWith(prefix.toLowerCase());
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function jsonArr(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

let archivePin: { vol: number; index: string; path: string; handle: bigint } | null = null;

export function pinD(p: string, label: string, create = false): string {
	const resolved = path.resolve(p);
	if (driveOf(resolved) !== "D") fail("NOT_D_ROOT", label);
	const walked = walkDir(resolved, create);
	try {
		if (driveOf(walked.finalPath) !== "D") fail("NOT_D_ROOT", label);
		if (!samePath(walked.finalPath, resolved)) fail("PATH_ESCAPE", "junction");
		return walked.finalPath;
	} finally {
		closeHandle(walked.handle);
	}
}

function assertArchiveHandle(): void {
	if (!archivePin) fail("PATH_ESCAPE", "archive root");
	const inf = fileInfo(archivePin.handle);
	if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "archive root");
	if (inf.vol !== archivePin.vol || inf.index !== archivePin.index) fail("PATH_ESCAPE", "archive root identity");
	const fp = finalPathOf(archivePin.handle);
	if (driveOf(fp) !== "D" || !samePath(fp, archivePin.path)) fail("PATH_ESCAPE", "archive root identity");
}

export function archiveRoot(): string {
	const lexical = ambientLab
		? assertAmbientLabTarget(ambientLab.archiveRoot)
		: path.resolve(DEFAULT_ARCHIVE_ROOT);
	if (!ambientLab && !samePath(lexical, "D:/OMPData/archives")) fail("PATH_ESCAPE", "archive root");
	if (archivePin) {
		assertArchiveHandle();
		return archivePin.path;
	}
	const walked = walkDir(lexical, true);
	if (driveOf(walked.finalPath) !== "D") {
		closeHandle(walked.handle);
		fail("NOT_D_ROOT", "archive root");
	}
	if (!samePath(walked.finalPath, lexical)) {
		closeHandle(walked.handle);
		fail("PATH_ESCAPE", "junction");
	}
	archivePin = { vol: walked.vol, index: walked.index, path: walked.finalPath, handle: walked.handle };
	return archivePin.path;
}

export function releaseArchiveRoot(): void {
	if (!archivePin) return;
	closeHandle(archivePin.handle);
	archivePin = null;
}

export function indexDir(): string {
	if (ambientLab) fail("LAB_EXTERNAL_PUBLISH_DISABLED", "index");
	const lexical = path.resolve(process.env.OMP_ARCHIVE_INDEX_DIR || DEFAULT_INDEX_DIR);
	if (driveOf(lexical) !== "D") fail("NOT_D_ROOT", "index dir");
	if (!fs.existsSync(lexical)) fail("INDEX_MISSING", "index");
	if (isReparse(fs.lstatSync(lexical))) fail("PATH_ESCAPE", "index");
	return pinD(lexical, "index dir", false);
}

export function safeRunId(value: string): string {
	if (!SAFE_ID.test(value)) fail("INVALID", "runId charset");
	return value;
}

export function slugOf(root: string, projectId: string): string {
	const base =
		path
			.basename(path.resolve(root))
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project";
	const id = projectId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase() || "id";
	const slug = `${base}-${id}`.slice(0, 80);
	if (!SAFE_ID.test(slug)) fail("INVALID", "slug charset");
	return slug;
}

export function outboxId(projectId: string, runId: string): string {
	return `archive.${sha256(`${projectId}\0${runId}`)}`;
}


export function archiveDir(slug: string, runId: string): string {
	const root = archiveRoot();
	if (!SAFE_ID.test(slug)) fail("INVALID", "slug charset");
	const id = safeRunId(runId);
	const dir = path.resolve(root, slug, id);
	if (!isUnder(root, dir)) fail("PATH_ESCAPE", "archive dir");
	if (path.basename(dir) !== id || path.basename(path.dirname(dir)) !== slug) fail("PATH_ESCAPE", "archive dir");
	return dir;
}

function isReparse(st: fs.Stats): boolean {
	return st.isSymbolicLink();
}

function assertNoReparseAlong(root: string, target: string): void {
	const rel = path.relative(root, target);
	if (rel.startsWith("..") || path.isAbsolute(rel)) fail("PATH_ESCAPE", "archive dir");
	let cur = root;
	if (isReparse(fs.lstatSync(cur))) fail("PATH_ESCAPE", "symlink");
	if (!rel || rel === ".") return;
	for (const part of rel.split(/[/\\]/)) {
		if (!part || part === ".") continue;
		cur = path.join(cur, part);
		if (isReparse(fs.lstatSync(cur))) fail("PATH_ESCAPE", "symlink");
	}
}

function assertNoReparseTree(dir: string): void {
	const walk = (cur: string) => {
		const st = fs.lstatSync(cur);
		if (isReparse(st)) fail("PATH_ESCAPE", "symlink");
		if (!st.isDirectory()) return;
		for (const name of fs.readdirSync(cur)) walk(path.join(cur, name));
	};
	walk(dir);
}
const GENERIC_READ = 0x80000000 >>> 0;
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
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 0x00000001;
const FILE_NON_DIRECTORY_FILE = 0x00000040;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const FILE_OPEN_REPARSE_POINT = 0x00200000;
const OBJ_CASE_INSENSITIVE = 0x40;
const FileRenameInformation = 10;
const FileDispositionInformation = 13;
const INVALID_HANDLE = 0xffffffffffffffffn;

type WinLibs = {
	k32: { symbols: Record<string, CallableFunction> };
	nt: { symbols: Record<string, CallableFunction> };
	shell: { symbols: Record<string, CallableFunction> };
};
let winApi: WinLibs | null = null;

function win(): WinLibs {
	if (winApi) return winApi;
	if (process.platform !== "win32") fail("UNSUPPORTED", "win32 required");
	winApi = {
		k32: dlopen("kernel32.dll", {
			CreateFileW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
				returns: FFIType.ptr,
			},
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetFinalPathNameByHandleW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
			GetFileInformationByHandle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			ReadFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			WriteFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			FlushFileBuffers: { args: [FFIType.ptr], returns: FFIType.i32 },
			CreateMutexW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
			WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
			ReleaseMutex: { args: [FFIType.ptr], returns: FFIType.i32 },
			SetFilePointerEx: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },

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
			NtQueryDirectoryFile: {
				args: [
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.ptr,
					FFIType.u32,
				],
				returns: FFIType.i32,
			},
		}),
		shell: dlopen("shell32.dll", {
			SHGetFolderPathW: {
				args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
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
	if (h && h !== INVALID_HANDLE) win().k32.symbols.CloseHandle(h);
}

function stripWinPrefix(p: string): string {
	let s = p;
	if (s.startsWith("\\\\?\\")) s = s.slice(4);
	if (s.startsWith("\\??\\")) s = s.slice(4);
	return s;
}

function ntCreate(
	root: bigint,
	name: string,
	disposition: number,
	dir: boolean,
	share = FILE_SHARE_ALL,
	access = FILE_RW_DELETE,
): { status: number; h: bigint } {
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
	const status = win().nt.symbols.NtCreateFile(
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
	) as number;
	return { status, h: handleOut.readBigUInt64LE(0) };
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
	if (status < 0) fail("PATH_ESCAPE", `NtCreateFile ${name} ${status >>> 0}`);
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
	if (dir && code === 0xc0000103) return null;
	if (!dir && code === 0xc00000ba) return null;
	fail("PATH_ESCAPE", `NtCreateFile ${name} ${code}`);
}

function fileInfo(h: bigint): { attr: number; vol: number; sizeHigh: number; sizeLow: number; size: bigint; index: string; links: number } {
	const buf = Buffer.alloc(52);
	if (!win().k32.symbols.GetFileInformationByHandle(h, ptr(buf))) fail("PATH_ESCAPE", "info");
	const sizeHigh = buf.readUInt32LE(32);
	const sizeLow = buf.readUInt32LE(36);
	return {
		attr: buf.readUInt32LE(0),
		vol: buf.readUInt32LE(28),
		sizeHigh,
		sizeLow,
		size: (BigInt(sizeHigh) << 32n) | BigInt(sizeLow),
		links: buf.readUInt32LE(40),
		index: `${buf.readUInt32LE(44)}:${buf.readUInt32LE(48)}`,
	};
}

function isZeroFileSize(inf: { sizeHigh: number; sizeLow: number }): boolean {
	return inf.sizeHigh === 0 && inf.sizeLow === 0;
}

const MAX_GIT_TEXT_FILE = 1024n * 1024n;
const MAX_GITDIR_FILE = 4096n;
const MAX_MANIFEST_FILE = 64n * 1024n;
const MAX_ARCHIVE_BLOB = 1024n * 1024n;

function fitReadSize(inf: { size: bigint }, cap: bigint): number {
	if (inf.size > cap) fail("FILE_TOO_LARGE", "size");
	return Number(inf.size);
}



function finalPathOf(h: bigint): string {
	const out = new Uint16Array(1024);
	const n = win().k32.symbols.GetFinalPathNameByHandleW(h, ptr(out), 1024, 0) as number;
	if (!n) fail("PATH_ESCAPE", "final path");
	return path.resolve(stripWinPrefix(Buffer.from(out.buffer, 0, n * 2).toString("utf16le")));
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
	if (!h || h === INVALID_HANDLE) fail("NOT_D_ROOT", "open D:\\");
	const inf = fileInfo(h);
	if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "D:");
	if (driveOf(finalPathOf(h)) !== "D") fail("NOT_D_ROOT", "D:");
	return h;
}

function walkDir(abs: string, create: boolean): { handle: bigint; finalPath: string; vol: number; index: string } {
	const resolved = path.resolve(abs);
	if (driveOf(resolved) !== "D") fail("NOT_D_ROOT", "path");
	const rel = path.relative("D:\\", resolved);
	const parts = path.resolve(resolved).toLowerCase() === "d:\\" ? [] : rel.split(/[\\/]/).filter(Boolean);
	if (parts.includes("..")) fail("PATH_ESCAPE", resolved);
	let h = openDrive();
	try {
		for (const part of parts) {
			const access = create ? DIR_CREATE_ACCESS : DIR_READ_ACCESS;
			let next = tryNtOpen(h, part, FILE_OPEN, true, FILE_SHARE_READ_WRITE, DIR_READ_ACCESS);
			if (!next) {
				if (!create) fail("PATH_ESCAPE", part);
				next = ntOpen(h, part, FILE_CREATE, true, FILE_SHARE_READ_WRITE, access);
			}
			const inf = fileInfo(next);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) {
				closeHandle(next);
				fail("PATH_ESCAPE", "symlink");
			}
			const fp = finalPathOf(next);
			if (driveOf(fp) !== "D") {
				closeHandle(next);
				fail("PATH_ESCAPE", "final path");
			}
			if (archivePin && samePath(fp, archivePin.path) && (inf.vol !== archivePin.vol || inf.index !== archivePin.index)) {
				closeHandle(next);
				fail("PATH_ESCAPE", "archive root identity");
			}
			closeHandle(h);
			h = next;
		}
		const inf = fileInfo(h);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "symlink");
		const fp = finalPathOf(h);
		if (driveOf(fp) !== "D") fail("PATH_ESCAPE", "final path");
		if (archivePin && samePath(fp, archivePin.path) && (inf.vol !== archivePin.vol || inf.index !== archivePin.index)) {
			fail("PATH_ESCAPE", "archive root identity");
		}
		return { handle: h, finalPath: fp, vol: inf.vol, index: inf.index };
	} catch (err) {
		closeHandle(h);
		throw err;
	}
}

type HeldDir = { path: string; vol: number; index: string; handle: bigint };
const plumbingStore = new AsyncLocalStorage<HeldDir[]>();
type SourcePin = {
	row: ProjectRow;
	root: HeldDir;
	gitDir: HeldDir;
	commonDir: HeldDir;
	objects: HeldDir;
	extra: PinnedBareConfig[];
	gitHead?: string;
};

const sourcePinStore = new AsyncLocalStorage<SourcePin>();

function currentPin(): SourcePin | undefined {
	return sourcePinStore.getStore();
}

function closeSourcePin(pin: SourcePin): void {
	for (let i = pin.extra.length - 1; i >= 0; i--) closeHandle(pin.extra[i].handle);
	closeHandle(pin.objects.handle);
	closeHandle(pin.commonDir.handle);
	closeHandle(pin.gitDir.handle);
	closeHandle(pin.root.handle);
}

function holdFromHandle(h: bigint): HeldDir {
	try {
		const inf = fileInfo(h);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "symlink");
		const fp = finalPathOf(h);
		if (driveOf(fp) !== "D") fail("GIT_IDENTITY", fp);
		return { path: fp, vol: inf.vol, index: inf.index, handle: h };
	} catch (err) {
		closeHandle(h);
		throw err;
	}
}

function openChild(parent: bigint, name: string, dir: boolean): bigint | null {
	const access = dir ? DIR_READ_ACCESS : GENERIC_READ | SYNCHRONIZE;
	return tryNtOpen(parent, name, FILE_OPEN, dir, FILE_SHARE_READ_WRITE, access);
}

function readHandleText(h: bigint, cap: bigint): string {
	const inf = fileInfo(h);
	if (isZeroFileSize(inf)) return "";
	const n = fitReadSize(inf, cap);
	const buf = Buffer.alloc(n);
	const got = Buffer.alloc(4);
	if (!win().k32.symbols.ReadFile(h, ptr(buf), n, ptr(got), null)) fail("GIT_IDENTITY", "read");
	return buf.subarray(0, got.readUInt32LE(0)).toString("utf8");
}



function parseGitdirLine(text: string, worktreeRoot: string): string {
	const line = text.split(/\r?\n/).find(l => /^gitdir:/i.test(l));
	if (!line) fail("GIT_IDENTITY", "gitdir");
	const raw = line.replace(/^gitdir:\s*/i, "").trim();
	const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(worktreeRoot, raw);
	if (driveOf(abs) !== "D") fail("GIT_IDENTITY", abs);
	return abs;
}

function parseCommondirLine(text: string, gitDirPath: string): string {
	const line = text.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith("#")) ?? "";
	if (!line) fail("GIT_IDENTITY", "commondir");
	const abs = path.isAbsolute(line) ? path.resolve(line) : path.resolve(gitDirPath, line);
	if (driveOf(abs) !== "D") fail("GIT_IDENTITY", abs);
	return abs;
}

function denyNamedFiles(parent: bigint, dirName: string, files: string[]): void {
	const dir = openChild(parent, dirName, true);
	if (!dir) return;
	try {
		if (fileInfo(dir).attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", dirName);
		for (const name of files) {
			const h = openChild(dir, name, false);
			if (h) {
				closeHandle(h);
				fail("GIT_IDENTITY", `${dirName}/${name}`);
			}
		}
	} finally {
		closeHandle(dir);
	}
}

function denyRefsReplace(dir: HeldDir): void {
	const refs = openChild(dir.handle, "refs", true);
	if (!refs) return;
	try {
		if (fileInfo(refs).attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "refs");
		const asDir = openChild(refs, "replace", true);
		if (asDir) {
			closeHandle(asDir);
			fail("GIT_IDENTITY", "refs/replace");
		}
		const asFile = openChild(refs, "replace", false);
		if (asFile) {
			closeHandle(asFile);
			fail("GIT_IDENTITY", "refs/replace");
		}
	} finally {
		closeHandle(refs);
	}
}

function denyAttrText(text: string, label: string): void {

	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		if (/\b(filter|diff|merge|textconv)\s*=/i.test(t)) fail("GIT_STATUS", label);
	}
}

function denyGitIncludeText(text: string, label: string): void {
	if (/^\s*\[include(If)?\b/im.test(text)) fail("GIT_STATUS", label);
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#") || t.startsWith("[")) continue;
		const eq = t.indexOf("=");
		const key = (eq >= 0 ? t.slice(0, eq) : t).trim().replace(/\s+/g, "");
		if (/^include(\.path)?$/i.test(key) || /^includeif\./i.test(key)) fail("GIT_STATUS", label);
	}
}

function denyGitAttributes(root: HeldDir, gitDir: HeldDir, commonDir: HeldDir): void {
	const scan = (parent: bigint, name: string, label: string) => {
		const h = openChild(parent, name, false);
		if (!h) return;
		try {
			const inf = fileInfo(h);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", label);
			if (inf.links > 1) fail("GIT_IDENTITY", label);
			denyAttrText(readHandleText(h, MAX_GIT_TEXT_FILE), label);

		} finally {
			closeHandle(h);
		}
	};
	scan(root.handle, ".gitattributes", ".gitattributes");
	const infoScan = (dir: HeldDir, label: string) => {
		const info = openChild(dir.handle, "info", true);
		if (!info) return;
		try {
			const inf = fileInfo(info);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", label);
			if (inf.links > 1) fail("GIT_IDENTITY", label);
			const attr = openChild(info, "attributes", false);
			if (!attr) return;
			try {
				const ainf = fileInfo(attr);
				if (ainf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", label);
				if (ainf.links > 1) fail("GIT_IDENTITY", label);
				denyAttrText(readHandleText(attr, MAX_GIT_TEXT_FILE), label);

			} finally {
				closeHandle(attr);
			}
		} finally {
			closeHandle(info);
		}
	};
	infoScan(gitDir, "gitdir-attributes");
	infoScan(commonDir, "common-attributes");
}

function denyGitEscape(gitDir: HeldDir, commonDir: HeldDir, objects: HeldDir): void {
	denyNamedFiles(objects.handle, "info", ["http-alternates"]);
	denyRefsReplace(gitDir);
	denyRefsReplace(commonDir);
}

const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;


function ensureInfoDir(parent: HeldDir): bigint {
	let info = openChild(parent.handle, "info", true);
	if (!info) {
		info = ntOpen(parent.handle, "info", FILE_CREATE, true, FILE_SHARE_READ_WRITE, DIR_CREATE_ACCESS);
	}
	try {
		const inf = fileInfo(info);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "info");
		if (!(inf.attr & FILE_ATTRIBUTE_DIRECTORY)) fail("GIT_IDENTITY", "info");
		return info;
	} catch (err) {
		closeHandle(info);
		throw err;
	}
}

function pinEmptySentinel(infoDir: bigint, name: string): PinnedBareConfig {
	const created = ntCreate(infoDir, name, FILE_CREATE, false, FILE_SHARE_READ, GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE);
	let h: bigint;
	if (created.status >= 0) {
		h = created.h;
	} else if ((created.status >>> 0) === STATUS_OBJECT_NAME_COLLISION) {
		h = ntOpen(infoDir, name, FILE_OPEN, false, FILE_SHARE_READ, GENERIC_READ | SYNCHRONIZE);
	} else {
		fail("PATH_ESCAPE", `sentinel ${name} ${created.status >>> 0}`);
	}
	try {
		const inf = fileInfo(h);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", name);
		if (inf.attr & FILE_ATTRIBUTE_DIRECTORY) fail("GIT_IDENTITY", name);
		if (inf.links > 1) fail("GIT_IDENTITY", name);
		const sizeHigh = testAdapter?.sentinelSize?.sizeHigh ?? inf.sizeHigh;
		const sizeLow = testAdapter?.sentinelSize?.sizeLow ?? inf.sizeLow;
		if (sizeHigh !== 0 || sizeLow !== 0) fail("GIT_IDENTITY", name);
		return { handle: h, vol: inf.vol, index: inf.index, sha: sha256("") };
	} catch (err) {
		closeHandle(h);
		throw err;
	}
}


function pinGitBarriers(gitDir: HeldDir, commonDir: HeldDir, objects: HeldDir): PinnedBareConfig[] {
	const pins: PinnedBareConfig[] = [];
	const add = (parent: HeldDir, name: string) => {
		const info = ensureInfoDir(parent);
		try {
			pins.push(pinEmptySentinel(info, name));
		} catch (err) {
			closeHandle(info);
			throw err;
		}
		closeHandle(info);
	};
	try {
		add(objects, "alternates");
		add(objects, "grafts");
		add(gitDir, "grafts");
		if (!samePath(gitDir.path, commonDir.path)) add(commonDir, "grafts");
		return pins;
	} catch (err) {
		for (let i = pins.length - 1; i >= 0; i--) closeHandle(pins[i].handle);
		throw err;
	}
}

function holdGitLayout(root: HeldDir): { gitDir: HeldDir; commonDir: HeldDir; objects: HeldDir } {
	const acquired: bigint[] = [];
	const keep = (h: bigint): bigint => {
		acquired.push(h);
		return h;
	};
	try {
		let gitDir: HeldDir;
		const asDir = openChild(root.handle, ".git", true);
		if (asDir) {
			gitDir = holdFromHandle(keep(asDir));
		} else {
			const asFile = openChild(root.handle, ".git", false);
			if (!asFile) fail("NOT_GIT_ROOT", ".git");
			let target = "";
			try {
				const inf = fileInfo(asFile);
				if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", ".git");
				target = parseGitdirLine(readHandleText(asFile, MAX_GITDIR_FILE), root.path);

			} finally {
				closeHandle(asFile);
			}
			const walked = walkDir(target, false);
			gitDir = holdFromHandle(keep(walked.handle));
		}
		let commonDir: HeldDir;
		const commonFile = openChild(gitDir.handle, "commondir", false);
		if (commonFile) {
			let target = "";
			try {
				const inf = fileInfo(commonFile);
				if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "commondir");
				target = parseCommondirLine(readHandleText(commonFile, MAX_GITDIR_FILE), gitDir.path);

			} finally {
				closeHandle(commonFile);
			}
			const walked = walkDir(target, false);
			commonDir = holdFromHandle(keep(walked.handle));
		} else {
			const walked = walkDir(gitDir.path, false);
			commonDir = holdFromHandle(keep(walked.handle));
		}
		const objH = openChild(commonDir.handle, "objects", true);
		if (!objH) fail("GIT_IDENTITY", "objects");
		const objects = holdFromHandle(keep(objH));
		denyGitEscape(gitDir, commonDir, objects);
		denyGitAttributes(root, gitDir, commonDir);
		return { gitDir, commonDir, objects };
	} catch (err) {
		for (let i = acquired.length - 1; i >= 0; i--) closeHandle(acquired[i]);
		throw err;
	}
}

function holdProjectRoot(row: ProjectRow): HeldDir {
	if (row.root_vol == null || row.root_index == null || row.root_vol < 0) fail("ROOT_IDENTITY", row.canonical_root);
	const walked = walkDir(row.canonical_root, false);
	try {
		if (!samePath(walked.finalPath, path.resolve(row.canonical_root))) fail("ROOT_IDENTITY", walked.finalPath);
		if (walked.vol !== row.root_vol || walked.index !== row.root_index) fail("ROOT_IDENTITY", walked.finalPath);
		return { path: walked.finalPath, vol: walked.vol, index: walked.index, handle: walked.handle };
	} catch (err) {
		closeHandle(walked.handle);
		throw err;
	}
}

function assertSourceIdentity(): void {
	const top = currentPin();
	if (!top) return;
	const check = (held: HeldDir, vol: number | null | undefined, index: string | null | undefined, code: string, label: string) => {
		const inf = fileInfo(held.handle);
		if (inf.vol !== held.vol || inf.index !== held.index) fail(code, label);
		if (vol != null && vol < 0) fail(code, label);
		if (vol != null && index != null && (inf.vol !== vol || inf.index !== index)) fail(code, label);
	};
	check(top.root, top.row.root_vol, top.row.root_index, "ROOT_IDENTITY", top.root.path);
	check(top.gitDir, top.row.git_dir_vol, top.row.git_dir_index, "GIT_IDENTITY", top.gitDir.path);
	check(top.commonDir, top.row.common_dir_vol, top.row.common_dir_index, "GIT_IDENTITY", top.commonDir.path);
	check(top.objects, null, null, "GIT_IDENTITY", top.objects.path);
	for (const extra of top.extra) assertPinnedBareConfig(extra);
}

function requireSession(sessionId: string | undefined): string {
	if (!sessionId || sessionId === "nosession") fail("OWNER_MISMATCH", "session");
	return sessionId;
}

function requireProjectOwner(row: ProjectRow, sessionId: string): void {
	requireSession(sessionId);
	if (!row.owner || row.owner === "nosession") fail("QUARANTINE", row.id);
}

function requireControlGitIdentity(row: ProjectRow): void {
	if (
		row.git_dir_vol == null ||
		row.git_dir_index == null ||
		row.common_dir_vol == null ||
		row.common_dir_index == null
	) {
		fail("NOT_MIGRATED", row.id);
	}
	if (row.git_dir_vol < 0 || row.common_dir_vol < 0) fail("GIT_IDENTITY", row.id);
}
const FileDirectoryInformation = 1;
const STATUS_NO_MORE_FILES = 0x80000006;

function holdPath(abs: string, create: boolean): HeldDir[] {
	const resolved = path.resolve(abs);
	if (driveOf(resolved) !== "D") fail("NOT_D_ROOT", "path");
	const rel = path.relative("D:\\", resolved);
	const parts = path.resolve(resolved).toLowerCase() === "d:\\" ? [] : rel.split(/[\\/]/).filter(Boolean);
	if (parts.includes("..")) fail("PATH_ESCAPE", resolved);
	const chain: HeldDir[] = [];
	let h = openDrive();
	try {
		const dInf = fileInfo(h);
		if (dInf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "D:");
		chain.push({ path: path.resolve("D:\\"), vol: dInf.vol, index: dInf.index, handle: h });
		for (const part of parts) {
			const access = create ? DIR_CREATE_ACCESS : DIR_READ_ACCESS;
			let next = tryNtOpen(h, part, FILE_OPEN, true, FILE_SHARE_READ_WRITE, DIR_READ_ACCESS);
			if (!next) {
				if (!create) fail("PATH_ESCAPE", part);
				next = ntOpen(h, part, FILE_CREATE, true, FILE_SHARE_READ_WRITE, access);
			}
			const inf = fileInfo(next);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) {
				closeHandle(next);
				fail("PATH_ESCAPE", "symlink");
			}
			const fp = finalPathOf(next);
			if (driveOf(fp) !== "D") {
				closeHandle(next);
				fail("PATH_ESCAPE", "final path");
			}
			chain.push({ path: fp, vol: inf.vol, index: inf.index, handle: next });
			h = next;
		}
		return chain;
	} catch (err) {
		for (const node of chain) closeHandle(node.handle);
		throw err;
	}
}

function assertHeldChain(chain: HeldDir[]): void {
	for (const node of chain) {
		const inf = fileInfo(node.handle);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "held");
		if (inf.vol !== node.vol || inf.index !== node.index) fail("PATH_ESCAPE", "identity");
		const fp = finalPathOf(node.handle);
		if (driveOf(fp) !== "D" || !samePath(fp, node.path)) fail("PATH_ESCAPE", "identity");
	}
}

function closeHeldChain(chain: HeldDir[]): void {
	for (let i = chain.length - 1; i >= 0; i--) closeHandle(chain[i].handle);
}

function listDirHandle(h: bigint): { name: string; attr: number }[] {
	const out: { name: string; attr: number }[] = [];
	const buf = Buffer.alloc(16384);
	const iosb = Buffer.alloc(16);
	let restart = 1;
	for (;;) {
		const st = win().nt.symbols.NtQueryDirectoryFile(
			h,
			null,
			null,
			null,
			ptr(iosb),
			ptr(buf),
			buf.length,
			FileDirectoryInformation,
			0,
			null,
			restart,
		) as number;
		restart = 0;
		const code = st >>> 0;
		if (code === STATUS_NO_MORE_FILES) break;
		if (st < 0) fail("PATH_ESCAPE", `NtQueryDirectoryFile ${code}`);
		let off = 0;
		for (;;) {
			const next = buf.readUInt32LE(off);
			const attr = buf.readUInt32LE(off + 56);
			const nameBytes = buf.readUInt32LE(off + 60);
			const name = Buffer.from(buf.buffer, buf.byteOffset + off + 64, nameBytes).toString("utf16le");
			if (name !== "." && name !== "..") out.push({ name, attr });
			if (!next) break;
			off += next;
		}
	}
	return out;
}

function wipeDirHandle(h: bigint): void {
	for (const ent of listDirHandle(h)) {
		const dir = (ent.attr & 0x10) !== 0;
		const child = ntOpen(h, ent.name, FILE_OPEN, dir, FILE_SHARE_READ_WRITE, FILE_RW_DELETE);
		try {
			const inf = fileInfo(child);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "wipe");
			if (dir) wipeDirHandle(child);
			disposeHandle(child);
		} finally {
			closeHandle(child);
		}
	}
}

function releaseWorkChain(chain: HeldDir[]): void {
	try {
		assertHeldChain(chain);
		const tmp = chain[chain.length - 1];
		wipeDirHandle(tmp.handle);
		disposeHandle(tmp.handle);
	} catch {
		/* quarantine in place; never pathname rm */
	}
	closeHeldChain(chain);
}


function writeHandle(h: bigint, bytes: Buffer): void {
	if (bytes.length === 0) {
		win().k32.symbols.FlushFileBuffers(h);
		return;
	}
	const got = Buffer.alloc(4);
	if (!win().k32.symbols.WriteFile(h, ptr(bytes), bytes.length, ptr(got), null)) fail("PATH_ESCAPE", "write");
	if (got.readUInt32LE(0) !== bytes.length) fail("PATH_ESCAPE", "write");
	win().k32.symbols.FlushFileBuffers(h);
}

function readHandle(h: bigint, size: number): Buffer {
	if (!Number.isInteger(size) || size < 0 || BigInt(size) > MAX_ARCHIVE_BLOB) fail("FILE_TOO_LARGE", "size");
	if (size === 0) return Buffer.alloc(0);
	const buf = Buffer.alloc(size);
	const got = Buffer.alloc(4);
	if (!win().k32.symbols.ReadFile(h, ptr(buf), size, ptr(got), null)) fail("PATH_ESCAPE", "read");
	return buf.subarray(0, got.readUInt32LE(0));
}


function renameReplace(tmpH: bigint, parent: bigint, basename: string): void {
	const nameW = wstr(basename);
	const nameBytes = (nameW.length - 1) * 2;
	const info = Buffer.alloc(20 + nameBytes);
	info.writeUInt32LE(1, 0);
	info.writeBigUInt64LE(parent, 8);
	info.writeUInt32LE(nameBytes, 16);
	Buffer.from(nameW.buffer, 0, nameBytes).copy(info, 20);
	const iosb = Buffer.alloc(16);
	const st = win().nt.symbols.NtSetInformationFile(tmpH, ptr(iosb), ptr(info), info.length, FileRenameInformation) as number;
	if (st < 0) fail("PATH_ESCAPE", `rename ${st >>> 0}`);
}

function disposeHandle(h: bigint): void {
	const info = Buffer.alloc(1);
	info.writeUInt8(1, 0);
	const iosb = Buffer.alloc(16);
	win().nt.symbols.NtSetInformationFile(h, ptr(iosb), ptr(info), 1, FileDispositionInformation);
}

function requireLeafName(name: string): string {
	if (!name || name === "." || name === ".." || /[\\/]/.test(name) || !/^[A-Za-z0-9._-]+$/.test(name)) {
		fail("PATH_ESCAPE", "name");
	}
	return name;
}

function openUnderArchive(abs: string, create: boolean): { handle: bigint; finalPath: string; owned: boolean } {
	archiveRoot();
	assertArchiveHandle();
	if (!archivePin) fail("PATH_ESCAPE", "archive root");
	const rel = path.relative(archivePin.path, path.resolve(abs));
	if (rel.startsWith("..") || path.isAbsolute(rel)) fail("PATH_ESCAPE", "archive dir");
	const parts = !rel || rel === "." ? [] : rel.split(/[\\/]/).filter(Boolean).map(requireLeafName);
	if (parts.length === 0) return { handle: archivePin.handle, finalPath: archivePin.path, owned: false };
	let h = archivePin.handle;
	try {
		for (const part of parts) {
			const access = create ? DIR_CREATE_ACCESS : DIR_READ_ACCESS;
			let next = tryNtOpen(h, part, FILE_OPEN, true, FILE_SHARE_READ_WRITE, DIR_READ_ACCESS);
			if (!next) {
				if (!create) fail("PATH_ESCAPE", part);
				next = ntOpen(h, part, FILE_CREATE, true, FILE_SHARE_READ_WRITE, access);
			}
			const inf = fileInfo(next);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) {
				closeHandle(next);
				fail("PATH_ESCAPE", "symlink");
			}
			const fp = finalPathOf(next);
			if (driveOf(fp) !== "D" || !isUnder(archivePin.path, fp)) {
				closeHandle(next);
				fail("PATH_ESCAPE", "final path");
			}
			if (h !== archivePin.handle) closeHandle(h);
			h = next;
		}
		return { handle: h, finalPath: finalPathOf(h), owned: true };
	} catch (err) {
		if (h !== archivePin.handle) closeHandle(h);
		throw err;
	}
}

function pinArchiveDir(slug: string, runId: string): string {
	const walked = openUnderArchive(archiveDir(slug, runId), true);
	try {
		if (path.basename(walked.finalPath) !== runId) fail("PATH_ESCAPE", "archive dir");
		if (!isUnder(archiveRoot(), walked.finalPath)) fail("PATH_ESCAPE", "archive dir");
		assertNoReparseTree(walked.finalPath);
		return walked.finalPath;
	} finally {
		if (walked.owned) closeHandle(walked.handle);
	}
}

function readNoFollow(file: string, root?: string, cap: bigint = MAX_ARCHIVE_BLOB): { bytes: Buffer; fileId: string; size: number } {
	if (isReparse(fs.lstatSync(file))) fail("PATH_ESCAPE", "file");
	const parentDir = path.dirname(file);
	const underArchive = Boolean(archivePin && isUnder(archivePin.path, parentDir));
	const parent = underArchive ? openUnderArchive(parentDir, false) : (() => {
		const w = walkDir(parentDir, false);
		return { handle: w.handle, finalPath: w.finalPath, owned: true };
	})();
	try {
		if (root && !isUnder(root, parent.finalPath)) fail("PATH_ESCAPE", "final path");
		const h = ntOpen(parent.handle, requireLeafName(path.basename(file)), FILE_OPEN, false);
		try {
			const inf = fileInfo(h);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "symlink");
			if (inf.attr & 0x10) fail("PATH_ESCAPE", "file");
			const fp = finalPathOf(h);
			if (driveOf(fp) !== "D") fail("PATH_ESCAPE", "final path");
			if (root && !isUnder(root, fp)) fail("PATH_ESCAPE", "final path");
			if (path.basename(fp) !== path.basename(file)) fail("PATH_ESCAPE", "file");
			const n = fitReadSize(inf, cap);
			const bytes = readHandle(h, n);
			const again = fileInfo(h);
			if (again.index !== inf.index || again.vol !== inf.vol || again.sizeHigh !== inf.sizeHigh || again.sizeLow !== inf.sizeLow) fail("PATH_ESCAPE", "identity");
			return { bytes, fileId: `${inf.vol}:${inf.index}:${inf.sizeHigh}:${inf.sizeLow}`, size: n };
		} finally {
			closeHandle(h);
		}
	} finally {
		if (parent.owned) closeHandle(parent.handle);
	}
}
function writeLocalFile(dir: string, name: string, content: string, root = archiveRoot()): void {
	const leaf = requireLeafName(name);
	const parent = openUnderArchive(dir, true);
	let tmpH = 0n;
	let replaced = false;
	try {
		assertArchiveHandle();
		if (!isUnder(root, parent.finalPath)) fail("PATH_ESCAPE", "final path");
		const tmpName = `.${leaf}.tmp-${crypto.randomBytes(6).toString("hex")}`;
		tmpH = ntOpen(parent.handle, tmpName, FILE_CREATE, false);
		const inf = fileInfo(tmpH);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "symlink");
		const fp = finalPathOf(tmpH);
		if (driveOf(fp) !== "D" || !isUnder(root, path.dirname(fp))) fail("PATH_ESCAPE", "final path");
		writeHandle(tmpH, Buffer.from(content));
		renameReplace(tmpH, parent.handle, leaf);
		replaced = true;
		const destFp = finalPathOf(tmpH);
		if (driveOf(destFp) !== "D" || !isUnder(root, destFp) || path.basename(destFp) !== leaf) {
			fail("PATH_ESCAPE", "replace");
		}
	} catch (err) {
		if (tmpH && !replaced) disposeHandle(tmpH);
		throw err;
	} finally {
		if (tmpH) closeHandle(tmpH);
		if (parent.owned) closeHandle(parent.handle);
	}
}

function unlinkLocalFile(dir: string, name: string): void {
	const leaf = requireLeafName(name);
	const parent = openUnderArchive(dir, false);
	try {
		const h = tryNtOpen(parent.handle, leaf, FILE_OPEN, false);
		if (!h) return;
		try {
			const inf = fileInfo(h);
			if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "symlink");
			const fp = finalPathOf(h);
			if (driveOf(fp) !== "D") fail("PATH_ESCAPE", "final path");
			disposeHandle(h);
		} finally {
			closeHandle(h);
		}
	} finally {
		if (parent.owned) closeHandle(parent.handle);
	}
}

export function deniedName(relOrAbs: string): boolean {
	return DENY_NAME.test(relOrAbs.replaceAll("/", path.sep));
}

export function deniedText(text: string): boolean {
	if (SECRET_TEXT.test(text)) return true;
	LOCAL_PATH_RE.lastIndex = 0;
	return LOCAL_PATH_RE.test(text);
}

export function redactRemote(spec: string): string {
	return spec.replace(USERINFO_ANY, "$1").replace(LOCAL_PATH_RE, "<local-path>");
}

export function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") return value.replace(USERINFO_ANY, "$1").replace(LOCAL_PATH_RE, "<local-path>");
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v);
		return out;
	}
	return value;
}

export function classifyRemote(spec: string): RemoteClass {
	const raw = spec.trim();
	if (!raw) return { kind: "forbidden", reason: "empty" };
	if (/[\0\r\n]/.test(raw)) return { kind: "forbidden", reason: "control chars" };
	if (/(https?:\/\/)[^@/]+@/i.test(raw)) return { kind: "forbidden", reason: "url userinfo" };
	if (/^file:/i.test(raw) || /^http:\/\//i.test(raw) || /^git:\/\//i.test(raw)) {
		return { kind: "forbidden", reason: "remote scheme" };
	}
	if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || /^\/(?:home|Users|root)\//.test(raw)) {
		return { kind: "forbidden", reason: "local path" };
	}
	let rest = raw;
	const gitAt = rest.match(/^git@github\.com:(.+)$/i);
	if (gitAt) rest = gitAt[1];
	else {
		const ssh = rest.match(/^ssh:\/\/(?:git@)?github\.com\/(.+)$/i);
		if (ssh) rest = ssh[1];
		else {
			const https = rest.match(/^https:\/\/github\.com\/(.+)$/i);
			if (https) rest = https[1];
		}
	}
	rest = rest.replace(/\.git$/i, "").replace(/\/$/, "");
	if (GITHUB_OWNER_REPO.test(rest) && rest.split("/").length === 2) {
		return { kind: "github", fullName: rest, url: `https://github.com/${rest}.git` };
	}
	return { kind: "forbidden", reason: "not github" };
}

function requireArchiveRemote(spec: string): RemoteClass & { kind: "github" } {
	const remote = classifyRemote(spec);
	if (remote.kind === "forbidden") fail("FORBIDDEN_REMOTE", "archive repo");
	const parts = remote.fullName.split("/");
	if (parts.length !== 2 || parts[0] !== "LJC-god") fail("FORBIDDEN_REMOTE", "archive repo");
	const repo = parts[1];
	if (!ARCHIVE_REPO_NAME.test(repo) || SECRET_TEXT.test(repo)) fail("FORBIDDEN_REMOTE", "archive repo");
	return { kind: "github", fullName: `LJC-god/${repo}`, url: `https://github.com/LJC-god/${repo}.git` };
}

function nowMs(host: ArchiveHost): number {
	return host.now ? host.now() : Date.now();
}

export async function readCappedStream(
	stream: ReadableStream<Uint8Array> | undefined | null,
	cap: number,
	opts: { entryCap?: number; sep?: number; kill?: () => void } = {},
): Promise<string> {
	if (!stream) return "";
	if (!Number.isInteger(cap) || cap < 0) fail("GIT_OUTPUT_TOO_LARGE", "cap");
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let n = 0;
	let entries = 0;
	let pending = false;
	const entryCap = opts.entryCap ?? 0;
	const sep = opts.sep ?? 10;
	const overflow = (): never => {
		chunks.length = 0;
		try {
			opts.kill?.();
		} catch {
			/* child already gone */
		}
		try {
			void reader.cancel();
		} catch {
			/* stream already closed */
		}
		fail("GIT_OUTPUT_TOO_LARGE", "output");
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			if (value.byteLength > cap - n) overflow();
			if (entryCap > 0) {
				for (let i = 0; i < value.byteLength; i++) {
					if (value[i] === sep) {
						entries += 1;
						pending = false;
					} else {
						pending = true;
					}
				}
				if (entries + (pending ? 1 : 0) > entryCap) overflow();
			}
			chunks.push(value);
			n += value.byteLength;
		}
	} catch (err) {
		if (err instanceof ArchiveError) throw err;
		try {
			opts.kill?.();
		} catch {
			/* child already gone */
		}
		throw err;
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* released */
		}
	}
	if (n === 0) return "";
	return Buffer.concat(chunks, n).toString("utf8");
}

function enforceReturnedOutput(
	r: { stdout: string; stderr: string; exitCode: number },
	limits: GitOutputLimits,
): { stdout: string; stderr: string; exitCode: number } {
	if (r.stderr.length > limits.stderrCap) fail("GIT_OUTPUT_TOO_LARGE", "stderr");
	if (r.stdout.length > limits.stdoutCap) fail("GIT_OUTPUT_TOO_LARGE", "stdout");
	if (limits.entryCap > 0) {
		let entries = 0;
		let pending = false;
		for (let i = 0; i < r.stdout.length; i++) {
			if (r.stdout.charCodeAt(i) === limits.sep) {
				entries += 1;
				pending = false;
			} else {
				pending = true;
			}
		}
		if (entries + (pending ? 1 : 0) > limits.entryCap) fail("GIT_OUTPUT_TOO_LARGE", "entries");
	}
	return r;
}

async function execCmd(
	host: ArchiveHost,
	cmd: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: Buffer | string; limits?: GitOutputLimits } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (cmd[0] === "gh" && cmd[1] === "repo" && cmd[2] === "create") fail("NO_AUTO_REPO", "refusing gh repo create");
	const exe0 = cmd[0] || "";
	const base0 = path.basename(exe0).toLowerCase();
	if ((base0 === "git" || base0 === "git.exe" || base0 === "gh" || base0 === "gh.exe") && !path.isAbsolute(exe0)) {
		fail(base0.startsWith("gh") ? "ARCHIVE_AUTH_UNAVAILABLE" : "GIT_UNAVAILABLE", "unqualified");
	}
	if (base0 === "gh" || base0 === "gh.exe") {
		const trusted = resolveGh();
		if (!trusted) fail("ARCHIVE_AUTH_UNAVAILABLE", "gh.exe");
		if (path.resolve(exe0).toLowerCase() !== path.resolve(trusted).toLowerCase()) fail("ARCHIVE_AUTH_UNAVAILABLE", "gh.exe");
	}

	const limits = opts.limits ?? {
		stdoutCap: GIT_STDOUT_META_CAP,
		stderrCap: GIT_STDERR_CAP,
		entryCap: 0,
		sep: 10,
	};
	const plumbingHeld = plumbingStore.getStore();
	if (plumbingHeld) assertHeldChain(plumbingHeld);
	assertSourceIdentity();
	if (host.exec) {
		const r = await host.exec(cmd, { cwd: opts.cwd, env: opts.env, stdin: opts.stdin });
		if (plumbingHeld) assertHeldChain(plumbingHeld);
		assertSourceIdentity();
		return enforceReturnedOutput(r, limits);
	}
	const child = Bun.spawn({
		cmd,
		cwd: opts.cwd,
		stdin: opts.stdin === undefined ? "ignore" : opts.stdin,
		stdout: "pipe",
		stderr: "pipe",
		env: opts.env ?? { SystemRoot: "C:\\Windows", windir: "C:\\Windows", PATH: "" },
	});
	const kill = () => {
		try {
			child.kill();
		} catch {
			/* already dead */
		}
	};
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			readCappedStream(child.stdout, limits.stdoutCap, { entryCap: limits.entryCap, sep: limits.sep, kill }),
			readCappedStream(child.stderr, limits.stderrCap, { kill }),
			child.exited,
		]);
		if (plumbingHeld) assertHeldChain(plumbingHeld);
		assertSourceIdentity();
		return { stdout, stderr, exitCode };
	} catch (err) {
		kill();
		try {
			await child.exited;
		} catch {
			/* killed */
		}
		throw err;
	}
}


function knownFolder(csidl: number): string {
	const buf = new Uint16Array(260);
	const hr = win().shell.symbols.SHGetFolderPathW(null, csidl, null, 0, ptr(buf));
	if (hr !== 0) fail("GIT_UNAVAILABLE", `SHGetFolderPathW ${hr}`);
	let n = 0;
	while (n < 260 && buf[n]) n += 1;
	if (!n) fail("GIT_UNAVAILABLE", "empty known folder");
	return Buffer.from(buf.buffer, 0, n * 2).toString("utf16le");
}

const FILE_ATTRIBUTE_DIRECTORY = 0x10;

function openExeNoReparse(abs: string, wantBase: string): string | null {
	const resolved = path.resolve(abs);
	const name = wstr(`\\\\?\\${resolved}`);
	const h = asHandle(
		win().k32.symbols.CreateFileW(
			ptr(name),
			GENERIC_READ,
			FILE_SHARE_READ_WRITE,
			null,
			OPEN_EXISTING,
			FILE_FLAG_OPEN_REPARSE_POINT,
			null,
		),
	);
	if (!h || h === INVALID_HANDLE) return null;
	try {
		const inf = fileInfo(h);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) return null;
		if (inf.attr & FILE_ATTRIBUTE_DIRECTORY) return null;
		const fp = finalPathOf(h);
		if (path.basename(fp).toLowerCase() !== wantBase) return null;
		return fp;
	} finally {
		closeHandle(h);
	}
}

function resolveGit(): string {
	const pf = knownFolder(0x26);
	const pf86 = knownFolder(0x2a);
	const gitRoots = [path.join(pf, "Git"), path.join(pf86, "Git")];
	const cands = gitRoots.flatMap(root => [path.join(root, "cmd", "git.exe"), path.join(root, "bin", "git.exe")]);
	for (const cand of cands) {
		const real = openExeNoReparse(cand, "git.exe");
		if (!real) continue;
		const low = real.toLowerCase();
		if (
			gitRoots.some(root => {
				const prefix = path.resolve(root).toLowerCase();
				return low === prefix || low.startsWith(prefix.endsWith("\\") ? prefix : `${prefix}\\`);
			})
		) {
			return real;
		}
	}
	fail("GIT_UNAVAILABLE", "git.exe");
}

function resolveGh(): string | null {
	if (testAdapter?.ghUnavailable) return null;
	if (testAdapter?.ghExe) {
		return openExeNoReparse(path.resolve(testAdapter.ghExe), "gh.exe");
	}
	const pf = knownFolder(0x26);
	const pf86 = knownFolder(0x2a);
	const roots = [path.join(pf, "GitHub CLI"), path.join(pf86, "GitHub CLI")];
	for (const root of roots) {
		const real = openExeNoReparse(path.join(root, "gh.exe"), "gh.exe");
		if (!real) continue;
		const low = real.toLowerCase();
		if (
			roots.some(r => {
				const prefix = path.resolve(r).toLowerCase();
				return low === prefix || low.startsWith(prefix.endsWith("\\") ? prefix : `${prefix}\\`);
			})
		) {
			return real;
		}
	}
	return null;
}


function ghExePath(): string {
	const verified = resolveGh();
	if (!verified) fail("ARCHIVE_AUTH_UNAVAILABLE", "gh.exe");
	return verified;
}



function ghChildEnv(): NodeJS.ProcessEnv {
	return {
		SystemRoot: "C:\\Windows",
		windir: "C:\\Windows",
		PATH: "",
		USERPROFILE: process.env.USERPROFILE || "",
		HOME: process.env.USERPROFILE || "",
		APPDATA: process.env.APPDATA || "",
		LOCALAPPDATA: process.env.LOCALAPPDATA || "",
	};
}

function ghCredentialArgs(): string[] {
	const gh = ghExePath().replaceAll("\\", "/");
	return ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=!\"${gh}\" auth git-credential`];
}

async function assertBareConfig(host: ArchiveHost, cwd: string, expectedUrl: string): Promise<void> {
	const r = await git(host, cwd, ["config", "--local", "--list"]);
	if (r.exitCode !== 0) fail("GIT_STATUS", "bare-config");
	const allow =
		/^(core\.(bare|repositoryformatversion|filemode|logallrefupdates|ignorecase|hookspath|symlinks|precomposeunicode|protectNTFS|longpaths)|remote\.origin\.(url|fetch)|user\.(name|email))$/i;
	for (const line of r.stdout.split(/\r?\n/)) {
		if (!line) continue;
		const eq = line.indexOf("=");
		const key = (eq >= 0 ? line.slice(0, eq) : line).trim();
		const val = eq >= 0 ? line.slice(eq + 1) : "";
		if (!key) continue;
		if (!allow.test(key)) fail("GIT_STATUS", key);
		if (key.toLowerCase() === "remote.origin.url" && val !== expectedUrl) fail("FORBIDDEN_REMOTE", "origin");
	}
}

async function gitNetwork(
	host: ArchiveHost,
	cwd: string,
	args: string[],
	expectedUrl: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	await assertBareConfig(host, cwd, expectedUrl);
	if (!(await ghAuthed(host))) fail("GH_AUTH", "gh auth missing");
	const safe = gitSafeArgs(args);
	return execCmd(host, [resolveGit(), ...GIT_SAFE_ARGS, "-c", "core.worktree=", ...ghCredentialArgs(), "-C", cwd, ...safe], {
		env: gitChildEnv(cwd),
		limits: gitOutputLimits(safe),
	});
}

function gitChildEnv(cwd: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		SystemRoot: process.env.SystemRoot || "C:\\Windows",
		windir: process.env.windir || "C:\\Windows",
		PATH: "",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "NUL",
		GIT_CONFIG_SYSTEM: "NUL",
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_NO_LAZY_FETCH: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "omp-archive",
		GIT_AUTHOR_EMAIL: "omp-archive@local",
		GIT_COMMITTER_NAME: "omp-archive",
		GIT_COMMITTER_EMAIL: "omp-archive@local",
	};
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			if (v === undefined) continue;
			if (/^GIT_CONFIG(_|$)/i.test(k)) continue;
			if (/^GIT_/i.test(k) && !/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/i.test(k)) continue;
			env[k] = v;
		}
	}
	const top = currentPin();
	if (top && samePath(cwd, top.root.path)) {
		env.GIT_DIR = top.gitDir.path;
		env.GIT_COMMON_DIR = top.commonDir.path;
		env.GIT_OBJECT_DIRECTORY = top.objects.path;
		env.GIT_WORK_TREE = top.root.path;
		env.GIT_INDEX_FILE = path.join(top.gitDir.path, "index");
		env.GIT_ATTR_SOURCE = top.gitHead || "HEAD";
	}
	env.GIT_NO_REPLACE_OBJECTS = "1";
	env.GIT_ATTR_NOSYSTEM = "1";
	return env;
}


const GIT_SAFE_ARGS = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=NUL",
	"-c",
	"diff.external=",
	"-c",
	"submodule.recurse=false",
	"-c",
	"attr.tree=HEAD",
	"-c",
	"core.attributesFile=NUL",
];


function gitSafeArgs(args: string[]): string[] {
	const cmd = args[0] ?? "";
	if (cmd === "diff" || cmd === "diff-index" || cmd === "diff-files" || cmd === "show" || cmd === "status") {
		const out = [cmd];
		if (!args.includes("--no-ext-diff") && cmd !== "status") out.push("--no-ext-diff", "--no-textconv");
		if (!args.includes("--ignore-submodules=all") && (cmd === "diff" || cmd === "diff-index" || cmd === "diff-files" || cmd === "status")) {
			out.push("--ignore-submodules=all");
		}
		out.push(...args.slice(1));
		return out;
	}
	return args;
}

async function git(
	host: ArchiveHost,
	cwd: string,
	args: string[],
	extra?: { stdin?: Buffer | string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const top = currentPin();
	const worktree = top && samePath(cwd, top.root.path) ? ["-c", `core.worktree=${top.root.path}`] : ["-c", "core.worktree="];
	const safe = gitSafeArgs(args);
	return execCmd(host, [resolveGit(), ...GIT_SAFE_ARGS, ...worktree, "-C", cwd, ...safe], {
		stdin: extra?.stdin,
		env: gitChildEnv(cwd, extra?.env),
		limits: gitOutputLimits(safe),
	});
}

async function gitMust(host: ArchiveHost, cwd: string, args: string[], code: string): Promise<string> {
	const r = await git(host, cwd, args);
	if (r.exitCode !== 0) fail(code, args[0] || "git");
	return r.stdout;
}

type GitEntry = { mode: string; type: string; sha: string; name: string };

function gitIdentityEnv(): NodeJS.ProcessEnv {
	return {
		GIT_AUTHOR_NAME: "omp-archive",
		GIT_AUTHOR_EMAIL: "omp-archive@local",
		GIT_COMMITTER_NAME: "omp-archive",
		GIT_COMMITTER_EMAIL: "omp-archive@local",
	};
}

function parseLsTree(stdout: string): GitEntry[] {
	const out: GitEntry[] = [];
	for (const rec of stdout.split("\0")) {
		if (!rec) continue;
		const tab = rec.indexOf("\t");
		if (tab < 0) continue;
		const meta = rec.slice(0, tab).split(" ");
		const name = rec.slice(tab + 1);
		if (meta.length < 3 || !name) continue;
		out.push({ mode: meta[0], type: meta[1], sha: meta[2], name });
	}
	return out;
}

function assertGitFile(entry: GitEntry | undefined, label: string): void {
	if (!entry) return;
	if (entry.mode === "120000" || entry.mode === "160000" || entry.type !== "blob") fail("PATH_ESCAPE", label);
	if (entry.mode !== "100644" && entry.mode !== "100755") fail("PATH_ESCAPE", label);
}

function assertGitTree(entry: GitEntry | undefined, label: string): void {
	if (!entry) return;
	if (entry.mode === "120000" || entry.mode === "160000" || entry.type !== "tree") fail("PATH_ESCAPE", label);
}

async function lsTree(host: ArchiveHost, cwd: string, treeish: string, code: string): Promise<GitEntry[]> {
	const r = await git(host, cwd, ["ls-tree", "-z", treeish]);
	if (r.exitCode !== 0) fail(code, "ls-tree");
	return parseLsTree(r.stdout);
}

async function mktree(host: ArchiveHost, cwd: string, entries: GitEntry[], code: string): Promise<string> {
	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	const body = sorted.map(e => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join("\0") + (sorted.length ? "\0" : "");
	const r = await git(host, cwd, ["mktree", "-z"], { stdin: Buffer.from(body) });
	if (r.exitCode !== 0) fail(code, "mktree");
	return r.stdout.trim();
}

async function hashBlob(host: ArchiveHost, cwd: string, bytes: Buffer, code: string): Promise<string> {
	const r = await git(host, cwd, ["hash-object", "-w", "--stdin"], { stdin: bytes });
	if (r.exitCode !== 0) fail(code, "hash-object");
	return r.stdout.trim();
}

async function catBlob(host: ArchiveHost, cwd: string, sha: string, code: string): Promise<string> {
	const r = await git(host, cwd, ["cat-file", "blob", sha]);
	if (r.exitCode !== 0) fail(code, "cat-file");
	return r.stdout;
}

async function upsertBlobPath(
	host: ArchiveHost,
	cwd: string,
	rootTree: string | null,
	filePath: string,
	blobSha: string,
	code: string,
): Promise<string> {
	const parts = filePath.split("/").filter(Boolean);
	const rec = async (treeSha: string | null, i: number): Promise<string> => {
		const name = parts[i];
		const last = i === parts.length - 1;
		const entries = treeSha ? await lsTree(host, cwd, treeSha, code) : [];
		const existing = entries.find(e => e.name === name);
		if (last) {
			assertGitFile(existing, filePath);
			return mktree(host, cwd, [...entries.filter(e => e.name !== name), { mode: "100644", type: "blob", sha: blobSha, name }], code);
		}
		assertGitTree(existing, parts.slice(0, i + 1).join("/"));
		const child = await rec(existing && existing.type === "tree" ? existing.sha : null, i + 1);
		return mktree(host, cwd, [...entries.filter(e => e.name !== name), { mode: "040000", type: "tree", sha: child, name }], code);
	};
	return rec(rootTree, 0);
}

const PUBLISH_MANIFEST = /^runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/manifest\.json$/;

async function buildPublishTree(
	host: ArchiveHost,
	cwd: string,
	rootTree: string | null,
	runId: string,
	blobSha: string,
	code: string,
): Promise<string> {
	const blobs = new Map<string, string>();
	if (rootTree) {
		const listed = await git(host, cwd, ["ls-tree", "-r", "-z", rootTree]);
		if (listed.exitCode !== 0) fail(code, "ls-tree");
		for (const ent of parseLsTree(listed.stdout)) {
			if (ent.mode === "120000" || ent.mode === "160000" || ent.type !== "blob") continue;
			const m = ent.name.match(PUBLISH_MANIFEST);
			if (!m) continue;
			if (ent.mode !== "100644" && ent.mode !== "100755") continue;
			blobs.set(m[1], ent.sha);
		}
	}
	blobs.set(runId, blobSha);
	const runTrees: GitEntry[] = [];
	for (const [id, sha] of blobs) {
		const fileTree = await mktree(host, cwd, [{ mode: "100644", type: "blob", sha, name: "manifest.json" }], code);
		runTrees.push({ mode: "040000", type: "tree", sha: fileTree, name: id });
	}
	const runsTree = await mktree(host, cwd, runTrees, code);
	const root = await mktree(host, cwd, [{ mode: "040000", type: "tree", sha: runsTree, name: "runs" }], code);
	const verify = await git(host, cwd, ["ls-tree", "-r", "--name-only", "-z", root]);
	if (verify.exitCode !== 0) fail(code, "ls-tree");
	for (const p of verify.stdout.split("\0")) {
		if (p && !PUBLISH_MANIFEST.test(p)) fail("PATH_ESCAPE", p);
	}
	return root;
}


function writeJson(file: string, body: unknown, root = archiveRoot()): string {
	const text = `${JSON.stringify(body, null, 2)}\n`;
	writeLocalFile(path.dirname(file), path.basename(file), text, root);
	return sha256(text);
}

function ensureArchiveSchema(): void {
	const db = openControlDb();
	db.exec(`
CREATE TABLE IF NOT EXISTS archive_bindings (
	project_id TEXT PRIMARY KEY,
	archive_repo TEXT NOT NULL,
	url TEXT NOT NULL,
	private INTEGER NOT NULL,
	bound_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_sessions (
	session_id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	run_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_manifests (
	project_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	sha TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'prepared',
	payload TEXT NOT NULL DEFAULT '',
	claim_token TEXT,
	claim_expires INTEGER,
	published INTEGER NOT NULL DEFAULT 0,
	remote_commit TEXT,
	PRIMARY KEY (project_id, run_id)
);
CREATE TABLE IF NOT EXISTS archive_git_pins (
	project_id TEXT PRIMARY KEY,
	git_dir_vol INTEGER NOT NULL,
	git_dir_index TEXT NOT NULL,
	common_dir_vol INTEGER NOT NULL,
	common_dir_index TEXT NOT NULL,
	objects_vol INTEGER NOT NULL,
	objects_index TEXT NOT NULL
);
`);
	for (const col of [
		"published INTEGER NOT NULL DEFAULT 0",
		"remote_commit TEXT",
		"state TEXT NOT NULL DEFAULT 'prepared'",
		"payload TEXT NOT NULL DEFAULT ''",
		"claim_token TEXT",
		"claim_expires INTEGER",
	]) {
		try {
			db.exec(`ALTER TABLE archive_manifests ADD COLUMN ${col}`);
		} catch {
			/* already present */
		}
	}
}

function getBinding(projectId: string): Binding | null {
	ensureArchiveSchema();
	const row = openControlDb()
		.query<{ archive_repo: string; url: string; private: number; bound_at: number }, [string]>(
			"SELECT archive_repo, url, private, bound_at FROM archive_bindings WHERE project_id = ?",
		)
		.get(projectId);
	if (!row) return null;
	return { archiveRepo: row.archive_repo, url: row.url, private: row.private === 1, boundAt: row.bound_at };
}

function putBinding(projectId: string, binding: Binding): Binding {
	ensureArchiveSchema();
	const db = openControlDb();
	db.transaction(() => {
		db.query(
			`INSERT INTO archive_bindings (project_id, archive_repo, url, private, bound_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(project_id) DO UPDATE SET
			 	archive_repo = excluded.archive_repo,
			 	url = excluded.url,
			 	private = excluded.private,
			 	bound_at = excluded.bound_at`,
		).run(projectId, binding.archiveRepo, binding.url, binding.private ? 1 : 0, binding.boundAt);
	}).immediate();
	return binding;
}

function bindSession(sessionId: string, projectId: string, runId: string): void {
	ensureArchiveSchema();
	const db = openControlDb();
	db.transaction(() => {
		db.query(
			`INSERT INTO archive_sessions (session_id, project_id, run_id) VALUES (?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, run_id = excluded.run_id`,
		).run(sessionId, projectId, runId);
	}).immediate();
}

function sessionCols(db: Database): Set<string> {
	try {
		return new Set(db.query<{ name: string }, []>("PRAGMA table_info(archive_sessions)").all().map(c => c.name));
	} catch {
		return new Set();
	}
}

function peekSessionRun(
	db: Database,
	sessionId: string,
	projectId: string,
): { session_id: string; project_id: string; run_id: string } | null {
	const sNames = sessionCols(db);
	const rNames = runsCols(db);
	if (!sNames.has("session_id") || !sNames.has("project_id") || !sNames.has("run_id")) return null;
	if (!rNames.has("id") || !rNames.has("project_id")) return null;
	const extra: string[] = [];
	if (rNames.has("status")) extra.push("r.status AS run_status");
	try {
		const row = db
			.query<Record<string, unknown>, [string]>(
				`SELECT s.session_id AS session_id, s.project_id AS session_project_id, s.run_id AS session_run_id,
					r.id AS run_id, r.project_id AS run_project_id${extra.length ? `, ${extra.join(", ")}` : ""}
				 FROM archive_sessions s
				 INNER JOIN runs r ON r.id = s.run_id
				 WHERE s.session_id = ?`,
			)
			.get(sessionId);
		if (!row) return null;
		const runId = String(row.run_id ?? "");
		if (!SAFE_ID.test(runId)) return null;
		const sessProj = String(row.session_project_id ?? "");
		const runProj = String(row.run_project_id ?? "");
		if (sessProj !== projectId || runProj !== projectId) return null;
		if (rNames.has("status") && row.run_status != null && String(row.run_status).length > 0) {
			const st = String(row.run_status).toLowerCase();
			if (st === "cancelled" || st === "aborted" || st === "deleted") return null;
		}
		return { session_id: String(row.session_id ?? sessionId), project_id: projectId, run_id: runId };
	} catch {
		return null;
	}
}

function sessionRun(sessionId: string, projectId: string): { session_id: string; project_id: string; run_id: string } | null {
	try {
		return withPreauth(db => peekSessionRun(db, sessionId, projectId));
	} catch (err) {
		if (err instanceof ArchiveError && err.code === "UNINITIALIZED") return null;
		throw err;
	}
}


type ManifestRow = {
	sha: string;
	state: string;
	payload: string;
	claim_token: string | null;
	claim_expires: number | null;
	published: number;
	remote_commit: string | null;
};

function hasFrozenPayload(row: ManifestRow): boolean {
	return typeof row.payload === "string" && row.payload.length > 0;
}

function requireFrozenPayload(row: ManifestRow): ManifestRow {
	if (!hasFrozenPayload(row)) fail("NOT_MIGRATED", "payload");
	return row;
}

function getManifestRow(projectId: string, runId: string): ManifestRow | null {
	ensureArchiveSchema();
	const row = openControlDb()
		.query<ManifestRow, [string, string]>(
			"SELECT sha, state, payload, claim_token, claim_expires, published, remote_commit FROM archive_manifests WHERE project_id = ? AND run_id = ?",
		)
		.get(projectId, runId);
	if (!row) return null;
	if (!row.state) row.state = row.published === 1 ? "published" : "prepared";
	return row;
}

function insertPreparedManifest(projectId: string, runId: string, sha: string, payload: string): { won: boolean; row: ManifestRow } {
	if (!payload) fail("NOT_MIGRATED", "payload");
	ensureArchiveSchema();
	const db = openControlDb();
	return db.transaction(() => {
		const info = db
			.query(
				`INSERT OR IGNORE INTO archive_manifests (project_id, run_id, sha, state, payload, published, remote_commit)
				 VALUES (?, ?, ?, 'prepared', ?, 0, NULL)`,
			)
			.run(projectId, runId, sha, payload);
		const row = getManifestRow(projectId, runId);
		if (!row) fail("MANIFEST_SHA", "missing");
		requireFrozenPayload(row);
		return { won: info.changes === 1, row };
	})();
}

const CLAIM_TTL_MS = 120_000;

function claimPublishing(projectId: string, runId: string, sha: string): { token: string } | { published: true } {
	ensureArchiveSchema();
	const token = crypto.randomBytes(16).toString("hex");
	const now = Date.now();
	const exp = now + CLAIM_TTL_MS;
	const db = openControlDb();
	return db.transaction(() => {
		const row = getManifestRow(projectId, runId);
		if (!row || row.sha !== sha) fail("MANIFEST_SHA", "missing");
		if (row.state === "published" || row.published === 1) return { published: true as const };
		if (row.state === "publishing" && row.claim_token && (row.claim_expires ?? 0) > now) fail("ARCHIVE_BUSY", "claim");
		const info = db
			.query(
				`UPDATE archive_manifests SET state = 'publishing', claim_token = ?, claim_expires = ?
				 WHERE project_id = ? AND run_id = ? AND sha = ?
				   AND (state = 'prepared' OR (state = 'publishing' AND (claim_expires IS NULL OR claim_expires <= ?)))`,
			)
			.run(token, exp, projectId, runId, sha, now);
		if (info.changes !== 1) fail("ARCHIVE_BUSY", "claim");
		return { token };
	})();
}

function casOwned(
	projectId: string,
	runId: string,
	sha: string,
	from: string,
	to: string,
	token: string,
	remoteCommit?: string,
): void {
	ensureArchiveSchema();
	const info = openControlDb()
		.query(
			`UPDATE archive_manifests
			 SET state = ?, published = ?, claim_token = ?, claim_expires = ?, remote_commit = COALESCE(?, remote_commit)
			 WHERE project_id = ? AND run_id = ? AND sha = ? AND state = ? AND claim_token = ?`,
		)
		.run(
			to,
			to === "published" ? 1 : 0,
			to === "published" || to === "prepared" ? null : token,
			to === "publishing" ? Date.now() + CLAIM_TTL_MS : null,
			remoteCommit ?? null,
			projectId,
			runId,
			sha,
			from,
			token,
		);
	if (info.changes !== 1) fail("ARCHIVE_BUSY", "cas");
}

function releaseClaim(projectId: string, runId: string, sha: string, token: string): void {
	ensureArchiveSchema();
	openControlDb()
		.query(
			`UPDATE archive_manifests SET state = 'prepared', claim_token = NULL, claim_expires = NULL, published = 0
			 WHERE project_id = ? AND run_id = ? AND sha = ? AND state = 'publishing' AND claim_token = ?`,
		)
		.run(projectId, runId, sha, token);
}

function expectedManifestSha(projectId: string, runId: string): string {
	const row = getManifestRow(projectId, runId);
	if (!row || !row.sha) fail("MANIFEST_SHA", "missing");
	return row.sha;
}


function requireSafeId(value: string, label: string): string {
	if (!SAFE_ID.test(value)) fail("INVALID", label);
	return value;
}
function safeProjectId(value: string): string {
	if (!SAFE_ID.test(value)) fail("QUARANTINE", "projectId");
	return value;
}

function parseRemoteManifest(raw: unknown, projectId: string, runId: string): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("MANIFEST_SHA", "schema");
	const rec = raw as Record<string, unknown>;
	const keys = Object.keys(rec);
	const allowed = [...REMOTE_MANIFEST_FIELDS];
	if (keys.length !== allowed.length || allowed.some(k => !keys.includes(k))) fail("MANIFEST_SHA", "schema");
	if (rec.schema !== REMOTE_MANIFEST_SCHEMA) fail("MANIFEST_SHA", "schema");
	if (rec.projectId !== projectId || rec.runId !== runId) fail("MANIFEST_SHA", "identity");
	if (typeof rec.projectId !== "string" || !SAFE_ID.test(rec.projectId)) fail("MANIFEST_SHA", "projectId");
	if (typeof rec.runId !== "string" || !SAFE_ID.test(rec.runId)) fail("MANIFEST_SHA", "runId");
	if (typeof rec.gitHead !== "string" || !HEX40.test(rec.gitHead)) fail("MANIFEST_SHA", "gitHead");
	if (typeof rec.status !== "string" || !REMOTE_STATUS.has(rec.status)) fail("MANIFEST_SHA", "status");
	if (typeof rec.createdAt !== "string" || !ISO_Z.test(rec.createdAt)) fail("MANIFEST_SHA", "createdAt");
	if (typeof rec.changedCount !== "number" || !Number.isInteger(rec.changedCount) || rec.changedCount < 0) fail("MANIFEST_SHA", "changedCount");
	if (typeof rec.untrackedCount !== "number" || !Number.isInteger(rec.untrackedCount) || rec.untrackedCount < 0) {
		fail("MANIFEST_SHA", "untrackedCount");
	}
	if (rec.baselineSha !== null && (typeof rec.baselineSha !== "string" || !HEX64.test(rec.baselineSha))) {
		fail("MANIFEST_SHA", "baselineSha");
	}
	return rec;
}

function buildRemoteManifest(input: {
	projectId: string;
	runId: string;
	gitHead: string;
	status: "PASS" | "FAIL";
	createdAt: string;
	changedCount: number;
	untrackedCount: number;
	baselineSha: string | null;
}): Record<string, unknown> {
	const gitHead = input.gitHead.trim().toLowerCase();
	if (!HEX40.test(gitHead)) fail("GIT_STATUS", "HEAD");
	if (input.baselineSha && !HEX64.test(input.baselineSha)) fail("INVALID", "baselineSha");
	return {
		schema: REMOTE_MANIFEST_SCHEMA,
		projectId: requireSafeId(input.projectId, "projectId"),
		runId: requireSafeId(input.runId, "runId"),
		gitHead,
		status: input.status,
		createdAt: input.createdAt,
		changedCount: input.changedCount,
		untrackedCount: input.untrackedCount,
		baselineSha: input.baselineSha,
	};
}

function projectCols(db: Database): Set<string> {
	try {
		return new Set(db.query<{ name: string }, []>("PRAGMA table_info(projects)").all().map(c => c.name));
	} catch {
		return new Set();
	}
}

function projectSelectSql(db: Database): string | null {
	const names = projectCols(db);
	if (!names.has("id") || !names.has("canonical_root")) return null;
	const cols = ["id", "canonical_root"];
	for (const c of [
		"allowed_roots",
		"created_at",
		"owner",
		"root_vol",
		"root_index",
		"git_dir",
		"git_dir_vol",
		"git_dir_index",
		"common_dir",
		"common_dir_vol",
		"common_dir_index",
	]) {
		if (names.has(c)) cols.push(c);
	}
	return `SELECT ${cols.join(", ")} FROM projects`;
}

function normalizeProject(row: Record<string, unknown>): ProjectRow {
	return {
		id: String(row.id),
		canonical_root: String(row.canonical_root),
		allowed_roots: typeof row.allowed_roots === "string" ? row.allowed_roots : "[]",
		created_at: typeof row.created_at === "number" ? row.created_at : 0,
		owner: typeof row.owner === "string" ? row.owner : "",
		root_vol: typeof row.root_vol === "number" ? row.root_vol : null,
		root_index: typeof row.root_index === "string" ? row.root_index : null,
		git_dir: typeof row.git_dir === "string" ? row.git_dir : null,
		git_dir_vol: typeof row.git_dir_vol === "number" ? row.git_dir_vol : null,
		git_dir_index: typeof row.git_dir_index === "string" ? row.git_dir_index : null,
		common_dir: typeof row.common_dir === "string" ? row.common_dir : null,
		common_dir_vol: typeof row.common_dir_vol === "number" ? row.common_dir_vol : null,
		common_dir_index: typeof row.common_dir_index === "string" ? row.common_dir_index : null,
	};
}

function peekProjectById(db: Database, id: string): ProjectRow | null {
	const sql = projectSelectSql(db);
	if (!sql) return null;
	const row = db.query<Record<string, unknown>, [string]>(`${sql} WHERE id = ?`).get(id);
	return row ? normalizeProject(row) : null;
}

function peekProjectByCwd(db: Database, cwd: string): ProjectRow | null {
	const sql = projectSelectSql(db);
	if (!sql) return null;
	const rows = db.query<Record<string, unknown>, []>(sql).all();
	const resolved = path.resolve(cwd);
	for (const raw of rows) {
		const row = normalizeProject(raw);
		const roots = [row.canonical_root, ...jsonArr(row.allowed_roots)];
		if (roots.some(root => isUnder(root, resolved))) return row;
	}
	return null;
}

function findProject(cwd: string): ProjectRow | null {
	return peekProjectByCwd(openControlDb(), cwd);
}


function runsCols(db: Database): Set<string> {
	try {
		return new Set(db.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map(c => c.name));
	} catch {
		return new Set();
	}
}

function peekRequireRun(db: Database, projectId: string, runId: string, sessionId?: string): void {
	const names = runsCols(db);
	if (!names.has("id") || !names.has("project_id")) fail("NOT_MIGRATED", "runs");
	const cols = ["id", "project_id"];
	if (names.has("owner")) cols.push("owner");
	if (names.has("status")) cols.push("status");
	let row: Record<string, unknown> | null = null;
	try {
		row = db.query<Record<string, unknown>, [string]>(`SELECT ${cols.join(", ")} FROM runs WHERE id = ?`).get(runId);
	} catch {
		fail("NOT_MIGRATED", "runs");
	}
	if (!row) fail("NOT_FOUND", "run");
	if (String(row.project_id) !== projectId) fail("FOREIGN_RUN", "run");
	if (sessionId) {
		if (!names.has("owner")) fail("NOT_MIGRATED", "run ownership");
		if (row.owner !== sessionId) fail("RUN_OWNER_MISMATCH", runId);
	}
	if (names.has("status") && row.status != null && String(row.status).length > 0) {
		const st = String(row.status).toLowerCase();
		if (st === "cancelled" || st === "aborted" || st === "deleted") fail("NOT_FOUND", "run");
	}
}

function requireRun(projectId: string, runId: string): void {
	const id = safeRunId(need(runId, "runId"));
	withPreauth(db => peekRequireRun(db, projectId, id));
}


async function assertSafeLocalGitConfig(host: ArchiveHost, cwd: string): Promise<void> {


	const danger =
		/^(core\.fsmonitor|core\.hookspath|core\.worktree|core\.attributesfile|diff\.external|credential\.helper|core\.sshcommand|core\.pager|core\.editor|submodule\.recurse|extensions\.partialclone|extensions\.worktreeconfig|core\.partialclonefilter)$/i;
	const filter = /^filter\.[^.]+\.(process|smudge|clean)$/i;
	const diffCmd = /^diff\.[^.]+\.(textconv|command|external)$/i;
	const mergeCmd = /^merge\.[^.]+\.(driver|name)$/i;
	const partial = /^remote\.[^.]+\.(promisor|partialclonefilter)$/i;
	const include = /^(include\.path|includeif\..+)/i;
	const scan = (stdout: string) => {
		for (const line of stdout.split(/\r?\n/)) {
			const eq = line.indexOf("=");
			const key = (eq >= 0 ? line.slice(0, eq) : line).trim();
			if (!key) continue;
			if (danger.test(key) || filter.test(key) || diffCmd.test(key) || mergeCmd.test(key) || partial.test(key) || include.test(key)) {
				fail("GIT_STATUS", key);
			}
		}
	};
	const scanOrigin = (stdout: string) => {
		for (const line of stdout.split(/\r?\n/)) {
			if (!line) continue;
			if (/^blob:/i.test(line) || /\tblob:/i.test(line)) fail("GIT_STATUS", "include-blob");
			const tab = line.indexOf("\t");
			const origin = (tab >= 0 ? line.slice(0, tab) : line).trim();
			if (/^blob:/i.test(origin)) fail("GIT_STATUS", "include-blob");
			const rest = tab >= 0 ? line.slice(tab + 1) : "";
			const eq = rest.indexOf("=");
			const key = (eq >= 0 ? rest.slice(0, eq) : rest).trim();
			if (include.test(key)) fail("GIT_STATUS", key);
		}
	};
	const local = await git(host, cwd, ["config", "--local", "--list"]);
	if (local.exitCode === 0) scan(local.stdout);
	const worktree = await git(host, cwd, ["config", "--worktree", "--list"]);
	if (worktree.exitCode === 0) scan(worktree.stdout);
	const shown = await git(host, cwd, ["config", "--local", "--list", "--show-origin"]);
	if (shown.exitCode === 0) scanOrigin(shown.stdout);
	const shownWt = await git(host, cwd, ["config", "--worktree", "--list", "--show-origin"]);
	if (shownWt.exitCode === 0) scanOrigin(shownWt.stdout);
}

async function assertGitRoot(host: ArchiveHost, root: string): Promise<string> {
	await assertSafeLocalGitConfig(host, root);
	const top = await git(host, root, ["rev-parse", "--show-toplevel"]);
	if (top.exitCode !== 0) fail("NOT_GIT_ROOT", "root");
	const resolvedTop = pinD(top.stdout.trim(), "git top");
	if (resolvedTop.toLowerCase() !== pinD(root, "git root").toLowerCase()) fail("NOT_GIT_ROOT", "root");
	const pin = currentPin();
	if (pin) {
		const head = (await gitMust(host, root, ["rev-parse", "HEAD"], "GIT_STATUS")).trim().toLowerCase();
		if (!HEX40.test(head)) fail("GIT_STATUS", "HEAD");
		pin.gitHead = head;
	}
	return resolvedTop;
}

function listArtifacts(root: string): { path: string; sha: string }[] {
	const omp = path.join(root, ".omp");
	const out: { path: string; sha: string }[] = [];
	if (!fs.existsSync(omp)) return out;
	const walk = (dir: string, rel: string) => {
		for (const name of fs.readdirSync(dir)) {
			const relPath = path.join(rel, name);
			if (deniedName(relPath) || deniedName(name)) continue;
			const full = path.join(dir, name);
			const lst = fs.lstatSync(full);
			if (isReparse(lst)) continue;
			if (lst.isDirectory()) walk(full, relPath);
			else if (lst.isFile()) out.push({ path: relPath.replaceAll("\\", "/"), sha: sha256(readNoFollow(full).bytes) });
		}
	};
	walk(omp, ".omp");
	return out;
}

function controlRecords(
	projectId: string,
	runId: string,
): { run: Record<string, unknown> | null; events: unknown[]; tasks: unknown[]; secret: boolean } {
	const db = openControlDb();
	const run = db
		.query<{ id: string; project_id: string; started_at: number }, [string, string]>(
			"SELECT id, project_id, started_at FROM runs WHERE id = ? AND project_id = ?",
		)
		.get(runId, projectId);
	const events = db
		.query<{ id: number; type: string; payload_sha: string; created_at: number; run_id: string | null }, [string, string]>(
			"SELECT id, type, payload_sha, created_at, run_id FROM events WHERE project_id = ? AND run_id = ? ORDER BY id ASC",
		)
		.all(projectId, runId)
		.map(row => ({
			id: row.id,
			type: row.type,
			payload_sha: row.payload_sha,
			created_at: row.created_at,
			run_id: row.run_id,
		}));
	const tasks = events.filter(e => e.type === "task" || e.type.startsWith("task_"));
	return {
		run: run ? { id: run.id, project_id: run.project_id, started_at: run.started_at } : null,
		events,
		tasks,
		secret: false,
	};
}

export function scanArchiveDir(dir: string): { ok: boolean; denied: string[]; findings: string[] } {
	const denied: string[] = [];
	const findings: string[] = [];
	if (!fs.existsSync(dir)) return { ok: false, denied: ["missing-dir"], findings: ["archive dir missing"] };
	try {
		if (isReparse(fs.lstatSync(dir))) return { ok: false, denied: ["symlink"], findings: ["symlink"] };
	} catch {
		return { ok: false, denied: ["missing-dir"], findings: ["archive dir missing"] };
	}
	const skipRemote: Record<string, true> = { "local.patch": true, "git-status.local.txt": true };
	const walk = (cur: string, rel: string) => {
		for (const name of fs.readdirSync(cur)) {
			const relPath = rel ? `${rel}/${name}` : name;
			const full = path.join(cur, name);
			const lst = fs.lstatSync(full);
			if (isReparse(lst)) {
				denied.push(relPath);
				findings.push("symlink");
				continue;
			}
			if (lst.isDirectory()) {
				if (deniedName(relPath)) {
					denied.push(relPath);
					findings.push("deny-name");
				} else walk(full, relPath);
				continue;
			}
			if (skipRemote[name] || skipRemote[relPath]) continue;
			if (deniedName(relPath) || deniedName(name)) {
				denied.push(relPath);
				findings.push("deny-name");
				continue;
			}
			if (!lst.isFile()) continue;
			let text = "";
			try {
				text = readNoFollow(full).bytes.toString("utf8");
			} catch {
				denied.push(relPath);
				findings.push("symlink");
				continue;
			}
			if (SECRET_TEXT.test(text)) {
				denied.push(relPath);
				findings.push("secret-text");
			}
			if (name.endsWith(".json")) {
				LOCAL_PATH_RE.lastIndex = 0;
				if (LOCAL_PATH_RE.test(text)) {
					denied.push(relPath);
					findings.push("local-path");
				}
			}
		}
	};
	walk(dir, "");
	return { ok: denied.length === 0, denied, findings };
}

type HeadScan = { ok: boolean; findings: string[]; denied: string[] };
const headScans = new Map<string, Promise<HeadScan>>();
export async function scanHeadTree(host: ArchiveHost, root: string): Promise<HeadScan> {
	const head = (await gitMust(host, root, ["rev-parse", "--verify", "HEAD"], "GIT_STATUS")).trim();
	if (!/^[a-f0-9]{40,64}$/i.test(head)) fail("GIT_STATUS", "head oid");
	const key = `${path.resolve(root).toLowerCase()}:${head}`;
	let pending = headScans.get(key);
	if (!pending) {
		pending = scanCommitTree(host, root, head);
		headScans.set(key, pending);
		if (headScans.size > 32) headScans.delete(headScans.keys().next().value!);
		pending.catch(() => { if (headScans.get(key) === pending) headScans.delete(key); });
	}
	const result = await pending;
	return { ...result, findings: [...result.findings], denied: [...result.denied] };
}

async function scanCommitTree(host: ArchiveHost, root: string, head: string): Promise<HeadScan> {
	const findings: string[] = [];
	const denied: string[] = [];
	const headNames = await git(host, root, ["ls-tree", "-r", "--name-only", "-z", head]);
	if (headNames.exitCode !== 0) fail("GIT_STATUS", "ls-tree");
	for (const p of parseZ(headNames.stdout)) {
		if (deniedName(p)) { findings.push("tracked-deny"); denied.push(p); }
	}

	const grep = await git(host, root, [
		"grep",
		"-l",
		"-z",
		"-I",
		"-E",
		"-e",
		"BEGIN [A-Z ]*PRIVATE KEY",
		"-e",
		"gh[pousr]_[A-Za-z0-9]{8,}",
		"-e",
		"github_pat_",
		"-e",
		"AKIA[0-9A-Z]{16}",
		head,
	]);
	if (grep.exitCode === 0) {
		findings.push("tracked-secret-content");
		for (const name of parseZ(grep.stdout)) denied.push(name.startsWith(`${head}:`) ? name.slice(head.length + 1) : name);
	}
	else if (grep.exitCode !== 1) fail("GIT_STATUS", "grep");
	return { ok: findings.length === 0, findings, denied: [...new Set(denied)] };
}

async function ghAuthed(host: ArchiveHost): Promise<boolean> {
	if (host.ghAuth) return host.ghAuth();
	const r = await execCmd(host, [ghExePath(), "auth", "status", "--hostname", "github.com"], { env: ghChildEnv() });
	return r.exitCode === 0;
}

async function repoIsPrivate(host: ArchiveHost, fullName: string): Promise<boolean> {
	if (host.ghRepoPrivate) {
		const v = await host.ghRepoPrivate(fullName);
		if (v === false) return false;
		if (v === true) return true;
	}
	const r = await execCmd(host, [ghExePath(), "repo", "view", fullName, "--json", "isPrivate,visibility"], { env: ghChildEnv() });
	if (r.exitCode !== 0) fail("GH_AUTH", "repo view");
	try {
		const j: unknown = JSON.parse(r.stdout);
		if (!j || typeof j !== "object") fail("GH_AUTH", "repo view");
		const rec = j as { isPrivate?: unknown; visibility?: unknown };
		return rec.isPrivate === true || rec.visibility === "PRIVATE";
	} catch (err) {
		if (err instanceof ArchiveError) throw err;
		fail("GH_AUTH", "repo view");
	}
}

async function requireGithubPrivate(host: ArchiveHost, spec: string): Promise<RemoteClass & { kind: "github" }> {
	const remote = requireArchiveRemote(spec);
	if (!(await ghAuthed(host))) fail("GH_AUTH", "auth");
	if (!(await repoIsPrivate(host, remote.fullName))) fail("NOT_PRIVATE", "repo");
	return remote;
}

async function withTarget<T>(
	input: ArchiveInput,
	host: ArchiveHost,
	sessionId: string | undefined,
	fn: (t: { project: ProjectRow; cwd: string; runId: string; slug: string; pin: SourcePin }) => Promise<T>,
): Promise<T> {
	const sid = requireSession(sessionId);
	if (input.cwd && driveOf(input.cwd) !== "D") fail("NOT_D_ROOT", "cwd");
	const { project, runId } = withPreauth(db => {
		const row = input.projectId ? peekProjectById(db, input.projectId) : peekProjectByCwd(db, need(input.cwd, "cwd"));
		if (!row) fail(input.projectId ? "NOT_FOUND" : "NOT_REGISTERED", input.projectId ? "project" : "cwd");
		requireProjectOwner(row, sid);
		safeProjectId(row.id);
		const id = safeRunId(need(input.runId, "runId"));
		peekRequireRun(db, row.id, id, sid);
		requireControlGitIdentity(row);
		return { project: row, runId: id };

	});
	openControlDb();
	ensureArchiveSchema();
	requireControlGitIdentity(project);
	const source = holdProjectRoot(project);
	let layout: { gitDir: HeldDir; commonDir: HeldDir; objects: HeldDir } | null = null;
	let extra: PinnedBareConfig[] = [];
	try {
		layout = holdGitLayout(source);
		extra = pinGitInputFiles(source, layout.gitDir, layout.commonDir);
		extra.push(...pinGitBarriers(layout.gitDir, layout.commonDir, layout.objects));
	} catch (err) {
		for (let i = extra.length - 1; i >= 0; i--) closeHandle(extra[i].handle);
		if (layout) {
			closeHandle(layout.objects.handle);
			closeHandle(layout.commonDir.handle);
			closeHandle(layout.gitDir.handle);
		}
		closeHandle(source.handle);
		throw err;
	}
	const pin: SourcePin = {
		row: project,
		root: source,
		gitDir: layout.gitDir,
		commonDir: layout.commonDir,
		objects: layout.objects,
		extra,
	};
	try {
		return await sourcePinStore.run(pin, async () => {
			assertSourceIdentity();
			await assertGitRoot(host, source.path);
			assertSourceIdentity();
			return fn({ project, cwd: source.path, runId, slug: slugOf(source.path, project.id), pin });
		});
	} finally {
		closeSourcePin(pin);
	}
}


function parseZ(stdout: string): string[] {
	if (!stdout) return [];
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i <= stdout.length; i++) {
		if (i === stdout.length || stdout.charCodeAt(i) === 0) {
			if (i > start) {
				out.push(stdout.slice(start, i));
				if (out.length > GIT_PATH_ENTRY_CAP) fail("GIT_OUTPUT_TOO_LARGE", "entries");
			}
			start = i + 1;
		}
	}
	return out;
}


async function snapshotGit(host: ArchiveHost, cwd: string): Promise<GitSnap> {
	await assertSafeLocalGitConfig(host, cwd);
	assertSourceIdentity();
	const head = (await gitMust(host, cwd, ["rev-parse", "HEAD"], "GIT_STATUS")).trim();
	const br = await git(host, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = br.exitCode === 0 ? br.stdout.trim() : "";
	const cached = await git(host, cwd, ["diff-index", "--cached", "--name-only", "-z", "HEAD"]);
	if (cached.exitCode !== 0) fail("GIT_STATUS", "diff-index");
	const work = await git(host, cwd, ["diff-files", "--name-only", "-z"]);
	if (work.exitCode !== 0) fail("GIT_STATUS", "diff-files");
	const untr = await git(host, cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
	if (untr.exitCode !== 0) fail("GIT_STATUS", "ls-files");
	const changed = [...new Set([...parseZ(cached.stdout), ...parseZ(work.stdout)])];
	const untracked = parseZ(untr.stdout);
	const status = [...changed.map(p => ` M ${p}`), ...untracked.map(p => `?? ${p}`)].join("\n");
	const diff = await git(host, cwd, ["diff-index", "--stat", "HEAD"]);
	assertSourceIdentity();
	return {
		head,
		branch,
		dirty: changed.length > 0 || untracked.length > 0,
		status,
		diffStat: diff.exitCode === 0 ? diff.stdout.trim() : "",
		untracked,
		changed,
	};
}

function mergeSecurity(
	parts: { ok: boolean; findings: string[]; denied?: string[] }[],
): { ok: boolean; denied: string[]; findings: string[] } {
	const denied: string[] = [];
	const findings: string[] = [];
	for (const p of parts) {
		if (p.denied) denied.push(...p.denied);
		findings.push(...p.findings);
	}
	return { ok: parts.every(p => p.ok), denied: [...new Set(denied)], findings };
}

export async function prepareArchive(
	input: ArchiveInput,
	host: ArchiveHost = {},
	sessionId?: string,
): Promise<Record<string, unknown>> {
	const sid = requireSession(sessionId);
	return withTarget(input, host, sid, async ({ project, cwd, runId, slug }) => {
		if (input.archiveRepo) {
			const remote = requireArchiveRemote(input.archiveRepo);
			putBinding(project.id, {
				archiveRepo: remote.fullName,
				private: true,
				url: remote.url,
				boundAt: nowMs(host),
			});
		}
		bindSession(sid, project.id, runId);
		const dir = pinArchiveDir(slug, runId);
		const existing = getManifestRow(project.id, runId);
		if (existing) {
			requireFrozenPayload(existing);
			writeLocalFile(dir, "manifest.json", existing.payload);
			const enq = await dispatchControl(
				{ action: "outbox_enqueue", projectId: project.id, runId, id: outboxId(project.id, runId), payload: JSON.stringify({ kind: "omp-archive", projectId: project.id, runId }) },
				{ sessionId: sid },
			);
			const binding = getBinding(project.id);
			return {
				ok: true,
				action: "prepare",
				projectId: project.id,
				runId,
				slug,
				archiveKey: `${slug}/${runId}`,
				manifestSha: existing.sha,
				copiedUntracked: false,
				duplicate: true,
				queued: !binding,
				bound: Boolean(binding),
				outboxId: outboxId(project.id, runId),
				outboxStatus: enq.status,
			};
		}
		const gitSnap = await snapshotGit(host, cwd);
		const baselinePath = path.join(cwd, ".omp", "baseline.json");
		const baselineSha = fs.existsSync(baselinePath) && !isReparse(fs.lstatSync(baselinePath))
			? sha256(readNoFollow(baselinePath).bytes)
			: null;
		const records = controlRecords(project.id, runId);
		if (gitSnap.dirty) {
			const patch = await git(host, cwd, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--ignore-submodules=all", "HEAD"]);
			if (patch.exitCode !== 0) fail("GIT_DIFF", "patch");
			writeLocalFile(dir, "local.patch", patch.stdout);
			writeLocalFile(dir, "git-status.local.txt", gitSnap.status);
		} else {
			unlinkLocalFile(dir, "local.patch");
			unlinkLocalFile(dir, "git-status.local.txt");
		}
		writeJson(path.join(dir, "git.json"), {
			head: gitSnap.head.trim().toLowerCase(),
			changedCount: gitSnap.changed.length,
			untrackedCount: gitSnap.untracked.length,
		});
		const headScan = await scanHeadTree(host, cwd);
		const disk = scanArchiveDir(dir);
		const security = mergeSecurity([
			disk,
			headScan,
			{ ok: !records.secret, findings: records.secret ? ["event-secret"] : [] },
		]);
		writeJson(path.join(dir, "security.json"), {
			ok: security.ok,
			result: security.ok ? "PASS" : "FAIL",
			denied: security.denied,
			findings: security.findings,
		});
		const remoteManifest = buildRemoteManifest({
			projectId: project.id,
			runId,
			gitHead: gitSnap.head,
			status: security.ok ? "PASS" : "FAIL",
			createdAt: new Date(nowMs(host)).toISOString(),
			changedCount: gitSnap.changed.length,
			untrackedCount: gitSnap.untracked.length,
			baselineSha,
		});
		const frozenPayload = `${JSON.stringify(remoteManifest, null, 2)}\n`;
		const { won, row } = insertPreparedManifest(project.id, runId, sha256(frozenPayload), frozenPayload);
		writeLocalFile(dir, "manifest.json", row.payload);
		const enq = await dispatchControl(
			{ action: "outbox_enqueue", projectId: project.id, runId, id: outboxId(project.id, runId), payload: JSON.stringify({ kind: "omp-archive", projectId: project.id, runId }) },
			{ sessionId: sid },
		);
		const binding = getBinding(project.id);
		return {
			ok: true,
			action: "prepare",
			projectId: project.id,
			runId,
			slug,
			archiveKey: `${slug}/${runId}`,
			manifestSha: row.sha,
			dirty: gitSnap.dirty,
			localPatch: gitSnap.dirty,
			copiedUntracked: false,
			security: security.ok ? "PASS" : "FAIL",
			duplicate: !won,
			queued: !binding,
			bound: Boolean(binding),
			outboxId: outboxId(project.id, runId),
			outboxStatus: enq.status,
		};
	});
}

export async function verifyArchive(input: ArchiveInput, host: ArchiveHost = {}, sessionId?: string): Promise<Record<string, unknown>> {
	const sid = requireSession(sessionId);
	return withTarget(input, host, sid, async ({ project, cwd, runId, slug }) => {
		const dir = archiveDir(slug, runId);
		if (!fs.existsSync(path.join(dir, "manifest.json"))) {
			await prepareArchive({ action: "prepare", projectId: project.id, runId, cwd: input.cwd, archiveRepo: input.archiveRepo }, host, sid);
		}
		const headScan = await scanHeadTree(host, cwd);
		const disk = scanArchiveDir(pinArchiveDir(slug, runId));
		const records = controlRecords(project.id, runId);
		const security = mergeSecurity([
			disk,
			headScan,
			{ ok: !records.secret, findings: records.secret ? ["event-secret"] : [] },
		]);
		writeJson(path.join(dir, "security.json"), {
			ok: security.ok,
			result: security.ok ? "PASS" : "FAIL",
			denied: security.denied,
			findings: security.findings,
			scannedAt: new Date(nowMs(host)).toISOString(),
		});
		return {
			ok: security.ok,
			action: "verify",
			projectId: project.id,
			runId,
			slug,
			archiveKey: `${slug}/${runId}`,
			security: security.ok ? "PASS" : "FAIL",
			denied: security.denied,
			findings: security.findings,
			dirty: fs.existsSync(path.join(dir, "local.patch")),
			remoteEligible: security.ok,
		};
	});
}


function readPinnedManifest(
	dir: string,
	projectId: string,
	runId: string,
	slug: string,
): { bytes: Buffer; sha: string; fileId: string } {
	const expectedSha = expectedManifestSha(projectId, runId);
	const root = archiveRoot();
	assertNoReparseAlong(root, dir);
	assertNoReparseTree(dir);
	const file = path.join(dir, "manifest.json");
	assertNoReparseAlong(root, file);
	const got = readNoFollow(file, root, MAX_MANIFEST_FILE);

	const sha = sha256(got.bytes);
	if (sha !== expectedSha) fail("MANIFEST_SHA", "mismatch");
	const text = got.bytes.toString("utf8");
	LOCAL_PATH_RE.lastIndex = 0;
	if (SECRET_TEXT.test(text) || LOCAL_PATH_RE.test(text)) fail("SECURITY_FAIL", "manifest");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		fail("MANIFEST_SHA", "json");
	}
	parseRemoteManifest(parsed, projectId, runId);
	const disk = scanArchiveDir(dir);
	if (!disk.ok) fail("SECURITY_FAIL", "rescan");
	return { bytes: got.bytes, sha, fileId: got.fileId };
}
function splitUrls(stdout: string): string[] {
	return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function urlMatches(got: string, expected: string): boolean {
	return got === expected || got === expected.replace(/\.git$/, "");
}

async function assertExactOrigin(host: ArchiveHost, cwd: string, expected: string, code: string): Promise<void> {
	const fetchAll = splitUrls((await git(host, cwd, ["remote", "get-url", "--all", "origin"])).stdout);
	const pushAll = splitUrls((await git(host, cwd, ["remote", "get-url", "--all", "--push", "origin"])).stdout);
	const rewritten = splitUrls((await git(host, cwd, ["ls-remote", "--get-url", "origin"])).stdout);
	if (fetchAll.length !== 1 || pushAll.length !== 1 || rewritten.length !== 1) fail(code, "origin");
	if (!urlMatches(fetchAll[0], expected) || !urlMatches(pushAll[0], expected) || !urlMatches(rewritten[0], expected)) {
		fail(code, "origin");
	}
	const cfg = await git(host, cwd, ["config", "--get-regexp", "^(remote\\.origin\\.pushurl|url\\..*\\.insteadOf)$"]);
	if (cfg.exitCode === 0 && cfg.stdout.trim()) fail(code, "origin");
}

async function assertIndexRemote(host: ArchiveHost): Promise<void> {
	const live = indexDir();
	if (!fs.existsSync(path.join(live, ".git"))) fail("INDEX_MISSING", "index");
	await assertExactOrigin(host, live, INDEX_ORIGIN_HTTPS, "INDEX_REMOTE");
}
const FILE_BEGIN = 0;

type PinnedBareConfig = { handle: bigint; vol: number; index: string; sha: string };


function pinReadOnlyFile(abs: string): PinnedBareConfig {
	const name = wstr(`\\\\?\\${path.resolve(abs)}`);
	const h = asHandle(
		win().k32.symbols.CreateFileW(
			ptr(name),
			GENERIC_READ,
			FILE_SHARE_READ,
			null,
			OPEN_EXISTING,
			FILE_FLAG_OPEN_REPARSE_POINT,
			null,
		),
	);
	if (!h || h === INVALID_HANDLE) fail("PATH_ESCAPE", "pin-file");
	try {
		const inf = fileInfo(h);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "pin-file");
		if (inf.attr & FILE_ATTRIBUTE_DIRECTORY) fail("PATH_ESCAPE", "pin-file");
		if (inf.links > 1) fail("GIT_IDENTITY", "hardlink");
		const bytes = readHandle(h, fitReadSize(inf, MAX_GIT_TEXT_FILE));

		return { handle: h, vol: inf.vol, index: inf.index, sha: sha256(bytes) };
	} catch (err) {
		closeHandle(h);
		throw err;
	}
}

function pinBareConfig(tmp: string): PinnedBareConfig {
	return pinReadOnlyFile(path.join(tmp, "config"));
}

function assertPinnedBareConfig(pin: PinnedBareConfig): void {
	const inf = fileInfo(pin.handle);
	if (inf.vol !== pin.vol || inf.index !== pin.index) fail("PATH_ESCAPE", "bare-config-id");
	if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", "bare-config");
	if (inf.links > 1) fail("GIT_IDENTITY", "hardlink");
	if (pin.sha === sha256("") && !isZeroFileSize(inf)) fail("GIT_IDENTITY", "sentinel-size");
	if (!win().k32.symbols.SetFilePointerEx(pin.handle, 0n, null, FILE_BEGIN)) fail("PATH_ESCAPE", "bare-config-seek");
	const bytes = readHandle(pin.handle, fitReadSize(inf, MAX_GIT_TEXT_FILE));

	if (sha256(bytes) !== pin.sha) fail("PATH_ESCAPE", "bare-config-bytes");
}

function pinChildFile(parent: bigint, name: string): PinnedBareConfig | null {
	const opened = ntCreate(parent, name, FILE_OPEN, false, FILE_SHARE_READ, GENERIC_READ | SYNCHRONIZE);
	if (opened.status < 0) {
		const code = opened.status >>> 0;
		if (code === STATUS_OBJECT_NAME_NOT_FOUND || code === STATUS_OBJECT_PATH_NOT_FOUND) return null;
		fail("PATH_ESCAPE", name);
	}
	const h = opened.h;
	try {
		const inf = fileInfo(h);
		if (inf.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("PATH_ESCAPE", name);
		if (inf.attr & FILE_ATTRIBUTE_DIRECTORY) fail("PATH_ESCAPE", name);
		if (inf.links > 1) fail("GIT_IDENTITY", name);
		const size = testAdapter?.forceGitTextSize
			? (BigInt(testAdapter.forceGitTextSize.sizeHigh) << 32n) | BigInt(testAdapter.forceGitTextSize.sizeLow)
			: inf.size;
		if (size > MAX_GIT_TEXT_FILE) fail("FILE_TOO_LARGE", name);
		const bytes = readHandle(h, Number(size));

		if (name === ".gitattributes" || name === "attributes") denyAttrText(bytes.toString("utf8"), name);
		if (name === "config" || name === "config.worktree") denyGitIncludeText(bytes.toString("utf8"), name);
		return { handle: h, vol: inf.vol, index: inf.index, sha: sha256(bytes) };
	} catch (err) {
		closeHandle(h);
		throw err;
	}
}

function pinOptionalEmpty(parent: HeldDir, name: string): PinnedBareConfig {
	const existing = pinChildFile(parent.handle, name);
	if (existing) return existing;
	return pinEmptySentinel(parent.handle, name);
}

function pinOptionalNestedEmpty(parent: HeldDir, dirName: string, fileName: string): PinnedBareConfig {
	const dirH = ensureInfoDir(parent);
	try {
		const existing = pinChildFile(dirH, fileName);
		if (existing) return existing;
		return pinEmptySentinel(dirH, fileName);
	} finally {
		closeHandle(dirH);
	}
}

function pinGitInputFiles(root: HeldDir, gitDir: HeldDir, commonDir: HeldDir): PinnedBareConfig[] {
	const pins: PinnedBareConfig[] = [];
	const add = (pin: PinnedBareConfig) => {
		pins.push(pin);
	};
	try {
		const cfg = pinChildFile(commonDir.handle, "config");
		if (!cfg) fail("GIT_IDENTITY", "config");
		add(cfg);
		if (!samePath(gitDir.path, commonDir.path)) {
			const wtCfg = pinChildFile(gitDir.handle, "config");
			if (wtCfg) add(wtCfg);
		}
		add(pinOptionalEmpty(gitDir, "config.worktree"));
		if (!samePath(gitDir.path, commonDir.path)) add(pinOptionalEmpty(commonDir, "config.worktree"));
		add(pinOptionalNestedEmpty(gitDir, "info", "attributes"));
		if (!samePath(gitDir.path, commonDir.path)) add(pinOptionalNestedEmpty(commonDir, "info", "attributes"));
		const ga = pinChildFile(root.handle, ".gitattributes");
		if (ga) add(ga);
		return pins;
	} catch (err) {
		for (let i = pins.length - 1; i >= 0; i--) closeHandle(pins[i].handle);
		throw err;
	}
}






async function pushManifest(
	host: ArchiveHost,
	remote: RemoteClass & { kind: "github" },
	runId: string,
	manifestBytes: Buffer,
): Promise<{ commitSha: string }> {
	const dest = remote.url;
	const chain = holdPath(path.join(WORK_ROOT, crypto.randomUUID()), true);
	try {
		return await plumbingStore.run(chain, async () => {
		assertHeldChain(chain);
		const tmp = chain[chain.length - 1].path;
		const init = await git(host, tmp, ["init", "--bare"]);
		if (init.exitCode !== 0) fail("PUBLISH_FAIL", "git init");
		const addRemote = await git(host, tmp, ["remote", "add", "origin", dest]);
		if (addRemote.exitCode !== 0) fail("PUBLISH_FAIL", "remote add");
		const cfgPin = pinBareConfig(tmp);
		try {
			assertPinnedBareConfig(cfgPin);
			await assertExactOrigin(host, tmp, dest, "FORBIDDEN_REMOTE");
			assertPinnedBareConfig(cfgPin);
			const fetched = await gitNetwork(host, tmp, ["fetch", dest, "+refs/heads/main:refs/remotes/origin/main"], dest);
			assertPinnedBareConfig(cfgPin);
			let parent: string | null = null;
			let rootTree: string | null = null;
			if (fetched.exitCode === 0) {
				parent = (await gitMust(host, tmp, ["rev-parse", "origin/main"], "PUBLISH_FAIL")).trim();
				rootTree = (await gitMust(host, tmp, ["rev-parse", "origin/main^{tree}"], "PUBLISH_FAIL")).trim();
			}
			const blob = await hashBlob(host, tmp, manifestBytes, "PUBLISH_FAIL");
			const newTree = await buildPublishTree(host, tmp, rootTree, runId, blob, "PUBLISH_FAIL");
			if (rootTree && newTree === rootTree && parent) return { commitSha: parent };
			const commitArgs = parent
				? ["commit-tree", newTree, "-p", parent, "-m", `run ${runId} manifest`]
				: ["commit-tree", newTree, "-m", `run ${runId} manifest`];
			const commit = await git(host, tmp, commitArgs);
			if (commit.exitCode !== 0) fail("PUBLISH_FAIL", "commit-tree");
			const sha = commit.stdout.trim();
			assertPinnedBareConfig(cfgPin);
			const push = await gitNetwork(host, tmp, ["push", dest, `${sha}:refs/heads/main`], dest);
			if (push.exitCode !== 0) fail("PUBLISH_FAIL", "git push");
			assertPinnedBareConfig(cfgPin);
			return { commitSha: sha };
		} finally {
			closeHandle(cfgPin.handle);
		}
		});
	} finally {
		releaseWorkChain(chain);
	}
}

async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
	const name = wstr(indexMutexName());
	const h = asHandle(win().k32.symbols.CreateMutexW(null, 0, ptr(name)));
	if (!h || h === INVALID_HANDLE) fail("INDEX_LOCK", "mutex");
	try {
		const waited = win().k32.symbols.WaitForSingleObject(h, 30_000) as number;
		if (waited === 0x00000102) fail("INDEX_LOCK", "timeout");
		if (waited !== 0 && waited !== 0x00000080) fail("INDEX_LOCK", "wait");
		return await fn();
	} finally {
		win().k32.symbols.ReleaseMutex(h);
		closeHandle(h);
	}
}

async function updateIndexTxn(host: ArchiveHost, entry: Record<string, unknown>): Promise<{ sha: string }> {
	await assertIndexRemote(host);
	return withIndexLock(async () => {
		await assertIndexRemote(host);
		const chain = holdPath(path.join(WORK_ROOT, `index-${crypto.randomUUID()}`), true);
		try {
			return await plumbingStore.run(chain, async () => {
			assertHeldChain(chain);
			const tmp = chain[chain.length - 1].path;
			const init = await git(host, tmp, ["init", "--bare"]);
			if (init.exitCode !== 0) fail("INDEX_FAIL", "init");
			const addRemote = await git(host, tmp, ["remote", "add", "origin", INDEX_ORIGIN_HTTPS]);
			if (addRemote.exitCode !== 0) fail("INDEX_FAIL", "remote add");
			const cfgPin = pinBareConfig(tmp);
			try {
			assertPinnedBareConfig(cfgPin);
			await assertExactOrigin(host, tmp, INDEX_ORIGIN_HTTPS, "INDEX_REMOTE");
			assertPinnedBareConfig(cfgPin);
			const fetched = await gitNetwork(host, tmp, ["fetch", INDEX_ORIGIN_HTTPS, "+refs/heads/main:refs/remotes/origin/main"], INDEX_ORIGIN_HTTPS);
			if (fetched.exitCode !== 0) fail("INDEX_FAIL", "fetch");
			const parent = (await gitMust(host, tmp, ["rev-parse", "origin/main"], "INDEX_FAIL")).trim();
			const rootTree = (await gitMust(host, tmp, ["rev-parse", "origin/main^{tree}"], "INDEX_FAIL")).trim();
			const rootEntries = await lsTree(host, tmp, rootTree, "INDEX_FAIL");
			const archives = rootEntries.find(e => e.name === "archives.json");
			assertGitFile(archives, "archives.json");
			let cur: { projects?: unknown[]; version?: number; index?: string } = {
				version: 1,
				index: CENTRAL_INDEX,
				projects: [],
			};
			if (archives) {
				try {
					cur = JSON.parse(await catBlob(host, tmp, archives.sha, "INDEX_FAIL")) as typeof cur;
				} catch (err) {
					if (err instanceof ArchiveError) throw err;
					fail("INDEX_FAIL", "archives.json");
				}
			}
			const projects: Record<string, unknown>[] = [];
			for (const item of Array.isArray(cur.projects) ? cur.projects : []) {
				if (item && typeof item === "object") projects.push({ ...item });
			}
			const idx = projects.findIndex(row => row.projectId === entry.projectId);
			const safe = {
				projectId: entry.projectId,
				latestRun: entry.latestRun,
				manifestSha: entry.manifestSha,
				status: "archived",
				archivedAt: entry.archivedAt,
				repo: entry.repo,
			};
			if (idx >= 0) projects[idx] = safe;
			else projects.push(safe);
			const next = { version: 1, index: CENTRAL_INDEX, projects };
			const blob = await hashBlob(host, tmp, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), "INDEX_FAIL");
			const newTree = await upsertBlobPath(host, tmp, rootTree, "archives.json", blob, "INDEX_FAIL");
			const commit = await git(host, tmp, [
				"commit-tree",
				newTree,
				"-p",
				parent,
				"-m",
				`archive ${String(entry.projectId)} ${String(entry.latestRun)}`,
			]);
			if (commit.exitCode !== 0) fail("INDEX_FAIL", "commit-tree");
			const sha = commit.stdout.trim();
			assertPinnedBareConfig(cfgPin);
			const pushed = await gitNetwork(host, tmp, ["push", INDEX_ORIGIN_HTTPS, `${sha}:refs/heads/main`], INDEX_ORIGIN_HTTPS);
			if (pushed.exitCode !== 0) fail("INDEX_FAIL", "push");
			assertPinnedBareConfig(cfgPin);
			return { sha };
			} finally {
				closeHandle(cfgPin.handle);
			}
			});
		} catch (err) {
			if (err instanceof ArchiveError) throw err;
			fail("INDEX_ROLLBACK", "isolated clone");
		} finally {
			try {
				releaseWorkChain(chain);
			} catch {
				closeHeldChain(chain);
			}
		}
	});
}

async function ackArchiveOutbox(projectId: string, oid: string, sessionId: string, runId: string): Promise<boolean> {
	try {
		const host = { sessionId };
		const drained = await dispatchControl({
			action: "outbox_drain",
			projectId,
			runId,
			id: oid,
			limit: 1,
			idempotencyKey: oid,
		} as Parameters<typeof dispatch>[0] & { idempotencyKey: string }, host);
		const items = drained.items;
		if (!Array.isArray(items)) return false;
		if (items.some(item => item && typeof item === "object" && "id" in item && item.id !== oid)) return false;
		for (const item of items) {
			if (!item || typeof item !== "object" || !("id" in item) || item.id !== oid) continue;
			if (!("claimToken" in item) || typeof item.claimToken !== "string") continue;
			await dispatchControl({ action: "outbox_ack", projectId, runId, id: oid, claimToken: item.claimToken }, host);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export async function publishArchive(input: ArchiveInput, host: ArchiveHost = {}, sessionId?: string): Promise<Record<string, unknown>> {
	if (ambientLab) fail("LAB_EXTERNAL_PUBLISH_DISABLED", "publish");
	const sid = requireSession(sessionId);
	return withTarget(input, host, sid, async ({ project, runId, slug }) => {
		if (input.archiveRepo) {
			const classified = requireArchiveRemote(input.archiveRepo);
			putBinding(project.id, {
				archiveRepo: classified.fullName,
				private: true,
				url: classified.url,
				boundAt: nowMs(host),
			});
		}
		const projectId = project.id;
		let row = getManifestRow(projectId, runId);
		if (row && (row.state === "published" || row.published === 1)) {
			requireFrozenPayload(row);
			return {
				ok: true,
				action: "publish",
				published: true,
				idempotent: true,
				localComplete: true,
				queued: false,
				projectId,
				runId,
				slug,
				archiveKey: `${slug}/${runId}`,
				manifestSha: row.sha,
				ref: row.remote_commit,
				manifestOnly: true,
				uploadedPatch: false,
				uploadedUntracked: false,
				createdRepo: false,
				sourceRef: false,
			};
		}
		if (!row) {
			await prepareArchive(
				{ action: "prepare", projectId, runId, cwd: input.cwd, archiveRepo: input.archiveRepo },
				host,
				sid,
			);
			row = getManifestRow(projectId, runId);
		}
		if (!row) fail("MANIFEST_SHA", "missing");
		requireFrozenPayload(row);
		const frozenSha = row.sha;
		writeLocalFile(archiveDir(slug, runId), "manifest.json", row.payload);
		const binding = getBinding(projectId);
		if (!binding) {
			return {
				ok: true,
				action: "publish",
				published: false,
				localComplete: true,
				queued: true,
				reason: "NO_BINDING",
				projectId,
				runId,
				slug,
				archiveKey: `${slug}/${runId}`,
				createdRepo: false,
			};
		}
		const claimed = claimPublishing(projectId, runId, frozenSha);
		if ("published" in claimed) {
			return {
				ok: true,
				action: "publish",
				published: true,
				idempotent: true,
				localComplete: true,
				queued: false,
				projectId,
				runId,
				slug,
				archiveKey: `${slug}/${runId}`,
				manifestSha: frozenSha,
				manifestOnly: true,
				uploadedPatch: false,
				uploadedUntracked: false,
				createdRepo: false,
				sourceRef: false,
			};
		}
		const claimToken = claimed.token;
		try {
			const verified = await verifyArchive({ action: "verify", projectId, runId, cwd: input.cwd }, host, sid);
			if (verified.security !== "PASS") fail("SECURITY_FAIL", "verify");
			const remote = await requireGithubPrivate(host, binding.archiveRepo);
			await assertIndexRemote(host);
			const pinned = readPinnedManifest(archiveDir(slug, runId), projectId, runId, slug);
			if (pinned.sha !== frozenSha) fail("MANIFEST_SHA", "prepared");
			const pushed = await pushManifest(host, remote, runId, pinned.bytes);
			const again = readPinnedManifest(archiveDir(slug, runId), projectId, runId, slug);
			if (again.sha !== frozenSha || again.fileId !== pinned.fileId) fail("PATH_ESCAPE", "identity");
			const ts = new Date(nowMs(host)).toISOString();
			const index = await updateIndexTxn(host, {
				projectId,
				repo: remote.fullName,
				status: "archived",
				latestRun: runId,
				manifestSha: frozenSha,
				archivedAt: ts,
			});
			casOwned(projectId, runId, frozenSha, "publishing", "published", claimToken, pushed.commitSha);
			const oid = outboxId(projectId, runId);
			const outboxAcked = await ackArchiveOutbox(projectId, oid, sid, runId);
			return {
				ok: true,
				action: "publish",
				published: true,
				idempotent: false,
				localComplete: true,
				queued: false,
				projectId,
				runId,
				slug,
				archiveKey: `${slug}/${runId}`,
				ref: pushed.commitSha,
				manifestOnly: true,
				uploadedPatch: false,
				uploadedUntracked: false,
				createdRepo: false,
				indexSha: index.sha,
				dirtyLocalPatch: fs.existsSync(path.join(archiveDir(slug, runId), "local.patch")),
				sourceRef: false,
				outboxAcked,
			};
		} catch (err) {
			releaseClaim(projectId, runId, frozenSha, claimToken);
			throw err;
		}
	});
}

export async function statusArchive(input: ArchiveInput, host: ArchiveHost = {}, sessionId?: string): Promise<Record<string, unknown>> {
	const sid = requireSession(sessionId);
	return withTarget(input, host, sid, async ({ project, runId, slug }) => {
		const dir = archiveDir(slug, runId);
		const binding = getBinding(project.id);
		const security = fs.existsSync(dir) ? scanArchiveDir(dir) : null;
		const oid = outboxId(project.id, runId);
		const box = openControlDb()
			.query<{ project_id: string; id: string; status: string }, [string, string]>(
				"SELECT project_id, id, status FROM outbox WHERE project_id = ? AND id = ?",
			)
			.get(project.id, oid);

		return {
			ok: true,
			action: "status",
			projectId: project.id,
			runId,
			slug,
			archiveKey: `${slug}/${runId}`,
			bound: Boolean(binding),
			archiveRepo: binding?.archiveRepo ?? null,
			security: security ? (security.ok ? "PASS" : "FAIL") : null,
			dirtyLocalPatch: fs.existsSync(path.join(dir, "local.patch")),
			queued: box ? box.status !== "acked" && !binding : !binding,
			outbox: box ?? null,
			centralIndex: CENTRAL_INDEX,
		};
	});
}

export async function dispatchArchive(
	input: ArchiveInput,
	host: ArchiveHost = {},
	sessionId?: string,
): Promise<Record<string, unknown>> {
	const action = String(input.action || "");
	if (ambientLab && (action === "publish" || input.archiveRepo)) fail("LAB_EXTERNAL_PUBLISH_DISABLED", action === "publish" ? "publish" : "archiveRepo");
	const sid = requireSession(sessionId);
	let result: Record<string, unknown>;
	if (action === "prepare") result = await prepareArchive(input, host, sid);
	else if (action === "verify") result = await verifyArchive(input, host, sid);
	else if (action === "publish") result = await publishArchive(input, host, sid);
	else if (action === "status") result = await statusArchive(input, host, sid);
	else return fail("INVALID", "action");
	// Archiving a blocked run remains allowed. Archive transport success is never task acceptance.
	const completion = await dispatchControl({ action: "run_status", projectId: String(result.projectId), runId: String(result.runId) }, { sessionId: sid });
	return { ...result, taskComplete: completion.taskComplete === true, completion };
}

export async function archiveFromCwd(
	cwd: string,
	reason: string,
	host: ArchiveHost = {},
	opts: { runId?: string; sessionId?: string } = {},
): Promise<Record<string, unknown>> {
	const resolved = path.resolve(cwd);
	if (driveOf(resolved) !== "D") return { ok: true, skipped: true, reason: "NOT_D_ROOT", event: reason };
	if (!opts.sessionId || opts.sessionId === "nosession") {
		return { ok: true, skipped: true, reason: "SESSION_RUN", event: reason };
	}
	let project: ProjectRow | null = null;
	try {
		project = withPreauth(db => peekProjectByCwd(db, resolved));
	} catch (err) {
		if (err instanceof ArchiveError && err.code === "UNINITIALIZED") {
			return { ok: true, skipped: true, reason: "NOT_REGISTERED", event: reason };
		}
		throw err;
	}
	if (!project) return { ok: true, skipped: true, reason: "NOT_REGISTERED", event: reason };
	requireProjectOwner(project, opts.sessionId);
	safeProjectId(project.id);
	const bound = sessionRun(opts.sessionId, project.id);

	if (!bound) return { ok: true, skipped: true, reason: "SESSION_RUN", event: reason };
	if (opts.runId && opts.runId !== bound.run_id) {
		return { ok: true, skipped: true, reason: "SESSION_RUN", event: reason };
	}
	const runId = bound.run_id;
	withPreauth(db => peekRequireRun(db, project!.id, runId, opts.sessionId));
	try {
		await assertGitRoot(host, project.canonical_root);
	} catch (err) {
		if (err instanceof ArchiveError && err.code === "OWNER_MISMATCH") throw err;
		return { ok: true, skipped: true, reason: "NOT_GIT_ROOT", event: reason };
	}
	return prepareArchive({ action: "prepare", projectId: project.id, runId, cwd: project.canonical_root }, host, opts.sessionId);
}


function sessionIdFrom(ctx: ExtensionContext | undefined): string | undefined {
	if (!ctx || !ctx.sessionManager || typeof ctx.sessionManager !== "object") return undefined;
	const sm = ctx.sessionManager as { getSessionId?: () => string };
	if (typeof sm.getSessionId === "function") return sm.getSessionId();
	return undefined;
}

export default function runArchiver(pi: ExtensionAPI) {
	const z = pi.zod;
	const parameters = z
		.object({
			action: z.enum(ACTIONS).describe("omp_archive action"),
			projectId: z.string().min(1).optional(),
			runId: z.string().min(1).optional(),
			cwd: z.string().min(1).optional(),
			archiveRepo: z.string().min(1).optional(),
		})
		.strict();

	if (!testAdapter) {
		openControlDb();
		ensureArchiveSchema();
	}
	archiveRoot();


	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue) return;
		try {
			await archiveFromCwd(ctx.cwd, "agent_end", {}, { sessionId: sessionIdFrom(ctx) });
		} catch (err) {
			const code = err instanceof ArchiveError || err instanceof ControlError ? (err as ArchiveError).code : "ERROR";
			pi.logger?.warn?.("run-archiver lifecycle failed", { code });
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await archiveFromCwd(ctx.cwd, "session_shutdown", {}, { sessionId: sessionIdFrom(ctx) });
		} catch (err) {
			const code = err instanceof ArchiveError || err instanceof ControlError ? (err as ArchiveError).code : "ERROR";
			pi.logger?.warn?.("run-archiver lifecycle failed", { code });
		}
		releaseArchiveRoot();
	});

	pi.registerTool({
		name: "omp_archive",
		label: "OMP Archive",
		description: "Prepare/verify/publish/status sanitized run archives for registered D: Git projects",
		parameters,
		strict: true,
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const sid = sessionIdFrom(ctx);
				if (!sid) fail("OWNER_MISMATCH", "session");
				const result = await dispatchArchive(
					{
						action: params.action,
						projectId: params.projectId,
						runId: params.runId,
						cwd: params.cwd,
						archiveRepo: params.archiveRepo,
					},
					{},
					sid,
				);
				const pub: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(result)) {
					if (k === "dir") continue;
					pub[k] = v;
				}
				if (result.slug && result.runId) pub.archiveKey = `${String(result.slug)}/${String(result.runId)}`;
				const cleaned = sanitizeValue(pub);
				return { content: [{ type: "text" as const, text: JSON.stringify(cleaned) }], details: cleaned };
			} catch (err) {
				const code = err instanceof ArchiveError || err instanceof ControlError ? (err as ArchiveError).code : "ERROR";
				return {
					content: [{ type: "text" as const, text: code }],
					isError: true,
					details: { error: code, code },
				};
			}
		},
	});
}
