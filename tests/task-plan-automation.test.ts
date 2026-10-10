import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { taskProgress } from "../scripts/task-plan-progress.ts";

const root = process.env.OMP_AUTOMATION_LAB_ROOT ?? "D:/Labs/omp/omp-automation-lab-20260918";
const runner = path.resolve(import.meta.dir, "../scripts/task-plan-automation.ts");
function git(cwd: string, args: string[]) { const out = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" }); assert.equal(out.exitCode, 0, out.stderr.toString()); return out.stdout.toString().trim(); }
function gitOk(cwd: string, args: string[]) { return Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" }).exitCode === 0; }
function run(args: string[], env: Record<string, string | undefined> = {}) { return Bun.spawnSync({ cmd: [process.execPath, runner, ...args], cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } }); }
function project(name: string) { const dir = path.join(root, "automation-tests", `${name}-${crypto.randomUUID()}`); fs.mkdirSync(dir, { recursive: true }); git(dir, ["init", "-b", "main"]); git(dir, ["config", "user.email", "automation@test.invalid"]); git(dir, ["config", "user.name", "automation test"]); fs.mkdirSync(path.join(dir, "src"), { recursive: true }); fs.writeFileSync(path.join(dir, "src", "base.ts"), "export const base = true;\n"); git(dir, ["add", "."]); git(dir, ["commit", "-m", "base"]); return dir; }
function plan(repo: string, tasks: unknown[], finalTestCommand = ["bun", "--version"]) { return { target: { repo, ref: "main" }, tasks, finalTestCommand }; }
function task(id: string, scope: string, dependsOn: unknown[] = [], sharedResources: string[] = [], testCommand = ["bun", "--version"]) { return { id, writePaths: [scope], sharedResources, dependsOn, prompt: `Implement ${id}.`, testCommand, agent: "task" }; }
function writePlan(repo: string, value: unknown) { const file = path.join(root, "automation-tests", "plans", `${path.basename(repo)}.json`); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); return file; }
function output(result: ReturnType<typeof run>) { assert.equal(result.exitCode, 0, result.stderr.toString()); return JSON.parse(result.stdout.toString()); }

test("validate is side-effect free and rejects unknown paths", () => {
	const repo = project("validate"), valid = writePlan(repo, plan(repo, [task("a", "src/a.ts")])); const before = path.join(root, "automation"); const exists = fs.existsSync(before); const report = output(run(["validate", valid, "--lab-root", root])); assert.equal(report.tasks[0].id, "a"); assert.equal(fs.existsSync(before), exists);
	const invalid = writePlan(repo, plan(repo, [task("bad", "../escape.ts")])); assert.notEqual(run(["validate", invalid, "--lab-root", root]).exitCode, 0);
});

test("concurrency accepts 1 through 4 and rejects invalid or unbounded values", () => {
  const repo = project("limits"), file = writePlan(repo, plan(repo, [task("a", "src/a.ts")]));
  for (const value of ["1", "2", "3", "4"]) output(run(["validate", file, "--lab-root", root, "--concurrency", value]));
  for (const value of ["0", "5", "8", "-1", "1.5", "04", "Infinity"]) {
    const result = run(["validate", file, "--lab-root", root, "--concurrency", value]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /CONCURRENCY_1_TO_4/);
  }
});

test("default four-author execution preserves roles, isolated worktrees and dependency integration", { timeout: 120_000 }, () => {
  const repo = project("four-authors");
  const authors = [task("apia", "src/apia.ts"), task("apib", "src/apib.ts"),
    { ...task("uia", "src/uia.ts"), agent: "frontend-worker" },
    { ...task("uib", "src/uib.ts"), agent: "frontend-worker" }];
  const joined = task("joined", "src/joined.ts", authors.map(item => ({ taskId: item.id, maturity: "integrated" })));
  const file = writePlan(repo, plan(repo, [...authors, joined]));
  const done = output(run(["run", file, "--lab-root", root, "--mock-executor"]));
  assert.deepEqual(done.waves.flatMap((wave: any) => wave.tasks).sort(), ["apia", "apib", "joined", "uia", "uib"]);
  assert.equal(done.waves[0].concurrency, 4);
  assert.equal(done.queue.items.filter((item: any) => item.state === "merged").length, 5);
  assert.equal(done.productComplete, false);
  const evidence = path.join(root, "automation", "attempts", done.id);
  const attempt = JSON.parse(fs.readFileSync(path.join(evidence, "attempt.json"), "utf8"));
  assert.equal(attempt.concurrency, 4);
  assert.equal(attempt.diagnosticEvidence.schema, "omp-check-diagnostic/v1");
  assert.equal(attempt.diagnosticEvidence.root, path.join(evidence, "diagnostics"));
  assert.ok(fs.readdirSync(path.join(evidence, "diagnostics")).some(name => /^check-[a-f0-9]{48}\.json$/.test(name)));
  for (const item of authors) {
    const receipt = JSON.parse(fs.readFileSync(path.join(evidence, "workers", `author-${item.id}-author`, "command-0.json"), "utf8"));
    assert.equal(receipt.input.agent, item.agent);
    assert.ok(fs.existsSync(path.join(evidence, "worktrees", item.id, ".git")));
    assert.ok(fs.existsSync(path.join(repo, "src", `${item.id}.ts`)));
  }
});

