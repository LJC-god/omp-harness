import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUDITED_OMP_VERSION, AUDITED_OMP_VERSIONS, inspectOmpRuntime, resolveOmpRuntime, runtimeModule, runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";

function fixture(version = AUDITED_OMP_VERSION, name = "@oh-my-pi/pi-coding-agent") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-runtime-"));
	const agent = path.join(root, "node_modules", "@oh-my-pi", "pi-coding-agent");
	fs.mkdirSync(path.join(agent, "src", "config"), { recursive: true });
	fs.writeFileSync(path.join(agent, "package.json"), JSON.stringify({ name, version }));
	fs.writeFileSync(path.join(agent, "src", "config", "settings.ts"), "export {};");
	fs.mkdirSync(path.join(root, "node_modules", "@oh-my-pi", "pi-catalog", "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "node_modules", "@oh-my-pi", "pi-catalog", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-catalog", version }));
	fs.writeFileSync(path.join(root, "node_modules", "@oh-my-pi", "pi-catalog", "src", "models.json"), "{}");
	return { root, modules: path.join(root, "node_modules"), agent };
}

type UpgradeCheck = { name: string; ok: boolean; detail?: any };
type UpgradeResult = { ok: boolean; checks: UpgradeCheck[] };

const candidateRoot = path.resolve(import.meta.dir, "..");
const requiredIsolation = ["OMP_EXPERIMENT_ROOT", "OMP_AUTOMATION_LAB_ROOT", "OMP_RUNTIME_SMOKE_ROOT", "OMP_AMBIENT_LAB_ROOT", "OMP_RUNTIME_ROOT", "BUN_INSTALL", "TEMP", "TMP"] as const;
for (const name of requiredIsolation) if (!process.env[name]) throw new Error(`UPGRADE_CHECKER_ISOLATION_REQUIRED:${name}`);
const runtimeSmokeRoot = path.resolve(process.env.OMP_RUNTIME_SMOKE_ROOT!);
const marked = (name: string, value: string) => fs.existsSync(path.join(runtimeSmokeRoot, name)) && fs.readFileSync(path.join(runtimeSmokeRoot, name), "utf8").trim() === value;
if (!/^D:[\\/]/i.test(runtimeSmokeRoot) || !marked(".omp-experiment-root", "omp-dependency-lab/v1") || !marked(".omp-automation-lab-root", "omp-automation-lab/v1")) throw new Error("RUNTIME_SMOKE_LAB_REQUIRED");
const trustEvidenceRoot = path.join(runtimeSmokeRoot, "evidence", "trust");
fs.mkdirSync(trustEvidenceRoot, { recursive: true });

function upgradeSnapshot() {
	const root = fs.mkdtempSync(path.join(trustEvidenceRoot, "runtime-compat-"));
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.copyFileSync(path.join(candidateRoot, "scripts", "check-upgrade.ts"), path.join(root, "scripts", "check-upgrade.ts"));
	fs.cpSync(path.join(candidateRoot, "omp"), path.join(root, "omp"), { recursive: true });
	const lab = path.join(root, "lab");
	fs.mkdirSync(lab, { recursive: true });
	fs.writeFileSync(path.join(lab, ".omp-experiment-root"), "omp-dependency-lab/v1\n");
	fs.writeFileSync(path.join(lab, ".omp-automation-lab-root"), "omp-automation-lab/v1\n");
	return { root, lab };
}

function checker(snapshot: ReturnType<typeof upgradeSnapshot>) {
	const env = {
		...process.env,
		BUN_INSTALL: process.env.BUN_INSTALL!,
		OMP_RUNTIME_ROOT: process.env.OMP_RUNTIME_ROOT!,
		OMP_EXPERIMENT_ROOT: snapshot.lab,
		OMP_AUTOMATION_LAB_ROOT: snapshot.lab,
		OMP_RUNTIME_SMOKE_ROOT: snapshot.lab,
		OMP_AMBIENT_LAB_ROOT: snapshot.lab,
		PI_CODING_AGENT_DIR: path.join(snapshot.root, "omp", "agent"),
		TEMP: path.join(snapshot.lab, "tmp"),
		TMP: path.join(snapshot.lab, "tmp"),
	};
	fs.mkdirSync(env.TEMP, { recursive: true });
	const result = Bun.spawnSync({ cmd: [process.execPath, path.join(snapshot.root, "scripts", "check-upgrade.ts")], cwd: snapshot.root, stdout: "pipe", stderr: "pipe", env });
	return { exitCode: result.exitCode, stderr: result.stderr.toString(), output: JSON.parse(result.stdout.toString()) as UpgradeResult };
}

