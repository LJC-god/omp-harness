export const PRODUCT_ACCEPTANCE_VERSION = 4 as const;
export type ProductAcceptanceVersion = 2 | 3 | typeof PRODUCT_ACCEPTANCE_VERSION;

export type ReviewVerdict = "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
export type ReviewPurpose = "development" | "final";
export type ReviewReceipt = {
  reviewer: string; taskId: string; transport: "native" | "controlled";
  verdict: ReviewVerdict; settled: boolean; cwd: string; windowId: string;
  sourceStart: string; sourceEnd: string; authorObserved: boolean; purpose?: ReviewPurpose;
};

const verdicts = new Set<ReviewVerdict>(["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"]);
// Native product reviews share this contract. Frozen controller schemas are untouched.
export const PRODUCT_REVIEW_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["status", "summary", "evidence", "findings"],
  properties: {
    status: { type: "string", enum: [...verdicts] },
    summary: { type: "string", minLength: 1, pattern: "\\S" },
    evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1, pattern: "\\S" } },
    findings: { type: "array", items: { type: "string" } },
  },
};

export function hasReviewStatusSchema(schema: any): boolean {
  const status = schema?.properties?.status;
  return schema?.type === "object" && Array.isArray(schema.required) && schema.required.includes("status")
    && status?.type === "string" && Array.isArray(status.enum) && status.enum.length === verdicts.size
    && [...verdicts].every(value => status.enum.includes(value))
    && ["summary", "evidence", "findings"].every(key => schema.required.includes(key))
    && schema.properties.summary?.type === "string"
    && ["evidence", "findings"].every(key => schema.properties[key]?.type === "array" && schema.properties[key].items?.type === "string");
}

// Validate receipt content too: a caller's richer schema must not admit an empty PASS.
export function nativeReviewVerdict(data: any, version: ProductAcceptanceVersion): ReviewVerdict | undefined {
  if (version >= 3 && !(typeof data?.summary === "string" && data.summary.trim()
    && Array.isArray(data.evidence) && data.evidence.length > 0
    && data.evidence.every((item: unknown) => typeof item === "string" && item.trim())
    && Array.isArray(data.findings) && data.findings.every((item: unknown) => typeof item === "string"))) return;
  return reviewVerdict(data?.status);
}
export const productReviewers = (userFacing: boolean, version: ProductAcceptanceVersion = PRODUCT_ACCEPTANCE_VERSION) => [
  "verifier", ...(version >= 3 ? ["security-reviewer", "purple-reviewer"] : []),
  ...(userFacing ? ["gpt-visual-director", "experience-reviewer"] : []),
];

export function reviewVerdict(value: unknown): ReviewVerdict | undefined {
  return typeof value === "string" && verdicts.has(value as ReviewVerdict) ? value as ReviewVerdict : undefined;
}

// A receipt is usable only at the exact source observed at dispatch and settlement.
export function incompleteProductReviews(receipts: ReviewReceipt[], userFacing: boolean, cwd: string,
  windowId: string, currentSource: string | null, version: ProductAcceptanceVersion = PRODUCT_ACCEPTANCE_VERSION): string[] {
  return productReviewers(userFacing, version).filter(reviewer => {
    const receipt = receipts.filter(item => item.reviewer === reviewer && item.cwd === cwd
      && item.windowId === windowId && (version < 4 || item.purpose === "final")).at(-1);
    return !receipt || !receipt.settled || !receipt.authorObserved || receipt.verdict !== "PASS" || !currentSource
      || receipt.sourceStart !== currentSource || receipt.sourceEnd !== currentSource;
  });
}
