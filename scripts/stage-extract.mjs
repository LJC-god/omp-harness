#!/usr/bin/env node
/**
 * Copy snapshot extensions into packages/runtime and rewrite host imports and paths.
 * Does not modify omp/. Re-run is idempotent.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snap = path.join(repo, "omp", "agent");
const runtime = path.join(repo, "packages", "runtime");
const extDir = path.join(runtime, "extensions");
const libDir = path.join(runtime, "lib");

function replaceOnce(text, from, to, label) {
	const at = text.indexOf(from);
	if (at < 0) throw new Error(`missing ${label}`);
	if (text.indexOf(from, at + from.length) >= 0) throw new Error(`ambiguous ${label}`);
	return text.slice(0, at) + to + text.slice(at + from.length);
}

function readText(file) {
	return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function write(file, text) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text.endsWith("\n") ? text : text + "\n");
}

function copy(rel, destRel = rel) {
	const from = path.join(snap, rel);
	const to = path.join(runtime, destRel);
	mkdirSync(path.dirname(to), { recursive: true });
	cpSync(from, to);
	return to;
}

mkdirSync(extDir, { recursive: true });
mkdirSync(libDir, { recursive: true });

for (const name of [
	"research-evidence.ts",
	"task-health.ts",
	"task-dispatch.ts",
	"task-graph.ts",
	"ambient-lab.ts",
	"acceptance-evidence.ts",
	"product-review-evidence.ts",
]) {
	copy(path.join("lib", name), path.join("lib", name));
}

const usage = copy("lib/task-usage.ts", "lib/task-usage.ts");
write(usage, replaceOnce(
	readText(usage, "utf8"),
	`import { runtimeModule } from "./omp-runtime.ts";
const { loadSessionFile } = await import(runtimeModule("pi-coding-agent/src/session/session-loader.ts"));`,
	`import { loadUsageApis } from "./host-apis.ts";
const { loadSessionFile } = await loadUsageApis();`,
	"task-usage host import",
));

const web = copy("extensions/web-research-tools.ts", "extensions/web-research-tools.ts");
let webText = readText(web, "utf8");
webText = replaceOnce(
	webText,
	`import { runtimeModule, runtimePackageFile } from "../lib/omp-runtime.ts";

const { getProjectDir } = await import(runtimePackageFile("pi-utils", "src/index.ts"));
const { applyProviderGlobalsFromSettings } = await import(runtimeModule("pi-coding-agent/src/config/provider-globals.ts"));
const { Settings } = await import(runtimeModule("pi-coding-agent/src/config/settings.ts"));
const { runSearchQuery } = await import(runtimeModule("pi-coding-agent/src/web/search/index.ts"));`,
	`import { loadResearchApis } from "../lib/host-apis.ts";

const { getProjectDir, applyProviderGlobalsFromSettings, Settings, runSearchQuery } = await loadResearchApis();`,
	"web-research host import",
);
webText = replaceOnce(
	webText,
	`description: "Search Exa and Brave in parallel by default, with Tavily fallback if neither is usable; use cross_check for all four providers. Read key original pages with web_fetch when excerpts are insufficient.",`,
	`description: "Bounded web research. The only prose engine order is the harness note web-research-policy.md. Read key original pages with web_fetch when excerpts are insufficient.",`,
	"web-research description",
);
write(web, webText);

copy("extensions/task-usage.ts", "extensions/task-usage.ts");
copy("extensions/product-review.ts", "extensions/product-review.ts");

const continuity = copy("extensions/session-continuity.ts", "extensions/session-continuity.ts");
let continuityText = readText(continuity, "utf8");
continuityText = replaceOnce(
	continuityText,
	`import { runtimePackageFile } from "../lib/omp-runtime.ts";
import { sourceFingerprint } from "./omp-control.ts";`,
	`import { loadContinuityApis } from "../lib/host-apis.ts";
import { sourceFingerprint } from "../lib/source-fingerprint.ts";`,
	"continuity imports",
);
continuityText = replaceOnce(
	continuityText,
	`const { createCustomMessage } = await import(runtimePackageFile("pi-agent-core", "src/compaction/messages.ts"));`,
	`const { createCustomMessage } = await loadContinuityApis();`,
	"continuity api",
);
write(continuity, continuityText);

const taskDest = path.join(runtime, "extensions", "task-orchestration.ts");
const keepWiredTask = (() => {
	try { return readText(taskDest).includes("OMP_SWARM_WIRED"); }
	catch { return false; }
})();
if (!keepWiredTask) {
const task = copy("extensions/task-health.ts", "extensions/task-orchestration.ts");
let taskText = readText(task, "utf8");
taskText = replaceOnce(
	taskText,
	`import { TaskHealth, guardedSubprocess } from "../lib/task-health.ts";
import { modelDispatchNotice } from "../lib/task-dispatch.ts";`,
	`import { TaskHealth, guardedSubprocess } from "../lib/task-health.ts";
import { modelDispatchNotice } from "../lib/task-dispatch.ts";

export type TaskInvokeHook = {
  beforeInvoke?: (params: Record<string, unknown>) => void | Promise<void>;
  afterInvoke?: (params: Record<string, unknown>, result: unknown) => void | Promise<void>;
};
const taskHooks: TaskInvokeHook[] = [];
/** Later swarm code registers here. It must not call registerTool for task. */
export function registerTaskHooks(hook: TaskInvokeHook): void {
  taskHooks.push(hook);
}`,
	"task hooks",
);
if (!taskText.includes("async execute(_id, params, signal, onUpdate, toolCtx)")) throw new Error("missing task execute");
taskText = taskText.replace(
	"if (!toolCtx.invokeTool) throw new Error(\"Native task invocation is unavailable\");",
	"console.error(\"OMP_TASK_SHADOW\");\n        if (!toolCtx.invokeTool) throw new Error(\"Native task invocation is unavailable\");\n        const record = params as Record<string, unknown>;\n        for (const hook of taskHooks) await hook.beforeInvoke?.(record);",
);
taskText = taskText.replace(
	"toolCtx.invokeTool!(params as Record<string, unknown>",
	"toolCtx.invokeTool!(record",
);
const resultAt = taskText.lastIndexOf("return result;");
if (resultAt < 0) throw new Error("missing task result");
taskText = taskText.slice(0, resultAt) + "for (const hook of taskHooks) await hook.afterInvoke?.(record, result);\n        return result;" + taskText.slice(resultAt + "return result;".length);
write(task, taskText);
}

const control = copy("extensions/omp-control.ts", "extensions/omp-control.ts");
let controlText = readText(control, "utf8");
controlText = replaceOnce(
	controlText,
	`import { ambientLabPaths, assertAmbientLabTarget } from "../lib/ambient-lab.ts";