function check(output: UpgradeResult, name: string) {
	const found = output.checks.find(item => item.name === name);
	if (!found) throw new Error(`UPGRADE_CHECK_MISSING:${name}`);
	return found;
}

test("explicit runtime root validates installed package identity and audited version before paths are exposed", () => {
	for (const version of AUDITED_OMP_VERSIONS) {
		const source = fixture(version);
		const inspected = inspectOmpRuntime({ runtimeRoot: source.modules });
		expect(inspected).toMatchObject({ root: fs.realpathSync(source.agent), version, source: "OMP_RUNTIME_ROOT", verified: true });
		expect(runtimeModule("pi-coding-agent/src/config/settings.ts", { runtimeRoot: source.modules })).toBe(path.join(fs.realpathSync(source.agent), "src", "config", "settings.ts"));
		expect(runtimePackageFile("pi-catalog", "src/models.json", { runtimeRoot: source.modules })).toBe(path.join(fs.realpathSync(source.modules), "@oh-my-pi", "pi-catalog", "src", "models.json"));
	}
});

test("sibling internals require their own audited package identity and version", () => {
	const source = fixture();
	const sibling = path.join(source.modules, "@oh-my-pi", "pi-agent-core");
	fs.mkdirSync(path.join(sibling, "src", "compaction"), { recursive: true });
	fs.writeFileSync(path.join(sibling, "src", "compaction", "messages.ts"), "export {};");
	fs.writeFileSync(path.join(sibling, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-agent-core", version: AUDITED_OMP_VERSION }));
	expect(runtimePackageFile("pi-agent-core", "src/compaction/messages.ts", { runtimeRoot: source.modules })).toContain("pi-agent-core");
	fs.writeFileSync(path.join(sibling, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-agent-core", version: "18.2.4" }));
	expect(() => runtimePackageFile("pi-agent-core", "src/compaction/messages.ts", { runtimeRoot: source.modules })).toThrow("OMP_RUNTIME_PACKAGE_UNVERIFIED");
	fs.writeFileSync(path.join(sibling, "package.json"), JSON.stringify({ name: "other/pi-agent-core", version: AUDITED_OMP_VERSION }));
	expect(() => runtimePackageFile("pi-agent-core", "src/compaction/messages.ts", { runtimeRoot: source.modules })).toThrow("OMP_RUNTIME_PACKAGE_UNVERIFIED");
	fs.writeFileSync(path.join(sibling, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-agent-core", version: "19.0.0" }));
	expect(() => runtimePackageFile("pi-agent-core", "src/compaction/messages.ts", { runtimeRoot: source.modules })).toThrow("OMP_RUNTIME_PACKAGE_UNVERIFIED");
});

test("unknown version or identity is reported unverified before internal resolution", () => {
	const stale = fixture("19.0.0");
	expect(inspectOmpRuntime({ runtimeRoot: stale.modules })).toMatchObject({ verified: false, reason: "OMP_RUNTIME_UNVERIFIED_VERSION" });
	expect(() => resolveOmpRuntime({ runtimeRoot: stale.modules })).toThrow("OMP_RUNTIME_UNVERIFIED_VERSION");
	const wrong = fixture(AUDITED_OMP_VERSION, "other/package");
	expect(inspectOmpRuntime({ runtimeRoot: wrong.modules })).toMatchObject({ verified: false, reason: "OMP_RUNTIME_IDENTITY_MISMATCH" });
	expect(() => runtimeModule("pi-coding-agent/../outside.ts", { runtimeRoot: stale.modules })).toThrow("OMP_RUNTIME_MODULE_INVALID");
	const absent = path.join(stale.root, "absent-runtime");
	expect(inspectOmpRuntime({ runtimeRoot: absent })).toMatchObject({ verified: false, source: "OMP_RUNTIME_ROOT" });
	expect(() => resolveOmpRuntime({ runtimeRoot: absent })).toThrow("OMP_RUNTIME_UNAVAILABLE");
});

test("fallback uses only the Bun global installation shape, never a project node_modules search", () => {
	const source = fixture();
	const bun = path.join(source.root, ".bun");
	fs.mkdirSync(path.join(bun, "install", "global"), { recursive: true });
	fs.renameSync(source.modules, path.join(bun, "install", "global", "node_modules"));
	const override = process.env.OMP_RUNTIME_ROOT;
	delete process.env.OMP_RUNTIME_ROOT;
	try {
		const inspected = inspectOmpRuntime({ bunInstall: bun, home: path.join(source.root, "unused-home") });
		expect(inspected).toMatchObject({ source: "BUN_INSTALL", verified: true });
	} finally {
		if (override !== undefined) process.env.OMP_RUNTIME_ROOT = override;
	}
});

test("actual upgrade checker accepts only the approved candidate source before extension imports", () => {
	const result = checker(upgradeSnapshot());
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(0);
	expect(result.output.ok).toBe(true);
	expect(check(result.output, "trusted_extension_sources").ok).toBe(true);
	expect(check(result.output, "trusted_import_sources").ok).toBe(true);
	expect(check(result.output, "custom_extension_module_imports").ok).toBe(true);
}, 30_000);

test("actual upgrade checker rejects a one-byte trusted extension change before imports", () => {
	const snapshot = upgradeSnapshot();
	fs.appendFileSync(path.join(snapshot.root, "omp", "agent", "extensions", "session-continuity.ts"), "\n");
	const result = checker(snapshot);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(1);
	expect(result.output.ok).toBe(false);
	expect(check(result.output, "trusted_extension_sources")).toMatchObject({ ok: false, detail: { changedExtensions: expect.arrayContaining(["session-continuity.ts"]) } });
	expect(check(result.output, "trusted_import_sources")).toMatchObject({ ok: false, detail: { changedExtensions: expect.arrayContaining(["session-continuity.ts"]) } });
	expect(check(result.output, "native_runtime_discovery")).toMatchObject({ ok: false, detail: expect.stringContaining("no internal runtime module was imported") });
	expect(check(result.output, "custom_extension_module_imports")).toMatchObject({ ok: false, detail: expect.stringContaining("inspect before importing") });
}, 30_000);

test("actual upgrade checker keeps the imported-library guard closed for a one-byte change before imports", () => {
	const snapshot = upgradeSnapshot();
	fs.appendFileSync(path.join(snapshot.root, "omp", "agent", "lib", "task-dispatch.ts"), "\n");
	const result = checker(snapshot);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(1);
	expect(check(result.output, "trusted_extension_sources").ok).toBe(true);
	expect(check(result.output, "trusted_import_sources")).toMatchObject({ ok: false, detail: { changedImportedLibs: expect.arrayContaining(["task-dispatch.ts"]) } });
	expect(check(result.output, "native_runtime_discovery")).toMatchObject({ ok: false, detail: expect.stringContaining("no internal runtime module was imported") });
	expect(check(result.output, "custom_extension_module_imports")).toMatchObject({ ok: false, detail: expect.stringContaining("inspect before importing") });
}, 30_000);

function smoke(root: string | undefined, runtime: string | undefined, extra: Record<string, string | undefined> = {}, sourceRoot = candidateRoot) {
	const env = { ...process.env, ...extra } as Record<string, string | undefined>;
	for (const name of ["OMP_EXPERIMENT_ROOT", "OMP_AUTOMATION_LAB_ROOT", "OMP_RUNTIME_SMOKE_ROOT", "OMP_AMBIENT_LAB_ROOT", "OMP_RUNTIME_ROOT", "BUN_INSTALL", "TEMP", "TMP"]) delete env[name];
	if (root !== undefined) env.OMP_EXPERIMENT_ROOT = root;
	if (runtime !== undefined) env.OMP_RUNTIME_ROOT = runtime;
	Object.assign(env, extra);
	// Bun on Windows restores system TEMP/TMP for spawned children even after
	// deletion; supply the launcher-derived values unless this case conflicts.
	if (root !== undefined) {
		const derivedTemp = path.join(root, "runtime-smoke", "tmp");
		if (env.TEMP === undefined) env.TEMP = derivedTemp;
		if (env.TMP === undefined) env.TMP = derivedTemp;
	}
	// Bootstrap Bun with a separate retained test temp, then set the fixture
	// environment before importing the launcher. Otherwise Bun itself creates a
	// negative fixture's runtime-smoke/tmp before the launcher can reject it.
	fs.mkdirSync(finishLabRoot, { recursive: true });
	const bootstrap = fs.mkdtempSync(path.join(finishLabRoot, "bootstrap-"));
	const intended = Object.fromEntries(requiredIsolation.flatMap(name => env[name] === undefined ? [] : [[name, env[name]!]]));
	const childEnv = { ...env };
	for (const name of requiredIsolation) delete childEnv[name];
	childEnv.TEMP = bootstrap; childEnv.TMP = bootstrap;
	const program = `for (const [name, value] of Object.entries(${JSON.stringify(intended)})) process.env[name] = String(value); await import(${JSON.stringify(path.join(sourceRoot, "scripts", "check-runtime-smoke.ts"))});`;
	const result = Bun.spawnSync({ cmd: [process.execPath, "--eval", program], cwd: sourceRoot, stdout: "pipe", stderr: "pipe", env: childEnv as Record<string, string> });
	return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

const finishLabRoot = path.join(runtimeSmokeRoot, "b-finish");

function markedSmokeLab(name: string) {
	const root = path.join(finishLabRoot, name);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, ".omp-experiment-root"), "omp-dependency-lab/v1\n");
	fs.writeFileSync(path.join(root, ".omp-automation-lab-root"), "omp-automation-lab/v1\n");
	return root;
}

function copiedSmokeSource(name: string) {
	const root = path.join(finishLabRoot, name);
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.copyFileSync(path.join(candidateRoot, "scripts", "check-runtime-smoke.ts"), path.join(root, "scripts", "check-runtime-smoke.ts"));
	fs.cpSync(path.join(candidateRoot, "omp"), path.join(root, "omp"), { recursive: true });
	fs.writeFileSync(path.join(root, ".omp-experiment-root"), "omp-dependency-lab/v1\n");
	fs.writeFileSync(path.join(root, ".omp-automation-lab-root"), "omp-automation-lab/v1\n");
	return root;
}

function directoryListing(root: string): string[] {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? [entry.name, ...directoryListing(path.join(root, entry.name)).map(child => `${entry.name}/${child}`)] : [entry.name]).sort();
}

test("smoke launcher rejects missing, unmarked, every inherited conflict, and invalid explicit runtime settings before it creates its temp root", () => {
	const runtime = process.env.OMP_RUNTIME_ROOT!;
	const missing = smoke(undefined, undefined);
	expect(missing.exitCode).toBe(1);
	expect(missing.output).toContain("RUNTIME_SMOKE_EXPERIMENT_ROOT_REQUIRED");
	const unmarked = path.join(finishLabRoot, `unmarked-${crypto.randomUUID()}`);
	fs.mkdirSync(unmarked, { recursive: true });
	const invalidMarker = smoke(unmarked, runtime);
	expect(invalidMarker.exitCode).toBe(1);
	expect(invalidMarker.output).toContain("RUNTIME_SMOKE_LAB_REQUIRED");
	expect(fs.existsSync(path.join(unmarked, "runtime-smoke"))).toBe(false);
	const wrongMarker = markedSmokeLab(`wrong-marker-${crypto.randomUUID()}`);
	fs.writeFileSync(path.join(wrongMarker, ".omp-automation-lab-root"), "wrong\n");
	const wrongMarkerResult = smoke(wrongMarker, runtime);
	expect(wrongMarkerResult.exitCode).toBe(1);
	expect(wrongMarkerResult.output).toContain("RUNTIME_SMOKE_LAB_REQUIRED");
	expect(fs.existsSync(path.join(wrongMarker, "runtime-smoke"))).toBe(false);
	const lab = markedSmokeLab(`launcher-${crypto.randomUUID()}`);
	const invalidRuntime = smoke(lab, path.join(lab, "absent-runtime"));
	expect(invalidRuntime.exitCode).toBe(1);
	expect(invalidRuntime.output).toContain("RUNTIME_SMOKE_RUNTIME_UNAVAILABLE");
	expect(fs.existsSync(path.join(lab, "runtime-smoke"))).toBe(false);
	const nestedRuntime = path.join(lab, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
	fs.mkdirSync(nestedRuntime, { recursive: true });
	fs.writeFileSync(path.join(nestedRuntime, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: AUDITED_OMP_VERSION }));
	const nestedRuntimeResult = smoke(lab, nestedRuntime);
	expect(nestedRuntimeResult.exitCode).toBe(1);
	expect(nestedRuntimeResult.output).toContain("RUNTIME_SMOKE_LAB_BOUNDARY");
	expect(fs.existsSync(path.join(lab, "runtime-smoke"))).toBe(false);
	for (const name of ["OMP_AUTOMATION_LAB_ROOT", "OMP_RUNTIME_SMOKE_ROOT", "OMP_AMBIENT_LAB_ROOT", "BUN_INSTALL", "TEMP", "TMP"]) {
		const conflict = smoke(lab, runtime, { [name]: path.join(lab, `foreign-${name}`) });
		expect(conflict.exitCode).toBe(1);
		expect(conflict.output).toContain(`RUNTIME_SMOKE_ENV_CONFLICT:${name}`);
		expect(fs.existsSync(path.join(lab, "runtime-smoke"))).toBe(false);
	}
});

test("smoke launcher rejects actual junctions and a marked isolated source copy before temp creation", () => {
	const runtime = process.env.OMP_RUNTIME_ROOT!;
	const target = markedSmokeLab(`junction-target-${crypto.randomUUID()}`), junction = path.join(finishLabRoot, `junction-${crypto.randomUUID()}`);
	fs.symlinkSync(target, junction, "junction");
	const redirected = smoke(junction, runtime);
	expect(redirected.exitCode).toBe(1); expect(redirected.output).toContain("RUNTIME_SMOKE_LAB_REQUIRED");
	expect(fs.existsSync(path.join(target, "runtime-smoke"))).toBe(false);
	const childLab = markedSmokeLab(`junction-child-${crypto.randomUUID()}`), outside = path.join(finishLabRoot, `junction-outside-${crypto.randomUUID()}`);
	fs.mkdirSync(outside, { recursive: true });
	const sentinel = path.join(outside, "sentinel.txt"); fs.writeFileSync(sentinel, "outside-must-stay-unchanged\n");
	const outsideBefore = directoryListing(outside);
	fs.symlinkSync(outside, path.join(childLab, "runtime-smoke"), "junction");
	const childRedirected = smoke(childLab, runtime);
	expect(childRedirected.exitCode).toBe(1); expect(childRedirected.output).toContain("WINDOWS_DIRECTORY_PIN_REPARSE");
	expect(fs.existsSync(path.join(outside, "tmp"))).toBe(false);
	expect(directoryListing(outside)).toEqual(outsideBefore);
	expect(fs.readFileSync(sentinel, "utf8")).toBe("outside-must-stay-unchanged\n");
	const sourceMarkers = [path.join(candidateRoot, ".omp-experiment-root"), path.join(candidateRoot, ".omp-automation-lab-root")];
	expect(sourceMarkers.every(file => !fs.existsSync(file))).toBe(true);
	const source = copiedSmokeSource(`source-boundary-${crypto.randomUUID()}`);
	const sourceRejected = smoke(source, runtime, {}, source);
	expect(sourceRejected.exitCode).toBe(1); expect(sourceRejected.output).toContain("RUNTIME_SMOKE_LAB_REQUIRED");
	expect(sourceMarkers.every(file => !fs.existsSync(file))).toBe(true);
	expect(fs.existsSync(path.join(candidateRoot, "runtime-smoke"))).toBe(false);
});
