import * as fs from "node:fs";
import * as path from "node:path";
import { spawn as spawnChild } from "node:child_process";
const { AgentRegistry } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/registry/agent-registry.ts`);
const { Settings } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts`);
const { z } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/omptype/src/zod.ts`);
import control, { closeControlDb, dispatchAt, setControlTestDb } from "../omp/agent/extensions/omp-control.ts";

const LAB = path.resolve("D:/Labs/omp/omp-automation-lab-20260918");
const MARKERS = [".omp-experiment-root", ".omp-automation-lab-root"];
const MARKER_VALUE = "omp-automation-lab/v1";

type HelperInput = { checkpoint: string; release: string; taskMarker: string };
type SpawnHostInput = {
	db: string; cwd: string; owner: string; taskKey: string; helper: string;
	input: Record<string, unknown>; result: string; hostReady: string;
};
type MergeHostInput = { db: string; cwd: string; owner: string; input: Record<string, unknown>; result: string; hostReady: string };

function inside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingParent(value: string): string {
	let current = value;
	while (!fs.existsSync(current)) {
		const next = path.dirname(current);
		if (next === current) throw new Error(`NO_EXISTING_PARENT:${value}`);
		current = next;
	}
	return current;
}

function labPath(value: string): string {
	if (!path.isAbsolute(value)) throw new Error(`LAB_ABSOLUTE_PATH_REQUIRED:${value}`);
	const root = fs.realpathSync.native(LAB);
	const resolved = path.resolve(value);
	if (!/^D:[\\/]/i.test(root) || !inside(fs.realpathSync.native(existingParent(resolved)), root)) throw new Error(`LAB_PATH_ESCAPE:${resolved}`);
	if (fs.existsSync(resolved) && !inside(fs.realpathSync.native(resolved), root)) throw new Error(`LAB_PATH_ESCAPE:${resolved}`);
	return resolved;
}

function assertLab(): void {
	const root = fs.realpathSync.native(LAB);
	if (!/^D:[\\/]/i.test(root) || !fs.statSync(root).isDirectory()) throw new Error("AUTOMATION_LAB_ROOT_INVALID");
	for (const marker of MARKERS) {
		const file = path.join(root, marker);
		if (!fs.existsSync(file) || fs.readFileSync(file, "utf8").trim() !== MARKER_VALUE || !inside(fs.realpathSync.native(file), root)) {
			throw new Error("AUTOMATION_LAB_MARKER_INVALID");
		}
	}
}

function read<T>(file: string): T {
	const checked = labPath(file);
	return JSON.parse(fs.readFileSync(checked, "utf8")) as T;
}

function write(file: string, value: unknown): void {
	const checked = labPath(file);
	fs.mkdirSync(path.dirname(checked), { recursive: true });
	fs.writeFileSync(checked, JSON.stringify(value, null, 2), "utf8");
}

async function helper(file: string): Promise<void> {
	assertLab();
	const input = read<HelperInput>(file);
	for (const value of [input.checkpoint, input.release]) labPath(value);
	write(input.checkpoint, {
		schema: "omp-automation-owned-helper/v1",
		pid: process.pid,
		parentPid: process.ppid,
		execPath: process.execPath,
		argv: process.argv.slice(0, 3),
		taskMarker: input.taskMarker,
		startedAt: Date.now(),
	});
	while (!fs.existsSync(labPath(input.release))) await Bun.sleep(50);
}

async function spawnHost(file: string): Promise<void> {
	assertLab();
	const config = read<SpawnHostInput>(file);
	for (const value of [config.db, config.cwd, config.helper, config.result, config.hostReady]) labPath(value);
	write(config.hostReady, { schema: "omp-automation-host/v1", pid: process.pid, parentPid: process.ppid, execPath: process.execPath, argv: process.argv.slice(0, 3), taskMarker: config.taskKey, startedAt: Date.now() });
	setControlTestDb(config.db);
	let execute: any;
	control({
		zod: z,
		pi: {
			AgentRegistry,
			runSubprocess: async () => {
				const child = spawnChild(process.execPath, [import.meta.path, "--helper", config.helper], { cwd: path.dirname(config.helper), detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
				const [exitCode, stdout, stderr] = await Promise.all([
					new Promise<number | null>(resolve => child.once("close", resolve)),
					new Promise<string>(resolve => { let text = ""; child.stdout?.setEncoding("utf8").on("data", value => { text += value; }).once("end", () => resolve(text)); }),
					new Promise<string>(resolve => { let text = ""; child.stderr?.setEncoding("utf8").on("data", value => { text += value; }).once("end", () => resolve(text)); }),
				]);
				return { exitCode, aborted: exitCode !== 0, stdout, stderr, structuredOutput: { status: "valid", data: { status: exitCode === 0 ? "completed" : "interrupted", evidence: ["owned Bun helper"] } } };
			},
		},
		registerTool: (tool: any) => { execute = tool.execute; },
		registerCommand() {},
	} as never);
	try {
		const response = await execute(config.taskKey, config.input, new AbortController().signal, () => {}, {
			cwd: config.cwd, settings: Settings.isolated(), sessionManager: { getSessionId: () => config.owner, getEntries: () => [] },
		});
		write(config.result, { schema: "omp-automation-spawn-host-result/v1", pid: process.pid, response });
	} catch (error) {
		write(config.result, { schema: "omp-automation-spawn-host-result/v1", pid: process.pid, failure: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
		process.exitCode = 1;
	} finally {
		closeControlDb();
		setControlTestDb(null);
	}
}

async function mergeHost(file: string): Promise<void> {
	assertLab();
	const config = read<MergeHostInput>(file);
	for (const value of [config.db, config.cwd, config.result, config.hostReady]) labPath(value);
	write(config.hostReady, { schema: "omp-automation-merge-host/v1", pid: process.pid, parentPid: process.ppid, execPath: process.execPath, argv: process.argv.slice(0, 3), taskMarker: String(config.input.action ?? "merge"), startedAt: Date.now() });
	setControlTestDb(config.db);
	try {
		const result = await dispatchAt(config.db, config.input as never, { sessionId: config.owner, cwd: config.cwd, settings: Settings.isolated() });
		write(config.result, { schema: "omp-automation-merge-host-result/v1", pid: process.pid, result });
	} catch (error) {
		write(config.result, { schema: "omp-automation-merge-host-result/v1", pid: process.pid, failure: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
		process.exitCode = 1;
	} finally {
		closeControlDb();
		setControlTestDb(null);
	}
}

const mode = process.argv[2];
const config = process.argv[3];
if (!config) throw new Error("AUTOMATION_FAULT_CONFIG_REQUIRED");
if (mode === "--helper") await helper(config);
else if (mode === "--spawn-host") await spawnHost(config);
else if (mode === "--merge-host") await mergeHost(config);
else throw new Error("AUTOMATION_FAULT_MODE_INVALID");
