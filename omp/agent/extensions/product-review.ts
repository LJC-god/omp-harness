import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { PRODUCT_REVIEW_ENTRY, PRODUCT_REVIEWERS, captureProductSnapshot, findNativeProductReview, hasSnapshotReviewSchema, observedDispatchModel, reviewSchemaForSnapshot, type MechanicalStatus, type ProductReviewer, type ProductSnapshot, validateProductReview } from "../lib/product-review-evidence.ts";

const isReviewer = (value: unknown): value is ProductReviewer => typeof value === "string" && (PRODUCT_REVIEWERS as readonly string[]).includes(value);
const isRoot = (ctx: ExtensionContext) => !!ctx.sessionManager?.getSessionId() && !ctx.sessionManager.getEntries().some(entry => entry.type === "session_init");
const CONTINUITY_ENTRY = "omp-continuity-v1";
const resultData = (value: unknown) => {
	if (!value || typeof value !== "object") return undefined;
	const output = value as { status?: unknown; data?: unknown };
	return output.status === "valid" ? output.data : undefined;
};
const documentIdentities = (snapshot: ProductSnapshot) => `Runtime snapshot document identities: ${JSON.stringify(snapshot.documents.map(document => ({ artifactPath: document.relativePath, artifactSha256: document.sha256 })))}`;

