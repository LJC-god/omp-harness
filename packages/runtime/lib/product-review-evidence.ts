import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const PRODUCT_REVIEW_ENTRY = "omp-product-review-v1";
export const PRODUCT_REVIEWERS = ["product-reviewer", "product-rules-reviewer"] as const;
export type ProductReviewer = (typeof PRODUCT_REVIEWERS)[number];
export type ReviewVerdict = "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
export type MechanicalStatus = "VALID" | "INVALID" | "STALE" | "PENDING";

const DOCUMENTS = [
	{ key: "prd", relativePath: "docs/product/PRD.md", required: true },
	{ key: "research", relativePath: "docs/product/research.md", required: true },
	{ key: "decisions", relativePath: "docs/product/decisions.md", required: false },
] as const;

export type ProductDocument = { key: string; relativePath: string; realPath: string; bytes: number; sha256: string };
export type ProductSnapshot = {
	schema: "omp-product-review-snapshot/v1"; snapshotId: string; canonicalRoot: string; manifestSha256: string;
	documents: ProductDocument[];
};
export type NativeReview = {
	state: "completed" | "failed" | "cancelled" | "pending" | "ambiguous";
	agent?: string; taskId?: string; jobId?: string; taskName: string;
	structured?: unknown; modelIdentity?: string; thinkingLevel?: string; modelConflict?: boolean; envelopeStatus?: string;
};

const digest = (value: Uint8Array | string) => crypto.createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const conflicting = (...values: Array<string | undefined>) => new Set(values.filter((value): value is string => value !== undefined)).size > 1;
const canonicalSchema = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalSchema)
	: isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalSchema(value[key])])) : value;
const rootPath = (cwd: string) => fs.realpathSync(cwd);

function exactFile(root: string, relativePath: string): string {
	const resolved = path.resolve(root, relativePath);
	if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("PRODUCT_REVIEW_PATH_ESCAPE");
	for (let current = path.dirname(resolved); current !== root; current = path.dirname(current)) {
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error("PRODUCT_REVIEW_SYMLINK");
	}
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error("PRODUCT_REVIEW_DOCUMENT_INVALID");
	return resolved;
}

export function captureProductSnapshot(cwd: string, snapshotId = crypto.randomUUID()): ProductSnapshot {
	const root = rootPath(cwd);
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error("PRODUCT_REVIEW_ROOT_SYMLINK");
	const documents: ProductDocument[] = [];
	for (const document of DOCUMENTS) {
		const expected = path.resolve(root, document.relativePath);
		if (!fs.existsSync(expected)) {
			if (document.required) throw new Error(`PRODUCT_REVIEW_DOCUMENT_MISSING:${document.relativePath}`);
			continue;
		}
		const file = exactFile(root, document.relativePath);
		const bytes = fs.readFileSync(file);
		if (document.key === "prd" && !bytes.toString("utf8").includes("Review status: complete and reviewable"))
			throw new Error("PRODUCT_REVIEW_PRD_INCOMPLETE");
		documents.push({ key: document.key, relativePath: document.relativePath, realPath: file, bytes: bytes.byteLength, sha256: digest(bytes) });
	}
	const canonical = documents.map(({ key, relativePath, bytes, sha256 }) => ({ key, relativePath, bytes, sha256 }));
	return { schema: "omp-product-review-snapshot/v1", snapshotId, canonicalRoot: root,
		manifestSha256: digest(JSON.stringify(canonical)), documents };
}

const reviewStatus = (value: unknown): value is ReviewVerdict => typeof value === "string" && ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"].includes(value);
const reviewDocument = (snapshot: ProductSnapshot, relativePath: unknown, sha256: unknown) =>
	typeof relativePath === "string" && typeof sha256 === "string" && snapshot.documents.find(document => document.relativePath === relativePath && document.sha256 === sha256);

