import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const AUDITED_OMP_VERSION = "18.2.6";
export const AUDITED_OMP_VERSIONS: readonly string[] = ["18.2.4", "18.2.5", AUDITED_OMP_VERSION];
export type RuntimeInspection = { root?: string; version?: string; source: "OMP_RUNTIME_ROOT" | "BUN_INSTALL" | "default"; verified: boolean; reason?: string };

type Options = { runtimeRoot?: string; bunInstall?: string; home?: string };
const packageName = "@oh-my-pi/pi-coding-agent";

function packageRoot(candidate: string) {
	const direct = path.resolve(candidate);
	if (path.basename(direct) === "pi-coding-agent") return direct;
	if (path.basename(direct) === "@oh-my-pi") return path.join(direct, "pi-coding-agent");
	return path.join(direct, "@oh-my-pi", "pi-coding-agent");
}

export function inspectOmpRuntime(options: Options = {}): RuntimeInspection {
	const explicit = options.runtimeRoot ?? process.env.OMP_RUNTIME_ROOT;
	const source: RuntimeInspection["source"] = explicit ? "OMP_RUNTIME_ROOT" : options.bunInstall ?? process.env.BUN_INSTALL ? "BUN_INSTALL" : "default";
	const install = explicit ? explicit : path.join(options.bunInstall ?? process.env.BUN_INSTALL ?? path.join(options.home ?? os.homedir(), ".bun"), "install", "global", "node_modules");
	const root = packageRoot(install);
	try {
		const real = fs.realpathSync(root);
		const manifest = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
		if (manifest.name !== packageName) return { root: real, source, verified: false, reason: "OMP_RUNTIME_IDENTITY_MISMATCH" };
		if (typeof manifest.version !== "string" || !AUDITED_OMP_VERSIONS.includes(manifest.version))
			return { root: real, version: typeof manifest.version === "string" ? manifest.version : undefined, source, verified: false, reason: "OMP_RUNTIME_UNVERIFIED_VERSION" };
		return { root: real, version: manifest.version, source, verified: true };
	} catch (error) {
		return { root, source, verified: false, reason: `OMP_RUNTIME_UNAVAILABLE:${error instanceof Error ? error.code ?? error.name : String(error)}` };
	}
}

export function resolveOmpRuntime(options: Options = {}): Required<Pick<RuntimeInspection, "root" | "version" | "source">> {
	const inspected = inspectOmpRuntime(options);
	if (!inspected.verified || !inspected.root || !inspected.version) throw new Error(`${inspected.reason ?? "OMP_RUNTIME_UNVERIFIED"}: ${inspected.root ?? "no runtime root"}`);
	return { root: inspected.root, version: inspected.version, source: inspected.source };
}

/** Resolve an installed OMP package file only after identity/version verification; no project node_modules fallback exists. */
export function runtimeModule(relative: string, options: Options = {}) {
	if (!/^[A-Za-z0-9@._/-]+$/.test(relative) || relative.includes("..") || !relative.startsWith("pi-coding-agent/")) throw new Error("OMP_RUNTIME_MODULE_INVALID");
	const file = path.join(path.dirname(resolveOmpRuntime(options).root), ...relative.split("/"));
	if (!fs.statSync(file).isFile()) throw new Error(`OMP_RUNTIME_MODULE_MISSING: ${relative}`);
	return file;
}

export function runtimePackageFile(packageId: "pi-catalog" | "omptype" | "pi-utils" | "pi-agent-core", relative: string, options: Options = {}) {
	if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.includes("..")) throw new Error("OMP_RUNTIME_MODULE_INVALID");
	const runtime = resolveOmpRuntime(options);
	const packageRoot = path.join(path.dirname(runtime.root), packageId);
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
	if (manifest.name !== `@oh-my-pi/${packageId}` || manifest.version !== runtime.version) throw new Error(`OMP_RUNTIME_PACKAGE_UNVERIFIED: ${packageId}`);
	const file = path.join(packageRoot, ...relative.split("/"));
	if (!fs.statSync(file).isFile()) throw new Error(`OMP_RUNTIME_MODULE_MISSING: ${packageId}/${relative}`);
	return file;
}
