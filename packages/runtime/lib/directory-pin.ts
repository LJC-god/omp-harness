import { createRequire } from "node:module";
import * as path from "node:path";
import { confineDataPath } from "./paths.ts";

const require = createRequire(import.meta.url);

export type WindowsDirectoryIdentity = { volume: number; index: string };
type Held = WindowsDirectoryIdentity & { handle: bigint; finalPath: string; attr: number };
export type WindowsDirectoryPin = { rootPath: string; identity: WindowsDirectoryIdentity; handle: bigint; _chain: Held[] };

function fail(code: string, detail: string): never {
	throw new Error(`${code}:${detail}`);
}

type WinPin = {
	pinWindowsDirectory: (abs: string) => WindowsDirectoryPin;
	extendWindowsDirectoryPin: (pin: WindowsDirectoryPin, parts: string[]) => void;
	assertWindowsDirectoryPin: (pin: WindowsDirectoryPin) => void;
	releaseWindowsDirectoryPin: (pin: WindowsDirectoryPin) => void;
};

let winPin: WinPin | undefined;
function loadWin(): WinPin {
	winPin ??= require("./directory-pin-win32.ts") as WinPin;
	return winPin;
}

function held(finalPath: string): Held {
	return { handle: 0n, finalPath, volume: 0, index: "posix", attr: 0 };
}

/**
 * On Windows this lazily loads the FFI pin. On other platforms the pin is lexical
 * confinement under OMP_DATA_ROOT. Importing this module does not open native libraries.
 */
export function pinWindowsDirectory(abs: string): WindowsDirectoryPin {
	if (process.platform === "win32") return loadWin().pinWindowsDirectory(abs);
	const rootPath = confineDataPath(path.resolve(abs), false);
	return { rootPath, identity: { volume: 0, index: "posix" }, handle: 0n, _chain: [held(rootPath)] };
}

export function extendWindowsDirectoryPin(pin: WindowsDirectoryPin, parts: string[]): void {
	if (process.platform === "win32") return loadWin().extendWindowsDirectoryPin(pin, parts);
	assertWindowsDirectoryPin(pin);
	let parent = pin._chain.at(-1)?.finalPath ?? pin.rootPath;
	for (const part of parts) {
		if (!part || part === "." || part === ".." || /[\\/]/.test(part)) fail("PATH_ESCAPE", part);
		const dir = confineDataPath(path.join(parent, part), true);
		pin._chain.push(held(dir));
		parent = dir;
	}
}

export function assertWindowsDirectoryPin(pin: WindowsDirectoryPin): void {
	if (process.platform === "win32") return loadWin().assertWindowsDirectoryPin(pin);
	if (!pin._chain.length) fail("PATH_ESCAPE", pin.rootPath);
	for (const item of pin._chain) confineDataPath(item.finalPath, false);
}

export function releaseWindowsDirectoryPin(pin: WindowsDirectoryPin): void {
	if (process.platform === "win32") return loadWin().releaseWindowsDirectoryPin(pin);
	pin._chain.length = 0;
}