import { runtimeModule } from "../lib/omp-runtime.ts";
import { assertWindowsDirectoryPin, pinWindowsDirectory, releaseWindowsDirectoryPin, type WindowsDirectoryIdentity, type WindowsDirectoryPin } from "../lib/windows-directory-pin.ts";`,
	`import { ambientLabPaths, assertAmbientLabTarget } from "../lib/ambient-lab.ts";
import { loadControlApis, loadDiscoverAgents } from "../lib/host-apis.ts";
import { controlDbFile, reservedTrees, worktreesRoot } from "../lib/paths.ts";
import { sourceFingerprint } from "../lib/source-fingerprint.ts";
import { assertWindowsDirectoryPin, pinWindowsDirectory, releaseWindowsDirectoryPin, type WindowsDirectoryIdentity, type WindowsDirectoryPin } from "../lib/directory-pin.ts";`,
	"control imports",
);
controlText = replaceOnce(
	controlText,
	`const { Settings } = await import(runtimeModule("pi-coding-agent/src/config/settings.ts"));
const { resolveAgentModelSelection } = await import(runtimeModule("pi-coding-agent/src/config/model-resolver.ts"));
const { SessionManager } = await import(runtimeModule("pi-coding-agent/src/session/session-manager.ts"));`,
	`const { Settings, resolveAgentModelSelection, SessionManager } = await loadControlApis();`,
	"control apis",
);
controlText = replaceOnce(
	controlText,
	`export const SYSTEM_DB_PATH = \`\${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/orchestration.sqlite\`;
const WORKTREES_ROOT = "D:/OMPData/worktrees";
const RESERVED_TREES = [
	"D:/OMPData",
	"D:/OMPData/registry",
	"D:/OMPData/archives",
	"D:/OMPData/github",
	"D:/OMPData/projects",
	"D:/OMPData/github/omp-archive-index",
	"D:/OMPData/worktrees",
] as const;`,
	`export const SYSTEM_DB_PATH = controlDbFile();
const WORKTREES_ROOT = worktreesRoot();
const RESERVED_TREES = reservedTrees();`,
	"control paths",
);
controlText = replaceOnce(
	controlText,
	`	const { discoverAgents } = await import(
		runtimeModule("pi-coding-agent/src/task/discovery.ts")
	);`,
	`	const { discoverAgents } = await loadDiscoverAgents();`,
	"discover agents",
);
const fingerStart = controlText.indexOf("// Fingerprint actual non-ignored source");
const fingerEnd = controlText.indexOf("type ProcessOutput", fingerStart);
if (fingerStart < 0 || fingerEnd < 0) throw new Error("sourceFingerprint block missing");
controlText = controlText.slice(0, fingerStart) + "export { sourceFingerprint };\n\n" + controlText.slice(fingerEnd);
controlText = replaceOnce(
	controlText,
	`function restrictAcl(target: string): string {\n	const sid = currentUserSid();`,
	`function restrictAcl(target: string): string {\n	if (process.platform !== "win32") {\n		fs.chmodSync(target, 0o600);\n		return target;\n	}\n	const sid = currentUserSid();`,
	"restrictAcl",
);
write(control, controlText);

