import * as path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { dataDrive } from "./paths.ts";

const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_LIST_DIRECTORY = 0x0001;
const FILE_TRAVERSE = 0x0020;
const FILE_READ_ATTRIBUTES = 0x0080;
const SYNCHRONIZE = 0x00100000;
const DIR_READ_ACCESS = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE;
const FILE_SHARE_READ_WRITE = 3;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 0x00000001;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const FILE_OPEN_REPARSE_POINT = 0x00200000;
const OBJ_CASE_INSENSITIVE = 0x40;

export type WindowsDirectoryIdentity = { volume: number; index: string };
type Held = WindowsDirectoryIdentity & { handle: bigint; finalPath: string; attr: number };
export type WindowsDirectoryPin = { rootPath: string; identity: WindowsDirectoryIdentity; handle: bigint; _chain: Held[] };

function fail(code: string, detail: string): never { throw new Error(`${code}:${detail}`); }
function wstr(s: string): Uint16Array { const a = new Uint16Array(s.length + 1); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function asHandle(v: unknown): bigint { return typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : 0n; }
function samePath(a: string, b: string) { return path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase(); }
function driveRoot(): string {
	const drive = dataDrive();
	if (!/^[A-Z]$/.test(drive)) fail("WINDOWS_DIRECTORY_PIN_NOT_D", "OMP_DATA_ROOT");
	return `${drive}:\\`;
}

const k32 = dlopen("kernel32.dll", {
	CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
	CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	GetFinalPathNameByHandleW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
	GetFileInformationByHandle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
});
const nt = dlopen("ntdll.dll", {
	NtCreateFile: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
});

function close(h: bigint) { if (h) k32.symbols.CloseHandle(h); }
function info(h: bigint): Held {
	const buf = Buffer.alloc(52);
	if (!k32.symbols.GetFileInformationByHandle(h, ptr(buf))) fail("WINDOWS_DIRECTORY_PIN_IO", "GetFileInformationByHandle");
	return { handle: h, finalPath: finalPath(h), attr: buf.readUInt32LE(0), volume: buf.readUInt32LE(28), index: `${buf.readUInt32LE(44)}:${buf.readUInt32LE(48)}` };
}
function finalPath(h: bigint): string {
	const needed = k32.symbols.GetFinalPathNameByHandleW(h, ptr(new Uint16Array(1)), 0, 0);
	if (!needed) fail("WINDOWS_DIRECTORY_PIN_IO", "GetFinalPathNameByHandleW");
	const buf = new Uint16Array(needed); const written = k32.symbols.GetFinalPathNameByHandleW(h, ptr(buf), buf.length, 0);
	if (!written) fail("WINDOWS_DIRECTORY_PIN_IO", "GetFinalPathNameByHandleW");
	let result = String.fromCharCode(...buf.subarray(0, written));
	if (result.startsWith("\\\\?\\")) result = result.slice(4);
	return result;
}
function onDataDrive(value: string): boolean {
	return new RegExp(`^${dataDrive()}:[\\\\/]`, "i").test(value);
}
function openDrive(): Held {
	const h = asHandle(k32.symbols.CreateFileW(ptr(wstr(`\\\\?\\${driveRoot()}`)), DIR_READ_ACCESS, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null));
	if (!h || h === 0xffffffffffffffffn || h === -1n) fail("WINDOWS_DIRECTORY_PIN_IO", "CreateFileW data drive");
	try { const held = info(h); if (held.attr & FILE_ATTRIBUTE_REPARSE_POINT || !onDataDrive(held.finalPath)) fail("WINDOWS_DIRECTORY_PIN_INVALID", driveRoot()); return held; }
	catch (error) { close(h); throw error; }
}
function openChild(parent: bigint, name: string, create: boolean): Held {
	const nameW = wstr(name), us = Buffer.alloc(16), oa = Buffer.alloc(48), out = Buffer.alloc(8), iosb = Buffer.alloc(16);
	us.writeUInt16LE((nameW.length - 1) * 2, 0); us.writeUInt16LE(nameW.length * 2, 2); us.writeBigUInt64LE(BigInt(ptr(nameW)), 8);
	oa.writeUInt32LE(48, 0); oa.writeBigUInt64LE(parent, 8); oa.writeBigUInt64LE(BigInt(ptr(us)), 16); oa.writeUInt32LE(OBJ_CASE_INSENSITIVE, 24);
	const status = nt.symbols.NtCreateFile(ptr(out), DIR_READ_ACCESS, ptr(oa), ptr(iosb), null, 0x80, FILE_SHARE_READ_WRITE, FILE_OPEN, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, null, 0);
	let h = out.readBigUInt64LE(0);
	if (status < 0 && create && (status >>> 0) === 0xc0000034) {
		out.fill(0); const made = nt.symbols.NtCreateFile(ptr(out), DIR_READ_ACCESS, ptr(oa), ptr(iosb), null, 0x80, FILE_SHARE_READ_WRITE, FILE_CREATE, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, null, 0); h = out.readBigUInt64LE(0);
		if (made < 0) fail("WINDOWS_DIRECTORY_PIN_OPEN", `${name}:${made >>> 0}`);
	} else if (status < 0) fail("WINDOWS_DIRECTORY_PIN_OPEN", `${name}:${status >>> 0}`);
	try { const held = info(h); if (held.attr & FILE_ATTRIBUTE_REPARSE_POINT) fail("WINDOWS_DIRECTORY_PIN_REPARSE", name); return held; }
	catch (error) { close(h); throw error; }
}

/** Holds every directory ancestor on the OMP_DATA_ROOT drive without delete sharing. Caller must release it. */
export function pinWindowsDirectory(abs: string): WindowsDirectoryPin {
	const resolved = path.resolve(abs);
	const root = driveRoot();
	if (!onDataDrive(resolved)) fail("WINDOWS_DIRECTORY_PIN_NOT_D", resolved);
	const rel = path.relative(root, resolved); const parts = resolved.toLowerCase() === root.toLowerCase() ? [] : rel.split(/[\\/]/).filter(Boolean);
	if (parts.some(part => part === "." || part === "..")) fail("WINDOWS_DIRECTORY_PIN_ESCAPE", resolved);
	const chain: Held[] = []; let parent: Held | undefined;
	try {
		parent = openDrive(); chain.push(parent);
		for (const part of parts) { const child = openChild(parent.handle, part, false); chain.push(child); parent = child; }
		if (!parent || !samePath(parent.finalPath, resolved)) fail("WINDOWS_DIRECTORY_PIN_MOVED", resolved);
		return { rootPath: parent.finalPath, identity: { volume: parent.volume, index: parent.index }, handle: parent.handle, _chain: chain };
	} catch (error) { for (let i = chain.length - 1; i >= 0; i--) close(chain[i].handle); throw error; }
}

export function extendWindowsDirectoryPin(pin: WindowsDirectoryPin, parts: string[]): void {
	assertWindowsDirectoryPin(pin);
	for (const part of parts) {
		if (!part || part === "." || part === ".." || /[\\/]/.test(part)) fail("WINDOWS_DIRECTORY_PIN_ESCAPE", part);
		const parent = pin._chain.at(-1)!; const child = openChild(parent.handle, part, true); pin._chain.push(child);
	}
}

export function assertWindowsDirectoryPin(pin: WindowsDirectoryPin): void {
	for (const held of pin._chain) {
		const current = info(held.handle);
		if (current.attr & FILE_ATTRIBUTE_REPARSE_POINT || current.volume !== held.volume || current.index !== held.index || !samePath(current.finalPath, held.finalPath)) fail("WINDOWS_DIRECTORY_PIN_MOVED", pin.rootPath);
	}
	const root = pin._chain.find(held => held.handle === pin.handle);
	if (!root || root.volume !== pin.identity.volume || root.index !== pin.identity.index) fail("WINDOWS_DIRECTORY_PIN_MOVED", pin.rootPath);
}

export function releaseWindowsDirectoryPin(pin: WindowsDirectoryPin): void { for (let i = pin._chain.length - 1; i >= 0; i--) close(pin._chain[i].handle); pin._chain.length = 0; }