export default function productReview(pi: ExtensionAPI) {
	const z = pi.zod;
	const entries = (ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch();
		let start = branch.findLastIndex(entry => entry.type === "reset_boundary");
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry: any = branch[index];
			if (entry?.type !== "custom" || entry.customType !== CONTINUITY_ENTRY || typeof entry.data?.taskStartId !== "string") continue;
			const checkpointStart = branch.findIndex(candidate => candidate.id === entry.data.taskStartId);
			if (checkpointStart > start) start = checkpointStart;
			break;
		}
		return branch.slice(start + 1);
	};
	const snapshots = (ctx: ExtensionContext) => entries(ctx).map((entry: any, index: number) => ({ entry, index }))
		.filter(({ entry }: { entry: any }) => entry?.type === "custom" && entry.customType === PRODUCT_REVIEW_ENTRY && entry.data?.sessionId === ctx.sessionManager.getSessionId() && entry.data?.kind === "snapshot");
	const checks = (ctx: ExtensionContext) => entries(ctx).filter((entry: any) => entry?.type === "custom" && entry.customType === PRODUCT_REVIEW_ENTRY && entry.data?.sessionId === ctx.sessionManager.getSessionId() && entry.data?.kind === "check");
	const append = (ctx: ExtensionContext, value: Record<string, unknown>) => pi.appendEntry(PRODUCT_REVIEW_ENTRY, { sessionId: ctx.sessionManager.getSessionId(), ...value });

	pi.on("tool_call", (event: any, ctx: ExtensionContext) => {
		if (!isRoot(ctx) || event.toolName !== "task" || !isReviewer(event.input?.agent)) return;
		if (typeof event.input?.name !== "string" || !event.input.name.trim())
			return { block: true, reason: "PRODUCT_REVIEW_TASK_NAME_REQUIRED: product reviewers require a named native task so omp_product_review can bind the actual receipt." };
		const snapshot = snapshots(ctx).at(-1)?.entry.data?.snapshot as ProductSnapshot | undefined;
		if (!snapshot)
			return { block: true, reason: "PRODUCT_REVIEW_SNAPSHOT_REQUIRED: call omp_product_review snapshot before dispatching a product reviewer." };
		if (event.input.outputSchema !== undefined && !hasSnapshotReviewSchema(event.input.outputSchema, snapshot))
			return { block: true, reason: "PRODUCT_REVIEW_SCHEMA: omit outputSchema to install this snapshot's contract automatically, or pass the returned reviewSchema unchanged; do not reconstruct it." };
		append(ctx, { kind: "launch", attemptId: crypto.randomUUID(), snapshotId: snapshot.snapshotId, reviewer: event.input.agent, taskName: event.input.name, callId: event.toolCallId });
		const task = typeof event.input.task === "string" ? `${event.input.task}\n\n${documentIdentities(snapshot)}` : documentIdentities(snapshot);
		return { input: { ...event.input, task, outputSchema: event.input.outputSchema ?? reviewSchemaForSnapshot(snapshot), schemaMode: "strict" } };
	});

	pi.registerTool({
		name: "omp_product_review", label: "Product review evidence", approval: "read", strict: true,
		description: "Root-only product-document snapshot and native-review receipt check. It reads only docs/product PRD, research, and optional decisions, binds a named product-reviewer native task to its actual current-branch structured result, validates file identities and exact quotes, and retains every outcome. It does not dispatch, approve, or change final product acceptance.",
		parameters: z.object({ action: z.enum(["snapshot", "check"]), snapshotId: z.string().max(128).optional(), reviewer: z.enum(PRODUCT_REVIEWERS).optional(), taskName: z.string().max(600).optional(), previousAttemptId: z.string().max(128).optional() }).strict(),
		async execute(_id: string, input: { action: "snapshot" | "check"; snapshotId?: string; reviewer?: ProductReviewer; taskName?: string; previousAttemptId?: string }, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
			if (!isRoot(ctx)) throw new Error("SUBAGENT_FORBIDDEN: product review evidence belongs to the root session");
			const attemptId = crypto.randomUUID();
			if (input.action === "snapshot") {
				try {
					const snapshot = captureProductSnapshot(ctx.cwd);
					append(ctx, { kind: "snapshot", attemptId, mechanicalStatus: "VALID", snapshot });
					const reviewSchema = reviewSchemaForSnapshot(snapshot);
					return { content: [{ type: "text", text: JSON.stringify({ mechanicalStatus: "VALID", snapshot, reviewSchema }) }], details: { mechanicalStatus: "VALID", snapshot, reviewSchema } };
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					append(ctx, { kind: "snapshot", attemptId, mechanicalStatus: "INVALID", reason });
					return { content: [{ type: "text", text: JSON.stringify({ mechanicalStatus: "INVALID", reason, attemptId }) }], details: { mechanicalStatus: "INVALID", reason, attemptId } };
				}
			}
			let mechanicalStatus: MechanicalStatus = "INVALID";
			const record: Record<string, unknown> = { kind: "check", attemptId, ...(input.previousAttemptId ? { previousAttemptId: input.previousAttemptId } : {}) };
			const source = snapshots(ctx).findLast(({ entry }: { entry: any }) => entry.data?.snapshot?.snapshotId === input.snapshotId);
			if (!source || !isReviewer(input.reviewer) || !input.taskName?.trim()) record.reason = "PRODUCT_REVIEW_CHECK_INPUT_INVALID";
			else {
				const snapshot = source.entry.data.snapshot as ProductSnapshot;
				record.snapshotId = snapshot.snapshotId;
				record.reviewer = input.reviewer;
				record.taskName = input.taskName;
				try {
					const current = captureProductSnapshot(ctx.cwd, snapshot.snapshotId);
					if (current.canonicalRoot !== snapshot.canonicalRoot) {
						record.reason = "PRODUCT_REVIEW_SNAPSHOT_ROOT_MISMATCH";
					} else if (current.manifestSha256 !== snapshot.manifestSha256) {
						mechanicalStatus = "STALE";
						record.reason = "PRODUCT_REVIEW_SNAPSHOT_STALE";
					} else {
						const native = findNativeProductReview(entries(ctx), source.index, input.reviewer, input.taskName);
						record.native = native ?? null;
						if (!native || native.state === "pending") {
							mechanicalStatus = "PENDING";
							record.reason = "PRODUCT_REVIEW_NATIVE_RECEIPT_PENDING";
						} else if (native.state !== "completed" || native.agent !== input.reviewer || (native.envelopeStatus !== undefined && native.envelopeStatus !== "completed")) {
							record.reason = "PRODUCT_REVIEW_NATIVE_RECEIPT_INVALID";
						} else {
							const dispatch = observedDispatchModel(entries(ctx), source.index, input.reviewer);
							const modelIdentity = native.modelIdentity ?? dispatch?.modelIdentity;
							const thinkingLevel = native.thinkingLevel ?? dispatch?.thinkingLevel;
							record.observedModel = { modelIdentity: modelIdentity ?? null, thinkingLevel: thinkingLevel ?? null };
							record.modelStatus = native.modelConflict ? "MISMATCH" : modelIdentity === undefined || thinkingLevel === undefined ? "INCONCLUSIVE"
								: modelIdentity === "openai-codex/gpt-5.6-terra" && thinkingLevel === "high" ? "CONFIRMED" : "MISMATCH";
							if (native.modelConflict || modelIdentity !== "openai-codex/gpt-5.6-terra" || thinkingLevel !== "high") {
								record.reason = "PRODUCT_REVIEW_MODEL_UNCONFIRMED";
								if (record.modelStatus === "INCONCLUSIVE" && native.jobId)
									record.recoveryHint = "Collect a settled hub snapshot for native.jobId, then recheck this existing task with previousAttemptId; do not respawn solely for missing model metadata.";
							} else {
								const review = validateProductReview(snapshot, resultData(native.structured));
								record.reviewStatus = review.verdict ?? null;
								record.errors = review.errors;
								if (!review.errors.length) mechanicalStatus = "VALID";
								else record.reason = "PRODUCT_REVIEW_OUTPUT_INVALID";
							}
						}
					}
				} catch (error) {
					record.reason = error instanceof Error ? error.message : String(error);
				}
			}
			if (input.previousAttemptId && !checks(ctx).some((entry: any) => entry.data?.attemptId === input.previousAttemptId)) {
				mechanicalStatus = "INVALID";
				record.reason = "PRODUCT_REVIEW_PREVIOUS_ATTEMPT_UNKNOWN";
			}
			record.mechanicalStatus = mechanicalStatus;
			append(ctx, record);
			return { content: [{ type: "text", text: JSON.stringify(record) }], details: record };
		},
	});
}
