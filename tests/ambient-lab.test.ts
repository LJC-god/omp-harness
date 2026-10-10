import { afterAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";
const { z } = await import(runtimePackageFile("omptype", "src/zod.ts"));

const labRoot = process.env.OMP_RUNTIME_SMOKE_ROOT ?? "D:/Labs/omp/omp-automation-lab-20260918";
const marker = path.join(labRoot, ".omp-automation-lab-root");
if (!/^D:[\\/]/i.test(path.resolve(labRoot)) || !fs.existsSync(path.join(labRoot, ".omp-experiment-root"))
	|| fs.readFileSync(path.join(labRoot, ".omp-experiment-root"), "utf8").trim() !== "omp-dependency-lab/v1"
	|| !fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim() !== "omp-automation-lab/v1") throw new Error("RUNTIME_SMOKE_LAB_REQUIRED");
const prodDb = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/orchestration.sqlite`;
const controlPath = path.resolve(import.meta.dir, "../omp/agent/extensions/omp-control.ts");
const archiverPath = path.resolve(import.meta.dir, "../omp/agent/extensions/run-archiver.ts");
const state = path.join(labRoot, "ambient", "test-state", crypto.randomUUID());

function digest(file: string): string {
	return fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "missing";
}

const productionBefore = [prodDb, `${prodDb}-wal`, `${prodDb}-shm`].map(digest);
const controlUrl = pathToFileURL(controlPath).href;

function coldProbe(root: string | undefined, body = "console.log(JSON.stringify({ path: mod.controlDbPath() }));") {
	const env = { ...process.env };
	if (root === undefined) delete env.OMP_AMBIENT_LAB_ROOT;
	else env.OMP_AMBIENT_LAB_ROOT = root;
	const program = `const mod = await import(${JSON.stringify(`${controlUrl}?mtime=cold-${crypto.randomUUID()}`)}); ${body}`;
	const child = Bun.spawnSync({ cmd: [process.execPath, "--eval", program], stdout: "pipe", stderr: "pipe", env });
	return { exitCode: child.exitCode, stdout: child.stdout.toString().trim(), stderr: child.stderr.toString() };
}

function api(tools: any[] = []) {
	return {
		zod: z,
		pi: { AgentRegistry: { global: () => ({ list: () => [] }) } },
		on() {},
		registerTool(tool: any) { tools.push(tool); },
		registerCommand() {},
		logger: { warn() {} },
	};
}

test("ambient helper rejects unsafe roots in isolated cold processes without opening C: control state", { timeout: 10_000 }, () => {
	const before = [prodDb, `${prodDb}-wal`, `${prodDb}-shm`].map(digest);
	const defaultProbe = coldProbe(undefined);
	expect(defaultProbe.exitCode).toBe(0);
	expect(JSON.parse(defaultProbe.stdout).path).toBe(prodDb);
	for (const [root, code] of [["", "ROOT_EMPTY"], [`${process.env.HOME ?? process.env.USERPROFILE}`, "ROOT_NOT_D"], [path.join(state, "unmarked"), "MARKER_INVALID"]] as const) {
		if (!root || /^D:[\\/]/i.test(root)) fs.mkdirSync(root || state, { recursive: true });
		const probe = coldProbe(root);
		expect(probe.exitCode).not.toBe(0);
		expect(probe.stderr).toContain(`OMP_AMBIENT_LAB_${code}`);
	}
	const junctionRoot = path.join(state, "junction-root");
	fs.mkdirSync(junctionRoot, { recursive: true });
	fs.writeFileSync(path.join(junctionRoot, ".omp-automation-lab-root"), "omp-automation-lab/v1\n", "utf8");
	fs.symlinkSync("D:/", path.join(junctionRoot, "ambient"), "junction");
	const junctionProbe = coldProbe(junctionRoot);
	expect(junctionProbe.exitCode).not.toBe(0);
	expect(junctionProbe.stderr).toContain("OMP_AMBIENT_LAB_PARENT_REPARSE");
	expect([prodDb, `${prodDb}-wal`, `${prodDb}-shm`].map(digest)).toEqual(before);
});

test("ambient helper pins the first valid root despite a later environment change", () => {
	const probe = coldProbe(labRoot, `
		const first = mod.controlDbPath();
		process.env.OMP_AMBIENT_LAB_ROOT = ${JSON.stringify(path.join(state, "unmarked"))};
		console.log(JSON.stringify({ first, after: mod.controlDbPath() }));
	`);
	expect(probe.exitCode).toBe(0);
	const paths = JSON.parse(probe.stdout);
	expect(paths.after).toBe(paths.first);
	expect(paths.first).toBe(path.join(labRoot, "ambient", "controller", "orchestration.sqlite"));
});

test("ambient lab uses a fixed D: seam across Windows cache-busted controller loads and child factory bindings", async () => {
	expect(fs.readFileSync(marker, "utf8").trim()).toBe("omp-automation-lab/v1");
	process.env.OMP_AMBIENT_LAB_ROOT = labRoot;
	const first = await import(`${controlUrl}?mtime=ambient-first`);
	const second = await import(`${controlUrl}?mtime=ambient-second`);
	// Bun currently coalesces file:// query imports on Windows; the lab seam is
	// independent of that behavior and remains correct when factories rebind.
	expect(first).toBe(second);
	expect(first.controlDbPath()).toBe(path.join(labRoot, "ambient", "controller", "orchestration.sqlite"));
	expect(second.controlDbPath()).toBe(first.controlDbPath());
	const setterDb = path.join(state, "setter.sqlite");
	first.setControlTestDb(setterDb);
	expect(first.controlDbPath()).toBe(setterDb);
	expect(second.controlDbPath()).toBe(setterDb);
	first.setControlTestDb(null);
	expect(second.controlDbPath()).toBe(path.join(labRoot, "ambient", "controller", "orchestration.sqlite"));
	first.default(api());
	const childTools: any[] = [];
	second.default(api(childTools));
	const control = childTools.find(tool => tool.name === "omp_control");
	expect(control).toBeDefined();
	const child = { cwd: labRoot, sessionManager: { getSessionId: () => "child", getEntries: () => [{ type: "session_init" }] } };
	expect((await control.execute("health", { action: "health" }, new AbortController().signal, undefined, child)).isError).not.toBe(true);
	const blocked = await control.execute("project_get", { action: "project_get" }, new AbortController().signal, undefined, child);
	expect(blocked.details.code).toBe("SUBAGENT_FORBIDDEN");
	expect(fs.existsSync(second.controlDbPath())).toBe(true);
	const usage = await import(`${pathToFileURL(path.resolve(import.meta.dir, "../omp/agent/extensions/task-usage.ts")).href}?mtime=ambient-usage`);
	const handlers = new Map<string, Function>();
	const entries: any[] = [];
	usage.default({
		zod: z,
		on(name: string, handler: Function) { handlers.set(name, handler); },
		appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
		registerTool() {},
		pi: { AgentRegistry: { global: () => ({ list: () => [] }) } },
		logger: { warn() {} },
	} as never);
	const outputPath = path.join(labRoot, "ambient", "controller", "sessions", "control", "project", "run", "child.jsonl");
	handlers.get("tool_result")?.({ toolName: "omp_control", input: { action: "project_spawn", projectId: "project", runId: "run" },
		details: { agentId: "child", result: { outputPath } }, isError: false }, {
			 sessionManager: { getEntries: () => [], getSessionId: () => "root", getSessionFile: () => path.join(labRoot, "ambient", "sessions", "root.jsonl"), getBranch: () => [] },
		});
	expect(entries).toContainEqual({ type: "omp-usage-source-v1", data: { sessionFile: outputPath } });
	first.closeControlDb(); first.setControlTestDb(null); second.closeControlDb();
});

test("ambient archiver factory only creates lab storage and rejects remote publishing", async () => {
	const archiver = await import(`${pathToFileURL(archiverPath).href}?mtime=ambient-archiver`);
	archiver.default(api());
	expect(archiver.archiveRoot()).toBe(path.join(labRoot, "ambient", "archives"));
	await expect(archiver.dispatchArchive({ action: "publish" }, {}, "root")).rejects.toThrow("LAB_EXTERNAL_PUBLISH_DISABLED");
	archiver.releaseArchiveRoot();
});

afterAll(() => {
	expect([prodDb, `${prodDb}-wal`, `${prodDb}-shm`].map(digest)).toEqual(productionBefore);
});
