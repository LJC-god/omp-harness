#!/usr/bin/env node
/**
 * Install the decomposed harness into a fresh OMP home.
 * Refuses to write the frozen snapshot at <repo>/omp.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const snapshot = path.join(repo, "omp");
const bun = process.env.BUN_BIN || "bun";

function fail(message) {
	throw new Error(message);
}

function requireAbsolute(name) {
	const value = process.env[name];
	if (!value || !path.isAbsolute(value)) fail(`${name} must be an absolute path`);
	return path.resolve(value);
}

function assertOutsideSnapshot(target) {
	const relative = path.relative(snapshot, path.resolve(target));
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
		fail(`refusing to write inside the snapshot tree: ${target}`);
	}
}

// Any Windows user-profile .omp directory, either path separator.
const legacyHome = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s`"']+[\\/]+\.omp/g;
const legacyData = "D:/" + "OMPData";
const legacyDataWin = "D:\\" + "OMPData";
const legacyLabs = "D:/" + "Labs";
const legacyOwner = "LJC-" + "god";

function rewritePaths(text) {
	return text
		.replace(legacyHome, "~/.omp")
		.replaceAll(legacyData, "$OMP_DATA_ROOT")
		.replaceAll(legacyDataWin, "$OMP_DATA_ROOT")
		.replaceAll(legacyLabs, "$OMP_DATA_ROOT")
		.replaceAll(`${legacyOwner}/omp-archive-index`, "$OMP_ARCHIVE_GITHUB_REPO")
		.replaceAll(legacyOwner, "$OMP_ARCHIVE_GITHUB_OWNER");
}

const preface = "本文件由 harness 安装器从冻结快照投影。本机路径已换成环境变量：数据根是 OMP_DATA_ROOT，控制库是 OMP_CONTROL_DB，归档远程是 OMP_ARCHIVE_GITHUB_REPO。历史句子里的盘符不是这台机器的默认盘。Windows 目录句柄只在 Windows 上、且数据根位于该盘时生效。\n\n";

function copyRewritten(from, to) {
	const stat = statSync(from);
	if (stat.isDirectory()) {
		mkdirSync(to, { recursive: true });
		for (const name of readdirSync(from)) copyRewritten(path.join(from, name), path.join(to, name));
		return;
	}
	const raw = readFileSync(from);
	if (from.endsWith(".md") || from.endsWith(".yml") || from.endsWith(".py")) {
		writeFileSync(to, preface + rewritePaths(raw.toString("utf8")));
		return;
	}
	writeFileSync(to, raw);
}

function copyTree(from, to) {
	rmSync(to, { recursive: true, force: true });
	cpSync(from, to, { recursive: true });
}

function installSkillPackage(dir, skillsDir) {
	const result = spawnSync(process.execPath, [path.join(dir, "install.mjs"), "--dest", skillsDir], { encoding: "utf8" });
	if (result.status !== 0) fail(result.stderr || result.stdout || `skill install failed: ${dir}`);
}

function ompVersion() {
	const result = spawnSync("omp", ["--version"], { encoding: "utf8" });
	const text = `${result.stdout || ""}\n${result.stderr || ""}`;
	const match = text.match(/18\.2\.6/);
	if (!match) fail(`OMP 18.2.6 is required, got: ${text.trim()}`);
}

function discoverRuntimeRoot() {
	const which = spawnSync("sh", ["-c", "command -v omp"], { encoding: "utf8" });
	const bin = (which.stdout || "").trim();
	if (!bin) fail("omp is not on PATH");
	let dir = path.dirname(realpathSync(bin));
	for (let hop = 0; hop < 8; hop++) {
		const manifestPath = path.join(dir, "package.json");
		if (existsSync(manifestPath)) {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (manifest.name === "@oh-my-pi/pi-coding-agent") {
				if (manifest.version !== "18.2.6") fail(`omp binary package is ${manifest.version}, want 18.2.6`);
				return dir;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	fail("could not locate @oh-my-pi/pi-coding-agent@18.2.6 from the omp binary");
}

export function installHarness(options = {}) {
	const home = path.resolve(options.home || process.env.OMP_HOME || path.join(process.env.HOME || "", ".omp"));
	if (!path.isAbsolute(home)) fail("OMP_HOME must be absolute");
	process.env.OMP_HOME = home;
	const dataRoot = requireAbsolute("OMP_DATA_ROOT");
	const archiveRepo = process.env.OMP_ARCHIVE_GITHUB_REPO || "";
	if (!/^[A-Za-z0-9_.-]+\/omp-archive-[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(archiveRepo)) {
		fail("OMP_ARCHIVE_GITHUB_REPO must look like owner/omp-archive-name");
	}
	const controlDb = process.env.OMP_CONTROL_DB
		? requireAbsolute("OMP_CONTROL_DB")
		: path.join(home, "agent", "orchestration.sqlite");
	const indexDir = process.env.OMP_ARCHIVE_INDEX_DIR
		? requireAbsolute("OMP_ARCHIVE_INDEX_DIR")
		: path.join(dataRoot, "github", "archive-index");
	const skillsDir = path.join(home, "agent", "skills");
	assertOutsideSnapshot(home);
	assertOutsideSnapshot(dataRoot);
	ompVersion();
	const runtimeRoot = discoverRuntimeRoot();

	const agent = path.join(home, "agent");
	mkdirSync(path.join(agent, "extensions"), { recursive: true });
	mkdirSync(skillsDir, { recursive: true });
	mkdirSync(dataRoot, { recursive: true });
	mkdirSync(path.join(dataRoot, "archives"), { recursive: true });
	mkdirSync(path.join(dataRoot, "worktrees"), { recursive: true });
	mkdirSync(indexDir, { recursive: true });
	mkdirSync(path.dirname(controlDb), { recursive: true });

	const config = readFileSync(path.join(repo, "harness", "config", "config.yml"), "utf8")
		.replaceAll("__OMP_SKILLS_DIR__", skillsDir)
		.replaceAll("__OMP_WORKTREE_BASE__", path.join(dataRoot, "worktrees"));
	writeFileSync(path.join(agent, "config.yml"), config);
	writeFileSync(path.join(agent, "web-research-large.yml"), readFileSync(path.join(repo, "harness", "config", "web-research-large.yml")));
	copyTree(path.join(repo, "harness", "rules"), path.join(agent, "rules"));
	copyTree(path.join(repo, "harness", "agents"), path.join(agent, "agents"));
	mkdirSync(path.join(agent, "commands"), { recursive: true });
	writeFileSync(path.join(agent, "commands", "web-research-v1.md"), readFileSync(path.join(repo, "harness", "commands", "web-research-v1.md")));
	for (const name of ["coding-procedure.md", "maintenance-cleanup.md"]) {
		writeFileSync(path.join(agent, "commands", name), preface + rewritePaths(readFileSync(path.join(snapshot, "agent", "commands", name), "utf8")));
	}
	mkdirSync(path.join(agent, "notes"), { recursive: true });
	writeFileSync(path.join(agent, "notes", "web-research-policy.md"), readFileSync(path.join(repo, "harness", "notes", "web-research-policy.md")));
	for (const name of readdirSync(path.join(snapshot, "agent", "notes"))) {
		if (name === "web-research-policy.md") continue;
		copyRewritten(path.join(snapshot, "agent", "notes", name), path.join(agent, "notes", name));
	}

	copyTree(path.join(repo, "packages", "runtime", "lib"), path.join(agent, "lib"));
	copyTree(path.join(repo, "packages", "runtime", "extensions"), path.join(agent, "extensions"));
	const swarmDest = path.join(agent, "swarm-control");
	rmSync(swarmDest, { recursive: true, force: true });
	mkdirSync(swarmDest, { recursive: true });
	const swarmSrc = path.join(repo, "packages", "runtime", "swarm-control");
	for (const name of ["package.json", "src", "adapters"]) {
		cpSync(path.join(swarmSrc, name), path.join(swarmDest, name), { recursive: true });
	}

	installSkillPackage(path.join(repo, "packages", "omp-skill-web-search"), skillsDir);
	for (const name of readdirSync(path.join(repo, "packages", "skills"))) {
		installSkillPackage(path.join(repo, "packages", "skills", name), skillsDir);
	}
	const pins = JSON.parse(readFileSync(path.join(repo, "packages", "third-party", "pins.lock.json"), "utf8"));
	for (const name of Object.keys(pins.skills)) {
		copyTree(path.join(snapshot, "agent", "skills", name), path.join(skillsDir, name));
	}

	const plugins = path.join(home, "plugins");
	mkdirSync(plugins, { recursive: true });
	writeFileSync(path.join(plugins, "package.json"), JSON.stringify({
		name: "omp-plugins",
		private: true,
		dependencies: { "@timiliang/pi-quotas": "npm:@timiliang/pi-quotas@0.5.2" },
	}, null, 2));
	const installed = spawnSync(bun, ["install"], { cwd: plugins, encoding: "utf8" });
	if (installed.status !== 0) fail(installed.stderr || installed.stdout || "bun install pi-quotas failed");
	const quotaPkg = path.join(plugins, "node_modules", "@timiliang", "pi-quotas", "package.json");
	if (!existsSync(quotaPkg)) fail("pi-quotas was not installed");
	const quota = JSON.parse(readFileSync(quotaPkg, "utf8"));
	if (quota.version !== "0.5.2") fail(`pi-quotas version ${quota.version}`);
	writeFileSync(path.join(plugins, "omp-plugins.lock.json"), JSON.stringify({
		plugins: { "@timiliang/pi-quotas": { version: "0.5.2", enabledFeatures: null, enabled: true } },
		settings: {},
	}, null, 2));
	const pluginManifest = readFileSync(path.join(plugins, "package.json"), "utf8");
	if (pluginManifest.includes("ponytail")) fail("ponytail plugin must not be installed");

	const env = [
		`OMP_HOME=${home}`,
		`OMP_DATA_ROOT=${dataRoot}`,
		`OMP_SKILLS_DIR=${skillsDir}`,
		`OMP_CONTROL_DB=${controlDb}`,
		`OMP_ARCHIVE_INDEX_DIR=${indexDir}`,
		`OMP_ARCHIVE_GITHUB_REPO=${archiveRepo}`,
		`OMP_RUNTIME_ROOT=${runtimeRoot}`,
	].join("\n") + "\n";
	writeFileSync(path.join(agent, "harness.env"), env);
	const wrapper = path.join(home, "bin", "omp-with-harness");
	mkdirSync(path.dirname(wrapper), { recursive: true });
	writeFileSync(wrapper, `#!/bin/sh\nset -a\n. "${path.join(agent, "harness.env")}"\nset +a\nexec omp "$@"\n`);
	spawnSync("chmod", ["+x", wrapper]);
	return { home, dataRoot, skillsDir, controlDb, indexDir, archiveRepo, runtimeRoot, wrapper };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = installHarness();
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
