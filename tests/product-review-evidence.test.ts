import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import productReview from "../omp/agent/extensions/product-review.ts";
import { PRODUCT_REVIEW_ENTRY, captureProductSnapshot, findNativeProductReview, observedDispatchModel, reviewSchemaForSnapshot, validateProductReview } from "../omp/agent/lib/product-review-evidence.ts";

const fixtureRoot = path.join("D:/Labs/omp/pm-a-dual-review-20260924-01", "test-product-review", crypto.randomUUID());
const productDir = path.join(fixtureRoot, "docs", "product");
fs.mkdirSync(productDir, { recursive: true });
fs.writeFileSync(path.join(productDir, "PRD.md"), "# Product\nReview status: complete and reviewable\nA retained product rule.\n");
fs.writeFileSync(path.join(productDir, "research.md"), "# Research\nA source-backed observation.\n");
fs.writeFileSync(path.join(productDir, "decisions.md"), "# Decisions\nSol selected one boundary.\n");

function data(snapshot: ReturnType<typeof captureProductSnapshot>) {
	const prd = snapshot.documents.find(document => document.key === "prd")!;
	return { status: "FAIL", summary: "One concrete handoff gap remains.", snapshotId: snapshot.snapshotId, manifestSha256: snapshot.manifestSha256,
		findings: [{ id: "R1", classification: "decision-needed", severity: "P1", evidence: [{ artifactPath: prd.relativePath, artifactSha256: prd.sha256, quote: "A retained product rule." }], consequence: "A later author could choose an incompatible behavior.", minimumCorrection: "Freeze the business outcome." }] };
}

test("snapshot binds required files and exact multi-document findings", () => {
	const snapshot = captureProductSnapshot(fixtureRoot, "snapshot-a");
	expect(snapshot.documents.map(document => document.key)).toEqual(["prd", "research", "decisions"]);
	expect(validateProductReview(snapshot, data(snapshot))).toEqual({ verdict: "FAIL", errors: [] });
	const badQuote = data(snapshot); badQuote.findings[0].evidence[0].quote = "invented words";
	expect(validateProductReview(snapshot, badQuote).errors).toContain("REVIEW_FINDING_QUOTE_INVALID");
	const badHash = data(snapshot); badHash.findings[0].evidence[0].artifactSha256 = "0".repeat(64);
	expect(validateProductReview(snapshot, badHash).errors).toContain("REVIEW_FINDING_ARTIFACT_INVALID");
	const schema = reviewSchemaForSnapshot(snapshot) as any;
	expect(schema.properties.snapshotId.enum).toEqual([snapshot.snapshotId]);
	expect(schema.properties.manifestSha256.enum).toEqual([snapshot.manifestSha256]);
	const evidenceProperties = schema.properties.findings.items.properties.evidence.items.properties;
	expect(evidenceProperties.artifactPath.enum).toEqual(snapshot.documents.map(document => document.relativePath));
	expect(evidenceProperties.artifactSha256.enum).toEqual(snapshot.documents.map(document => document.sha256));
});

test("snapshot rejects a nonempty but incomplete PRD", () => {
	const incompleteRoot = path.join("D:/Labs/omp/pm-a-dual-review-20260924-01", "test-product-review", crypto.randomUUID());
	fs.mkdirSync(path.join(incompleteRoot, "docs", "product"), { recursive: true });
	fs.writeFileSync(path.join(incompleteRoot, "docs", "product", "PRD.md"), "# Draft\nNot empty.\n");
	fs.writeFileSync(path.join(incompleteRoot, "docs", "product", "research.md"), "# Research\nPresent.\n");
	expect(() => captureProductSnapshot(incompleteRoot)).toThrow("PRODUCT_REVIEW_PRD_INCOMPLETE");
});

