import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AUDITED_VERSION = "18.2.6";
const AUDITED_VERSIONS = ["18.2.4", "18.2.5", AUDITED_VERSION];
const mode = process.argv.includes("--deployed") ? "deployed" : "candidate";
const repo = path.resolve(import.meta.dir, "..");
const deployed = process.env.OMP_DEPLOY_ROOT;
if (mode === "deployed" && (!deployed || !path.isAbsolute(deployed))) throw new Error("DEPLOYED_ROOT_REQUIRED: set absolute OMP_DEPLOY_ROOT for --deployed");
const OMP_ROOT = mode === "deployed" ? path.resolve(deployed!) : path.join(repo, "omp");
const TASK_HOME = process.env.OMP_TASK_HOME ?? (mode === "deployed" ? path.dirname(OMP_ROOT) : os.homedir());
const BUN_ROOT = process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun");
const OMP_BINARY = path.join(BUN_ROOT, "bin", "omp.exe");
// OMP's native discovery APIs have only been exercised against the real home/.omp layout.
// A custom deployed root is therefore inventoried from its own files, never discovered via
// the caller's ambient home.
const deployedNativeDiscoveryScope = mode === "deployed"
	&& path.resolve(TASK_HOME) === path.resolve(os.homedir())
	&& path.resolve(OMP_ROOT) === path.resolve(TASK_HOME, ".omp");
