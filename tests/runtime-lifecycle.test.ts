import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";

const root = path.resolve(process.env.OMP_RUNTIME_SMOKE_ROOT ?? "D:/Labs/omp/omp-config-hardening-95c64117ba2a");
const marker = (name: string, value: string) => fs.existsSync(path.join(root, name)) && fs.readFileSync(path.join(root, name), "utf8").trim() === value;
if (!/^D:[\\/]/i.test(root) || !marker(".omp-experiment-root", "omp-dependency-lab/v1") || !marker(".omp-automation-lab-root", "omp-automation-lab/v1")) throw new Error("RUNTIME_SMOKE_LAB_REQUIRED");
process.env.OMP_AMBIENT_LAB_ROOT = root;

const id = `runtime-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const workspace = path.join(root, "runtime-smoke", id, "workspace");
const git = (...args: string[]) => {
	const result = Bun.spawnSync({ cmd: ["git", "-C", workspace, ...args], stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

test("marked D: lab runs local archive, usage, checkpoint recovery, and stale receipt rejection", async () => {
	fs.mkdirSync(workspace, { recursive: true });
	git("init", "-b", "main"); git("config", "user.email", "runtime@example.invalid"); git("config", "user.name", "runtime");
	fs.writeFileSync(path.join(workspace, "fixture.txt"), "runtime\n"); git("add", "."); git("commit", "-m", "runtime");
	const control = await import("../omp/agent/extensions/omp-control.ts");
	if (control.controlDbPath() !== path.join(root, "ambient", "controller", "orchestration.sqlite")) throw new Error("RUNTIME_SMOKE_AMBIENT_IMPORT_REQUIRED");
	const archiver = await import("../omp/agent/extensions/run-archiver.ts");
	const usage = await import("../omp/agent/lib/task-usage.ts");
	const continuity = await import("../omp/agent/extensions/session-continuity.ts");
	const web = await import("../omp/agent/extensions/web-research-tools.ts");
	const { z } = await import(runtimePackageFile("omptype", "src/zod.ts"));
	const host = { cwd: workspace, sessionId: id };
	const expectedProjectId = `project-${id.slice(-12)}`;
	const project = await control.dispatchAt(control.controlDbPath(), { action: "project_register", projectId: expectedProjectId, canonicalRoot: workspace }, host);
	expect(project).toMatchObject({ projectId: expectedProjectId, canonicalRoot: workspace });
	const run = await control.dispatchAt(control.controlDbPath(), { action: "run_begin", projectId: String(project.projectId), risk: "mechanical" }, host);
	const input = { projectId: String(project.projectId), runId: String(run.runId), cwd: workspace };
	expect((await archiver.dispatchArchive({ action: "prepare", ...input }, {}, id)).action).toBe("prepare");
	expect((await archiver.dispatchArchive({ action: "verify", ...input }, {}, id)).security).toBe("PASS");
	fs.mkdirSync(path.join(root, "ambient", "sessions"), { recursive: true });
	const report = await usage.collectUsage({ sessionId: id, sessionsRoot: path.join(root, "ambient", "sessions"), endedAt: 2_000,
		branch: [{ id: "request", type: "message", timestamp: 1_000, message: { role: "user" } }, { id: "usage", type: "model_usage", timestamp: 1_500, provider: "fixture", model: "local", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, duration: 4 }] });
	expect(report.rows[0]?.totalTokens).toBe(3);

	const entries: any[] = [{ id: "request", type: "message", message: { role: "user" } }];
	const checkpoint = () => {
		let tool: any;
		continuity.default({ zod: z, appendEntry: (_type: string, data: unknown) => entries.push({ id: `saved-${entries.length}`, type: "custom", customType: continuity.CHECKPOINT_TYPE, data }), on() {}, registerTool: (value: any) => { if (value.name === "omp_checkpoint") tool = value; } } as never);
		return tool;
	};
	const ctx: any = { cwd: workspace, sessionManager: { getSessionId: () => id, getEntries: () => [], getBranch: () => entries } };
	await checkpoint().execute("save", { action: "update", goal: "retain local state" }, undefined, undefined, ctx);
	expect((await checkpoint().execute("restore", { action: "get" }, undefined, undefined, ctx)).details.checkpoint.goal).toBe("retain local state");
	const tools: any[] = [];
	web.default({ zod: z, on() {}, appendEntry() {}, registerTool: (tool: any) => tools.push(tool) } as never);
	const evidence = tools.find(tool => tool.name === "omp_research_evidence");
	entries.push({ type: "reset_boundary" });
	await expect(evidence.execute("stale", { action: "record_decision", searchReceiptId: "old" }, undefined, undefined, ctx)).rejects.toThrow("RESEARCH_RECEIPT_REQUIRED");
	archiver.releaseArchiveRoot(); control.closeControlDb();
}, 30_000);