const archiver = copy("extensions/run-archiver.ts", "extensions/run-archiver.ts");
let archiverText = readText(archiver, "utf8");
archiverText = replaceOnce(
	archiverText,
	`import { ambientLabPaths, assertAmbientLabTarget } from "../lib/ambient-lab.ts";`,
	`import { ambientLabPaths, assertAmbientLabTarget } from "../lib/ambient-lab.ts";
import { archiveRootPath, confineDataPath, indexDirPath, worktreesRoot } from "../lib/paths.ts";`,
	"archiver path import",
);
archiverText = replaceOnce(
	archiverText,
	`export const CENTRAL_INDEX = "LJC-god/omp-archive-index";
export const DEFAULT_ARCHIVE_ROOT = "D:/OMPData/archives";
export const DEFAULT_INDEX_DIR = "D:/OMPData/github/omp-archive-index";
export const INDEX_ORIGIN_HTTPS = \`https://github.com/\${CENTRAL_INDEX}.git\`;`,
	`function requireArchiveRepo(): string {
	const value = process.env.OMP_ARCHIVE_GITHUB_REPO ?? "";
	if (!/^[A-Za-z0-9_.-]+\\/omp-archive-[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(value)) {
		throw new Error("OMP_ARCHIVE_GITHUB_REPO_UNSET");
	}
	return value;
}
export const CENTRAL_INDEX = requireArchiveRepo();
export const INDEX_ORIGIN_HTTPS = \`https://github.com/\${CENTRAL_INDEX}.git\`;`,
	"archive repo",
);
archiverText = replaceOnce(
	archiverText,
	`const WORK_ROOT = path.join(ambientLab?.workRoot ?? "D:/OMPData/worktrees", \`run-archiver-\${crypto.randomUUID()}\`);`,
	`const WORK_ROOT = path.join(ambientLab?.workRoot ?? worktreesRoot(), \`run-archiver-\${crypto.randomUUID()}\`);`,
	"work root",
);
archiverText = replaceOnce(
	archiverText,
	`let archivePin: { vol: number; index: string; path: string; handle: bigint } | null = null;`,
	`let archivePin: { vol: number; index: string; path: string; handle: bigint } | null = null;
let posixArchive: string | null = null;`,
	"posix archive slot",
);
archiverText = replaceOnce(
	archiverText,
	`export function pinD(p: string, label: string, create = false): string {
	const resolved = path.resolve(p);
	if (driveOf(resolved) !== "D") fail("NOT_D_ROOT", label);`,
	`export function pinD(p: string, label: string, create = false): string {
	const resolved = path.resolve(p);
	if (process.platform !== "win32") {
		try { return confineDataPath(resolved, create); } catch { fail("PATH_ESCAPE", label); }
	}
	if (driveOf(resolved) !== "D") fail("NOT_D_ROOT", label);`,
	"pinD",
);
archiverText = replaceOnce(
	archiverText,
	`export function archiveRoot(): string {
	const lexical = ambientLab
		? assertAmbientLabTarget(ambientLab.archiveRoot)
		: path.resolve(DEFAULT_ARCHIVE_ROOT);
	if (!ambientLab && !samePath(lexical, "D:/OMPData/archives")) fail("PATH_ESCAPE", "archive root");`,
	`export function archiveRoot(): string {
	if (process.platform !== "win32") {
		if (posixArchive) return posixArchive;
		const lexical = archiveRootPath();
		fs.mkdirSync(lexical, { recursive: true });
		posixArchive = confineDataPath(lexical, true);
		return posixArchive;
	}
	const lexical = ambientLab
		? assertAmbientLabTarget(ambientLab.archiveRoot)
		: path.resolve(archiveRootPath());
	if (!ambientLab && !samePath(lexical, archiveRootPath())) fail("PATH_ESCAPE", "archive root");`,
	"archiveRoot",
);
archiverText = replaceOnce(
	archiverText,
	`export function releaseArchiveRoot(): void {
	if (!archivePin) return;
	closeHandle(archivePin.handle);
	archivePin = null;
}`,
	`export function releaseArchiveRoot(): void {
	if (process.platform !== "win32") { posixArchive = null; return; }
	if (!archivePin) return;
	closeHandle(archivePin.handle);
	archivePin = null;
}`,
	"releaseArchiveRoot",
);
archiverText = replaceOnce(
	archiverText,
	`export function indexDir(): string {
	if (ambientLab) fail("LAB_EXTERNAL_PUBLISH_DISABLED", "index");
	const lexical = path.resolve(process.env.OMP_ARCHIVE_INDEX_DIR || DEFAULT_INDEX_DIR);`,
	`export function indexDir(): string {
	if (ambientLab) fail("LAB_EXTERNAL_PUBLISH_DISABLED", "index");
	if (process.platform !== "win32") {
		const lexical = indexDirPath();
		if (!fs.existsSync(lexical)) fail("INDEX_MISSING", "index");
		if (isReparse(fs.lstatSync(lexical))) fail("PATH_ESCAPE", "index");
		return confineDataPath(lexical, false);
	}
	const lexical = path.resolve(indexDirPath());`,
	"indexDir",
);
archiverText = replaceOnce(
	archiverText,
	`	if (parts.length !== 2 || parts[0] !== "LJC-god") fail("FORBIDDEN_REMOTE", "archive repo");
	const repo = parts[1];
	if (!ARCHIVE_REPO_NAME.test(repo) || SECRET_TEXT.test(repo)) fail("FORBIDDEN_REMOTE", "archive repo");
	return { kind: "github", fullName: \`LJC-god/\${repo}\`, url: \`https://github.com/LJC-god/\${repo}.git\` };`,
	`	const expectedOwner = CENTRAL_INDEX.split("/")[0];
	if (parts.length !== 2 || parts[0] !== expectedOwner) fail("FORBIDDEN_REMOTE", "archive repo");
	const repo = parts[1];
	if (!ARCHIVE_REPO_NAME.test(repo) || SECRET_TEXT.test(repo)) fail("FORBIDDEN_REMOTE", "archive repo");
	return { kind: "github", fullName: \`\${expectedOwner}/\${repo}\`, url: \`https://github.com/\${expectedOwner}/\${repo}.git\` };`,
	"archive remote owner",
);
archiverText = replaceOnce(
	archiverText,
	`	const resolved = path.resolve(cwd);
	if (driveOf(resolved) !== "D") return { ok: true, skipped: true, reason: "NOT_D_ROOT", event: reason };`,
	`	const resolved = path.resolve(cwd);
	if (process.platform !== "win32") return { ok: true, skipped: true, reason: "NOT_D_ROOT", event: reason };
	if (driveOf(resolved) !== "D") return { ok: true, skipped: true, reason: "NOT_D_ROOT", event: reason };`,
	"archiveFromCwd",
);
archiverText = replaceOnce(
	archiverText,
	`description: "Prepare/verify/publish/status sanitized run archives for registered D: Git projects",`,
	`description: "Prepare/verify/publish/status sanitized run archives for registered Git projects under the harness data root",`,
	"archive description",
);
write(archiver, archiverText);