const AGENT = path.join(OMP_ROOT, "agent");
const runtimeCandidate = process.env.OMP_RUNTIME_ROOT ?? path.join(process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun"), "install", "global", "node_modules");
const CORE = path.basename(path.resolve(runtimeCandidate)) === "pi-coding-agent" ? path.resolve(runtimeCandidate)
	: path.basename(path.resolve(runtimeCandidate)) === "@oh-my-pi" ? path.join(runtimeCandidate, "pi-coding-agent")
	: path.join(runtimeCandidate, "@oh-my-pi", "pi-coding-agent");
const EXTENSIONS = ["omp-control.ts", "product-review.ts", "run-archiver.ts", "session-continuity.ts", "task-health.ts", "task-usage.ts", "web-research-tools.ts"].map(name => `${AGENT}/extensions/${name}`);
const RETIRED = ["sp-research-auditor", "sp-research-synthesis", "sp-search-brave", "sp-search-exa", "sp-search-grok", "sp-search-tavily", "sp-search-x"];
const TRUSTED_EXTENSION_HASHES: Record<string, string> = {
	"omp-control.ts": "632a7fa4fec59d03d47fac7bd376f6cd0fcb2e1eebb089f83ec547d2f9a7c90e",
	"product-review.ts": "dac202ca8662930795786f6451bf35b5cc17fcdf6d171efd1e59b5bef13e6a21",
	"run-archiver.ts": "d127fd0d3e0f77d6798cda0c19626baa7f7887612a80e6acf74726a92dfa3699",
	"session-continuity.ts": "d6fcb39a2e33f950f75f2e394376a21aab204f54c843538e8efd38c3f0ad8978",
	"task-health.ts": "9ee23825616e1769c2fa75de6cc2796e87015d69b560c4059710c8606bd95790",
	"task-usage.ts": "771e252e147d07fa92a54cb51b0772bf1c20c1e954f74d4e8a167830f94c4431",
	"web-research-tools.ts": "dc583d33e9866b536b7b17861553eeb1ad5cf8d9a9e845a2a32aea28ef0682be",
};
const TRUSTED_IMPORTED_LIB_HASHES: Record<string, string> = {
	"windows-directory-pin.ts": "f60a9688880b81bdbe0ec96df4969e4a804e3f90e6b12b00465eb44c5562d7fd",
	"ambient-lab.ts": "aadf8fa4e3b6f4ded695c0ce13da1a178d68beef66f97461ab276202db14b5f3",
	"task-graph.ts": "71be3ca75c813636dc5c9e8ac3231d93ec259b9307778dea1cc934fc8aa4901a",
	"task-health.ts": "872f1ed615eb4680b17e8d910907241bbbacc50d709a48a37ec65e9b7340a217",
	"task-usage.ts": "09b0b5ee22969956c60a7588bfba6375b10b850c97b1423df20ed9a3d57112a4",
	"omp-runtime.ts": "c46dae1abf0790117b4bcf194c6a69956aea288e5d33659395d187fe3c3ff6c0",
	"research-evidence.ts": "5c2b51d7cde8d2557ed148d3f48ae08128dc288e93289b04952fa358c7f48dbc",
	"acceptance-evidence.ts": "2c62e832a5255d4e5d4c9c5ef37f84462bac7017909591c0ddda4b803fae1685",
	"product-review-evidence.ts": "e2713cb2ef7b909d20013d7be778e4acf040b4c06a884ebb5bc57587fc5bd950",
	"task-dispatch.ts": "07da1c58457f9f9e56480f99b4803058181a02d228098b7976826ed7896c2796",
};

type Check = { name: string; ok: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
const hash = async (file: string) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const exists = async (file: string) => fs.access(file).then(() => true).catch(() => false);

function inspectRuntime() {
	try {
		const root = fsSync.realpathSync(CORE);
		const manifest = JSON.parse(fsSync.readFileSync(path.join(root, "package.json"), "utf8"));
		if (manifest.name !== "@oh-my-pi/pi-coding-agent") return { ok: false, root, version: manifest.version, reason: "OMP_RUNTIME_IDENTITY_MISMATCH" };
		if (!AUDITED_VERSIONS.includes(manifest.version)) return { ok: false, root, version: manifest.version, reason: "OMP_RUNTIME_UNVERIFIED_VERSION" };
		return { ok: true, root, version: manifest.version };
	} catch (error) { return { ok: false, reason: `OMP_RUNTIME_UNAVAILABLE:${error instanceof Error ? error.name : String(error)}` }; }
}

async function files(root: string): Promise<string[]> {
	const output: string[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		const target = path.join(root, entry.name);
		if (entry.isDirectory()) output.push(...await files(target));
		else if (entry.isFile()) output.push(target);
	}
	return output;
}

async function main() {
	const runtime = inspectRuntime();
	check("omp_runtime", runtime.ok, runtime);
	if (!runtime.ok) {
		console.log(JSON.stringify({ ok: false, baseline: { recordedVersion: AUDITED_VERSION }, observed: { mode, runtime }, checks,
			limits: ["Runtime identity/version was rejected before any OMP internal module import."] }, null, 2));
		process.exitCode = 1;
		return;
	}
	const configPath = path.join(AGENT, "config.yml");
	const config = Bun.YAML.parse(await Bun.file(configPath).text()) as any;
	const lockPath = path.join(OMP_ROOT, "plugins", "omp-plugins.lock.json");
	const lock = JSON.parse(await Bun.file(lockPath).text()) as any;
	const binary = Bun.spawnSync([OMP_BINARY, "--version"], { stdout: "pipe", stderr: "pipe" });
	const binaryVersion = binary.stdout.toString().trim();
	check("omp_binary", binary.exitCode === 0 && binaryVersion.length > 0, { exitCode: binary.exitCode, version: binaryVersion });

	const manifests = Object.fromEntries(await Promise.all([
		"pi-coding-agent", "pi-natives", "pi-natives-win32-x64", "pi-tui", "pi-agent-core", "pi-utils", "omptype", "pi-catalog",
	].map(async name => [name, JSON.parse(await Bun.file(path.join(path.dirname(CORE), name, "package.json")).text())])) as Record<string, any>);
	const packages = Object.fromEntries(Object.entries(manifests).map(([name, manifest]) => [name, manifest.version]));
	const expectedNatives = manifests["pi-coding-agent"].dependencies?.["@oh-my-pi/pi-natives"];
	const expectedPlatform = manifests["pi-natives"].optionalDependencies?.["@oh-my-pi/pi-natives-win32-x64"];
	const binaryPackageVersion = binaryVersion.replace(/^omp\//, "");
	const internalPackagesMatch = ["pi-tui", "pi-agent-core", "pi-utils", "omptype", "pi-catalog"].every(name =>
		manifests[name].name === `@oh-my-pi/${name}` && packages[name] === manifests["pi-coding-agent"].dependencies?.[`@oh-my-pi/${name}`]);
	check("package_versions", internalPackagesMatch && packages["pi-coding-agent"] === binaryPackageVersion && packages["pi-natives"] === expectedNatives && packages["pi-natives-win32-x64"] === expectedPlatform, { packages, expectedNatives, expectedPlatform, binaryPackageVersion });

	let pluginSummary: any[] = [], agentNames: string[] = [], skillPaths: any[] = [], extensionPaths: string[] = [];

	const overrides = config.task?.agentModelOverrides ?? {};
	const unresolvedAliases = Object.entries(overrides).filter(([, value]) => typeof value === "string" && value.startsWith("@") && !config.modelRoles?.[value.slice(1)]);
	check("role_aliases_resolve", unresolvedAliases.length === 0, { modelRoles: config.modelRoles, agentModelOverrides: overrides, unresolvedAliases });
	check("retired_role_bindings_absent", RETIRED.every(name => !(name in overrides)), overrides);

	const extensionHashes = Object.fromEntries(await Promise.all(EXTENSIONS.map(async file => [path.basename(file), await hash(file)])));
	const changedExtensions = Object.entries(TRUSTED_EXTENSION_HASHES).filter(([name, expected]) => extensionHashes[name] !== expected).map(([name]) => name);
	check("trusted_extension_sources", changedExtensions.length === 0, { changedExtensions, extensionHashes });
	const importedLibs = Object.keys(TRUSTED_IMPORTED_LIB_HASHES).map(name => `${AGENT}/lib/${name}`);
	const importedLibHashes = Object.fromEntries(await Promise.all(importedLibs.map(async file => [path.basename(file), await hash(file)])));
	const changedImportedLibs = Object.entries(TRUSTED_IMPORTED_LIB_HASHES).filter(([name, expected]) => importedLibHashes[name] !== expected).map(([name]) => name);
	check("trusted_import_sources", changedExtensions.length === 0 && changedImportedLibs.length === 0, { changedExtensions, changedImportedLibs, importedLibHashes });
	if (mode === "deployed") check("native_deployed_discovery_scope", deployedNativeDiscoveryScope, { OMP_ROOT, TASK_HOME, expectedRoot: path.join(os.homedir(), ".omp") });
	if (runtime.ok && changedExtensions.length === 0 && changedImportedLibs.length === 0) {
		try {
			if (mode === "candidate" || !deployedNativeDiscoveryScope) {
				agentNames = (await fs.readdir(path.join(AGENT, "agents"), { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".md")).map(entry => path.basename(entry.name, ".md"));
				skillPaths = (await fs.readdir(path.join(AGENT, "skills"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, path: path.join(AGENT, "skills", entry.name, "SKILL.md") }));
				const inventory = mode === "candidate" ? "candidate" : "deployed_custom_root";
				check(`${inventory}_plugin_inventory`, lock.plugins !== undefined, { lockPath });
				check("ponytail_disabled_but_local_skill_present", lock.plugins?.["@dietrichgebert/ponytail"]?.enabled === false && skillPaths.some(skill => skill.name === "ponytail"), { pluginEnabled: lock.plugins?.["@dietrichgebert/ponytail"]?.enabled, localSkill: skillPaths.find(skill => skill.name === "ponytail") });
				check(`${inventory}_agent_inventory`, RETIRED.every(name => !agentNames.includes(name)), { retired: RETIRED, discovered: agentNames });
				check(`${inventory}_extension_inventory`, (await Promise.all(EXTENSIONS.map(exists))).every(Boolean), EXTENSIONS);
				if (mode === "candidate") {
					const imported = await Promise.all(EXTENSIONS.map(async file => ({ file, module: await import(file) })));
					check("custom_extension_module_imports", imported.every(item => typeof item.module.default === "function"), imported.map(item => ({ file: item.file, defaultExport: typeof item.module.default })));
				} else check("custom_extension_module_imports", true, "Skipped for custom deployed root: only its own file inventory was inspected.");
			} else {
			const [{ getEnabledPlugins, resolvePluginExtensionPaths }, { discoverAgents }, { discoverExtensionPaths }, { loadCapability }] = await Promise.all([
				import(path.join(CORE, "src/extensibility/plugins/loader.ts")),
				import(path.join(CORE, "src/task/discovery.ts")),
				import(path.join(CORE, "src/extensibility/extensions/loader.ts")),
				import(path.join(CORE, "src/discovery/index.ts")),
			]);
			const [plugins, agentResult, skills, paths] = await Promise.all([
				getEnabledPlugins(TASK_HOME, { home: TASK_HOME }), discoverAgents(TASK_HOME, TASK_HOME),
				loadCapability<any>("skills", { cwd: TASK_HOME }), discoverExtensionPaths([], TASK_HOME, undefined, { ambient: true, includeAmbientHooks: false }),
			]);
			pluginSummary = plugins.map((plugin: any) => ({ name: plugin.name, version: plugin.version, extensions: resolvePluginExtensionPaths(plugin) }));
			agentNames = agentResult.agents.map((agent: any) => agent.name);
			skillPaths = skills.items.filter((skill: any) => skill.path.replaceAll("\\", "/").includes("/.omp/agent/skills/")).map((skill: any) => ({ name: skill.name, path: skill.path }));
			extensionPaths = paths;
			check("native_plugin_discovery", !pluginSummary.some(plugin => plugin.name === "@dietrichgebert/ponytail"), pluginSummary);
			check("ponytail_disabled_but_local_skill_present", lock.plugins?.["@dietrichgebert/ponytail"]?.enabled === false && skillPaths.some(skill => skill.name === "ponytail"), { pluginEnabled: lock.plugins?.["@dietrichgebert/ponytail"]?.enabled, localSkill: skillPaths.find(skill => skill.name === "ponytail") });
			check("native_agent_discovery", RETIRED.every(name => !agentNames.includes(name)), { retired: RETIRED, discovered: agentNames });
			check("native_extension_path_discovery", EXTENSIONS.every(extension => extensionPaths.map(value => path.resolve(value)).includes(path.resolve(extension))), { mode, extensionPaths });
			const imported = await Promise.all(EXTENSIONS.map(async file => ({ file, module: await import(file) })));
			check("custom_extension_module_imports", imported.every(item => typeof item.module.default === "function"), imported.map(item => ({ file: item.file, defaultExport: typeof item.module.default })));
			}
		} catch (error) {
			check("native_runtime_discovery", false, error instanceof Error ? error.message : String(error));
			check("custom_extension_module_imports", false, error instanceof Error ? error.message : String(error));
		}
	} else {
		const reason = runtime.ok ? "extension or transitive local lib source changed since the reviewed baseline" : "runtime identity/version is unverified";
		check("native_runtime_discovery", false, `Skipped: ${reason}; no internal runtime module was imported.`);
		check("custom_extension_module_imports", false, `Skipped: ${reason}; inspect before importing.`);
	}

	const tracked = [...EXTENSIONS, ...await files(`${AGENT}/lib`), configPath, lockPath, `${AGENT}/skills/ponytail/SKILL.md`, ...await files(`${AGENT}/rules`)];
	const missing = await Promise.all(tracked.map(async file => ({ file, exists: await exists(file) })));
	check("tracked_files_present", missing.every(item => item.exists), missing.filter(item => !item.exists));
	const hashes = Object.fromEntries(await Promise.all(tracked.filter((_, index) => missing[index].exists).map(async file => [file.replaceAll("\\", "/"), await hash(file)])));

	const result = {
		ok: checks.every(item => item.ok),
		baseline: { recordedVersion: AUDITED_VERSION, auditedVersions: AUDITED_VERSIONS, note: "Only explicitly reviewed releases are accepted; prior reviewed release remains available for rollback." },
		observed: { mode, runtime, binaryVersion, packages, plugins: pluginSummary, agents: agentNames, localSkills: skillPaths, extensionPaths, hashes },
		checks,
		limits: ["Offline structural compatibility only: imports occur only for reviewed extension and transitive local-lib hashes and never invoke an extension factory, model call, task start/cancel, restore, archive, or usage-gate lifecycle test.", "Full bundling is not tested by this checker. The initial OMP 18.2.4 probe failed because legacy-pi-compat.ts dynamically imported unresolved omp-legacy-pi-modules; this is historical evidence, not a result for the observed version.", "A passing result is not live acceptance or a claim of full upgrade compatibility."],
	};
	console.log(JSON.stringify(result, null, 2));
	if (!result.ok) process.exitCode = 1;
}

main().catch(error => {
	console.log(JSON.stringify({ ok: false, checks, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }, null, 2));
	process.exitCode = 1;
});