test("native receipt extraction accepts one real-shaped sync or hub result and rejects repeated names", () => {
	const snapshot = captureProductSnapshot(fixtureRoot, "snapshot-b");
	const sync = [{ type: "custom", customType: PRODUCT_REVIEW_ENTRY, data: { kind: "snapshot", snapshot } },
		{ type: "custom", customType: PRODUCT_REVIEW_ENTRY, data: { kind: "launch", reviewer: "product-reviewer", taskName: "bmad", callId: "call" } },
		{ type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "call", details: { results: [{ id: "sync", agent: "product-reviewer", exitCode: 0, resolvedModelIdentity: "openai-codex/gpt-5.6-terra", resolvedThinkingLevel: "high", structuredOutput: { status: "valid", data: data(snapshot) } }] } } }];
	expect(findNativeProductReview(sync, 0, "product-reviewer", "bmad")).toMatchObject({ state: "completed", taskId: "sync" });
	const hub = [{ type: "custom", customType: PRODUCT_REVIEW_ENTRY, data: { kind: "snapshot", snapshot } },
		{ type: "custom", customType: PRODUCT_REVIEW_ENTRY, data: { kind: "launch", reviewer: "product-rules-reviewer", taskName: "rules", callId: "call" } },
		{ type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "call", details: { async: { jobId: "job" }, progress: [{ id: "child", agent: "product-rules-reviewer" }], results: [] } } },
		{ type: "message", content: "", message: { role: "toolResult", toolName: "hub", details: { jobs: [{ id: "job", type: "task", status: "completed", resolvedModelIdentity: "openai-codex/gpt-5.6-terra", resolvedThinkingLevel: "high", resultText: '<task-result id="child" agent="product-rules-reviewer" status="completed"></task-result>', structured: { status: "valid", data: data(snapshot) } }] } } }];
	expect(findNativeProductReview(hub, 0, "product-rules-reviewer", "rules")).toMatchObject({ state: "completed", jobId: "job", envelopeStatus: "completed" });
	expect(findNativeProductReview([...hub, hub.at(-1)], 0, "product-rules-reviewer", "rules")).toMatchObject({ state: "completed", jobId: "job" });
	const autoDelivery = [...hub.slice(0, 3), { type: "custom_message", customType: "async-result", content: '<task-result id="child" agent="product-rules-reviewer" status="completed"></task-result>', details: { jobs: [{ jobId: "job", schema: { status: "valid", data: data(snapshot) }, resolvedModelIdentity: "openai-codex/gpt-5.6-terra", resolvedThinkingLevel: "high" }] } }];
	expect(findNativeProductReview(autoDelivery, 0, "product-rules-reviewer", "rules")).toMatchObject({ state: "completed", jobId: "job", envelopeStatus: "completed" });
	const enrichedThenSparse = [...hub, { type: "custom_message", customType: "async-result", content: '<task-result id="child" agent="product-rules-reviewer" status="completed"></task-result>', details: { jobs: [{ jobId: "job", schema: { status: "valid", data: data(snapshot) } }] } }];
	expect(findNativeProductReview(enrichedThenSparse, 0, "product-rules-reviewer", "rules")).toMatchObject({ modelIdentity: "openai-codex/gpt-5.6-terra", thinkingLevel: "high" });
	const conflictingDelivery = [...hub, { type: "custom_message", customType: "async-result", content: '<task-result id="child" agent="product-rules-reviewer" status="completed"></task-result>', details: { jobs: [{ jobId: "job", schema: { status: "valid", data: data(snapshot) }, resolvedModelIdentity: "other/provider", resolvedThinkingLevel: "high" }] } }];
	expect(findNativeProductReview(conflictingDelivery, 0, "product-rules-reviewer", "rules")).toMatchObject({ modelIdentity: "other/provider", modelConflict: true });
	const noticeBoundAuto = [...hub.slice(0, 3), { type: "custom_message", customType: "omp-task-model-dispatch-v1", details: { source: "native", id: "child", agent: "product-rules-reviewer", modelIdentity: "openai-codex/gpt-5.6-terra", thinkingLevel: "high" } }, { type: "custom_message", customType: "async-result", content: '<task-result id="child" agent="product-rules-reviewer" status="completed"></task-result>', details: { jobs: [{ jobId: "job", schema: { status: "valid", data: data(snapshot) } }] } }];
	expect(findNativeProductReview(noticeBoundAuto, 0, "product-rules-reviewer", "rules")).toMatchObject({ modelIdentity: "openai-codex/gpt-5.6-terra", thinkingLevel: "high" });
	const duplicate = [...sync, { type: "custom", customType: PRODUCT_REVIEW_ENTRY, data: { kind: "launch", reviewer: "product-reviewer", taskName: "bmad", callId: "again" } }];
	expect(findNativeProductReview(duplicate, 0, "product-reviewer", "bmad")).toMatchObject({ state: "ambiguous" });
	const fallback = [{ type: "custom", customType: PRODUCT_REVIEW_ENTRY, data: { kind: "snapshot", snapshot } }, { type: "custom", customType: PRODUCT_REVIEW_ENTRY, data: { kind: "launch", reviewer: "product-reviewer", taskName: "fallback", callId: "fallback" } }, { type: "custom_message", customType: "omp-task-model-dispatch-v1", content: "子任务模型状态更新：任务「fallback」；代理 product-reviewer；实际模型 openai-codex/gpt-5.6-terra；思考强度 high。" }];
	expect(observedDispatchModel(fallback, 0, "product-reviewer")).toEqual({ modelIdentity: "openai-codex/gpt-5.6-terra", thinkingLevel: "high" });
});