const forbidden = [/[A-Za-z]:[\\/]+Users[\\/]/, /D:\/OMPData/, /D:\/Labs/, /LJC-god/, /pi-coding-agent\/src\//, /pi-utils\/src\//, /pi-agent-core\/src\//];
function walk(dir) {
	const files = [];
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) files.push(...walk(full));
		else files.push(full);
	}
	return files;
}
for (const file of walk(runtime)) {
	if (!file.endsWith(".ts") || file.includes(`${path.sep}test${path.sep}`)) continue;
	const text = readText(file, "utf8");
	for (const pattern of forbidden) {
		if (pattern.test(text)) throw new Error(`${path.relative(repo, file)} still matches ${pattern}`);
	}
}
const taskRegs = walk(path.join(runtime, "extensions"))
	.filter(file => file.endsWith(".ts"))
	.flatMap(file => [...readText(file, "utf8").matchAll(/registerTool\(\{ name: "task"/g)].map(() => file));
if (taskRegs.length !== 1 || !taskRegs[0].endsWith("task-orchestration.ts")) {
	throw new Error(`expected one task shadow, found ${taskRegs.join(",")}`);
}

const manifests = {
	"omp-web-research": ["extensions/web-research-tools.ts"],
	"omp-task-usage": ["extensions/task-usage.ts"],
	"omp-product-continuity": ["extensions/product-review.ts", "extensions/session-continuity.ts"],
	"omp-task-orchestration": ["extensions/task-orchestration.ts"],
	"omp-run-archiver": ["extensions/run-archiver.ts"],
	"omp-control": ["extensions/omp-control.ts"],
};
for (const [name, entries] of Object.entries(manifests)) {
	const dir = path.join(repo, "packages", "extensions", name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	write(path.join(dir, "package.json"), JSON.stringify({
		name,
		version: "0.1.0",
		private: true,
		type: "module",
		description: `Extracted OMP 18.2.6 extension ${name}.`,
		ompConfig: { kind: "extension", runtime: "18.2.6", entries },
	}, null, 2));
	write(path.join(dir, "README.md"), `# ${name}\n\n运行时钉在 OMP 18.2.6。入口在 \`packages/runtime/${entries[0]}\`。安装器把它复制到 \`~/.omp/agent/extensions\`。本包不写 \`omp.extensions\`，避免 18.2.6 把清单字段当成插件入口。\n`);
}

function hashFile(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function countFiles(dir) {
	return walk(dir).length;
}
const thirdParty = [
	"caveman", "frontend-design", "emil-design-eng", "fixing-accessibility", "fixing-motion-performance",
	"shadcn", "archify", "baoyu-design", "cloudbase",
];
const pins = {
	runtime: "18.2.6",
	source: "frozen snapshot omp/agent/skills",
	note: "安装器从冻结快照复制这些字节。本仓库不把它们再改成另一份正文。",
	skills: Object.fromEntries(thirdParty.map(name => {
		const dir = path.join(snap, "skills", name);
		return [name, { skillSha256: hashFile(path.join(dir, "SKILL.md")), files: countFiles(dir) }];
	})),
};
write(path.join(repo, "packages", "third-party", "pins.lock.json"), JSON.stringify(pins, null, 2));
write(path.join(repo, "packages", "third-party", "pi-quotas.json"), JSON.stringify({
	name: "@timiliang/pi-quotas",
	version: "0.5.2",
	enabled: true,
	install: "bun install in $OMP_HOME/plugins",
}, null, 2));
write(path.join(repo, "packages", "third-party", "ponytail.json"), JSON.stringify({
	plugin: "@dietrichgebert/ponytail",
	pluginInstalled: false,
	source: "packages/skills/omp-skill-ponytail",
	note: "活的来源是 skill 文件。安装器不安装已禁用的插件依赖。",
}, null, 2));

function stubLeaves(text) {
	return text.replace(/~\/\.omp\/agent\/git\/github\.com\/[^\s`)]+/g, (match) => {
		const parts = match.split("/").filter(Boolean);
		const leaf = parts.at(-2) === "SKILL.md" ? parts.at(-3) : parts.at(-1);
		return `SKILL_UNAVAILABLE (${leaf} upstream leaf is not shipped)`;
	});
}

function copySkill(name, transform = (text) => text) {
	const from = path.join(snap, "skills", name);
	const destRoot = path.join(repo, "packages", "skills", `omp-skill-${name}`);
	const skillDest = path.join(destRoot, "skills", name);
	rmSync(destRoot, { recursive: true, force: true });
	cpSync(from, skillDest, { recursive: true });
	for (const file of walk(skillDest)) {
		if (!file.endsWith(".md")) continue;
		write(file, transform(readText(file, "utf8")));
	}
	write(path.join(destRoot, "package.json"), JSON.stringify({
		name: `omp-skill-${name}`,
		version: "0.1.0",
		private: true,
		type: "module",
		license: name === "ui-ux-design-audit" ? "SEE LICENSE IN skills/ui-ux-design-audit/SOURCE.md" : "UNLICENSED",
		ompConfig: { kind: "skill", skillName: name, runtime: "18.2.6", install: "custom-directory" },
	}, null, 2));
	write(path.join(destRoot, "install.mjs"), `#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "..", "..", "..");
const skillName = ${JSON.stringify(name)};
export function installSkill(dest) {
  const resolved = path.resolve(dest);
  const snapshot = path.join(repoRoot, "omp");
  const relative = path.relative(snapshot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("refusing to write inside the snapshot tree: " + resolved);
  }
  const target = path.join(resolved, skillName);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true });
  cpSync(path.join(packageRoot, "skills", skillName), target, { recursive: true });
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--dest");
  const dest = process.argv[index + 1];
  if (!dest) throw new Error("usage: node install.mjs --dest <skills-parent>");
  process.stdout.write(installSkill(dest) + "\\n");
}
`);
	write(path.join(destRoot, "test", "smoke.mjs"), `import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installSkill } from "../install.mjs";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillName = ${JSON.stringify(name)};
const skillDir = path.join(packageRoot, "skills", skillName);
function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}
const texts = files(skillDir).filter(file => file.endsWith(".md")).map(file => readFileSync(file, "utf8"));
const front = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
assert.match(front, new RegExp("^name: " + skillName + "$", "m"));
assert.match(front, /^description: \\S+/m);
for (const text of texts) {
  assert.doesNotMatch(text, /[A-Za-z]:[\\\\/]+Users[\\\\/]|D:\\/OMPData|D:\\/Labs|LJC-god/);
}
${name === "matt" || name === "pm" ? `assert.ok(texts.some(text => text.includes("SKILL_UNAVAILABLE")));\n` : ""}
const dest = mkdtempSync(path.join(tmpdir(), "omp-skill-${name}-"));
try {
  const installed = installSkill(dest);
  assert.equal(path.basename(installed), skillName);
  assert.throws(() => installSkill(path.resolve(packageRoot, "..", "..", "..", "omp", "agent", "skills")), /snapshot tree/);
} finally { rmSync(dest, { recursive: true, force: true }); }
process.stdout.write("PASS omp-skill-${name}\\n");
`);
	write(path.join(destRoot, "README.md"), `# omp-skill-${name}\n\nOMP 18.2.6 的 custom directory skill。安装：\`node install.mjs --dest <skills 父目录>\`。安装器拒绝写入本仓库 \`omp/\`。\n`);
}

copySkill("ponytail");
copySkill("fixed-route");
copySkill("ui-ux-design-audit");
copySkill("product-testing", (text) => text.replaceAll("`D:/Labs/omp`", "`$OMP_DATA_ROOT`（由 harness 环境变量指定的数据根，下面再建唯一的运行目录）"));
copySkill("matt", stubLeaves);
copySkill("pm", stubLeaves);

for (const name of ["ponytail", "fixed-route", "ui-ux-design-audit", "product-testing", "matt", "pm"]) {
	const dir = path.join(repo, "packages", "skills", `omp-skill-${name}`);
	for (const file of walk(dir)) {
		if (!file.endsWith(".md")) continue;
		const text = readText(file, "utf8");
		for (const pattern of forbidden) {
			if (pattern.test(text)) throw new Error(`${path.relative(repo, file)} still matches ${pattern}`);
		}
	}
}

const harness = path.join(repo, "harness");
mkdirSync(path.join(harness, "config"), { recursive: true });
mkdirSync(path.join(harness, "rules"), { recursive: true });
mkdirSync(path.join(harness, "agents"), { recursive: true });
mkdirSync(path.join(harness, "commands"), { recursive: true });
let config = readText(path.join(snap, "config.yml"), "utf8");
config = config.replace(
	`# The built-in web_search tool stays off on purpose: research goes through
# extensions/web-research-tools.ts (web_research_v1), whose default engine order
# (Exa + Brave, Tavily fallback) is fixed in code. providers.webSearchOrder above is
# consumed by OMP's search-provider layer, not by that extension.`,
	`# The built-in web_search tool stays off. Research goes through web_research_v1.
# The only prose retrieval policy is notes/web-research-policy.md.
# providers.webSearchOrder is the provider layer, not that extension.`,
);
config = config.replace("    - ~/.omp/agent/skills", "    - __OMP_SKILLS_DIR__");
config = config.replace("  base: D:/OMPData/worktrees", "  base: __OMP_WORKTREE_BASE__");
write(path.join(harness, "config", "config.yml"), config);
write(path.join(harness, "config", "web-research-large.yml"), readText(path.join(snap, "web-research-large.yml"), "utf8"));
for (const rule of ["communication.md", "main-agent-orchestrator.md"]) {
	write(path.join(harness, "rules", rule), readText(path.join(snap, "rules", rule), "utf8"));
}
let router = readText(path.join(snap, "rules", "harness-router.md"), "utf8");
router = router.replaceAll("`D:/Labs/omp`", "`$OMP_DATA_ROOT`");
router = replaceOnce(
	router,
	"PM calls the shared read-only web_research_v1 for product discovery; Sol retains it for its own research: default quick mode omits engine and searches Exa + Brave in parallel, falling back to Tavily only if neither is usable; use cross_check only for source conflicts or justified independent coverage.",
	"PM calls the shared read-only web_research_v1 for product discovery; Sol retains it for its own research. Engine order, fallback, original-page fetch and receipt linking are only in ~/.omp/agent/notes/web-research-policy.md.",
	"router research sentence",
);
write(path.join(harness, "rules", "harness-router.md"), router);
rmSync(path.join(harness, "agents"), { recursive: true, force: true });
cpSync(path.join(snap, "agents"), path.join(harness, "agents"), { recursive: true });
write(path.join(harness, "commands", "web-research-v1.md"), `---
description: Compatibility entry for bounded Web research. Policy lives in notes/web-research-policy.md.
---

Read \`~/.omp/agent/notes/web-research-policy.md\` and call \`web_research_v1\`. Do not repeat a second engine order in this command.
`);
write(path.join(harness, "bootstrap", "local.example.yml"), `# 复制为本地环境，不要提交真实 local.yml。
# 安装器读取这些变量；缺 OMP_DATA_ROOT 或 OMP_ARCHIVE_GITHUB_REPO 时拒绝安装。
OMP_DATA_ROOT: /absolute/path/to/omp-data
OMP_ARCHIVE_GITHUB_REPO: owner/omp-archive-index
OMP_ARCHIVE_INDEX_DIR: /absolute/path/to/omp-data/github/archive-index
OMP_CONTROL_DB: /absolute/path/to/home/.omp/agent/orchestration.sqlite
`);

for (const file of walk(harness)) {
	if (file.endsWith(".yml") || file.endsWith(".md")) {
		const text = readText(file, "utf8");
		for (const pattern of [/[A-Za-z]:[\\/]+Users[\\/]/, /D:\/OMPData/, /D:\/Labs/, /LJC-god/]) {
			if (pattern.test(text)) throw new Error(`${path.relative(repo, file)} still matches ${pattern}`);
		}
	}
}

console.log("staged runtime extensions, skills, and harness");