export const PRODUCT_DOCUMENT_REVIEW_SCHEMA = {
	type: "object", additionalProperties: false,
	required: ["status", "summary", "snapshotId", "manifestSha256", "findings"],
	properties: {
		status: { type: "string", enum: ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"] },
		summary: { type: "string", minLength: 1, pattern: "\\S" },
		snapshotId: { type: "string", minLength: 1, maxLength: 128 },
		manifestSha256: { type: "string", minLength: 64, maxLength: 64 },
		findings: { type: "array", items: {
			type: "object", additionalProperties: false,
			required: ["id", "classification", "severity", "evidence", "consequence", "minimumCorrection"],
			properties: {
				id: { type: "string", minLength: 1, maxLength: 128 }, classification: { type: "string", enum: ["defect", "decision-needed", "evidence-gap", "optional"] }, severity: { type: "string", enum: ["P0", "P1", "P2", "P3", "INFO"] },
				evidence: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false,
					required: ["artifactPath", "artifactSha256", "quote"], properties: {
						artifactPath: { type: "string", minLength: 1, maxLength: 300 }, artifactSha256: { type: "string", minLength: 64, maxLength: 64 }, quote: { type: "string", minLength: 1 },
					} } },
				consequence: { type: "string", minLength: 1, pattern: "\\S" }, minimumCorrection: { type: "string", minLength: 1, pattern: "\\S" },
			},
		} },
	},
} as const;

export function hasProductReviewSchema(schema: unknown): boolean {
	if (!isRecord(schema) || schema.type !== "object" || schema.additionalProperties !== false || !Array.isArray(schema.required) || !isRecord(schema.properties)) return false;
	return ["status", "summary", "snapshotId", "manifestSha256", "findings"].every(key => schema.required.includes(key) && key in schema.properties);
}

export function reviewSchemaForSnapshot(snapshot: ProductSnapshot): Record<string, unknown> {
	const schema = structuredClone(PRODUCT_DOCUMENT_REVIEW_SCHEMA) as Record<string, unknown>;
	const properties = schema.properties as Record<string, Record<string, unknown>>;
	properties.snapshotId.enum = [snapshot.snapshotId];
	properties.manifestSha256.enum = [snapshot.manifestSha256];
	const evidenceProperties = ((properties.findings as any).items.properties.evidence.items.properties) as Record<string, Record<string, unknown>>;
	evidenceProperties.artifactPath.enum = snapshot.documents.map(document => document.relativePath);
	evidenceProperties.artifactSha256.enum = snapshot.documents.map(document => document.sha256);
	return schema;
}

export function hasSnapshotReviewSchema(schema: unknown, snapshot: ProductSnapshot): boolean {
	return hasProductReviewSchema(schema) && JSON.stringify(canonicalSchema(schema)) === JSON.stringify(canonicalSchema(reviewSchemaForSnapshot(snapshot)));
}

export function validateProductReview(snapshot: ProductSnapshot, data: unknown): { verdict?: ReviewVerdict; errors: string[] } {
	if (!isRecord(data)) return { errors: ["REVIEW_OUTPUT_NOT_OBJECT"] };
	const errors: string[] = [];
	const topLevel = ["status", "summary", "snapshotId", "manifestSha256", "findings"];
	if (Object.keys(data).length !== topLevel.length || !topLevel.every(key => key in data)) errors.push("REVIEW_OUTPUT_SHAPE_INVALID");
	if (!reviewStatus(data.status)) errors.push("REVIEW_STATUS_INVALID");
	if (typeof data.summary !== "string" || !data.summary.trim()) errors.push("REVIEW_SUMMARY_INVALID");
	if (data.snapshotId !== snapshot.snapshotId || data.manifestSha256 !== snapshot.manifestSha256) errors.push("REVIEW_SNAPSHOT_MISMATCH");
	if (!Array.isArray(data.findings)) errors.push("REVIEW_FINDINGS_INVALID");
	else for (const finding of data.findings) {
		if (!isRecord(finding)) { errors.push("REVIEW_FINDING_INVALID"); continue; }
		const findingKeys = ["id", "classification", "severity", "evidence", "consequence", "minimumCorrection"];
		if (Object.keys(finding).length !== findingKeys.length || !findingKeys.every(key => key in finding)) errors.push("REVIEW_FINDING_SHAPE_INVALID");
		if (!Array.isArray(finding.evidence) || finding.evidence.length < 1 || finding.evidence.length > 4) errors.push("REVIEW_FINDING_EVIDENCE_INVALID");
		else for (const evidence of finding.evidence) {
			if (!isRecord(evidence)) { errors.push("REVIEW_FINDING_EVIDENCE_INVALID"); continue; }
			const evidenceKeys = ["artifactPath", "artifactSha256", "quote"];
			if (Object.keys(evidence).length !== evidenceKeys.length || !evidenceKeys.every(key => key in evidence)) errors.push("REVIEW_FINDING_EVIDENCE_INVALID");
			const document = reviewDocument(snapshot, evidence.artifactPath, evidence.artifactSha256);
			if (!document) { errors.push("REVIEW_FINDING_ARTIFACT_INVALID"); continue; }
			if (typeof evidence.quote !== "string" || !evidence.quote || !fs.readFileSync(document.realPath, "utf8").includes(evidence.quote)) errors.push("REVIEW_FINDING_QUOTE_INVALID");
		}
		for (const key of ["id", "classification", "severity", "consequence", "minimumCorrection"])
			if (typeof finding[key] !== "string" || !finding[key].trim()) errors.push(`REVIEW_FINDING_${key.toUpperCase()}_INVALID`);
		if (typeof finding.classification === "string" && !["defect", "decision-needed", "evidence-gap", "optional"].includes(finding.classification)) errors.push("REVIEW_FINDING_CLASSIFICATION_INVALID");
		if (typeof finding.severity === "string" && !["P0", "P1", "P2", "P3", "INFO"].includes(finding.severity)) errors.push("REVIEW_FINDING_SEVERITY_INVALID");
	}
	return { ...(reviewStatus(data.status) ? { verdict: data.status } : {}), errors: [...new Set(errors)] };
}

