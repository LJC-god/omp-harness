import { expect, test } from "bun:test";
import { runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";
const { z } = await import(runtimePackageFile("omptype", "src/zod.ts"));
import webResearchTools, { researchEvidence } from "../omp/agent/extensions/web-research-tools.ts";
import { compactSearchReceipt, currentBranchToolResults, isFetchedOriginal, safeSourceUrl } from "../omp/agent/lib/research-evidence.ts";

const response = (sources: any[] = []) => ({ content: {}, details: { response: { sources } } }) as any;

test("default quick always searches Exa and Brave, retaining partial results and bounded fallback", async () => {
	for (const working of [["exa", "brave"], ["exa"], ["brave"], ["tavily"], []]) {
		const called: string[] = [];
		const packet = await researchEvidence("current pricing", undefined, undefined, undefined, async provider => {
			called.push(provider);
			return response(working.includes(provider) ? [{ url: `https://example.com/${provider}` }] : []);
		});
		const primaryUsable = working.includes("exa") || working.includes("brave");
		expect(called).toEqual(primaryUsable ? ["exa", "brave"] : ["exa", "brave", "tavily"]);
		expect(packet.status).toBe(working.length === 2 ? "OK" : working.length ? "PARTIAL" : "UNAVAILABLE");
	}
});

test("explicit single-engine quick keeps its fallback and cancelled default makes no requests", async () => {
	const called: string[] = [];
	const packet = await researchEvidence("current pricing", "quick", "grok", undefined, async provider => {
		called.push(provider);
		if (provider === "xai") throw new Error("unavailable");
		return response([{ url: "https://example.com/fallback" }]);
	});
	expect(called).toEqual(["xai", "tavily"]);
	expect(packet.status).toBe("OK");
	const controller = new AbortController(); controller.abort();
	let cancelledCalls = 0;
	const cancelled = await researchEvidence("current pricing", undefined, undefined, controller.signal, async () => {
		cancelledCalls++;
		throw new Error("must not be called");
	});
	expect(cancelled.status).toBe("CANCELLED");
	expect(cancelledCalls).toBe(0);
	expect(Object.keys(cancelled.evidence)).toEqual(["exa", "brave"]);
});

test("cross-check reports provider partial failure without claiming verification", async () => {
	const packet = await researchEvidence("current pricing", "cross_check", "exa", undefined, async provider => {
		if (provider === "exa") return response([{ url: "https://example.com/price", title: "Price", snippet: "excerpt" }]);
		throw new Error(`${provider} unavailable`);
	});
	expect(packet.status).toBe("PARTIAL");
	expect(packet.evidence.exa.toolStatus).toBe("SUCCEEDED");
	expect(packet.evidence.tavily.toolStatus).toBe("ERROR");
	expect(packet.display).toContain("仅检索摘要");
	expect(packet.display).toContain("未声明验证");
});

test("search receipts retain bounded safe references and report retained versus actual sources", () => {
	const receipt = compactSearchReceipt("search-1", { query: "token=do-not-store" }, { packet: {
		status: "OK", reason: "provider result", evidence: { exa: { status: "OK", toolStatus: "SUCCEEDED", sources: [
			...Array.from({ length: 5 }, (_, index) => ({ url: `https://example.com/${index}`, title: `source ${index}` })),
			{ url: "https://example.com/?token=secret", title: "credential" },
		] } },
	} }, false);
	expect(receipt.question).toContain("[redacted]");
	expect(receipt.providers[0].sourceCount).toBe(6);
	expect(receipt.providers[0].retainedSourceCount).toBe(4);
	expect(receipt.providers[0].sources).toHaveLength(4);
	expect(JSON.stringify(receipt)).not.toContain("do-not-store");
	expect(safeSourceUrl("https://example.com/#access_token=secret")).toBeUndefined();
	expect(isFetchedOriginal({ id: "error-page", index: 0, toolName: "web_fetch", input: { url: "https://example.com/error" }, details: {}, content: [{ type: "text", text: "<!doctype html><title>404 Not Found</title>" }], isError: false })).toBe(false);
});

function fakeApi(branch: any[]) {
	const handlers = new Map<string, Function>(); const tools: any[] = []; const records: any[] = []; let messages = 0;
	const api = { zod: z, on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool(tool: any) { tools.push(tool); },
		appendEntry(type: string, data: unknown) { records.push({ type, data }); }, sendMessage() { messages++; } };
	const ctx = { sessionManager: { getSessionId: () => "root", getEntries: () => [], getBranch: () => branch } };
	return { handlers, tools, records, ctx, messageCount: () => messages, api };
}

test("xd search and successful URL-read receipts link an explicit synthesis on the current branch", async () => {
	const packet = { status: "OK", reason: "1/1", evidence: { exa: { status: "OK", toolStatus: "SUCCEEDED", sources: [{ url: "https://example.com/source", title: "Source" }] } } };
	const branch: any[] = [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "search-1", name: "write", arguments: { path: "xd://web_research_v1", content: "ignored" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "search-1", toolName: "write", details: { xdev: { tool: "web_research_v1", args: { query: "current price" }, inner: { packet } } }, content: [{ type: "text", text: "search" }], isError: false } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "fetch-1", name: "read", arguments: { path: "https://example.com/source" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "fetch-1", toolName: "read", details: { status: 200 }, content: [{ type: "text", text: "original body" }], isError: false } },
	];
	const { api, handlers, tools, records, ctx, messageCount } = fakeApi(branch); webResearchTools(api as never);
	handlers.get("tool_result")!({ toolCallId: "search-1", toolName: "write", input: { path: "xd://web_research_v1" }, details: branch[1].message.details, content: branch[1].message.content, isError: false }, ctx);
	handlers.get("tool_result")!({ toolCallId: "fetch-1", toolName: "read", input: { path: "https://example.com/source" }, details: { status: 200 }, content: branch[3].message.content, isError: false }, ctx);
	expect(records.map(record => record.data.status)).toEqual(["OK", "已读取原始页面"]);
	const decision = tools.find(tool => tool.name === "omp_research_evidence");
	const result = await decision.execute("decision-1", { action: "record_decision", searchReceiptId: "search-1", fetchReceiptIds: ["fetch-1"], decision: "Use the observed source", gaps: [] }, undefined, undefined, ctx);
	expect(result.details.record.fetchedOriginalReceiptIds).toEqual(["fetch-1"]);
	expect(result.details.record.verificationStatus).toBe("未声明验证");
	expect(messageCount()).toBe(0);
});