test("UI plans preserve role routing and runner completion never claims product acceptance", { timeout: 90_000 }, () => {
  const repo = project("ui-logic"), ui = { ...task("ui", "src/ui.ts"), agent: "frontend-worker" };
  const file = writePlan(repo, plan(repo, [ui, task("logic", "src/logic.ts")]));
  assert.equal(output(run(["validate", file, "--lab-root", root])).tasks[0].agent, "frontend-worker");
  const done = output(run(["run", file, "--lab-root", root, "--concurrency", "2", "--mock-executor"]));
  assert.deepEqual(done.waves.flatMap((wave: any) => wave.tasks).sort(), ["logic", "ui"]);
  assert.equal(done.productComplete, false);
  assert.equal(done.productAcceptance, "pending-parent-review");
  const evidence = path.join(root, "automation", "attempts", done.id);
  const author = JSON.parse(fs.readFileSync(path.join(evidence, "workers", "author-ui-author", "command-0.json"), "utf8"));
  assert.equal(author.input.agent, "frontend-worker");
  const report = fs.readFileSync(path.join(evidence, done.progressFile), "utf8");
  assert.match(report, /MOCK \(no model calls\)/);
  assert.match(report, /ui \/ frontend-worker \/ merged/);
  assert.match(report, /Product acceptance: pending/);
	const repair = writePlan(repo, plan(repo, [{ ...task("repair", "src/repair.ts"), agent: "repair-worker" }]));
	assert.equal(output(run(["validate", repair, "--lab-root", root])).tasks[0].agent, "repair-worker");
  const bad = writePlan(repo, plan(repo, [{ ...ui, agent: "experience-reviewer" }]));
  assert.match(run(["validate", bad, "--lab-root", root]).stderr.toString(), /PLAN_AGENT/);
});

test("progress preserves dependency maturity and stopped state without treating planned paths as real", () => {
  const tasks = [
    { id: "base", agent: "sonic", writePaths: ["src/base.ts"], sharedResources: [], dependsOn: [] },
    { id: "ui", agent: "frontend-worker", writePaths: ["src/ui.ts"], sharedResources: [], dependsOn: [{ taskId: "base", maturity: "integrated" }] },
  ];
  const report = taskProgress("example", "D:/lab", tasks, new Map([["base", "claimed"], ["ui", "planned"]]), "stopped", false);
  assert.match(report, /Execution: stopped/);
  assert.match(report, /t0 -->\|integrated\| t1/);
  assert.match(report, /ui \/ frontend-worker \/ planned/);
  assert.match(report, /planned paths may not exist/);
  assert.match(report, /failure.json/);
});

