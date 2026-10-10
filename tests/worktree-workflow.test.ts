import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeModule, runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";
const { AgentRegistry } = await import(runtimeModule("pi-coding-agent/src/registry/agent-registry.ts"));
const { Settings } = await import(runtimeModule("pi-coding-agent/src/config/settings.ts"));
const { z } = await import(runtimePackageFile("omptype", "src/zod.ts"));
import control, { closeControlDb, dispatchAt, openControlDbAt, setControlTestDb, sourceFingerprint } from "../omp/agent/extensions/omp-control.ts";

// This is a protocol test around existing controller receipts and real Git.
// It deliberately does not claim an automatic merge queue, CAS claim, or cross-root lock.
function requireExperimentRoot() {
	const configured = process.env.OMP_EXPERIMENT_ROOT;
	if (!configured) throw new Error("OMP_EXPERIMENT_ROOT is required for isolated worktree fixtures");
	if (!path.isAbsolute(configured) || !/^D:[\\/]/i.test(configured)) throw new Error(`OMP_EXPERIMENT_ROOT must be an absolute D: path: ${configured}`);
	const configuredRoot = path.resolve(configured);
	const rootStat = fs.statSync(configuredRoot, { throwIfNoEntry: false });
	if (!rootStat?.isDirectory()) throw new Error(`OMP_EXPERIMENT_ROOT must be an existing directory: ${configuredRoot}`);
	const experimentRoot = fs.realpathSync(configuredRoot);
	if (!/^D:[\\/]/i.test(experimentRoot)) throw new Error(`OMP_EXPERIMENT_ROOT must resolve to a D: path: ${experimentRoot}`);
	const markerPath = path.join(experimentRoot, ".omp-experiment-root");
	const markerStat = fs.statSync(markerPath, { throwIfNoEntry: false });
	if (!markerStat?.isFile() || fs.readFileSync(markerPath, "utf8").trim() !== "omp-dependency-lab/v1") {
		throw new Error(`OMP_EXPERIMENT_ROOT marker must contain omp-dependency-lab/v1: ${markerPath}`);
	}
	return experimentRoot;
}

const experimentRoot = requireExperimentRoot();
const worktreeRoot = path.join(experimentRoot, "worktrees");
const marker = crypto.randomUUID();
const fixturePrefix = `omp-worktree-proof-${marker}`;
const target = path.join(experimentRoot, "worktrees", `${fixturePrefix}-target`);
const author = path.join(experimentRoot, "worktrees", `${fixturePrefix}-author`);
const badAuthor = path.join(experimentRoot, "worktrees", `${fixturePrefix}-author-bad`);
const failedCandidate = path.join(experimentRoot, "worktrees", `${fixturePrefix}-candidate-failed`);
const conflictSource = path.join(experimentRoot, "worktrees", `${fixturePrefix}-conflict-source`);
const conflictCandidate = path.join(experimentRoot, "worktrees", `${fixturePrefix}-conflict-candidate`);
const dbFile = path.join(experimentRoot, "evidence", "omp-worktree-upgrade-20260918", `${fixturePrefix}.sqlite`);
const owner = `worktree-proof-${marker}`;
const settings = Settings.isolated();
const authorSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" } }, required: ["status"] };
const verificationSchema = {
	type: "object", additionalProperties: false,
	properties: {
		status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" },
		findings: { type: "array", items: { type: "object", additionalProperties: false, properties: {}, required: [] } },
		evidence: { type: "array", items: { type: "string" } },
	},
	required: ["status", "runId", "generation", "findings", "evidence"],
};
let execute: any;
let subprocess: (options: any) => Promise<any>;

