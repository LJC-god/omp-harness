import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PINNED_OMP_VERSION = "18.2.6";
const PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";

type Manifest = { name?: unknown; version?: unknown; exports?: Record<string, unknown> };

function readManifest(dir: string): Manifest | undefined {
	const file = path.join(dir, "package.json");
	if (!fs.existsSync(file)) return undefined;
	return JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
}

function assertPinned(dir: string, name: string): string {
	const manifest = readManifest(dir);
	if (!manifest || manifest.name !== name) throw new Error("OMP_RUNTIME_UNAVAILABLE");
	if (manifest.version !== PINNED_OMP_VERSION) {
		throw new Error(`OMP_RUNTIME_UNVERIFIED_VERSION:${String(manifest.version)}`);
	}
	return dir;
}

function walkResolvedPackage(): string {
	const entry = fileURLToPath(import.meta.resolve(PACKAGE_NAME));
	let dir = path.dirname(entry);
	for (let hop = 0; hop < 8; hop++) {
		const manifest = readManifest(dir);
		if (manifest?.name === PACKAGE_NAME) return assertPinned(dir, PACKAGE_NAME);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("OMP_RUNTIME_UNAVAILABLE");
}

/**
 * Prefer OMP_RUNTIME_ROOT. A bare package resolve from a file outside the
 * install tree lets the loader fetch a newer release into the current HOME.
 */
export function pinnedRuntimeRoot(): string {
	const fromEnv = process.env.OMP_RUNTIME_ROOT;
	if (fromEnv) {
		if (!path.isAbsolute(fromEnv)) throw new Error("OMP_RUNTIME_ROOT_NOT_ABSOLUTE");
		return assertPinned(path.resolve(fromEnv), PACKAGE_NAME);
	}
	return walkResolvedPackage();
}

function pickImport(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.import === "string") return record.import;
		if (typeof record.default === "string") return record.default;
		if (record.import) return pickImport(record.import);
	}
	throw new Error("OMP_RUNTIME_EXPORT_MISSING");
}

function exportFile(root: string, subpath: string): string {
	const exportsMap = readManifest(root)?.exports ?? {};
	const request = subpath === "." ? "." : `./${subpath}`;
	if (exportsMap[request]) return path.resolve(root, pickImport(exportsMap[request]));
	let best: { score: number; file: string } | undefined;
	for (const [key, value] of Object.entries(exportsMap)) {
		const star = key.indexOf("*");
		if (star < 0) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue;
		const rest = request.slice(prefix.length, request.length - suffix.length);
		const dest = pickImport(value).replaceAll("*", rest);
		if (!best || prefix.length > best.score) best = { score: prefix.length, file: path.resolve(root, dest) };
	}
	if (!best) throw new Error(`OMP_RUNTIME_EXPORT_MISSING:${subpath}`);
	return best.file;
}

async function loadExport(root: string, subpath: string) {
	return import(pathToFileURL(exportFile(root, subpath)).href);
}

function siblingPackage(name: string): string {
	return assertPinned(path.join(path.dirname(pinnedRuntimeRoot()), name), `@oh-my-pi/${name}`);
}

export async function loadControlApis() {
	const root = pinnedRuntimeRoot();
	const settings = await loadExport(root, "config/settings");
	const resolver = await loadExport(root, "config/model-resolver");
	const session = await loadExport(root, "session/session-manager");
	return {
		Settings: settings.Settings,
		resolveAgentModelSelection: resolver.resolveAgentModelSelection,
		SessionManager: session.SessionManager,
	};
}

export async function loadDiscoverAgents() {
	const discovery = await loadExport(pinnedRuntimeRoot(), "task/discovery");
	return { discoverAgents: discovery.discoverAgents };
}

export async function loadResearchApis() {
	const root = pinnedRuntimeRoot();
	const utils = await loadExport(siblingPackage("pi-utils"), ".");
	const settings = await loadExport(root, "config/settings");
	const globals = await loadExport(root, "config/provider-globals");
	const search = await loadExport(root, "web/search");
	return {
		getProjectDir: utils.getProjectDir,
		Settings: settings.Settings,
		applyProviderGlobalsFromSettings: globals.applyProviderGlobalsFromSettings,
		runSearchQuery: search.runSearchQuery,
	};
}

export async function loadUsageApis() {
	const loader = await loadExport(pinnedRuntimeRoot(), "session/session-loader");
	return { loadSessionFile: loader.loadSessionFile };
}

export async function loadContinuityApis() {
	const messages = await loadExport(siblingPackage("pi-agent-core"), "compaction/messages");
	return { createCustomMessage: messages.createCustomMessage };
}
