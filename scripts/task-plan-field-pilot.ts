import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const LAB = path.resolve("D:/Labs/omp/omp-field-lab-20260918");
const EXPERIMENT_MARKER = path.join(LAB, ".omp-experiment-root");
const ROOT = path.join(LAB, "field-project");
const MARKER = path.join(ROOT, ".field-project-marker.json");
const REPO = path.join(ROOT, "repo");
const WORKTREES = path.join(ROOT, "worktrees");
const EVIDENCE = path.join(ROOT, "evidence");
const MANIFEST = path.join(ROOT, "manifest.json");
const CONTROL_SOURCE = path.resolve(import.meta.dir, "../omp/agent/extensions/omp-control.ts");
const GRAPH_SOURCE = path.resolve(import.meta.dir, "../omp/agent/lib/task-graph.ts");
const CONTROL_DEPLOYED = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/extensions/omp-control.ts`;
const GRAPH_DEPLOYED = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/lib/task-graph.ts`;
const EXTENSION = path.join(import.meta.dir, "task-plan-field-extension.ts");
const SDK = `${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts`;
const AGENT_DIR = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent`;
const TERRA = "openai-codex/gpt-5.6-terra:high";
const ROOT_MODEL = "openai-codex/gpt-5.6-sol";
const FROZEN_SEED = "bc069630fc812c461625c90ea1079e279c296734";
const PRESERVED_ATTEMPT = "b47cafc0-7974-4299-b5e8-6db9da73717d";

type Author = { id: "readiness" | "conflicts" | "cli"; branch: string; paths: string[]; path?: string };
type Manifest = {
	schema: "omp-field-task-plan/v1"; createdAt: string; repo: string; target: string;
	authors: Author[]; frozenAcceptanceSha256: string; frozenContractSha256: string; frozenGraphSha256: string;
	overlay: Record<string, string>; graph: { targetRef: string; tasks: unknown[] };
};
type WorkerPlan = { schema: "omp-field-worker/v1"; cwd: string; sessionFile?: string; sessionDir: string; commands: Array<{ input: Record<string, unknown>; evidenceFile: string }> };
type WorkerResult = { ok: boolean; rootSessionId?: string; rootSessionFile?: string; results: Array<Record<string, any>>; failure?: { name: string; message: string }; stderr?: string };
type Context = { name: string; cwd: string; projectId: string; runId: string; sessionFile: string; sessionDir: string };

function inside(child: string, parent: string): boolean { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function parent(value: string): string { let current = value; while (!fs.existsSync(current)) { const next = path.dirname(current); if (next === current) throw new Error(`no existing parent for ${value}`); current = next; } return current; }
function labPath(value: string): string {
	const resolved = path.resolve(value); if (!inside(resolved, LAB)) throw new Error(`outside field lab: ${resolved}`);
	const actual = fs.realpathSync.native(LAB); if (!/^[dD]:[\\/]/.test(actual) || !inside(fs.realpathSync.native(parent(resolved)), actual)) throw new Error(`field lab junction escape: ${resolved}`);
	if (fs.existsSync(resolved) && !inside(fs.realpathSync.native(resolved), actual)) throw new Error(`field lab junction escape: ${resolved}`); return resolved;
}
function experimentRoot(): void {
	if (!fs.existsSync(EXPERIMENT_MARKER)) throw new Error("OMP_EXPERIMENT_ROOT_MARKER_MISSING");
	const actual = fs.realpathSync.native(LAB);
	if (!/^[dD]:[\\/]/.test(actual) || fs.readFileSync(EXPERIMENT_MARKER, "utf8").trim() !== "omp-dependency-lab/v1" || !inside(fs.realpathSync.native(EXPERIMENT_MARKER), actual)) throw new Error("OMP_EXPERIMENT_ROOT_MARKER_INVALID");
}
function fixture(): void {
	experimentRoot();
	const marker = JSON.parse(fs.readFileSync(MARKER, "utf8")) as { schema?: unknown; root?: unknown };
	if (marker.schema !== "omp-field-task-plan/v1" || marker.root !== ROOT) throw new Error("FIELD_FIXTURE_MARKER_INVALID");
	labPath(ROOT);
}
function write(file: string, value: string): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, "utf8"); }
function git(cwd: string, args: string[]): string { const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`); return r.stdout.toString().trim(); }
function sha(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function treeSha(directory: string, excluded = new Set<string>()): string { const h = crypto.createHash("sha256"); for (const item of fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((x): x is string => typeof x === "string").sort()) { const relative = item.replace(/\\/g, "/"); const file = path.join(directory, item); if (fs.statSync(file).isFile() && !excluded.has(relative)) { h.update(relative); h.update("\0"); h.update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")); h.update("\0"); } } return h.digest("hex"); }
function frozenAcceptanceSha(repo: string): string { return treeSha(path.join(repo, "test"), new Set(["readiness.test.ts", "conflicts.test.ts", "cli.unit.test.ts"])); }
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function command(action: string, fields: Record<string, unknown>): Record<string, unknown> { return { action, ...fields }; }
function capability(): Record<string, unknown> {
	const source = fs.readFileSync(CONTROL_SOURCE, "utf8"); const need = ["task_graph_create", "task_claim", "task_deliver", "project_spawn", "merge_enqueue", "merge_prepare", "merge_verify", "merge_apply", "merge_status"];
	const supported = Object.fromEntries(need.map(action => [action, source.includes(`\"${action}\"`)]));
	return { schema: "omp-field-capability/v1", observedAt: new Date().toISOString(), controlSource: CONTROL_SOURCE, extension: EXTENSION, supported, readyForRealModelRun: Object.values(supported).every(Boolean) };
}
function parity(): Record<string, unknown> {
	const pairs = Object.fromEntries([["controller", CONTROL_SOURCE, CONTROL_DEPLOYED], ["taskGraph", GRAPH_SOURCE, GRAPH_DEPLOYED]].map(([name, source, deployed]) => [name, { source, deployed, sourceSha256: fs.existsSync(source) ? sha(source) : null, deployedSha256: fs.existsSync(deployed) ? sha(deployed) : null, matches: fs.existsSync(source) && fs.existsSync(deployed) && sha(source) === sha(deployed) }]));
	return { schema: "omp-field-runtime-parity/v1", observedAt: new Date().toISOString(), sdk: { path: SDK, present: fs.existsSync(SDK), sha256: fs.existsSync(SDK) ? sha(SDK) : null }, pairs, ready: fs.existsSync(SDK) && Object.values(pairs).every((x: any) => x.matches) };
}

const CONTRACT = `import type { DependencyMaturity, TaskGraphSpec } from './task-graph.ts';
export type CompletionState = { deliveredTaskIds?: string[]; integratedTaskIds?: string[]; proposedTaskIds?: string[] };
export type Blocker = { taskId: string; maturity: DependencyMaturity };
export type Readiness = { readyTaskIds: string[]; waiting: Array<{ taskId: string; blockedBy: Blocker[] }> };
export type ParallelConflict = { taskIds: [string, string]; writePaths: string[]; sharedResources: string[] };
export type Summary = Readiness & { proposedTaskIds: string[]; conflicts: ParallelConflict[] };
export type ParsedPlan = TaskGraphSpec;
`;
const PLAN = JSON.stringify({ targetRef: "main", tasks: [
	{ id: "compile", writePaths: ["src/shared"], sharedResources: ["cache"], dependsOn: [] },
	{ id: "lint", writePaths: ["src/shared/check"], sharedResources: ["cache"], dependsOn: [] },
	{ id: "publish", writePaths: ["src/publish"], sharedResources: [], dependsOn: [{ taskId: "compile", maturity: "verified_commit" }, { taskId: "lint", maturity: "integrated" }] },
] }, null, 2) + "\n";
const STATE = JSON.stringify({ deliveredTaskIds: ["compile", "lint"], integratedTaskIds: ["lint"], proposedTaskIds: ["compile", "lint"] }, null, 2) + "\n";
const BAD_STATE = JSON.stringify({ deliveredTaskIds: ["missing"] }, null, 2) + "\n";
const DELIVERED_ONLY = JSON.stringify({ deliveredTaskIds: ["compile", "lint"] }, null, 2) + "\n";
const WAITING_PROPOSED = JSON.stringify({ proposedTaskIds: ["compile", "publish"] }, null, 2) + "\n";
const UNKNOWN_KEY = JSON.stringify({ unsupported: [] }, null, 2) + "\n";
const DUPLICATE_IDS = JSON.stringify({ deliveredTaskIds: ["compile", "compile"] }, null, 2) + "\n";
const UNKNOWN_PROPOSED = JSON.stringify({ proposedTaskIds: ["missing"] }, null, 2) + "\n";
const INTEGRATED_NOT_DELIVERED = JSON.stringify({ deliveredTaskIds: ["compile"], integratedTaskIds: ["lint"] }, null, 2) + "\n";
const ACCEPTANCE = `import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
function run(...args: string[]) { return Bun.spawnSync({ cmd: [process.execPath, 'src/cli.ts', ...args], cwd: root, stdout: 'pipe', stderr: 'pipe' }); }
function json(result: ReturnType<typeof run>) { assert.equal(result.exitCode, 0, result.stderr.toString()); return JSON.parse(result.stdout.toString()); }
test('CLI reports default ready tasks and exact path/resource conflict', () => {
  assert.deepEqual(json(run('--plan', 'test/fixtures/plan.json')), { readyTaskIds: ['compile', 'lint'], waiting: [{ taskId: 'publish', blockedBy: [{ taskId: 'compile', maturity: 'verified_commit' }, { taskId: 'lint', maturity: 'integrated' }] }], proposedTaskIds: ['compile', 'lint'], conflicts: [{ taskIds: ['compile', 'lint'], writePaths: ['src/shared', 'src/shared/check'], sharedResources: ['cache'] }] });
});
test('maturity uses delivered vs integrated and completed work is excluded', () => {
  assert.deepEqual(json(run('--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/complete.json')), { readyTaskIds: ['publish'], waiting: [], proposedTaskIds: ['compile', 'lint'], conflicts: [{ taskIds: ['compile', 'lint'], writePaths: ['src/shared', 'src/shared/check'], sharedResources: ['cache'] }] });
});
test('delivered but not integrated leaves the integrated dependency waiting', () => {
  assert.deepEqual(json(run('--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/delivered-only.json')), { readyTaskIds: [], waiting: [{ taskId: 'publish', blockedBy: [{ taskId: 'lint', maturity: 'integrated' }] }], proposedTaskIds: [], conflicts: [] });
});
test('explicit waiting proposal is reported without changing readiness', () => {
  assert.deepEqual(json(run('--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/waiting-proposed.json')), { readyTaskIds: ['compile', 'lint'], waiting: [{ taskId: 'publish', blockedBy: [{ taskId: 'compile', maturity: 'verified_commit' }, { taskId: 'lint', maturity: 'integrated' }] }], proposedTaskIds: ['compile', 'publish'], conflicts: [] });
});
test('malformed inputs, invalid state, unknown IDs, and flags fail nonzero', () => {
  for (const args of [['--plan', 'test/fixtures/missing.json'], ['--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/bad-state.json'], ['--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/unknown-key.json'], ['--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/duplicate-ids.json'], ['--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/unknown-proposed.json'], ['--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/integrated-not-delivered.json'], ['--plan', 'test/fixtures/plan.json', '--state', 'test/fixtures/malformed.json'], ['--wat'], ['--plan', 'test/fixtures/plan.json', '--plan', 'test/fixtures/plan.json'], ['--plan', 'test/fixtures/plan.json', '--state']]) assert.notEqual(run(...args).exitCode, 0);
});
`;

function prepare(): Manifest {
	experimentRoot();
	if (fs.existsSync(REPO)) throw new Error(`field fixture already exists: ${REPO}`);
	fs.mkdirSync(LAB, { recursive: true }); fs.mkdirSync(ROOT, { recursive: true });
	write(MARKER, JSON.stringify({ schema: "omp-field-task-plan/v1", root: ROOT, lab: LAB }, null, 2));
	git(ROOT, ["init", "--initial-branch=main", REPO]); git(REPO, ["config", "user.name", "OMP Field Pilot"]); git(REPO, ["config", "user.email", "omp-field-pilot@local.invalid"]);
	write(path.join(REPO, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { test: "bun test test" } }, null, 2) + "\n");
	write(path.join(REPO, "src", "task-graph.ts"), fs.readFileSync(GRAPH_SOURCE, "utf8")); write(path.join(REPO, "src", "contract.ts"), CONTRACT);
	write(path.join(REPO, "src", "readiness.ts"), "export function evaluateReadiness() { throw new Error('author task required'); }\n");
	write(path.join(REPO, "src", "conflicts.ts"), "export function findParallelConflicts() { throw new Error('author task required'); }\n");
	write(path.join(REPO, "src", "cli.ts"), "throw new Error('author task required');\n");
	write(path.join(REPO, "test", "fixtures", "plan.json"), PLAN); write(path.join(REPO, "test", "fixtures", "complete.json"), STATE); write(path.join(REPO, "test", "fixtures", "bad-state.json"), BAD_STATE); write(path.join(REPO, "test", "fixtures", "delivered-only.json"), DELIVERED_ONLY); write(path.join(REPO, "test", "fixtures", "waiting-proposed.json"), WAITING_PROPOSED); write(path.join(REPO, "test", "fixtures", "unknown-key.json"), UNKNOWN_KEY); write(path.join(REPO, "test", "fixtures", "duplicate-ids.json"), DUPLICATE_IDS); write(path.join(REPO, "test", "fixtures", "unknown-proposed.json"), UNKNOWN_PROPOSED); write(path.join(REPO, "test", "fixtures", "integrated-not-delivered.json"), INTEGRATED_NOT_DELIVERED); write(path.join(REPO, "test", "fixtures", "malformed.json"), "{\n"); write(path.join(REPO, "test", "cli.acceptance.test.ts"), ACCEPTANCE);
	write(path.join(REPO, "README.md"), "# Task-plan checker\n\nAfter the dependent CLI task is merged: `bun src/cli.ts --plan test/fixtures/plan.json [--state test/fixtures/complete.json]`. State accepts deliveredTaskIds, integratedTaskIds, and proposedTaskIds only; IDs must be known and unique, and integrated IDs must also be delivered. Delivered/integrated tasks are not suggested as ready. Explicit proposed task IDs may include waiting tasks for conflict inspection; that does not make them controller-claimable.\n");
	git(REPO, ["add", "."]); git(REPO, ["commit", "-m", "seed field task-plan fixture"]);
	fs.mkdirSync(WORKTREES, { recursive: true });
	const authors: Author[] = [
		{ id: "readiness", branch: "field/readiness", paths: ["src/readiness.ts", "test/readiness.test.ts"], path: path.join(WORKTREES, "readiness") },
		{ id: "conflicts", branch: "field/conflicts", paths: ["src/conflicts.ts", "test/conflicts.test.ts"], path: path.join(WORKTREES, "conflicts") },
		{ id: "cli", branch: "field/cli", paths: ["src/cli.ts", "test/cli.unit.test.ts"] },
	];
	for (const author of authors.filter(author => author.path)) git(REPO, ["worktree", "add", "-b", author.branch, author.path!, "main"]);
	git(REPO, ["worktree", "add", "-b", "field/cli-early-probe", path.join(WORKTREES, "cli-early-probe"), "main"]);
	const manifest: Manifest = { schema: "omp-field-task-plan/v1", createdAt: new Date().toISOString(), repo: REPO, target: REPO, authors, frozenAcceptanceSha256: frozenAcceptanceSha(REPO), frozenContractSha256: sha(path.join(REPO, "src", "contract.ts")), frozenGraphSha256: sha(path.join(REPO, "src", "task-graph.ts")), overlay: { task: TERRA, sonic: TERRA, verifier: TERRA, "security-reviewer": TERRA }, graph: { targetRef: "main", tasks: [
		{ id: "readiness", writePaths: authors[0].paths, sharedResources: [], dependsOn: [] },
		{ id: "conflicts", writePaths: authors[1].paths, sharedResources: [], dependsOn: [] },
		{ id: "cli", writePaths: authors[2].paths, sharedResources: [], dependsOn: [{ taskId: "readiness", maturity: "integrated" }, { taskId: "conflicts", maturity: "integrated" }] },
	] } };
	write(MANIFEST, JSON.stringify(manifest, null, 2)); write(path.join(EVIDENCE, "capability.json"), JSON.stringify(capability(), null, 2)); return manifest;
}
function manifest(): Manifest { fixture(); if (!fs.existsSync(MANIFEST)) throw new Error("field fixture absent; run --prepare"); return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Manifest; }
function verify(m: Manifest): void {
	fixture(); const acceptanceHash = frozenAcceptanceSha(m.target); if (acceptanceHash !== m.frozenAcceptanceSha256) throw new Error(`FROZEN_ACCEPTANCE_CHANGED:${acceptanceHash}`);
	if (sha(path.join(m.target, "src", "contract.ts")) !== m.frozenContractSha256 || sha(path.join(m.target, "src", "task-graph.ts")) !== m.frozenGraphSha256) throw new Error("FROZEN_SHARED_CONTRACT_CHANGED");
	const sameFrozenText = (file: string, target: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") === fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
	for (const author of m.authors.filter(x => x.path)) { if (frozenAcceptanceSha(author.path!) !== m.frozenAcceptanceSha256) throw new Error(`FROZEN_ACCEPTANCE_CHANGED:${author.id}`); if (!sameFrozenText(path.join(author.path!, "src", "contract.ts"), path.join(m.target, "src", "contract.ts")) || !sameFrozenText(path.join(author.path!, "src", "task-graph.ts"), path.join(m.target, "src", "task-graph.ts"))) throw new Error(`FROZEN_SHARED_CONTRACT_CHANGED:${author.id}`); }
}

function workerPlan(attempt: string, name: string, cwd: string, inputs: Record<string, unknown>[], sessionFile?: string, sessionDir = path.join(attempt, "workers", name, "session")): string {
	const file = path.join(attempt, "workers", name, "plan.json"); write(file, JSON.stringify({ schema: "omp-field-worker/v1", cwd, sessionFile, sessionDir, commands: inputs.map((input, index) => ({ input, evidenceFile: path.join(attempt, "workers", name, `command-${index}.json`) })) } satisfies WorkerPlan, null, 2)); return file;
}
async function invoke(planFile: string): Promise<WorkerResult> {
	const child = Bun.spawn({ cmd: [process.execPath, import.meta.path, "--worker", planFile], cwd: path.dirname(planFile), stdout: "pipe", stderr: "pipe", env: { ...process.env } });
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	write(path.join(path.dirname(planFile), "process.json"), JSON.stringify({ exitCode, stdout, stderr }, null, 2)); const file = path.join(path.dirname(planFile), "result.json"); if (!fs.existsSync(file)) throw new Error(`worker did not report: ${stderr.trim()}`); const result = JSON.parse(fs.readFileSync(file, "utf8")) as WorkerResult; if (exitCode !== 0) result.stderr = stderr.trim(); return result;
}
function result(worker: WorkerResult, index = 0): Record<string, any> { const item = worker.results[index]; if (!worker.ok || !item || item.failure || !item.result || typeof item.result !== "object") throw new Error(item?.failure?.message ?? worker.failure?.message ?? worker.stderr ?? "controller command failed"); return item.result; }
function evidence(attempt: string, worker: WorkerResult): void { const rows = worker.results.filter(x => x.input?.action === "project_spawn").map(x => { const native = x.result?.result ?? {}; return { schema: "omp-field-native-model/v1", observedAt: new Date().toISOString(), evidenceFile: x.evidenceFile ?? null, rootSessionId: x.rootSessionId ?? worker.rootSessionId ?? null, action: x.input.action, projectId: x.input.projectId, runId: x.input.runId, taskId: x.input.taskId ?? null, idempotencyKey: x.input.idempotencyKey, agent: x.input.agent, gate: x.input.gate ?? null, resolvedModel: native.resolvedModel ?? null, resolvedModelIdentity: native.resolvedModelIdentity ?? null, resolvedEffort: native.resolvedThinkingLevel ?? null, usage: native.usage ?? null, requests: native.requests ?? null, elapsedMs: native.durationMs ?? x.elapsedMs ?? null }; }); if (rows.length) fs.appendFileSync(path.join(attempt, "model-calls.jsonl"), `${rows.map(JSON.stringify).join("\n")}\n`); }
async function step(attempt: string, plan: string): Promise<WorkerResult> { const worker = await invoke(plan); evidence(attempt, worker); return worker; }
async function context(attempt: string, name: string, cwd: string): Promise<Context> {
	const sessionDir = path.join(attempt, "workers", name, "session"); const registered = await step(attempt, workerPlan(attempt, `${name}-register`, cwd, [command("project_register", { canonicalRoot: cwd })], undefined, sessionDir)); const projectId = String(result(registered).projectId); const sessionFile = String(registered.rootSessionFile);
	const begun = await step(attempt, workerPlan(attempt, `${name}-run`, cwd, [command("run_begin", { projectId, risk: "standard" })], sessionFile, sessionDir)); if (String(begun.rootSessionFile) !== sessionFile) throw new Error(`${name} did not resume root session`); return { name, cwd, projectId, runId: String(result(begun).runId), sessionFile, sessionDir };
}
function scope(author: Author): string { return author.paths.join(" and "); }
function authorPrompt(author: Author): string {
	const work = author.id === "readiness"
		? "Implement normalizeState(plan, state) and evaluateReadiness(plan, state). Parse plans only with the frozen parser. State has only optional deliveredTaskIds/integratedTaskIds/proposedTaskIds arrays: reject unknown keys, non-string/duplicate/unknown IDs, and integrated IDs missing from delivered. Return task-ID-sorted readiness; exclude delivered or integrated tasks from ready and waiting; verified_commit depends on delivered and integrated depends on integrated."
		: author.id === "conflicts"
			? "Implement findParallelConflicts(plan, taskIds). Reject unknown, duplicate, or non-string task IDs. Return task-pair-sorted conflicts; use the frozen taskScopesOverlap exactly for write paths and direct equality for shared resources; sort each reported path/resource list."
			: "Implement the CLI. Accept exactly --plan <file> and optional --state <file>; reject duplicate/unknown flags, nonexistent files, malformed JSON, and invalid plan/state with nonzero exit. Import readiness and conflicts. Default proposedTaskIds to readyTaskIds; explicit proposed IDs may include waiting tasks, and output must retain waiting without implying claimability. Emit stable JSON keys/order: readyTaskIds, waiting, proposedTaskIds, conflicts.";
	const prior = author.id === "cli" ? "" : ` A prior failed run preserved a read-only implementation at ${path.join(ROOT, "worktrees", author.id, author.paths[0])} and ${path.join(ROOT, "worktrees", author.id, author.paths[1])}; you may inspect it, then independently implement or confirm it only in your current owned paths.`;
	return `Implement only ${scope(author)}. ${work}${prior} Read src/contract.ts and use the exact frozen src/task-graph.ts API. Create your owned unit test. Do not edit the frozen contract, task graph, acceptance tests, fixtures, package metadata, README, or any other path. Do not use Git; the runner commits only your owned paths. Return the requested JSON.`;
}
function gatePrompt(kind: "verification" | "security", commandText: string, scopeText: string, runId: string, securityContext = ""): string {
	const output = `For this controlled gate use only the supplied outputSchema. Return one complete final object containing status, runId "${runId}", generation "1", findings, and a nonempty evidence array. Do not emit evidence-only, coverage-summary-only, or incremental yield objects. Report FAIL or BLOCKED truthfully with findings when warranted; use PASS only with no findings.`;
	return kind === "verification" ? `Independently verify ${scopeText}. Run exactly: ${commandText}. Do not edit files or Git. ${output}` : `Independently perform a read-only source security review of ${scopeText}, including input validation and path handling. Do not execute commands: the verification gate separately owns test execution. Do not edit files or Git. ${output} Evidence must name inspected source and state that test execution belongs to verification.${securityContext}`;
}
const AUTHOR_OUT = { type: "object", additionalProperties: false, properties: { status: { type: "string" }, evidence: { type: "array", items: { type: "string" } } }, required: ["status", "evidence"] };
const OUT = { type: "object", additionalProperties: false, properties: { status: { type: "string" }, runId: { type: "string" }, generation: { type: "string" }, findings: { type: "array", items: { type: "object", additionalProperties: false, properties: { block: { type: "boolean" }, severity: { type: "string" }, summary: { type: "string" }, runId: { type: "string" }, generation: { type: "string" } }, required: ["block", "severity", "summary", "runId", "generation"] } }, evidence: { type: "array", items: { type: "string" } } }, required: ["status", "runId", "generation", "findings", "evidence"] };
async function gates(attempt: string, c: Context, key: string, commandText: string, scopeText: string, securityContext = ""): Promise<void> {
	const inputs = (["verification", "security"] as const).map(kind => command("project_spawn", { projectId: c.projectId, runId: c.runId, idempotencyKey: `${key}-${kind}`, agent: kind === "verification" ? "verifier" : "security-reviewer", gate: kind, task: gatePrompt(kind, commandText, scopeText, c.runId, securityContext), outputSchema: OUT }));
	const worker = await step(attempt, workerPlan(attempt, `${c.name}-${key}-gates`, c.cwd, inputs, c.sessionFile, c.sessionDir)); result(worker, 0); result(worker, 1); if (String(worker.rootSessionFile) !== c.sessionFile) throw new Error(`${c.name} gate session changed`);
	const completed = await step(attempt, workerPlan(attempt, `${c.name}-${key}-complete`, c.cwd, [command("run_complete", { projectId: c.projectId, runId: c.runId })], c.sessionFile, c.sessionDir)); if (result(completed).taskComplete !== true) throw new Error(`${c.name} gates incomplete`);
}
function runnerCommit(author: Author, cwd: string, claimHead: string): string {
	if (git(cwd, ["rev-parse", "HEAD"]) !== claimHead) throw new Error(`${author.id} changed Git history`); const changed = [...new Set([...git(cwd, ["diff", "--name-only", "HEAD"]).split(/\r?\n/).filter(Boolean), ...git(cwd, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean)])].sort();
	if (changed.length !== author.paths.length || changed.some(file => !author.paths.includes(file))) throw new Error(`${author.id} wrote outside ownership: ${changed.join(",") || "none"}`); git(cwd, ["add", "--", ...author.paths]); git(cwd, ["commit", "-m", `field: implement ${author.id}`]); if (git(cwd, ["status", "--porcelain"]) !== "") throw new Error(`${author.id} left dirty worktree`); return git(cwd, ["rev-parse", "HEAD"]);
}

async function author(attempt: string, graphId: string, spec: Author): Promise<{ spec: Author; c: Context; token: string; head: string }> {
	if (!spec.path) throw new Error(`${spec.id} worktree absent`); const c = await context(attempt, `author-${spec.id}`, spec.path);
	const claimed = await step(attempt, workerPlan(attempt, `${c.name}-claim`, c.cwd, [command("task_claim", { projectId: c.projectId, runId: c.runId, graphId, taskId: spec.id, idempotencyKey: `${spec.id}-author` })], c.sessionFile, c.sessionDir)); const claim = result(claimed); return { spec, c, token: String(claim.claimToken), head: String(claim.claimHead) };
}
async function dispatchAuthor(attempt: string, item: { spec: Author; c: Context; token: string; head: string }, graphId: string): Promise<Record<string, unknown>> {
	const worker = await step(attempt, workerPlan(attempt, `${item.c.name}-author`, item.c.cwd, [command("project_spawn", { projectId: item.c.projectId, runId: item.c.runId, graphId, taskId: item.spec.id, claimToken: item.token, idempotencyKey: `${item.spec.id}-author`, agent: "task", task: authorPrompt(item.spec), outputSchema: AUTHOR_OUT })], item.c.sessionFile, item.c.sessionDir)); result(worker); const started = Number(worker.results[0]?.startedAt); const elapsed = Number(worker.results[0]?.elapsedMs); const nativeDurationMs = Number(worker.results[0]?.result?.result?.durationMs); if (!Number.isFinite(started) || !Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(nativeDurationMs) || nativeDurationMs <= 0) throw new Error(`${item.spec.id} author timing absent`); const ended = started + elapsed;
	const commit = runnerCommit(item.spec, item.c.cwd, item.head); write(path.join(attempt, "runner-commits", `${item.spec.id}.json`), JSON.stringify({ taskId: item.spec.id, claimHead: item.head, commit }, null, 2));
	const commandText = item.spec.id === "cli" ? "bun test" : `bun test test/${item.spec.id}.test.ts`; await gates(attempt, item.c, item.spec.id, commandText, scope(item.spec));
	const delivered = await step(attempt, workerPlan(attempt, `${item.c.name}-deliver`, item.c.cwd, [command("task_deliver", { projectId: item.c.projectId, runId: item.c.runId, graphId, taskId: item.spec.id, claimToken: item.token })], item.c.sessionFile, item.c.sessionDir)); if (result(delivered).state !== "delivered") throw new Error(`${item.spec.id} not delivered`);
	return { taskId: item.spec.id, commandStartedAt: started, commandFinishedAt: ended, commandElapsedMs: elapsed, nativeDurationMs, delivered: result(delivered) };
}
function candidate(attempt: string, m: Manifest, id: string, suffix = ""): string { const cwd = labPath(path.join(attempt, "candidates", `${id}${suffix}`)); if (fs.existsSync(cwd)) throw new Error(`candidate exists: ${cwd}`); git(m.target, ["worktree", "add", "-b", `field/candidate-${path.basename(attempt)}-${id}${suffix}`, cwd, "HEAD"]); return cwd; }
async function merge(attempt: string, m: Manifest, target: Context, graphId: string, taskId: string, testCommand: string, suffix = "", securityContext = ""): Promise<void> {
	const label = `${taskId}${suffix}`; const key = `${path.basename(attempt)}-${taskId}${suffix}`; const queued = await step(attempt, workerPlan(attempt, `target-enqueue-${label}`, m.target, [command("merge_enqueue", { projectId: target.projectId, runId: target.runId, graphId, taskId, idempotencyKey: key })], target.sessionFile, target.sessionDir)); const queue = result(queued); const token = String(queue.claimToken);
	const cwd = candidate(attempt, m, taskId, suffix); const c = await context(attempt, `candidate-${label}`, cwd);
	const prepared = await step(attempt, workerPlan(attempt, `${c.name}-prepare`, cwd, [command("merge_prepare", { projectId: c.projectId, runId: c.runId, graphId, taskId, idempotencyKey: key, claimToken: token })], c.sessionFile, c.sessionDir)); if (result(prepared).state !== "candidate_ready") throw new Error(`${label} candidate not ready`);
	await gates(attempt, c, `candidate-${label}`, testCommand, `candidate ${label}`, securityContext); const verified = await step(attempt, workerPlan(attempt, `${c.name}-verify`, cwd, [command("merge_verify", { projectId: c.projectId, runId: c.runId, graphId, taskId, idempotencyKey: key, claimToken: token })], c.sessionFile, c.sessionDir)); if (result(verified).state !== "verified") throw new Error(`${label} candidate not verified`);
	const applied = await step(attempt, workerPlan(attempt, `target-apply-${label}`, m.target, [command("merge_apply", { projectId: target.projectId, runId: target.runId, graphId, taskId, idempotencyKey: key, claimToken: token })], target.sessionFile, target.sessionDir)); if (result(applied).state !== "merged") throw new Error(`${label} not merged`); verify(m);
}
function attemptAuthors(m: Manifest, attempt: string): Author[] {
	if (git(m.target, ["rev-parse", "HEAD"]) !== FROZEN_SEED) throw new Error("TARGET_NOT_FROZEN_SEED");
	const root = labPath(path.join(attempt, "worktrees")); if (fs.existsSync(root)) throw new Error(`attempt worktrees exist: ${root}`);
	const retry = path.basename(attempt);
	return m.authors.slice(0, 2).map(spec => {
		const cwd = path.join(root, spec.id); git(m.target, ["worktree", "add", "-b", `field/retry-${retry}-${spec.id}`, cwd, "main"]);
		return { ...spec, branch: `field/retry-${retry}-${spec.id}`, path: cwd };
	});
}
function attemptEarlyProbe(m: Manifest, attempt: string): string {
	const cwd = path.join(attempt, "worktrees", "cli-early-probe"); git(m.target, ["worktree", "add", "-b", `field/retry-${path.basename(attempt)}-cli-early-probe`, cwd, "main"]); return cwd;
}
async function earlyClaim(attempt: string, graphId: string, cwd: string): Promise<void> {
	const c = await context(attempt, "cli-early-probe", cwd); const worker = await step(attempt, workerPlan(attempt, "cli-early-probe-claim", cwd, [command("task_claim", { projectId: c.projectId, runId: c.runId, graphId, taskId: "cli", idempotencyKey: "cli-early-probe" })], c.sessionFile, c.sessionDir));
	const failure = worker.results[0]?.failure; if (!failure || failure.name !== "ControlError" || failure.message !== "TASK_NOT_READY: readiness") throw new Error("CLI_EARLY_CLAIM_NOT_REJECTED"); write(path.join(attempt, "early-claim-rejection.json"), JSON.stringify({ taskId: "cli", projectId: c.projectId, runId: c.runId, expected: "TASK_NOT_READY: readiness", failure, workerProcessSucceeded: worker.ok, preservedProbe: cwd }, null, 2));
}
function actualCliWorktree(m: Manifest, attempt: string): string { const cwd = path.join(attempt, "worktrees", "cli"); if (fs.existsSync(cwd)) throw new Error(`actual CLI worktree already exists: ${cwd}`); git(m.target, ["worktree", "add", "-b", `field/retry-${path.basename(attempt)}-cli`, cwd, "HEAD"]); return cwd; }
function recordedWorker(attempt: string, name: string): WorkerResult {
	const file = path.join(attempt, "workers", name, "result.json"); if (!fs.existsSync(file)) throw new Error(`RECOVERY_WORKER_RESULT_MISSING:${name}`); return JSON.parse(fs.readFileSync(file, "utf8")) as WorkerResult;
}
function recordedContext(attempt: string, name: string, cwd: string): Context {
	const registered = recordedWorker(attempt, `${name}-register`); const begun = recordedWorker(attempt, `${name}-run`); const sessionFile = String(registered.rootSessionFile);
	if (String(begun.rootSessionFile) !== sessionFile) throw new Error(`RECOVERY_SESSION_CHANGED:${name}`); return { name, cwd, projectId: String(result(registered).projectId), runId: String(result(begun).runId), sessionFile, sessionDir: path.join(attempt, "workers", name, "session") };
}
async function continueA8dd(m: Manifest, attempt: string): Promise<Record<string, unknown>> {
	const id = "a8dd0edc-3b33-4f9a-8628-762a54fa8437"; if (path.basename(attempt) !== id || !fs.existsSync(path.join(attempt, "failure.json"))) throw new Error("CONTINUATION_ATTEMPT_REQUIRED");
	const target = recordedContext(attempt, "target", m.target); const graphId = `field-${id}`;
	await merge(attempt, m, target, graphId, "readiness", "bun test test/readiness.test.ts", "-retry");
	await merge(attempt, m, target, graphId, "conflicts", "bun test test/readiness.test.ts test/conflicts.test.ts");
	const readiness = result(recordedWorker(attempt, "author-readiness-deliver")); const conflicts = result(recordedWorker(attempt, "author-conflicts-deliver"));
	const cliPath = actualCliWorktree(m, attempt); const upstream = [String(readiness.verifiedCommit), String(conflicts.verifiedCommit)]; const targetHeadAtCliStart = git(m.target, ["rev-parse", "HEAD"]); const ancestry = upstream.map(commit => ({ commit, ancestor: git(cliPath, ["merge-base", "--is-ancestor", commit, "HEAD"]) === "" })); write(path.join(attempt, "cli-predecessor-ancestry.json"), JSON.stringify({ actualCliWorktree: cliPath, targetHeadAtCliStart, upstream, ancestry }, null, 2)); if (ancestry.some(item => !item.ancestor)) throw new Error("CLI_UPSTREAM_ANCESTRY_REQUIRED");
	const cliSpec: Author = { ...m.authors[2], path: cliPath }; const cli = await author(attempt, graphId, cliSpec); const cliAuthored = await dispatchAuthor(attempt, cli, graphId); await merge(attempt, m, target, graphId, "cli", "bun test");
	await gates(attempt, target, "target", "bun test", "final target and frozen CLI acceptance"); const status = await step(attempt, workerPlan(attempt, "target-merge-status-continuation", m.target, [command("merge_status", { projectId: target.projectId, runId: target.runId })], target.sessionFile, target.sessionDir)); const queue = result(status); if (queue.lock !== null || !Array.isArray(queue.items) || queue.items.length !== 4 || queue.items.filter((item: any) => item.state === "merged").length !== 3 || queue.items.filter((item: any) => item.state === "cancelled").length !== 1) throw new Error("CONTINUATION_MERGE_QUEUE_NOT_SETTLED");
	verify(m); const modelEvidence = verifyModels(attempt); return { graphId, targetProjectId: target.projectId, targetRunId: target.runId, cliAuthored, queue, modelEvidence };
}
function cliSecurityDisposition(attempt: string): string {
	const file = path.join(attempt, "reviewer-cli-security-disposition.md");
	if (!fs.existsSync(file)) throw new Error("CLI_SECURITY_DISPOSITION_MISSING");
	return ` This re-review is limited to the current frozen same-permission local CLI boundary: chosen local JSON files are read, evaluated in memory, and a JSON summary is printed to stdout. There is no service, controller, scheduler, write action, subprocess, network, privilege boundary, or consumer that executes conflicts. Read the preserved prior strict FAIL and independent disposition at ${file}. Independently assess the current source under this boundary; do not assume PASS, and return FAIL or BLOCKED if you identify a currently reachable issue.`;
}
async function continueCliA8dd(m: Manifest, attempt: string): Promise<Record<string, unknown>> {
	const id = "a8dd0edc-3b33-4f9a-8628-762a54fa8437"; if (path.basename(attempt) !== id || !fs.existsSync(path.join(attempt, "continuation-failure.json"))) throw new Error("CLI_CONTINUATION_ATTEMPT_REQUIRED");
	const graphId = `field-${id}`, target = recordedContext(attempt, "target", m.target), oldCandidatePath = path.join(attempt, "candidates", "cli"), oldCandidate = recordedContext(attempt, "candidate-cli", oldCandidatePath);
	const oldQueue = result(recordedWorker(attempt, "target-enqueue-cli")); const key = `${id}-cli`, token = String(oldQueue.claimToken);
	const blocked = await step(attempt, workerPlan(attempt, "candidate-cli-block-original", oldCandidatePath, [command("merge_verify", { projectId: oldCandidate.projectId, runId: oldCandidate.runId, graphId, taskId: "cli", idempotencyKey: key, claimToken: token })], oldCandidate.sessionFile, oldCandidate.sessionDir)); const blockedResult = result(blocked); if (blockedResult.state !== "blocked" || blockedResult.reason !== "TASK_GATES_REQUIRED") throw new Error("CLI_ORIGINAL_CANDIDATE_NOT_BLOCKED");
	const cancelled = await step(attempt, workerPlan(attempt, "target-cancel-cli-original", m.target, [command("merge_reconcile", { projectId: target.projectId, runId: target.runId, graphId, taskId: "cli", idempotencyKey: key, claimToken: token, cancel: true })], target.sessionFile, target.sessionDir)); if (result(cancelled).state !== "cancelled") throw new Error("CLI_ORIGINAL_CANDIDATE_NOT_CANCELLED");
	await merge(attempt, m, target, graphId, "cli", "bun test", "-retry", cliSecurityDisposition(attempt));
	await gates(attempt, target, "target", "bun test", "final target and frozen CLI acceptance", cliSecurityDisposition(attempt));
	const status = await step(attempt, workerPlan(attempt, "target-merge-status-cli-continuation", m.target, [command("merge_status", { projectId: target.projectId, runId: target.runId })], target.sessionFile, target.sessionDir)); const queue = result(status); if (queue.lock !== null || !Array.isArray(queue.items) || queue.items.length !== 5 || queue.items.filter((item: any) => item.state === "merged").length !== 3 || queue.items.filter((item: any) => item.state === "cancelled").length !== 2) throw new Error("CLI_CONTINUATION_MERGE_QUEUE_NOT_SETTLED");
	verify(m); const modelEvidence = verifyModels(attempt); return { graphId, targetProjectId: target.projectId, targetRunId: target.runId, originalBlocked: blockedResult, originalCancelled: result(cancelled), queue, modelEvidence };
}function verifyModels(attempt: string): Record<string, unknown> {
	const file = path.join(attempt, "model-calls.jsonl"); if (!fs.existsSync(file)) throw new Error("MODEL_EVIDENCE_MISSING"); const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
	const expected = [
		["readiness-author", "task", null, "readiness"], ["conflicts-author", "task", null, "conflicts"], ["cli-author", "task", null, "cli"],
		...(["readiness", "conflicts", "cli"] as const).flatMap(id => [[`${id}-verification`, "verifier", "verification", null], [`${id}-security`, "security-reviewer", "security", null]]),
		...(["conflicts"] as const).flatMap(id => [[`candidate-${id}-verification`, "verifier", "verification", null], [`candidate-${id}-security`, "security-reviewer", "security", null]]),
		["candidate-readiness-retry-verification", "verifier", "verification", null], ["candidate-readiness-retry-security", "security-reviewer", "security", null],
		["candidate-cli-retry-verification", "verifier", "verification", null], ["candidate-cli-retry-security", "security-reviewer", "security", null],
		["target-verification", "verifier", "verification", null], ["target-security", "security-reviewer", "security", null],
	] as Array<[string, string, string | null, string | null]>;
	const byKey = new Map<string, Record<string, any>>();
	for (const [index, row] of rows.entries()) { if (row.action !== "project_spawn" || row.resolvedModel?.split(":")[0] !== "openai-codex/gpt-5.6-terra" || row.resolvedEffort !== "high" || !Number.isInteger(row.requests) || row.requests <= 0 || !Number.isFinite(row.elapsedMs) || row.elapsedMs <= 0 || !row.usage || typeof row.idempotencyKey !== "string" || byKey.has(row.idempotencyKey)) throw new Error(`MODEL_EVIDENCE_INVALID:${index}`); byKey.set(row.idempotencyKey, row); }
	for (const [key, agent, gate, taskId] of expected) { const row = byKey.get(key); if (!row || row.agent !== agent || row.gate !== gate || row.taskId !== taskId) throw new Error(`MODEL_EVIDENCE_MAPPING:${key}`); }
	const cancelledCandidateKeys = ["candidate-readiness-verification", "candidate-readiness-security", "candidate-cli-verification", "candidate-cli-security"];
	for (const key of cancelledCandidateKeys) if (!byKey.has(key)) throw new Error(`MODEL_EVIDENCE_CANCELLED_CANDIDATE_MISSING:${key}`);
	if (byKey.size !== expected.length + cancelledCandidateKeys.length) throw new Error("MODEL_EVIDENCE_UNEXPECTED_CALL");
	const totalUsage: Record<string, number> = {}; for (const row of rows) for (const [key, value] of Object.entries(row.usage)) if (typeof value === "number" && Number.isFinite(value)) totalUsage[key] = (totalUsage[key] ?? 0) + value;
	const report = { schema: "omp-field-native-model-evidence/v1", acceptedExpectedCalls: expected, acceptedRecords: expected.map(([key]) => byKey.get(key)), cancelledCandidateKeys, cancelledCandidateRecords: cancelledCandidateKeys.map(key => byKey.get(key)), records: rows, totalRequests: rows.reduce((sum, row) => sum + row.requests, 0), totalUsage }; write(path.join(attempt, "model-evidence.json"), JSON.stringify(report, null, 2)); return report;
}
function under(root: string, file: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); }
function rawCommand(attempt: string, worker: string, index = 0): Record<string, any> {
	const file = path.join(attempt, "workers", worker, `command-${index}.json`); if (!fs.existsSync(file)) throw new Error(`AUDIT_COMMAND_MISSING:${worker}:${index}`); const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>; if (raw.evidenceFile !== file || raw.controllerDb !== path.join(attempt, "controller.sqlite") || !raw.input || !raw.result) throw new Error(`AUDIT_COMMAND_BINDING:${worker}:${index}`); return raw;
}
function auditedContext(attempt: string, name: string, cwd: string): Context {
	const registered = recordedWorker(attempt, `${name}-register`), begun = recordedWorker(attempt, `${name}-run`), reg = rawCommand(attempt, `${name}-register`), run = rawCommand(attempt, `${name}-run`); const projectId = String(result(registered).projectId), runId = String(result(begun).runId), sessionFile = String(registered.rootSessionFile), sessionRoot = path.join(attempt, "workers", name, "session");
	if (reg.input.action !== "project_register" || reg.input.canonicalRoot !== cwd || reg.result.projectId !== projectId || reg.result.canonicalRoot !== cwd || run.input.action !== "run_begin" || run.input.projectId !== projectId || run.result.projectId !== projectId || run.result.runId !== runId || String(begun.rootSessionFile) !== sessionFile || reg.rootSessionFile !== sessionFile || run.rootSessionFile !== sessionFile || !under(sessionRoot, sessionFile) || !fs.existsSync(sessionFile)) throw new Error(`AUDIT_CONTEXT_BINDING:${name}`);
	return { name, cwd, projectId, runId, sessionFile, sessionDir: sessionRoot };
}
function auditA8dd(m: Manifest, attempt: string): Record<string, unknown> {
	const id = "a8dd0edc-3b33-4f9a-8628-762a54fa8437"; if (path.basename(attempt) !== id) throw new Error("AUDIT_ATTEMPT_REQUIRED"); const graphId = `field-${id}`;
	const contexts = [auditedContext(attempt, "target", m.target), auditedContext(attempt, "author-readiness", path.join(attempt, "worktrees", "readiness")), auditedContext(attempt, "author-conflicts", path.join(attempt, "worktrees", "conflicts")), auditedContext(attempt, "author-cli", path.join(attempt, "worktrees", "cli")), auditedContext(attempt, "candidate-readiness", path.join(attempt, "candidates", "readiness")), auditedContext(attempt, "candidate-readiness-retry", path.join(attempt, "candidates", "readiness-retry")), auditedContext(attempt, "candidate-conflicts", path.join(attempt, "candidates", "conflicts")), auditedContext(attempt, "candidate-cli", path.join(attempt, "candidates", "cli")), auditedContext(attempt, "candidate-cli-retry", path.join(attempt, "candidates", "cli-retry"))];
	const pairs = new Set(contexts.map(c => `${c.projectId}/${c.runId}`)); const deliveries = (["readiness", "conflicts", "cli"] as const).map(taskId => { const raw = rawCommand(attempt, `author-${taskId}-deliver`); if (raw.input.action !== "task_deliver" || raw.input.graphId !== graphId || raw.input.taskId !== taskId || raw.result.state !== "delivered" || raw.result.graphId !== graphId || raw.result.taskId !== taskId || typeof raw.result.verifiedCommit !== "string" || !pairs.has(`${raw.input.projectId}/${raw.input.runId}`)) throw new Error(`AUDIT_DELIVERY_BINDING:${taskId}`); return { taskId, projectId: raw.input.projectId, runId: raw.input.runId, verifiedCommit: raw.result.verifiedCommit }; });
	const evidence = verifyModels(attempt) as any; const rows = evidence.records as Array<Record<string, any>>; for (const [index, row] of rows.entries()) { if (typeof row.evidenceFile !== "string" || !under(attempt, row.evidenceFile) || !fs.existsSync(row.evidenceFile)) throw new Error(`AUDIT_MODEL_FILE:${index}`); const raw = JSON.parse(fs.readFileSync(row.evidenceFile, "utf8")) as Record<string, any>, input = raw.input; if (raw.evidenceFile !== row.evidenceFile || input?.action !== "project_spawn" || input.projectId !== row.projectId || input.runId !== row.runId || input.idempotencyKey !== row.idempotencyKey || input.agent !== row.agent || (input.gate ?? null) !== row.gate || (input.taskId ?? null) !== row.taskId || !pairs.has(`${row.projectId}/${row.runId}`)) throw new Error(`AUDIT_MODEL_BINDING:${index}`); }
	const targetHead = git(m.target, ["rev-parse", "HEAD"]), retryHead = git(path.join(attempt, "candidates", "cli-retry"), ["rev-parse", "HEAD"]), queueRaw = rawCommand(attempt, "target-merge-status-cli-continuation"), queueHead = queueRaw.result.items?.find((item: any) => item.taskId === "cli" && item.attemptId === `${id}-cli-retry`)?.candidateHead; if (targetHead !== retryHead || queueHead !== targetHead) throw new Error("AUDIT_FINAL_HEAD_BINDING"); const report = { schema: "omp-field-post-run-evidence-audit/v1", attemptId: id, auditedAt: new Date().toISOString(), scriptSha256: sha(path.resolve(import.meta.path)), contexts: contexts.map(c => ({ name: c.name, projectId: c.projectId, runId: c.runId, sessionFile: c.sessionFile })), deliveries, modelRecordsAudited: rows.length, cancelledCandidateKeys: evidence.cancelledCandidateKeys, finalHeadEvidence: { head: targetHead, targetGit: m.target, retryCandidateGit: path.join(attempt, "candidates", "cli-retry"), queueEvidenceFile: path.join(attempt, "workers", "target-merge-status-cli-continuation", "command-0.json"), queueCandidateHead: queueHead }, frozen: { acceptance: m.frozenAcceptanceSha256, contract: m.frozenContractSha256, graph: m.frozenGraphSha256 } }; write(path.join(attempt, "post-run-evidence-audit.json"), JSON.stringify(report, null, 2)); return report;
}async function run(m: Manifest, attempt: string, id: string): Promise<Record<string, unknown>> {
	const retryAuthors = attemptAuthors(m, attempt); const earlyProbe = attemptEarlyProbe(m, attempt); write(path.join(attempt, "retry-from-recovery.json"), JSON.stringify({ preservedAttempt: PRESERVED_ATTEMPT, frozenSeed: FROZEN_SEED, retryAuthors: retryAuthors.map(author => ({ id: author.id, branch: author.branch, path: author.path })), earlyProbe }, null, 2));
	const target = await context(attempt, "target", m.target); const graphId = `field-${id}`; const created = await step(attempt, workerPlan(attempt, "target-graph", m.target, [command("task_graph_create", { projectId: target.projectId, runId: target.runId, graphId, graphPlan: m.graph })], target.sessionFile, target.sessionDir)); result(created);
	await earlyClaim(attempt, graphId, earlyProbe);
	const claims = await Promise.allSettled([author(attempt, graphId, retryAuthors[0]), author(attempt, graphId, retryAuthors[1])]);
	if (claims.some(item => item.status === "rejected")) throw new AggregateError(claims.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason), "parallel author claims failed after every claim settled");
	const [a, b] = claims.map(item => (item as PromiseFulfilledResult<Awaited<ReturnType<typeof author>>>).value);
	const dispatched = await Promise.allSettled([dispatchAuthor(attempt, a, graphId), dispatchAuthor(attempt, b, graphId)]);
	if (dispatched.some(item => item.status === "rejected")) throw new AggregateError(dispatched.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason), "parallel author execution failed after every author settled");
	const authored = dispatched.map(item => (item as PromiseFulfilledResult<Record<string, unknown>>).value);
	const windows = authored.map((x: any) => ({ taskId: x.taskId, commandStartedAt: x.commandStartedAt, commandFinishedAt: x.commandFinishedAt, commandElapsedMs: x.commandElapsedMs, nativeDurationMs: x.nativeDurationMs })); const overlapMs = Math.min(...windows.map(x => x.commandFinishedAt)) - Math.max(...windows.map(x => x.commandStartedAt)); write(path.join(attempt, "author-overlap.json"), JSON.stringify({ schema: "omp-field-author-overlap/v1", windows, overlapMs, concurrent: overlapMs > 0, timingSource: "project_spawn command startedAt/elapsedMs with required native duration" }, null, 2)); if (overlapMs <= 0) throw new Error("AUTHOR_COMMANDS_DID_NOT_OVERLAP");
	await merge(attempt, m, target, graphId, "readiness", "bun test test/readiness.test.ts"); await merge(attempt, m, target, graphId, "conflicts", "bun test test/readiness.test.ts test/conflicts.test.ts");
	const cliPath = actualCliWorktree(m, attempt); const upstream = authored.map((x: any) => String(x.delivered.verifiedCommit)); const targetHeadAtCliStart = git(m.target, ["rev-parse", "HEAD"]); const ancestry = upstream.map(commit => ({ commit, ancestor: git(cliPath, ["merge-base", "--is-ancestor", commit, "HEAD"]) === "" })); write(path.join(attempt, "cli-predecessor-ancestry.json"), JSON.stringify({ actualCliWorktree: cliPath, targetHeadAtCliStart, upstream, ancestry }, null, 2));
	const cliSpec: Author = { ...m.authors[2], path: cliPath }; const c = await author(attempt, graphId, cliSpec); await dispatchAuthor(attempt, c, graphId); await merge(attempt, m, target, graphId, "cli", "bun test");
	await gates(attempt, target, "target", "bun test", "final target and frozen CLI acceptance"); const status = await step(attempt, workerPlan(attempt, "target-merge-status", m.target, [command("merge_status", { projectId: target.projectId, runId: target.runId })], target.sessionFile, target.sessionDir)); const queue = result(status); if (queue.lock !== null || !Array.isArray(queue.items) || queue.items.length !== 3 || queue.items.some((item: any) => item.state !== "merged")) throw new Error("MERGE_QUEUE_NOT_SETTLED"); verify(m); const modelEvidence = verifyModels(attempt); return { graphId, targetProjectId: target.projectId, targetRunId: target.runId, authored, queue, modelEvidence };
}

async function sdkProbe(): Promise<Record<string, unknown>> { fixture(); const sdk = await import(SDK); const report = { schema: "omp-field-sdk-probe/v1", observedAt: new Date().toISOString(), sdk: SDK, required: Object.fromEntries(["createAgentSession", "discoverAuthStorage", "AgentRegistry"].map(key => [key, key in sdk])), noSessionCreated: true, noAuthStorageOpened: true, noModelPrompted: true }; write(path.join(EVIDENCE, "sdk-probe.json"), JSON.stringify(report, null, 2)); return report; }
async function sessionSmoke(): Promise<Record<string, unknown>> {
	const m = manifest(); verify(m); const id = crypto.randomUUID(); const root = path.join(ROOT, "smoke", id); const db = path.join(root, "controller.sqlite"); process.env.FIELD_CONTROL_DB = db;
	const sdk = await import(SDK) as any; const { SessionManager } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts`); const { ModelRegistry } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-registry.ts`); const settings = await sdk.Settings.loadReadOnly({ cwd: m.target, agentDir: AGENT_DIR }); settings.override("task.agentModelOverrides", { ...settings.get("task.agentModelOverrides"), task: TERRA, sonic: TERRA, verifier: TERRA, "security-reviewer": TERRA }); const auth = await sdk.discoverAuthStorage(AGENT_DIR); let session: any; let manager: any; let failure: { name: string; message: string } | undefined;
	try { const registry = new ModelRegistry(auth, path.join(AGENT_DIR, "models.yml"), { settings, cacheDbPath: path.join(root, "model-cache.sqlite") }); manager = SessionManager.create(m.target, path.join(root, "session")); await manager.ensureOnDisk(); const started = Date.now(); const created = await sdk.createAgentSession({ cwd: m.target, agentDir: AGENT_DIR, settings, authStorage: auth, modelRegistry: registry, sessionManager: manager, modelPattern: ROOT_MODEL, thinkingLevel: "high", disableExtensionDiscovery: true, additionalExtensionPaths: [EXTENSION], enableMCP: false, enableLsp: false, enableIrc: false }); const registrations = path.join(EVIDENCE, "extension-registrations.jsonl"); const registered = fs.existsSync(registrations) && fs.readFileSync(registrations, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).some((x: any) => x.command === "field-plan" && x.pid === process.pid && x.registeredAt >= started); if (!created.extensionsResult.extensions.some((x: any) => path.resolve(x.resolvedPath) === path.resolve(EXTENSION)) || created.extensionsResult.errors.length || !registered) throw new Error("FIELD_COMMAND_NOT_REGISTERED"); session = created.session; const evidenceFile = path.join(root, "health.json"); await session.prompt(`/field-plan ${JSON.stringify({ input: { action: "health" }, evidenceFile })}`); const entries = manager.getEntries() as Array<{ type?: string; message?: { role?: string } }>; const usage = manager.getUsageStatistics(); const modelEntries = entries.filter(x => x.type === "model_usage" || (x.type === "message" && x.message?.role === "assistant")); if (modelEntries.length || usage.totalTokens !== 0 || usage.cost !== 0) throw new Error("SMOKE_MODEL_USAGE_OBSERVED"); const report = { schema: "omp-field-session-smoke/v1", id, rootSessionId: manager.getSessionId(), rootSessionFile: manager.getSessionFile(), controllerDb: db, extensionLoaded: true, registrationRecorded: true, providerRequests: 0, usage }; write(path.join(EVIDENCE, `session-smoke-${id}.json`), JSON.stringify(report, null, 2)); return report; }
	catch (error) { failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) }; throw error; }
	finally { try { await session?.dispose(); } finally { await auth.close?.(); write(path.join(root, "result.json"), JSON.stringify({ id, failure }, null, 2)); } }
}
async function workerSmoke(): Promise<Record<string, unknown>> {
	const m = manifest(); verify(m); const id = crypto.randomUUID(); const root = path.join(ROOT, "smoke", `worker-${id}`); process.env.FIELD_CONTROL_DB = path.join(root, "controller.sqlite"); const worker = await invoke(workerPlan(root, "health", m.target, [command("health", {})])); const health = result(worker); const report = { schema: "omp-field-worker-smoke/v1", id, workerRootSessionId: worker.rootSessionId ?? null, workerRootSessionFile: worker.rootSessionFile ?? null, healthEvidenceCount: worker.results.length, health, providerRequests: 0, noProjectSpawn: worker.results.every(x => x.input?.action !== "project_spawn") }; if (report.healthEvidenceCount !== 1 || report.noProjectSpawn !== true) throw new Error("WORKER_SMOKE_EVIDENCE_OR_MODEL_PATH"); write(path.join(root, "report.json"), JSON.stringify(report, null, 2)); return report;
}
async function runWorker(planFile: string): Promise<void> {
	fixture(); const plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as WorkerPlan; if (plan.schema !== "omp-field-worker/v1") throw new Error("invalid worker plan"); labPath(planFile); labPath(plan.cwd); labPath(plan.sessionDir); for (const item of plan.commands) labPath(item.evidenceFile);
	const sdk = await import(SDK) as any; const { SessionManager } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts`); const { ModelRegistry } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-registry.ts`); const settings = await sdk.Settings.loadReadOnly({ cwd: plan.cwd, agentDir: AGENT_DIR }); settings.override("task.agentModelOverrides", { ...settings.get("task.agentModelOverrides"), task: TERRA, sonic: TERRA, verifier: TERRA, "security-reviewer": TERRA });
	const auth = await sdk.discoverAuthStorage(AGENT_DIR); let session: any; let manager: any; const results: Array<Record<string, any>> = []; let caught: { name: string; message: string } | undefined;
	try { const registry = new ModelRegistry(auth, path.join(AGENT_DIR, "models.yml"), { settings, cacheDbPath: path.join(ROOT, "model-cache.sqlite") }); manager = plan.sessionFile ? await SessionManager.open(labPath(plan.sessionFile), plan.sessionDir, undefined, { throwIfMissing: true }) : SessionManager.create(plan.cwd, plan.sessionDir); await manager.ensureOnDisk(); const started = Date.now(); const created = await sdk.createAgentSession({ cwd: plan.cwd, agentDir: AGENT_DIR, settings, authStorage: auth, modelRegistry: registry, sessionManager: manager, modelPattern: ROOT_MODEL, thinkingLevel: "high", disableExtensionDiscovery: true, additionalExtensionPaths: [EXTENSION], enableMCP: false, enableLsp: false, enableIrc: false }); const registrations = path.join(EVIDENCE, "extension-registrations.jsonl"); const registered = fs.existsSync(registrations) && fs.readFileSync(registrations, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).some((x: any) => x.command === "field-plan" && x.pid === process.pid && x.registeredAt >= started); if (!created.extensionsResult.extensions.some((x: any) => path.resolve(x.resolvedPath) === path.resolve(EXTENSION)) || created.extensionsResult.errors.length || !registered) throw new Error("FIELD_COMMAND_NOT_REGISTERED"); session = created.session; for (const item of plan.commands) { await session.prompt(`/field-plan ${JSON.stringify(item)}`); results.push(JSON.parse(fs.readFileSync(item.evidenceFile, "utf8"))); } }
	catch (error) { caught = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) }; throw error; }
	finally { try { await session?.dispose(); } finally { await auth.close?.(); for (const item of plan.commands) if (fs.existsSync(item.evidenceFile) && !results.some(x => x.evidenceFile === item.evidenceFile)) results.push(JSON.parse(fs.readFileSync(item.evidenceFile, "utf8"))); write(path.join(path.dirname(planFile), "result.json"), JSON.stringify({ ok: !caught, rootSessionId: manager?.getSessionId?.(), rootSessionFile: manager?.getSessionFile?.(), results, failure: caught }, null, 2)); } }
}
async function main(): Promise<void> {
	const action = process.argv[2] ?? "--probe";
	if (action === "--prepare") { const m = prepare(); print({ prepared: m, capability: capability() }); return; }
	if (action === "--probe") { print(capability()); return; }
	if (action === "--runtime-parity") { print(parity()); return; }
	if (action === "--sdk-probe") { print(await sdkProbe()); return; }
	if (action === "--session-smoke") { print(await sessionSmoke()); return; }
	if (action === "--worker-smoke") { print(await workerSmoke()); return; }
	if (action === "--verify-fixture") { const m = manifest(); verify(m); print({ ok: true, manifest: m, capability: capability() }); return; }
	if (action === "--worker") { const plan = process.argv[3]; if (!plan) throw new Error("worker plan required"); await runWorker(plan); return; }
	if (action === "--continue-a8dd") { const id = "a8dd0edc-3b33-4f9a-8628-762a54fa8437"; const attempt = labPath(path.join(ROOT, "attempts", id)); const db = path.join(attempt, "controller.sqlite"); process.env.FIELD_CONTROL_DB = db; const startedAt = Date.now(); try { const m = manifest(); verify(m); if (process.env.FIELD_ALLOW_REAL_MODEL !== "1") throw new Error(`REAL_MODEL_RUN_NOT_ARMED:${id}`); write(path.join(attempt, "continuation.json"), JSON.stringify({ schema: "omp-field-candidate-continuation/v1", id, startedAt, controllerDb: db, priorFailure: path.join(attempt, "failure.json"), cancelledCandidate: "a8dd0edc-3b33-4f9a-8628-762a54fa8437-readiness" }, null, 2)); const completed = await continueA8dd(m, attempt); write(path.join(attempt, "continuation-completed.json"), JSON.stringify({ id, startedAt, elapsedMs: Date.now() - startedAt, ...completed }, null, 2)); print({ ok: true, id, attempt, ...completed }); } catch (error) { write(path.join(attempt, "continuation-failure.json"), JSON.stringify({ id, startedAt, elapsedMs: Date.now() - startedAt, failure: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) } }, null, 2)); throw error; } return; }
		if (action === "--continue-cli-a8dd") { const id = "a8dd0edc-3b33-4f9a-8628-762a54fa8437"; const attempt = labPath(path.join(ROOT, "attempts", id)); const db = path.join(attempt, "controller.sqlite"); process.env.FIELD_CONTROL_DB = db; const startedAt = Date.now(); try { const m = manifest(); verify(m); if (process.env.FIELD_ALLOW_REAL_MODEL !== "1") throw new Error(`REAL_MODEL_RUN_NOT_ARMED:${id}`); write(path.join(attempt, "cli-continuation.json"), JSON.stringify({ schema: "omp-field-cli-candidate-continuation/v1", id, startedAt, controllerDb: db, priorFailure: path.join(attempt, "failure.json"), priorContinuationFailure: path.join(attempt, "continuation-failure.json"), originalCandidateKey: `${id}-cli`, retryCandidateKey: `${id}-cli-retry`, disposition: path.join(attempt, "reviewer-cli-security-disposition.md") }, null, 2)); const completed = await continueCliA8dd(m, attempt); write(path.join(attempt, "cli-continuation-completed.json"), JSON.stringify({ id, startedAt, elapsedMs: Date.now() - startedAt, ...completed }, null, 2)); print({ ok: true, id, attempt, ...completed }); } catch (error) { write(path.join(attempt, "cli-continuation-failure.json"), JSON.stringify({ id, startedAt, elapsedMs: Date.now() - startedAt, failure: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) } }, null, 2)); throw error; } return; }
	if (action === "--audit-a8dd") { const id = "a8dd0edc-3b33-4f9a-8628-762a54fa8437", attempt = labPath(path.join(ROOT, "attempts", id)); process.env.FIELD_CONTROL_DB = path.join(attempt, "controller.sqlite"); const m = manifest(); verify(m); print({ ok: true, audit: auditA8dd(m, attempt) }); return; }
	if (action === "--run") { const id = crypto.randomUUID(); const attempt = labPath(path.join(ROOT, "attempts", id)); const db = path.join(attempt, "controller.sqlite"); fs.mkdirSync(attempt, { recursive: true }); process.env.FIELD_CONTROL_DB = db; const startedAt = Date.now(); try { const m = manifest(); verify(m); const caps = capability(); const runtime = parity(); write(path.join(attempt, "attempt.json"), JSON.stringify({ schema: "omp-field-real-attempt/v1", id, startedAt, controllerDb: db, overlay: { task: TERRA, sonic: TERRA, verifier: TERRA, "security-reviewer": TERRA }, caps, runtime }, null, 2)); if (!caps.readyForRealModelRun || !runtime.ready) throw new Error("FIELD_RUNTIME_NOT_READY"); if (process.env.FIELD_ALLOW_REAL_MODEL !== "1") throw new Error(`REAL_MODEL_RUN_NOT_ARMED:${id}`); const completed = await run(m, attempt, id); write(path.join(attempt, "completed.json"), JSON.stringify({ id, startedAt, elapsedMs: Date.now() - startedAt, ...completed }, null, 2)); print({ ok: true, id, attempt, ...completed }); } catch (error) { write(path.join(attempt, "failure.json"), JSON.stringify({ id, startedAt, elapsedMs: Date.now() - startedAt, failure: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) } }, null, 2)); throw error; } return; }
	throw new Error("usage: --prepare | --probe | --runtime-parity | --sdk-probe | --session-smoke | --worker-smoke | --verify-fixture | --worker | --continue-a8dd | --continue-cli-a8dd | --audit-a8dd | --run");
}
await main();