function deliveryStatus(content: unknown, taskId: string, agent: string): string | undefined {
	const text = typeof content === "string" ? content : "";
	for (const match of text.matchAll(/<task-result\s+[^>]*>/gi)) {
		const attributes = Object.fromEntries([...match[0].matchAll(/([a-z]+)="([^"]*)"/gi)].map(item => [item[1], item[2]]));
		if (attributes.id === taskId && attributes.agent === agent) return attributes.status;
	}
}

export function findNativeProductReview(branch: unknown[], start: number, reviewer: ProductReviewer, taskName: string): NativeReview | undefined {
	const calls = new Map<string, { taskId?: string; jobId?: string }>();
	const jobsById = new Map<string, { taskId?: string; jobId?: string }>();
	const matches = new Map<string, NativeReview>();
	const runtimeModels = new Map<string, { modelIdentity?: string; thinkingLevel?: string; conflict?: boolean }>();
	for (const entry of branch.slice(start + 1)) {
		if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== "omp-task-model-dispatch-v1" || !isRecord(entry.details)) continue;
		const details = entry.details;
		if (details.source !== "native" || details.agent !== reviewer || typeof details.id !== "string") continue;
		const previous = runtimeModels.get(details.id);
		const modelIdentity = typeof details.modelIdentity === "string" ? details.modelIdentity : undefined;
		const thinkingLevel = typeof details.thinkingLevel === "string" ? details.thinkingLevel : undefined;
		runtimeModels.set(details.id, {
			modelIdentity: modelIdentity ?? previous?.modelIdentity, thinkingLevel: thinkingLevel ?? previous?.thinkingLevel,
			...(previous?.conflict || conflicting(previous?.modelIdentity, modelIdentity) || conflicting(previous?.thinkingLevel, thinkingLevel) ? { conflict: true } : {}),
		});
	}
	for (const entry of branch.slice(start + 1)) {
		if (!isRecord(entry)) continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		const launch = entry.type === "custom" && entry.customType === PRODUCT_REVIEW_ENTRY && entry.data?.kind === "launch"
			&& entry.data?.reviewer === reviewer && entry.data?.taskName === taskName ? entry.data : undefined;
		if (launch && typeof launch.callId === "string") calls.set(launch.callId, {});
		if (message?.role === "toolResult" && message.toolName === "task") {
			const declared = isRecord(message.input) && message.input.agent === reviewer && message.input.name === taskName;
			const matchingCall = typeof message.toolCallId === "string" && calls.has(message.toolCallId);
			if (!declared && !matchingCall) continue;
			const details = isRecord(message.details) ? message.details : {};
			const results = Array.isArray(details.results) ? details.results : [];
			const result = results.find(item => isRecord(item) && item.agent === reviewer);
			if (isRecord(result)) {
				const taskId = typeof result.id === "string" ? result.id : undefined;
				const runtime = taskId ? runtimeModels.get(taskId) : undefined;
				const currentModel = typeof result.resolvedModelIdentity === "string" ? result.resolvedModelIdentity : undefined;
				const currentThinking = typeof result.resolvedThinkingLevel === "string" ? result.resolvedThinkingLevel : undefined;
				matches.set(`task:${taskId ?? entry.id ?? branch.indexOf(entry)}`, { state: result.exitCode === 0 && !result.error && !result.aborted ? "completed" : "failed", agent: reviewer,
				taskId: typeof result.id === "string" ? result.id : undefined, taskName, structured: result.structuredOutput,
				modelIdentity: currentModel ?? runtime?.modelIdentity, thinkingLevel: currentThinking ?? runtime?.thinkingLevel,
				...(runtime?.conflict || conflicting(currentModel, runtime?.modelIdentity) || conflicting(currentThinking, runtime?.thinkingLevel) ? { modelConflict: true } : {}) });
			}
			const progress = Array.isArray(details.progress) ? details.progress.find(item => isRecord(item) && item.agent === reviewer) : undefined;
			const job = isRecord(details.async) && typeof details.async.jobId === "string" ? details.async.jobId : undefined;
			if (isRecord(progress) && typeof progress.id === "string" && job) jobsById.set(job, { taskId: progress.id, jobId: job });
		}
		const jobs = entry.type === "custom_message" && entry.customType === "async-result" && Array.isArray(entry.details?.jobs)
			? entry.details.jobs : message?.role === "toolResult" && message.toolName === "hub" && isRecord(message.details) && Array.isArray(message.details.jobs) ? message.details.jobs : [];
		for (const raw of jobs) {
			if (!isRecord(raw)) continue;
			const jobId = typeof raw.id === "string" ? raw.id : typeof raw.jobId === "string" ? raw.jobId : undefined;
			if (!jobId) continue;
			const launch = jobsById.get(jobId); if (!launch?.taskId) continue;
			const content = raw.resultText ?? entry.content;
			const envelopeStatus = deliveryStatus(content, launch.taskId, reviewer);
			const state = raw.status === "completed" || (!raw.status && envelopeStatus === "completed") ? "completed" : raw.status === "cancelled" ? "cancelled" : raw.status === "failed" ? "failed" : "pending";
			const key = `job:${jobId}`, previous = matches.get(key);
			const runtime = runtimeModels.get(launch.taskId);
			const currentModel = typeof raw.resolvedModelIdentity === "string" ? raw.resolvedModelIdentity : undefined;
			const currentThinking = typeof raw.resolvedThinkingLevel === "string" ? raw.resolvedThinkingLevel : undefined;
			const modelConflict = previous?.modelConflict || runtime?.conflict
				|| conflicting(previous?.modelIdentity, runtime?.modelIdentity, currentModel)
				|| conflicting(previous?.thinkingLevel, runtime?.thinkingLevel, currentThinking);
			// The newest delivery owns lifecycle/result fields. Sparse auto-delivery must not erase prior runtime identity.
			matches.set(key, { state, agent: reviewer, taskId: launch.taskId, jobId, taskName, structured: raw.structured ?? raw.schema,
				modelIdentity: currentModel ?? runtime?.modelIdentity ?? previous?.modelIdentity, thinkingLevel: currentThinking ?? runtime?.thinkingLevel ?? previous?.thinkingLevel,
				...(modelConflict ? { modelConflict: true } : {}), envelopeStatus });
		}
	}
	if (matches.size > 1 || calls.size > 1) return { state: "ambiguous", agent: reviewer, taskName };
	return matches.values().next().value;
}

/** Display dispatches are usable only when this snapshot has one launch for that reviewer. */
export function observedDispatchModel(branch: unknown[], start: number, reviewer: ProductReviewer): { modelIdentity?: string; thinkingLevel?: string } | undefined {
	const launches = branch.slice(start + 1).filter((entry: any) => entry?.type === "custom" && entry.customType === PRODUCT_REVIEW_ENTRY
		&& entry.data?.kind === "launch" && entry.data?.reviewer === reviewer);
	if (launches.length !== 1) return;
	for (const entry of [...branch.slice(start + 1)].reverse()) {
		const content = isRecord(entry) && entry.type === "custom_message" && entry.customType === "omp-task-model-dispatch-v1" && typeof entry.content === "string" ? entry.content : undefined;
		if (!content || !content.includes(`代理 ${reviewer}`)) continue;
		const model = /实际模型\s+([^；。\s]+)/.exec(content)?.[1];
		const effort = /思考强度\s+([^；。\s]+)/.exec(content)?.[1];
		if (model || effort) return { ...(model ? { modelIdentity: model } : {}), ...(effort ? { thinkingLevel: effort } : {}) };
	}
}
