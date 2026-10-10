import * as fs from "node:fs";
import * as path from "node:path";
import { inspectOmpRuntime } from "../omp/agent/lib/omp-runtime.ts";
import { assertWindowsDirectoryPin, extendWindowsDirectoryPin, pinWindowsDirectory, releaseWindowsDirectoryPin, type WindowsDirectoryPin } from "../omp/agent/lib/windows-directory-pin.ts";

const repo = path.resolve(import.meta.dir, "..");
const suites = ["tests/ambient-lab.test.ts", "tests/runtime-lifecycle.test.ts", "tests/runtime-compat.test.ts", "tests/research-evidence.test.ts", "tests/acceptance-evidence.test.ts"];
type Isolation = Readonly<{ root: string; runtimeRoot: string; bunInstall: string; temp: string; env: Record<string, string>; pin: WindowsDirectoryPin }>;

function samePath(a: string, b: string) { return path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase(); }
function marker(root: string, name: string, value: string) { return fs.existsSync(path.join(root, name)) && fs.readFileSync(path.join(root, name), "utf8").trim() === value; }

function candidateRoot(configured: string) {
	if (!path.isAbsolute(configured)) throw new Error("RUNTIME_SMOKE_RUNTIME_ROOT_NOT_ABSOLUTE");
	const inspected = inspectOmpRuntime({ runtimeRoot: configured });
	if (!inspected.verified || !inspected.root) throw new Error(`RUNTIME_SMOKE_${(inspected.reason ?? "OMP_RUNTIME_UNAVAILABLE").replace(/^OMP_/, "")}`);
	return inspected.root;
}

function isolation(): Isolation {
	const configuredRoot = process.env.OMP_EXPERIMENT_ROOT;
	const configuredRuntime = process.env.OMP_RUNTIME_ROOT;
	if (!configuredRoot) throw new Error("RUNTIME_SMOKE_EXPERIMENT_ROOT_REQUIRED");
	if (!configuredRuntime) throw new Error("RUNTIME_SMOKE_RUNTIME_ROOT_REQUIRED");
	if (!path.isAbsolute(configuredRoot)) throw new Error("RUNTIME_SMOKE_LAB_NOT_ABSOLUTE");
	let pin: WindowsDirectoryPin; try { pin = pinWindowsDirectory(configuredRoot); } catch { throw new Error("RUNTIME_SMOKE_LAB_REQUIRED"); }
	try {
		const root = pin.rootPath;
		if (!marker(root, ".omp-experiment-root", "omp-dependency-lab/v1") || !marker(root, ".omp-automation-lab-root", "omp-automation-lab/v1") || isUnder(repo, root) || isUnder(root, repo)) throw new Error("RUNTIME_SMOKE_LAB_REQUIRED");
		const runtimeRoot = candidateRoot(configuredRuntime);
		if (isUnder(runtimeRoot, root) || isUnder(root, runtimeRoot)) throw new Error("RUNTIME_SMOKE_LAB_BOUNDARY");
		const modules = path.dirname(path.dirname(runtimeRoot));
		const bunInstall = path.resolve(modules, "..", "..", "..");
		if (!samePath(modules, path.join(bunInstall, "install", "global", "node_modules"))) throw new Error("RUNTIME_SMOKE_RUNTIME_LAYOUT_INVALID");
		const temp = path.join(root, "runtime-smoke", "tmp");
		const env = { ...process.env, OMP_EXPERIMENT_ROOT: root, OMP_AUTOMATION_LAB_ROOT: root, OMP_RUNTIME_SMOKE_ROOT: root, OMP_AMBIENT_LAB_ROOT: root, OMP_RUNTIME_ROOT: runtimeRoot, BUN_INSTALL: bunInstall, TEMP: temp, TMP: temp };
		for (const [name, value] of Object.entries(env).filter(([name]) => ["OMP_AUTOMATION_LAB_ROOT", "OMP_RUNTIME_SMOKE_ROOT", "OMP_AMBIENT_LAB_ROOT", "BUN_INSTALL", "TEMP", "TMP"].includes(name)))
			if (process.env[name] !== undefined && !samePath(process.env[name]!, value)) throw new Error(`RUNTIME_SMOKE_ENV_CONFLICT:${name}`);
		extendWindowsDirectoryPin(pin, ["runtime-smoke", "tmp"]); assertWindowsDirectoryPin(pin);
		return Object.freeze({ root, runtimeRoot, bunInstall, temp, env, pin });
	} catch (error) { releaseWindowsDirectoryPin(pin); throw error; }
}

function isUnder(parent: string, child: string) { const relative = path.relative(parent, child); return !relative || !relative.startsWith("..") && !path.isAbsolute(relative); }
async function run(cmd: string[], env: Record<string, string>, pin: WindowsDirectoryPin) {
	assertWindowsDirectoryPin(pin);
	const child = Bun.spawn({ cmd, cwd: repo, stdout: "pipe", stderr: "pipe", env });
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { pid: child.pid, exitCode, stdout, stderr };
}

async function main() {
	const state = isolation();
	try {
		const probe = await run([process.execPath, "--eval", `const os = await import("node:os"); const runtime = await import(${JSON.stringify(path.join(repo, "omp", "agent", "lib", "omp-runtime.ts"))}); const inspected = runtime.resolveOmpRuntime(); console.log(JSON.stringify({ pid: process.pid, runtime: inspected.root, temp: os.tmpdir() }));`], state.env, state.pin);
		if (probe.exitCode !== 0) throw new Error("RUNTIME_SMOKE_PROBE_FAILED");
		let observed: { pid?: unknown; runtime?: unknown; temp?: unknown }; try { observed = JSON.parse(probe.stdout); } catch { throw new Error("RUNTIME_SMOKE_PROBE_INVALID"); }
		if (observed.pid === process.pid || !samePath(String(observed.runtime), state.runtimeRoot) || !samePath(String(observed.temp), state.temp)) throw new Error("RUNTIME_SMOKE_PROBE_ISOLATION_FAILED");
		const results = [];
		for (const file of suites) { const result = await run([process.execPath, "test", file, "--timeout", "90000"], state.env, state.pin); results.push({ suite: file, pid: result.pid, exitCode: result.exitCode }); if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
		const report = { ok: results.every(result => result.exitCode === 0), isolation: { root: state.root, fields: ["OMP_EXPERIMENT_ROOT", "OMP_AUTOMATION_LAB_ROOT", "OMP_RUNTIME_SMOKE_ROOT", "OMP_AMBIENT_LAB_ROOT", "OMP_RUNTIME_ROOT", "BUN_INSTALL", "TEMP", "TMP"], childRuntimeVerified: true, childTempVerified: true }, children: results, limits: ["No model, browser, publish, live deployment, or production controller database action runs.", "The created Git fixture is retained beneath the marked D: lab for inspection."] };
		console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
	} finally { releaseWindowsDirectoryPin(state.pin); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