test("extension retains invalid checks and binds a check to the actual task result", async () => {
	const branch: any[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let tool: any;
	const chain = { max() { return this; }, optional() { return this; } };
	const pi = { zod: { object: () => ({ strict: () => ({}) }), enum: () => chain, string: () => chain }, on: (name: string, handler: any) => handlers.set(name, handler), appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }), registerTool: (value: unknown) => { tool = value; } } as any;
	const ctx = { cwd: fixtureRoot, sessionManager: { getSessionId: () => "root", getEntries: () => branch, getBranch: () => branch } };
	productReview(pi);
	const missing = await tool.execute("missing", { action: "check", snapshotId: "none", reviewer: "product-reviewer", taskName: "bmad" }, new AbortController().signal, undefined, ctx);
	expect(missing.details.mechanicalStatus).toBe("INVALID");
	expect(branch.at(-1).data.kind).toBe("check");
	const snapped = await tool.execute("snapshot", { action: "snapshot" }, new AbortController().signal, undefined, ctx);
	const snapshot = snapped.details.snapshot;
	const originalTask = "Review the supplied product documents for handoff gaps.";
	const call = handlers.get("tool_call")!({ toolName: "task", toolCallId: "call", input: { agent: "product-reviewer", name: "bmad", task: originalTask } }, ctx);
	expect(call.input.outputSchema).toBeDefined();
	expect(call.input.task).toBe(`${originalTask}\n\nRuntime snapshot document identities: ${JSON.stringify(snapshot.documents.map((document: any) => ({ artifactPath: document.relativePath, artifactSha256: document.sha256 })) )}`);
	const weakenedSchema = structuredClone(call.input.outputSchema);
	delete weakenedSchema.properties.findings.items.additionalProperties;
	expect(handlers.get("tool_call")!({ toolName: "task", toolCallId: "weakened", input: { agent: "product-reviewer", name: "weakened", outputSchema: weakenedSchema } }, ctx)).toMatchObject({ block: true, reason: "PRODUCT_REVIEW_SCHEMA: omit outputSchema to install this snapshot's contract automatically, or pass the returned reviewSchema unchanged; do not reconstruct it." });
	const reorderedSchema = { ...call.input.outputSchema, properties: Object.fromEntries(Object.entries(call.input.outputSchema.properties).reverse()) };
	expect(handlers.get("tool_call")!({ toolName: "task", toolCallId: "reordered", input: { agent: "product-reviewer", name: "reordered", outputSchema: reorderedSchema } }, ctx).input.schemaMode).toBe("strict");
	branch.push({ type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "call", details: { results: [{ id: "done", agent: "product-reviewer", exitCode: 0, resolvedModelIdentity: "openai-codex/gpt-5.6-terra", resolvedThinkingLevel: "high", structuredOutput: { status: "valid", data: data(snapshot) } }] } } });
	const checked = await tool.execute("check", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-reviewer", taskName: "bmad", previousAttemptId: missing.details.attemptId }, new AbortController().signal, undefined, ctx);
	expect(checked.details).toMatchObject({ mechanicalStatus: "VALID", reviewStatus: "FAIL" });
	const noModel = handlers.get("tool_call")!({ toolName: "task", toolCallId: "no-model", input: { agent: "product-rules-reviewer", name: "rules-no-model" } }, ctx);
	expect(noModel.input.outputSchema.properties.snapshotId.enum).toEqual([snapshot.snapshotId]);
	branch.push({ type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "no-model", details: { async: { jobId: "no-model-job" }, progress: [{ id: "no-model", agent: "product-rules-reviewer" }], results: [] } } });
	branch.push({ type: "custom_message", customType: "async-result", content: '<task-result id="no-model" agent="product-rules-reviewer" status="completed"></task-result>', details: { jobs: [{ jobId: "no-model-job", schema: { status: "valid", data: data(snapshot) } }] } });
	const unconfirmed = await tool.execute("unconfirmed", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-rules-reviewer", taskName: "rules-no-model" }, new AbortController().signal, undefined, ctx);
	expect(unconfirmed.details).toMatchObject({ mechanicalStatus: "INVALID", reason: "PRODUCT_REVIEW_MODEL_UNCONFIRMED", modelStatus: "INCONCLUSIVE", recoveryHint: "Collect a settled hub snapshot for native.jobId, then recheck this existing task with previousAttemptId; do not respawn solely for missing model metadata." });
	const launchesBeforeEnrichedRecheck = branch.filter(entry => entry.type === "custom" && entry.customType === PRODUCT_REVIEW_ENTRY && entry.data?.kind === "launch").length;
	branch.push({ type: "message", message: { role: "toolResult", toolName: "hub", details: { jobs: [{ id: "no-model-job", type: "task", status: "completed", resolvedModelIdentity: "openai-codex/gpt-5.6-terra", resolvedThinkingLevel: "high", resultText: '<task-result id="no-model" agent="product-rules-reviewer" status="completed"></task-result>', structured: { status: "valid", data: data(snapshot) } }] } } });
	const enriched = await tool.execute("enriched", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-rules-reviewer", taskName: "rules-no-model", previousAttemptId: unconfirmed.details.attemptId }, new AbortController().signal, undefined, ctx);
	expect(enriched.details).toMatchObject({ mechanicalStatus: "VALID", reviewStatus: "FAIL", modelStatus: "CONFIRMED", previousAttemptId: unconfirmed.details.attemptId });
	expect(branch.filter(entry => entry.type === "custom" && entry.customType === PRODUCT_REVIEW_ENTRY && entry.data?.kind === "launch")).toHaveLength(launchesBeforeEnrichedRecheck);
	const noticeBound = handlers.get("tool_call")!({ toolName: "task", toolCallId: "notice-bound", input: { agent: "product-rules-reviewer", name: "rules-notice-bound" } }, ctx);
	branch.push({ type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "notice-bound", details: { async: { jobId: "notice-bound-job" }, progress: [{ id: "notice-bound", agent: "product-rules-reviewer" }], results: [] } } });
	branch.push({ type: "custom_message", customType: "omp-task-model-dispatch-v1", details: { source: "native", id: "notice-bound", agent: "product-rules-reviewer", modelIdentity: "openai-codex/gpt-5.6-terra", thinkingLevel: "high" } });
	branch.push({ type: "custom_message", customType: "async-result", content: '<task-result id="notice-bound" agent="product-rules-reviewer" status="completed"></task-result>', details: { jobs: [{ jobId: "notice-bound-job", schema: { status: "valid", data: data(snapshot) } }] } });
	const noticeChecked = await tool.execute("notice-bound", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-rules-reviewer", taskName: "rules-notice-bound" }, new AbortController().signal, undefined, ctx);
	expect(noticeChecked.details).toMatchObject({ mechanicalStatus: "VALID", modelStatus: "CONFIRMED", reviewStatus: "FAIL" });
	const malformed = handlers.get("tool_call")!({ toolName: "task", toolCallId: "malformed", input: { agent: "product-rules-reviewer", name: "rules-malformed" } }, ctx);
	branch.push({ type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "malformed", details: { results: [{ id: "malformed", agent: "product-rules-reviewer", exitCode: 0, resolvedModelIdentity: "openai-codex/gpt-5.6-terra", resolvedThinkingLevel: "high", structuredOutput: { status: "valid", data: { ...data(snapshot), findings: "not-an-array" } } }] } } });
	const parseFailure = await tool.execute("malformed", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-rules-reviewer", taskName: "rules-malformed" }, new AbortController().signal, undefined, ctx);
	expect(parseFailure.details).toMatchObject({ mechanicalStatus: "INVALID", reason: "PRODUCT_REVIEW_OUTPUT_INVALID" });
	const badRetry = await tool.execute("retry", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-reviewer", taskName: "bmad", previousAttemptId: "missing-attempt" }, new AbortController().signal, undefined, ctx);
	expect(badRetry.details).toMatchObject({ mechanicalStatus: "INVALID", reason: "PRODUCT_REVIEW_PREVIOUS_ATTEMPT_UNKNOWN" });
	const copiedRoot = path.join("D:/Labs/omp/pm-a-dual-review-20260924-01", "test-product-review", crypto.randomUUID());
	fs.cpSync(fixtureRoot, copiedRoot, { recursive: true });
	ctx.cwd = copiedRoot;
	const wrongRoot = await tool.execute("root", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-reviewer", taskName: "bmad" }, new AbortController().signal, undefined, ctx);
	expect(wrongRoot.details).toMatchObject({ mechanicalStatus: "INVALID", reason: "PRODUCT_REVIEW_SNAPSHOT_ROOT_MISMATCH" });
	ctx.cwd = fixtureRoot;
	fs.appendFileSync(path.join(productDir, "PRD.md"), "changed\n");
	const stale = await tool.execute("stale", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-reviewer", taskName: "bmad" }, new AbortController().signal, undefined, ctx);
	expect(stale.details.mechanicalStatus).toBe("STALE");
	branch.push({ id: "new-task-start", type: "message", message: { role: "user", content: "A new task starts." } });
	branch.push({ type: "custom", customType: "omp-continuity-v1", data: { taskStartId: "new-task-start" } });
	const reset = await tool.execute("reset", { action: "check", snapshotId: snapshot.snapshotId, reviewer: "product-reviewer", taskName: "bmad" }, new AbortController().signal, undefined, ctx);
	expect(reset.details).toMatchObject({ mechanicalStatus: "INVALID", reason: "PRODUCT_REVIEW_CHECK_INPUT_INVALID" });
	const evidencePath = path.join(fixtureRoot, "product-review-synthetic-check-records.json");
	fs.writeFileSync(evidencePath, JSON.stringify({ schema: "omp-product-review-test-evidence/v1", synthetic: true, source: "tests/product-review-evidence.test.ts", branch }, null, 2));
	expect(fs.statSync(evidencePath).size).toBeGreaterThan(0);
});
