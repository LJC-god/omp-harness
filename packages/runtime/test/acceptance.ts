import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_OMP_VERSION, pinnedRuntimeRoot } from "../lib/host-apis.ts";
import { pinWindowsDirectory } from "../lib/directory-pin.ts";

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(runtime, "..", "..");
const root = mkdtempSync(path.join(tmpdir(), "omp-runtime-"));
const data = path.join(root, "data");
mkdirSync(data, { recursive: true });
process.env.OMP_HOME = path.join(root, "home");
process.env.OMP_DATA_ROOT = data;
process.env.OMP_CONTROL_DB = path.join(root, "home", "agent", "orchestration.sqlite");
process.env.OMP_ARCHIVE_INDEX_DIR = path.join(data, "github", "archive-index");
process.env.OMP_ARCHIVE_GITHUB_REPO = "local/omp-archive-index";
mkdirSync(path.dirname(process.env.OMP_CONTROL_DB), { recursive: true });
mkdirSync(process.env.OMP_ARCHIVE_INDEX_DIR, { recursive: true });

function files(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const full = path.join(dir, name);
		return statSync(full).isDirectory() ? files(full) : [full];
	});
}

const forbidden = [/[A-Za-z]:[\\/]+Users[\\/]/, /D:\/OMPData/, /D:\/Labs/, /LJC-god/, /pi-coding-agent\/src\//];
for (const file of files(path.join(repo, "packages")).concat(files(path.join(repo, "harness")))) {
	if (!/\.(ts|mjs|md|yml|json)$/.test(file)) continue;
	if (file.includes(`${path.sep}node_modules${path.sep}`) || file.includes(`${path.sep}test${path.sep}`)) continue;
	const text = readFileSync(file, "utf8");
	for (const pattern of forbidden) assert.doesNotMatch(text, pattern, file);
}

const taskFiles = files(path.join(runtime, "extensions")).filter(file => file.endsWith(".ts") && readFileSync(file, "utf8").includes('registerTool({ name: "task"'));
assert.deepEqual(taskFiles.map(file => path.basename(file)), ["task-orchestration.ts"]);
const discovered = pinnedRuntimeRoot();
assert.equal(discovered && PINNED_OMP_VERSION, "18.2.6");
const fakeRuntime = path.join(root, "fake-runtime");
mkdirSync(fakeRuntime, { recursive: true });
writeFileSync(path.join(fakeRuntime, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.8.7" }));
process.env.OMP_RUNTIME_ROOT = fakeRuntime;
assert.throws(() => pinnedRuntimeRoot(), /OMP_RUNTIME_UNVERIFIED_VERSION:18\.8\.7/);
process.env.OMP_RUNTIME_ROOT = discovered;
assert.equal(pinnedRuntimeRoot(), discovered);
const hostSource = readFileSync(path.join(runtime, "lib", "host-apis.ts"), "utf8");
assert.doesNotMatch(hostSource, /await import\("@oh-my-pi\//);

const pin = pinWindowsDirectory(data);
assert.equal(pin.rootPath, data);
pinWindowsDirectory(path.join(data, "missing-child"));

function chain() {
	const proxy: any = new Proxy(() => proxy, { get: () => proxy, apply: () => proxy });
	return proxy;
}
function mockPi() {
	const tools: any[] = [];
	const ons: Record<string, Array<(...args: any[]) => any>> = {};
	const pi = {
		zod: chain(),
		tools,
		pi: { AgentRegistry: { global: () => ({ list: () => [], get: () => undefined }) } },
		on(name: string, fn: (...args: any[]) => any) { (ons[name] ||= []).push(fn); },
		registerTool(tool: any) { tools.push(tool); },
		registerCommand() {},
		getAllTools() { return [{ name: "task", sourceInfo: { source: "builtin" }, description: "native task", parameters: chain(), promptGuidelines: [] }]; },
		events: { on: () => () => {} },
		appendEntry() {},
		sendMessage() {},
		logger: { warn() {} },
		ons,
	};
	return pi;
}

const web = await import("../extensions/web-research-tools.ts");
const packet = await web.researchEvidence("omp harness smoke", "quick", undefined, undefined, async () => {
	throw new Error("no search key");
});
assert.equal(packet.status, "UNAVAILABLE");
const webPi = mockPi();
web.default(webPi as any);
assert.ok(webPi.tools.some(tool => tool.name === "web_research_v1"));
assert.ok(webPi.tools.some(tool => tool.name === "omp_research_evidence"));

const usage = await import("../extensions/task-usage.ts");
usage.default(mockPi() as any);
const review = await import("../extensions/product-review.ts");
review.default(mockPi() as any);
const continuity = await import("../extensions/session-continuity.ts");
continuity.default(mockPi() as any);

const orchestration = await import("../extensions/task-orchestration.ts");
let before = 0;
let after = 0;
orchestration.registerTaskHooks({
	beforeInvoke() { before += 1; },
	afterInvoke() { after += 1; },
});
const taskPi = mockPi();
orchestration.default(taskPi as any);
const ctx = {
	sessionManager: { getEntries: () => [], getSessionId: () => "sess", getBranch: () => [] },
	setInterval: () => 1,
	clearTimer() {},
	ui: { notify() {} },
	isIdle: () => true,
};
for (const handler of taskPi.ons.session_start) handler({}, ctx);
const taskTool = taskPi.tools.find(tool => tool.name === "task");
assert.ok(taskTool, "session_start registers the single task shadow");
const errors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
try {
	const result = await taskTool.execute("call", { agent: "task", task: "smoke" }, undefined, undefined, {
		invokeTool: async () => ({ content: [{ type: "text", text: "child-ok" }], details: { ok: true } }),
	});
	assert.equal(before, 1);
	assert.equal(after, 1);
	assert.match(JSON.stringify(result), /child-ok/);
	assert.ok(errors.some(line => line.includes("OMP_TASK_SHADOW")));
} finally { console.error = originalError; }

const control = await import("../extensions/omp-control.ts");
assert.equal(control.SYSTEM_DB_PATH, process.env.OMP_CONTROL_DB);
control.default(mockPi() as any);
const archiver = await import("../extensions/run-archiver.ts");
const archiverPi = mockPi();
archiver.default(archiverPi as any);
const archiveRoot = archiver.archiveRoot();
assert.ok(archiveRoot.startsWith(data + path.sep) || archiveRoot === path.join(data, "archives"));
const archiveTool = archiverPi.tools.find(tool => tool.name === "omp_archive");
const status = await archiveTool.execute("call", { action: "status", projectId: "missing", runId: "run1" }, undefined, undefined, {
	sessionManager: { getSessionId: () => "sess" },
});
assert.equal(status.isError, true);
assert.match(String(status.content?.[0]?.text ?? status.details?.code), /NOT_FOUND|INVALID|UNINITIALIZED|NOT_REGISTERED/);

rmSync(root, { recursive: true, force: true });
process.stdout.write("PASS omp-runtime\n");