function command(cwd: string, command: string[], allowFailure = false) {
	// Mirror the controller's clean Git environment so the test runner's repository
	// cannot leak GIT_DIR/GIT_COMMON_DIR into the fixture repositories.
	const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe", env: {
		PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
	} });
	if (!allowFailure && result.exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed in ${cwd}: ${result.stderr.toString().trim()}`);
	}
	return result;
}

function git(cwd: string, ...args: string[]) {
	return command(cwd, ["git", "-C", cwd, ...args]);
}

function gitFailure(cwd: string, ...args: string[]) {
	return command(cwd, ["git", "-C", cwd, ...args], true);
}

function gitOutput(cwd: string, ...args: string[]) {
	return git(cwd, ...args).stdout.toString().trim();
}

function canonical(value: string) {
	return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function head(cwd: string) {
	return gitOutput(cwd, "rev-parse", "HEAD");
}

function status(cwd: string) {
	return gitOutput(cwd, "status", "--porcelain");
}

function runCandidateCheck(cwd: string) {
	return command(cwd, ["bun", "check.mjs"], true);
}

// The following three helpers are the documented single-owner procedure, not controller guards.
function protocolRequiresClean(cwd: string) {
	if (status(cwd)) throw new Error(`DIRTY_WORKTREE: ${cwd}`);
}

function protocolRequiresCurrentBase(targetRoot: string, recordedBase: string) {
	if (head(targetRoot) !== recordedBase) throw new Error("STALE_CANDIDATE_BASE");
}

function protocolRequiresPassingCheck(cwd: string) {
	const result = runCandidateCheck(cwd);
	if (result.exitCode !== 0) throw new Error(`CANDIDATE_CHECK_FAILED: ${result.stderr.toString().trim()}`);
}

function call(projectId: string, cwd: string, input: Record<string, unknown>) {
	return dispatchAt(dbFile, { projectId, ...input } as never, { sessionId: owner, cwd, settings });
}

async function spawn(projectId: string, cwd: string, runId: string, key: string, agent: string, gate?: string) {
	// This host cwd simulates the already-settled native /move result for controller testing.
	// It does not exercise the native frontend's streaming-time /move rejection.
	const response = await execute(key, {
		action: "project_spawn", projectId, runId, idempotencyKey: key, agent,
		task: `Isolated linked-worktree proof ${key}. Never invoke real models or tools.`, outputSchema: gate ? verificationSchema : authorSchema, ...(gate ? { gate } : {}),
	}, new AbortController().signal, () => {}, { cwd, settings, sessionManager: { getSessionId: () => owner, getEntries: () => [] } });
	if (response.isError) throw new Error(`project_spawn ${key} returned an error`);
	return response.details;
}

async function register(cwd: string) {
	return dispatchAt(dbFile, { action: "project_register", canonicalRoot: cwd } as never, { sessionId: owner, cwd, settings });
}

function verificationProof(runId: string, generation: string) {
	return {
		status: "valid",
		data: { status: "PASS", runId, generation, findings: [], evidence: ["isolated candidate check receipt"] },
	};
}

async function verifyCandidate(projectId: string, cwd: string, runId: string, key: string) {
	const generation = String((await call(projectId, cwd, { action: "generation_get", runId })).generation);
	subprocess = async (options: any) => {
		expect(canonical(String(options.cwd))).toBe(canonical(cwd));
		protocolRequiresPassingCheck(cwd);
		return { exitCode: 0, structuredOutput: verificationProof(runId, generation) };
	};
	const receipt = await spawn(projectId, cwd, runId, key, "verifier", "verification");
	expect(receipt).toMatchObject({ state: "succeeded" });
}

beforeAll(() => {
	fs.mkdirSync(worktreeRoot, { recursive: true });
	fs.mkdirSync(path.dirname(dbFile), { recursive: true });
	fs.mkdirSync(target, { recursive: true });
	command(target, ["git", "init", "-b", "main", target]);
	git(target, "config", "user.email", "omp-worktree-proof@example.invalid");
	git(target, "config", "user.name", "OMP worktree proof");
	fs.writeFileSync(path.join(target, ".gitignore"), ".omp/\n");
	fs.writeFileSync(path.join(target, "base.mjs"), "export const base = () => 'base';\n");
	fs.writeFileSync(path.join(target, "check.mjs"), [
		"import { base } from './base.mjs';",
		"import { authorFeature } from './author.mjs';",
		"if (base() !== 'base' || authorFeature() !== 'author') throw new Error('candidate integration check failed');",
		"console.log('candidate-pass');",
	].join("\n") + "\n");
	git(target, "add", ".");
	git(target, "commit", "-m", "fixture baseline");
	git(target, "worktree", "add", "-b", "author-task", author, "HEAD");
	setControlTestDb(dbFile);
	control({ zod: z, pi: { AgentRegistry, runSubprocess: (options: any) => subprocess(options) }, registerTool: (tool: any) => { execute = tool.execute; }, registerCommand() {} } as never);
});

afterAll(() => {
	closeControlDb();
	setControlTestDb(null);
});

test("manual one-task linked-worktree delivery keeps controller evidence and target history honest", async () => {
	const originalTarget = head(target);
	const authorProject = await register(author);
	const authorProjectId = String(authorProject.projectId);
	const pinned = openControlDbAt(dbFile).query("SELECT canonical_root,git_dir,common_dir FROM projects WHERE id=?").get(authorProjectId) as Record<string, string>;
	expect(canonical(pinned.canonical_root)).toBe(canonical(author));
	expect(canonical(pinned.git_dir)).toBe(canonical(gitOutput(author, "rev-parse", "--absolute-git-dir")));
	expect(canonical(pinned.common_dir)).toBe(canonical(gitOutput(author, "rev-parse", "--git-common-dir")));
	expect(canonical(pinned.common_dir)).toBe(canonical(path.join(target, ".git")));

	const authorRun = String((await call(authorProjectId, author, { action: "run_begin", risk: "mechanical" })).runId);
	expect(await call(authorProjectId, author, { action: "baseline_capture", runId: authorRun })).toMatchObject({ ok: true });
	const lease = await call(authorProjectId, author, { action: "lease_acquire", runId: authorRun, resource: "*" });
	expect(lease).toMatchObject({ ok: true, resource: "*" });
	let authorLaunches = 0;
	subprocess = async (options: any) => {
		authorLaunches += 1;
		expect(canonical(String(options.cwd))).toBe(canonical(author));
		fs.writeFileSync(path.join(author, "author.mjs"), "export const authorFeature = () => 'author';\n");
		git(author, "add", "author.mjs");
		git(author, "commit", "-m", "author feature");
		return { exitCode: 0, structuredOutput: { status: "valid", data: { status: "PASS" } } };
	};
	const authorReceipt = await spawn(authorProjectId, author, authorRun, "author-feature", "fast-worker");
	expect(authorReceipt).toMatchObject({ state: "succeeded" });
	expect(canonical(String(authorReceipt.cwd))).toBe(canonical(author));
	expect((await spawn(authorProjectId, author, authorRun, "author-feature", "fast-worker"))).toMatchObject({ duplicate: true, state: "succeeded" });
	expect(authorLaunches).toBe(1);
	expect(head(target)).toBe(originalTarget);
	expect(status(author)).toBe("");
	await expect(dispatchAt(dbFile, { action: "generation_get", projectId: authorProjectId, runId: authorRun } as never, { sessionId: owner, cwd: target, settings })).rejects.toThrow("ROOT_MISMATCH");
	const authorHead = head(author);

	git(author, "merge", "--no-edit", "--no-ff", originalTarget);
	protocolRequiresPassingCheck(author);
	await verifyCandidate(authorProjectId, author, authorRun, "candidate-verification");
	expect(await call(authorProjectId, author, { action: "run_complete", runId: authorRun })).toMatchObject({ ok: true, taskComplete: true });
	const firstGate = await call(authorProjectId, author, { action: "task_get", runId: authorRun, idempotencyKey: "candidate-verification" });
	expect((firstGate.result as any).sourceFingerprint).toBe(sourceFingerprint(author));

	fs.writeFileSync(path.join(author, "stale-proof.txt"), "makes verification receipt stale\n");
	expect(await call(authorProjectId, author, { action: "run_status", runId: authorRun })).toMatchObject({ taskComplete: false, staleGates: ["verification"] });
	fs.writeFileSync(path.join(target, "target-note.mjs"), "export const targetNote = () => 'advanced';\n");
	git(target, "add", "target-note.mjs");
	git(target, "commit", "-m", "target advances independently");
	expect(() => protocolRequiresCurrentBase(target, originalTarget)).toThrow("STALE_CANDIDATE_BASE");
	expect(() => protocolRequiresClean(author)).toThrow("DIRTY_WORKTREE");

	const advancedTarget = head(target);
	git(author, "add", "stale-proof.txt");
	git(author, "commit", "-m", "author revalidates changed source");
	git(author, "merge", "--no-edit", "--no-ff", advancedTarget);
	protocolRequiresClean(author);
	protocolRequiresCurrentBase(target, advancedTarget);
	await verifyCandidate(authorProjectId, author, authorRun, "candidate-reverification");
	expect(await call(authorProjectId, author, { action: "run_complete", runId: authorRun })).toMatchObject({ ok: true, taskComplete: true });
	const exactCandidate = head(author);
	git(author, "merge-base", "--is-ancestor", authorHead, exactCandidate);
	git(author, "merge-base", "--is-ancestor", advancedTarget, exactCandidate);
	expect(await call(authorProjectId, author, { action: "lease_release", runId: authorRun, resource: "*", token: String(lease.token) })).toMatchObject({ ok: true, resource: "*" });
	git(target, "merge", "--ff-only", exactCandidate);
	expect(head(target)).toBe(exactCandidate);
	expect(runCandidateCheck(target).exitCode).toBe(0);

	git(target, "worktree", "add", "-b", "author-bad", badAuthor, "HEAD");
	fs.writeFileSync(path.join(badAuthor, "author.mjs"), "export const authorFeature = () => 'broken';\n");
	git(badAuthor, "add", "author.mjs");
	git(badAuthor, "commit", "-m", "broken author feature");
	const beforeFailedCheck = head(target);
	git(target, "worktree", "add", "-b", "candidate-failed", failedCandidate, beforeFailedCheck);
	git(failedCandidate, "merge", "--no-edit", "--no-ff", head(badAuthor));
	expect(runCandidateCheck(failedCandidate).exitCode).not.toBe(0);
	expect(() => protocolRequiresPassingCheck(failedCandidate)).toThrow("CANDIDATE_CHECK_FAILED");
	expect(head(target)).toBe(beforeFailedCheck);
	fs.writeFileSync(path.join(failedCandidate, "dirty-after-failed-check.txt"), "do not merge\n");
	expect(() => protocolRequiresClean(failedCandidate)).toThrow("DIRTY_WORKTREE");
	expect(head(target)).toBe(beforeFailedCheck);

	git(target, "worktree", "add", "-b", "conflict-source", conflictSource, "HEAD");
	fs.writeFileSync(path.join(conflictSource, "conflict.txt"), "author side\n");
	git(conflictSource, "add", "conflict.txt");
	git(conflictSource, "commit", "-m", "author conflict side");
	const beforeConflict = head(target);
	git(target, "worktree", "add", "-b", "conflict-candidate", conflictCandidate, beforeConflict);
	fs.writeFileSync(path.join(conflictCandidate, "conflict.txt"), "integration side\n");
	git(conflictCandidate, "add", "conflict.txt");
	git(conflictCandidate, "commit", "-m", "integration conflict side");
	const conflict = gitFailure(conflictCandidate, "merge", "--no-edit", head(conflictSource));
	expect(conflict.exitCode).not.toBe(0);
	expect(head(target)).toBe(beforeConflict);
}, 60_000);
