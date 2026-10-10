export const RESEARCH_EVIDENCE_TYPE = "omp-research-evidence-v1";

type Entry = Record<string, unknown>;
export type ToolResult = { id: string; index: number; toolName: string; input: Entry; details: unknown; content: unknown; isError: boolean };

const MAX_QUESTION = 600;
const MAX_URL = 2_000;
const MAX_TITLE = 200;
const MAX_SOURCES_PER_PROVIDER = 4;
const SECRET = /(?:api[_-]?key|token|password|authorization|bearer)\s*[:=]\s*[^\s,;]+|\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}\b/gi;
const CN = { failed: "\u5931\u8d25", timeout: "\u8d85\u65f6", cancelled: "\u5df2\u53d6\u6d88", unavailable: "\u4e0d\u53ef\u7528", partial: "\u90e8\u5206\u53ef\u7528", successSnippet: "\u6210\u529f\uff08\u4ec5\u68c0\u7d22\u6458\u8981\uff09", unknown: "\u672a\u77e5", originalNotRead: "\u5c1a\u672a\u8bfb\u53d6\u539f\u59cb\u9875\u9762", verificationNotDeclared: "\u672a\u58f0\u660e\u9a8c\u8bc1", fetchFailed: "\u8bfb\u53d6\u5931\u8d25", fetched: "\u5df2\u8bfb\u53d6\u539f\u59cb\u9875\u9762", fetchUnconfirmed: "\u8bfb\u53d6\u5b8c\u6210\u4f46\u672a\u786e\u8ba4\u539f\u59cb\u9875\u9762\u5185\u5bb9" };

export const asRecord = (value: unknown): Entry => value && typeof value === "object" && !Array.isArray(value) ? value as Entry : {};
const short = (value: unknown, limit: number) => typeof value === "string" ? value.replace(SECRET, "[redacted]").slice(0, limit) : "";

export function safeSourceUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > MAX_URL) return;
	try {
		const url = new URL(value);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password
			|| [...url.searchParams.keys()].some(key => /api[_-]?key|token|password|authorization|secret/i.test(key))
			|| /(?:api[_-]?key|token|password|authorization|secret)\s*=/i.test(url.hash)) return;
		return value;
	} catch { return; }
}

function providerStatus(status: unknown, toolStatus: unknown, isError: boolean) {
	if (isError) return CN.failed;
	if (toolStatus === "TIMEOUT") return CN.timeout;
	if (toolStatus === "CANCELLED") return CN.cancelled;
	if (toolStatus === "ERROR") return CN.failed;
	if (status === "OK" && toolStatus === "SUCCEEDED") return CN.successSnippet;
	if (status === "UNAVAILABLE") return CN.unavailable;
	return CN.partial;
}

export function compactSearchReceipt(receiptId: string, input: Entry, details: unknown, isError: boolean) {
	const packet = asRecord(asRecord(details).packet);
	const evidence = asRecord(packet.evidence);
	const providers = Object.entries(evidence).slice(0, 4).map(([engine, value]) => {
		const item = asRecord(value), allSources = Array.isArray(item.sources) ? item.sources : [];
		const sources = allSources.slice(0, MAX_SOURCES_PER_PROVIDER).flatMap(source => {
			const row = asRecord(source), url = safeSourceUrl(row.url);
			return url ? [{ url, ...(short(row.title, MAX_TITLE) ? { title: short(row.title, MAX_TITLE) } : {}) }] : [];
		});
		return { engine: short(engine, 20), status: providerStatus(item.status, item.toolStatus, isError),
			resultStatus: short(item.status, 30) || "UNKNOWN", toolStatus: short(item.toolStatus, 30) || (isError ? "ERROR" : "UNKNOWN"),
			sourceCount: allSources.length, retainedSourceCount: sources.length, sources };
	});
	return { schema: 1 as const, kind: "search" as const, receiptId, question: short(input.query, MAX_QUESTION),
		status: isError ? CN.failed : short(packet.status, 30) || CN.unknown, providers,
		originalPageStatus: CN.originalNotRead, verificationStatus: CN.verificationNotDeclared,
		...(short(packet.reason, 300) ? { reason: short(packet.reason, 300) } : {}) };
}