test("continuous dispatch refills while an unrelated author is slow and resolves verified commits before claim", { timeout: 120_000 }, () => {
	const repo = project("continuous"), tasks = [task("aslow", "src/slow.ts"), task("fast", "src/shared", [], ["lock"]), task("child", "src/shared", [{ taskId: "fast", maturity: "verified_commit" }]), task("peer", "src/peer.ts", [{ taskId: "fast", maturity: "verified_commit" }], ["lock"])], done = output(run(["run", writePlan(repo, plan(repo, tasks)), "--lab-root", root, "--concurrency", "2", "--mock-executor"], { OMP_AUTOMATION_TEST_GUARD: "aslow:wait-for:child" })), evidence = path.join(root, "automation", "attempts", done.id), events = fs.readFileSync(path.join(evidence, "scheduler-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const at = (event: string, taskId: string) => events.findIndex((item: any) => item.event === event && item.taskId === taskId);
	for (const index of [at("author-dispatched", "child"), at("author-dispatched", "peer"), at("delivered", "fast"), at("delivered", "aslow"), at("merge-started", "fast"), at("merged", "fast")]) assert.ok(index >= 0);
	assert.ok(at("author-dispatched", "child") > at("delivered", "fast"));
	assert.ok(at("author-dispatched", "child") < at("delivered", "aslow"));
	assert.ok(at("author-dispatched", "child") < at("merge-started", "fast"));
	assert.ok(at("author-dispatched", "child") < at("merged", "fast"));
	assert.ok(at("author-dispatched", "peer") > at("merged", "fast"));
	assert.ok(events.every((item: any) => item.activeAuthors <= 2));
	const merges = events.filter((item: any) => item.event === "merge-started" || item.event === "merged"); for (let index = 1; index < merges.length; index++) if (merges[index].event === "merge-started") assert.equal(merges[index - 1].event, "merged");
	const delivered = JSON.parse(fs.readFileSync(path.join(evidence, "workers", "author-fast-deliver", "command-0.json"), "utf8")).result.verifiedCommit;
	assert.equal(gitOk(path.join(evidence, "worktrees", "child"), ["merge-base", "--is-ancestor", delivered, "HEAD"]), true);
	assert.ok(at("dependency-resolved", "child") >= 0);
	assert.equal(fs.readdirSync(path.join(evidence, "workers")).some(name => name.includes("-gates")), false);
});

test("scope/resource conflicts remain isolated, candidate checks are real, and failure latches then drains", { timeout: 120_000 }, () => {
	const repo = project("isolation"), isolated = output(run(["run", writePlan(repo, plan(repo, [task("alpha", "src/shared.ts", [], ["schema"]), task("beta", "src/shared.ts", [], ["schema"]), task("pathpeer", "src/shared.ts")])), "--lab-root", root, "--concurrency", "3", "--mock-executor"])), evidence = path.join(root, "automation", "attempts", isolated.id), events = fs.readFileSync(path.join(evidence, "scheduler-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const event = (kind: string, id: string) => events.findIndex((item: any) => item.event === kind && item.taskId === id);
	assert.ok(event("author-dispatched", "beta") > event("merged", "alpha"));
	assert.ok(event("author-dispatched", "pathpeer") > event("merged", "beta"));
	const candidateRepo = project("candidate-fail"), candidateTask = task("candidate", "src/candidate.ts", [], [], ["bun", "-e", "process.exit(process.cwd().includes('candidates') ? 1 : 0)"]), beforeCandidates = new Set(fs.readdirSync(path.join(root, "automation", "attempts"))), candidateRun = run(["run", writePlan(candidateRepo, plan(candidateRepo, [candidateTask])), "--lab-root", root, "--mock-executor"]); assert.notEqual(candidateRun.exitCode, 0); const candidateAttempt = fs.readdirSync(path.join(root, "automation", "attempts")).find(id => !beforeCandidates.has(id))!, candidateCheck = JSON.parse(fs.readFileSync(path.join(root, "automation", "attempts", candidateAttempt, "workers", `candidate-candidate-${candidateAttempt}-candidate-merge-candidate-check-check`, "command-0.json"), "utf8")); assert.equal(candidateCheck.input.action, "run_check"); assert.equal(candidateCheck.result.ok, false);
	const failureRepo = project("failure"), failurePlan = writePlan(failureRepo, plan(failureRepo, [task("aslow", "src/slow.ts"), task("zbad", "src/bad.ts", [], [], ["bun", "-e", "process.exit(1)"]), task("zpending", "src/pending.ts")])), beforeFailures = new Set(fs.readdirSync(path.join(root, "automation", "attempts"))), failure = run(["run", failurePlan, "--lab-root", root, "--concurrency", "2", "--mock-executor"], { OMP_AUTOMATION_TEST_GUARD: "aslow:delay" }); assert.notEqual(failure.exitCode, 0); const failureAttempt = fs.readdirSync(path.join(root, "automation", "attempts")).find(id => !beforeFailures.has(id))!, record = JSON.parse(fs.readFileSync(path.join(root, "automation", "attempts", failureAttempt, "failure.json"), "utf8")), failureEvents = fs.readFileSync(path.join(root, "automation", "attempts", failureAttempt, "scheduler-events.jsonl"), "utf8"); assert.equal(record.states.zpending, "planned"); assert.equal(record.states.aslow, "delivered"); assert.match(failureEvents, /dispatch-latched/);
});

test("candidate-only setup uses its argv before the frozen check and keeps a durable receipt (mock authors; real Git/controller/check/setup)", { timeout: 120_000 }, () => {
	const repo = project("candidate-setup-success");
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
	fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ private: true, devDependencies: { fixture: "1.0.0" } }) + "\n");
	git(repo, ["add", ".gitignore", "package.json"]); git(repo, ["commit", "-m", "dependency manifest"]);
	const check = [process.execPath, "-e", "if(process.cwd().includes('candidates')&&!require('node:fs').existsSync('node_modules/.candidate-setup'))process.exit(1)"];
	const sentinel = "candidate-setup-secret-sentinel", setup = [process.execPath, "-e", `require('node:fs').mkdirSync('node_modules',{recursive:true});require('node:fs').writeFileSync('node_modules/.candidate-setup','ready');process.stdout.write('{\"token\":\"'+'x'.repeat(8190));process.stdout.write('${sentinel}\"\\n');console.log('candidate setup complete')`];
	const done = output(run(["run", writePlan(repo, { ...plan(repo, [task("setup", "src/setup.ts", [], [], check)]), candidateSetupCommand: setup }), "--lab-root", root, "--mock-executor"]));
	const evidence = path.join(root, "automation", "attempts", done.id), receipt = JSON.parse(fs.readFileSync(path.join(evidence, "candidate-preparation", "setup.json"), "utf8"));
	assert.equal(receipt.outcome, "passed");
	assert.deepEqual(receipt.command, setup);
	assert.equal(receipt.cwd, path.join(evidence, "candidates", "setup"));
	assert.equal(receipt.process.exitCode, 0);
	assert.equal(receipt.integrity.source, true);
	assert.equal(receipt.integrity.lockfiles, true);
	assert.match(receipt.diagnostics.stdout.text, /line omitted/);
	assert.equal(receipt.diagnostics.stdout.text.includes(sentinel), false);
	assert.ok(fs.existsSync(path.join(evidence, "candidates", "setup", "node_modules", ".candidate-setup")));
	assert.equal(fs.existsSync(path.join(evidence, "worktrees", "setup", "node_modules", ".candidate-setup")), false);
});

test("candidate setup failure and lockfile mutation stop before the frozen check while retaining the candidate receipt", { timeout: 120_000 }, () => {
	const failedRepo = project("candidate-setup-failure");
	fs.writeFileSync(path.join(failedRepo, "package.json"), JSON.stringify({ private: true, dependencies: { fixture: "1.0.0" } }) + "\n"); git(failedRepo, ["add", "package.json"]); git(failedRepo, ["commit", "-m", "dependency manifest"]);
	const failures = new Set(fs.readdirSync(path.join(root, "automation", "attempts")));
	const failed = run(["run", writePlan(failedRepo, { ...plan(failedRepo, [task("install", "src/install.ts")]), candidateSetupCommand: [process.execPath, "-e", "process.stderr.write('install failed');process.exit(17)"] }), "--lab-root", root, "--mock-executor"]);
	assert.notEqual(failed.exitCode, 0);
	const failedId = fs.readdirSync(path.join(root, "automation", "attempts")).find(id => !failures.has(id))!, failedEvidence = path.join(root, "automation", "attempts", failedId), failedReceipt = JSON.parse(fs.readFileSync(path.join(failedEvidence, "candidate-preparation", "install.json"), "utf8"));
	assert.equal(failedReceipt.outcome, "failed");
	assert.equal(failedReceipt.process.exitCode, 17);
	assert.match(failedReceipt.error.code, /CANDIDATE_SETUP_EXIT_CODE:17/);
	assert.ok(fs.existsSync(path.join(failedEvidence, "candidates", "install", ".git")));
	assert.equal(fs.existsSync(path.join(failedEvidence, "workers", `candidate-install-${failedId}-install-merge-candidate-check-check`)), false);

	const lockRepo = project("candidate-setup-lock");
	fs.writeFileSync(path.join(lockRepo, "bun.lock"), "lock-v1\n"); git(lockRepo, ["add", "bun.lock"]); git(lockRepo, ["commit", "-m", "lockfile"]);
	const lockBefore = fs.readFileSync(path.join(lockRepo, "bun.lock"), "utf8"), known = new Set(fs.readdirSync(path.join(root, "automation", "attempts")));
	const lock = run(["run", writePlan(lockRepo, { ...plan(lockRepo, [task("lock", "src/lock.ts")]), candidateSetupCommand: [process.execPath, "-e", "require('node:fs').appendFileSync('bun.lock','mutated')"] }), "--lab-root", root, "--mock-executor"]);
	assert.notEqual(lock.exitCode, 0);
	const lockId = fs.readdirSync(path.join(root, "automation", "attempts")).find(id => !known.has(id))!, lockEvidence = path.join(root, "automation", "attempts", lockId), lockReceipt = JSON.parse(fs.readFileSync(path.join(lockEvidence, "candidate-preparation", "lock.json"), "utf8"));
	assert.equal(lockReceipt.outcome, "failed");
	assert.equal(lockReceipt.integrity.lockfiles, false);
	assert.match(lockReceipt.error.code, /CANDIDATE_SETUP_MUTATION/);
	assert.equal(fs.readFileSync(path.join(lockRepo, "bun.lock"), "utf8"), lockBefore);
	assert.match(fs.readFileSync(path.join(lockEvidence, "candidates", "lock", "bun.lock"), "utf8"), /mutated/);

	const workspaceRepo = project("candidate-setup-workspace-missing");
	fs.mkdirSync(path.join(workspaceRepo, "packages", "leaf"), { recursive: true });
	fs.writeFileSync(path.join(workspaceRepo, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }) + "\n");
	fs.writeFileSync(path.join(workspaceRepo, "packages", "leaf", "package.json"), JSON.stringify({ name: "leaf", dependencies: { fixture: "1.0.0" } }) + "\n");
	git(workspaceRepo, ["add", "package.json", "packages/leaf/package.json"]); git(workspaceRepo, ["commit", "-m", "workspace manifest"]);
	const workspaceTargetHead = git(workspaceRepo, ["rev-parse", "HEAD"]), workspaceKnown = new Set(fs.readdirSync(path.join(root, "automation", "attempts")));
	const workspace = run(["run", writePlan(workspaceRepo, plan(workspaceRepo, [task("workspace", "src/workspace.ts")])), "--lab-root", root, "--mock-executor"]);
	assert.notEqual(workspace.exitCode, 0);
	const workspaceId = fs.readdirSync(path.join(root, "automation", "attempts")).find(id => !workspaceKnown.has(id))!, workspaceEvidence = path.join(root, "automation", "attempts", workspaceId), workspaceReceipt = JSON.parse(fs.readFileSync(path.join(workspaceEvidence, "candidate-preparation", "workspace.json"), "utf8"));
	assert.equal(workspaceReceipt.dependency.reason, "ROOT_PACKAGE_WORKSPACES");
	assert.match(workspaceReceipt.error.code, /CANDIDATE_SETUP_COMMAND_REQUIRED/);
	assert.equal(git(workspaceRepo, ["rev-parse", "HEAD"]), workspaceTargetHead);
	assert.equal(fs.existsSync(path.join(workspaceEvidence, "workers", `candidate-workspace-${workspaceId}-workspace-merge-candidate-check-check`)), false);
});