test("decision rejects stale and cross-branch receipt IDs", async () => {
	const branch: any[] = [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "old", name: "web_research_v1", arguments: { query: "old" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "old", toolName: "web_research_v1", details: { packet: {} }, content: [], isError: false } },
		{ type: "reset_boundary" }];
	const { api, tools, ctx } = fakeApi(branch); webResearchTools(api as never);
	const decision = tools.find(tool => tool.name === "omp_research_evidence");
	await expect(decision.execute("decision-2", { action: "record_decision", searchReceiptId: "old" }, undefined, undefined, ctx)).rejects.toThrow("RESEARCH_RECEIPT_REQUIRED");
	expect(currentBranchToolResults(branch)).toEqual([]);
});

test("status does not surface evidence from before the current reset", async () => {
	const branch: any[] = [{ type: "custom", customType: "omp-research-evidence-v1", data: { receiptId: "old" } }, { type: "reset_boundary" }];
	const { api, tools, ctx } = fakeApi(branch); webResearchTools(api as never);
	const status = tools.find(tool => tool.name === "omp_research_evidence");
	const result = await status.execute("status", { action: "status" }, undefined, undefined, ctx);
	expect(result.details.records).toEqual([]);
});

test("PM owns local research receipts; other children and foreign/stale references remain rejected", async () => {
	const packet = { status: "OK", evidence: { exa: { status: "OK", toolStatus: "SUCCEEDED", sources: [{ url: "https://example.com/source" }] } } };
	const branch: any[] = [
		{ type: "session_init", agent: "pm-worker" },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "pm-search", name: "web_research_v1", arguments: { query: "need" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "pm-search", toolName: "web_research_v1", details: { packet }, content: [], isError: false } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "pm-fetch", name: "read", arguments: { path: "https://example.com/source" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "pm-fetch", toolName: "read", details: { status: 503 }, content: [{ type: "text", text: "unavailable" }], isError: true } },
	];
	const fixture = fakeApi(branch);
	fixture.ctx.sessionManager.getSessionId = () => "pm-session";
	fixture.ctx.sessionManager.getEntries = () => branch;
	webResearchTools(fixture.api as never);
	const evidence = fixture.tools.find(tool => tool.name === "omp_research_evidence");
	fixture.handlers.get("tool_result")!({ toolCallId: "pm-search", toolName: "web_research_v1", input: { query: "need" }, details: { packet }, content: [], isError: false }, fixture.ctx);
	expect(fixture.records[0].data).toMatchObject({ sessionId: "pm-session", agent: "pm-worker", receiptId: "pm-search" });
	const result = await evidence.execute("decision", { action: "record_decision", searchReceiptId: "pm-search", fetchReceiptIds: ["pm-fetch"], decision: "Unresolved original" }, undefined, undefined, fixture.ctx);
	expect(result.details.record).toMatchObject({ sessionId: "pm-session", agent: "pm-worker", fetchedOriginalReceiptIds: [], failedFetchReceiptIds: ["pm-fetch"] });
	const status = await evidence.execute("status", { action: "status" }, undefined, undefined, fixture.ctx);
	expect(status.details).toMatchObject({ sessionId: "pm-session", agent: "pm-worker" });
	const root = fakeApi([]).ctx;
	await expect(evidence.execute("foreign", { action: "record_decision", searchReceiptId: "pm-search" }, undefined, undefined, root)).rejects.toThrow("RESEARCH_RECEIPT_REQUIRED");
	await expect(evidence.execute("foreign-fetch", { action: "record_decision", searchReceiptId: "pm-search", fetchReceiptIds: ["root-fetch"] }, undefined, undefined, fixture.ctx)).rejects.toThrow("RESEARCH_FETCH_RECEIPT_INVALID");
	branch.push({ type: "reset_boundary" });
	await expect(evidence.execute("stale", { action: "record_decision", searchReceiptId: "pm-search" }, undefined, undefined, fixture.ctx)).rejects.toThrow("RESEARCH_RECEIPT_REQUIRED");
	branch.push({ type: "session_init", agent: "frontend-worker" });
	await expect(evidence.execute("other", { action: "status" }, undefined, undefined, fixture.ctx)).rejects.toThrow("SUBAGENT_FORBIDDEN");
	const count = fixture.records.length;
	fixture.handlers.get("tool_result")!({ toolCallId: "other-search", toolName: "web_research_v1", input: {}, details: { packet } }, fixture.ctx);
	expect(fixture.records).toHaveLength(count);
});