export function sourceUrlForFetch(toolName: string, input: Entry) {
	return safeSourceUrl(toolName === "read" ? input.path : input.url);
}

export function isFetchedOriginal(result: ToolResult) {
	const hasContent = Array.isArray(result.content) && result.content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
	const detail = asRecord(result.details), response = asRecord(detail.response);
	const diagnostic = [detail, response].some(value => value.ok === false || value.success === false
		|| typeof value.error === "string" && value.error.trim() || typeof value.status === "number" && value.status >= 400);
	const text = Array.isArray(result.content) ? result.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n") : "";
	return !result.isError && !diagnostic && !/^\s*(?:error|fetch failed|http\s+[45]\d\d|<!doctype[^>]*>\s*<title>\s*(?:[45]\d\d|error|not found))/i.test(text)
		&& (result.toolName === "web_fetch" || result.toolName === "read") && !!sourceUrlForFetch(result.toolName, result.input) && hasContent;
}

export function compactFetchReceipt(receiptId: string, toolName: string, input: Entry, content: unknown, details: unknown, isError: boolean) {
	const result: ToolResult = { id: receiptId, index: 0, toolName, input, content, details, isError };
	const url = sourceUrlForFetch(toolName, input);
	return { schema: 1 as const, kind: "fetch" as const, receiptId, ...(url ? { url } : {}),
		status: isError ? CN.fetchFailed : isFetchedOriginal(result) ? CN.fetched : CN.fetchUnconfirmed,
		verificationStatus: CN.verificationNotDeclared };
}

export function unwrapToolResult(toolName: string, input: Entry, details: unknown) {
	const xdev = asRecord(asRecord(details).xdev);
	if (typeof xdev.tool !== "string") return { toolName, input, details };
	return { toolName: xdev.tool, input: asRecord(xdev.args), details: xdev.inner };
}

export function currentBranchToolResults(branch: unknown[]): ToolResult[] {
	const reset = branch.findLastIndex((entry: any) => entry?.type === "reset_boundary");
	const calls = new Map<string, Entry>(), rows: ToolResult[] = [];
	for (let index = reset + 1; index < branch.length; index++) {
		const entry = branch[index] as any, message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) if (block?.type === "toolCall" && typeof block.id === "string") calls.set(block.id, asRecord(block.arguments));
		}
		if (message?.role !== "toolResult" || typeof message.toolCallId !== "string" || typeof message.toolName !== "string") continue;
		const native = unwrapToolResult(message.toolName, calls.get(message.toolCallId) ?? {}, message.details);
		rows.push({ id: message.toolCallId, index, ...native, content: message.content, isError: message.isError === true });
	}
	return rows;
}

export function sourceUrlsFromSearch(result: ToolResult): Set<string> {
	const receipt = compactSearchReceipt(result.id, result.input, result.details, result.isError);
	return new Set(receipt.providers.flatMap(provider => provider.sources.map(source => source.url)));
}

export function displayResearchStatus(receipt: ReturnType<typeof compactSearchReceipt>) {
	const providers = receipt.providers.length ? receipt.providers.map(provider => `${provider.engine}\uff1a${provider.status}`).join("\uff1b") : "\u672a\u53d6\u5f97\u63d0\u4f9b\u65b9\u660e\u7ec6";
	return `\u68c0\u7d22\u72b6\u6001\uff1a${receipt.status}\u3002${providers}\u3002\u539f\u59cb\u9875\u9762\uff1a${receipt.originalPageStatus}\u3002\u9a8c\u8bc1\uff1a${receipt.verificationStatus}\u3002`;
}