test("a claim admitted after the latch is cancelled with its evidence retained", { timeout: 90_000 }, () => {
	const repo = project("claim-race"), before = new Set(fs.readdirSync(path.join(root, "automation", "attempts"))), failed = run(["run", writePlan(repo, plan(repo, [task("afail", "src/fail.ts", [], [], ["bun", "-e", "process.exit(1)"]), task("bclaim", "src/claim.ts")])), "--lab-root", root, "--concurrency", "2", "--mock-executor"], { OMP_AUTOMATION_TEST_GUARD: "bclaim:claim-wait-for-latch" });
	assert.notEqual(failed.exitCode, 0);
	const id = fs.readdirSync(path.join(root, "automation", "attempts")).find(candidate => !before.has(candidate))!, evidence = path.join(root, "automation", "attempts", id), failure = JSON.parse(fs.readFileSync(path.join(evidence, "failure.json"), "utf8"));
	assert.equal(failure.states.bclaim, "cancelled");
	assert.equal(failure.neverDispatchedReconciliation[0].taskId, "bclaim");
	assert.equal(failure.neverDispatchedReconciliation[0].state, "cancelled");
	assert.deepEqual(failure.unsettledClaimedTaskIds, ["afail"]);
	assert.equal(fs.existsSync(path.join(evidence, "workers", "author-bclaim-author")), false);
	assert.match(fs.readFileSync(path.join(evidence, "scheduler-events.jsonl"), "utf8"), /claimed-reconciled/);
});

test("normal validation leaves production untouched and mock guards preserve unsafe evidence", { timeout: 90_000 }, () => {
	const repo = project("normal"), file = writePlan(repo, plan(repo, [task("a", "src/a.ts")])); const db = `${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/orchestration.sqlite`, dbFingerprint = () => [db, `${db}-wal`, `${db}-shm`].map(file => fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null), before = dbFingerprint(); output(run(["validate", file, "--normal"], { OMP_AMBIENT_LAB_ROOT: "" })); assert.deepEqual(dbFingerprint(), before); const ambient = run(["validate", file, "--normal"], { OMP_AMBIENT_LAB_ROOT: root }); assert.notEqual(ambient.exitCode, 0); assert.match(ambient.stderr.toString(), /NORMAL_AMBIENT_LAB_ENV_REJECTED/);
	const outside = writePlan("D:/omp-automation-outside-not-a-repo", plan("D:/omp-automation-outside-not-a-repo", [task("a", "src/a.ts")])), outsideRun = run(["validate", outside, "--lab-root", root]); assert.notEqual(outsideRun.exitCode, 0); assert.match(outsideRun.stderr.toString(), /targetRepo:OUTSIDE_LAB/);
	for (const guard of ["a:scope", "a:history"]) { const guarded = project(`guard-${guard.replace(":", "-")}`), guardedPlan = writePlan(guarded, plan(guarded, [task("a", "src/a.ts")])); const guardedRun = run(["run", guardedPlan, "--lab-root", root, "--mock-executor"], { OMP_AUTOMATION_TEST_GUARD: guard }); assert.notEqual(guardedRun.exitCode, 0); assert.match(guardedRun.stderr.toString(), guard.endsWith("scope") ? /AUTHOR_SCOPE_VIOLATION:a/ : /AUTHOR_CHANGED_HISTORY:a/); }
	const nativeRepo = project("guard-native"), nativePlan = writePlan(nativeRepo, plan(nativeRepo, [task("a", "src/a.ts")])), nativeHead = git(nativeRepo, ["rev-parse", "HEAD"]), attemptRoot = path.join(root, "automation", "attempts"), known = new Set(fs.readdirSync(attemptRoot)); const nativeRun = run(["run", nativePlan, "--lab-root", root, "--mock-executor"], { OMP_AUTOMATION_TEST_GUARD: "a:native" }); assert.notEqual(nativeRun.exitCode, 0); assert.match(nativeRun.stderr.toString(), /CONTROLLER_NEGATIVE_RESULT:project_spawn/); const nativeId = fs.readdirSync(attemptRoot).find(id => !known.has(id))!, nativeAttempt = path.join(attemptRoot, nativeId), nativeFailure = JSON.parse(fs.readFileSync(path.join(nativeAttempt, "failure.json"), "utf8")); assert.equal(nativeFailure.states.a, "claimed"); assert.equal(git(path.join(nativeAttempt, "worktrees", "a"), ["rev-parse", "HEAD"]), nativeHead); assert.equal(fs.readdirSync(path.join(nativeAttempt, "workers")).some(name => name.includes("-gates")), false); const nativeLedger = JSON.parse(fs.readFileSync(path.join(nativeAttempt, "durable-receipt-ledger.json"), "utf8")); assert.equal(nativeLedger.receipts.some((receipt: any) => receipt.gate !== null), false);
	const cased = project("case"), casePlan = writePlan(cased, plan(cased, [task("a", "src/foo.ts")])); assert.equal(run(["run", casePlan, "--lab-root", root, "--mock-executor"], { OMP_AUTOMATION_TEST_GUARD: "a:case" }).exitCode, 0);
});
