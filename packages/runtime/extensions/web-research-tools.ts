import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { RESEARCH_EVIDENCE_TYPE, compactFetchReceipt, compactSearchReceipt, currentBranchToolResults, displayResearchStatus, isFetchedOriginal, sourceUrlForFetch, sourceUrlsFromSearch, unwrapToolResult } from "../lib/research-evidence.ts";
import { loadResearchApis } from "../lib/host-apis.ts";

const { getProjectDir, applyProviderGlobalsFromSettings, Settings, runSearchQuery } = await loadResearchApis();
type SearchResponse = { sources: Array<{ url: string; title?: string; publishedDate?: string; snippet?: string }> };

type SearchProvider = "exa" | "tavily" | "brave" | "xai";

type Engine = "exa" | "tavily" | "brave" | "grok";
type DiscoveryRequest = { engine: Engine; query: string; timeoutMs: number };
type SearchRunner = (provider: SearchProvider, query: string, signal?: AbortSignal) => Promise<{
	content: unknown; details: { response: SearchResponse; error?: string };
}>;

// Collect source fields directly. No extra model turn stands between retrieval and evidence.
export async function discoverEvidence(request: DiscoveryRequest, signal?: AbortSignal, run: SearchRunner = search) {
	const { engine, query, timeoutMs } = request;
	if (!["exa", "tavily", "brave", "grok"].includes(engine) || !query.trim() || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid discovery request");
	const started = Date.now();
	const controller = new AbortController();
	const cancelled = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", cancelled, { once: true });
	if (signal?.aborted) cancelled();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Search deadline exceeded")); }, timeoutMs);
	try {
		controller.signal.throwIfAborted();
		const interrupted = Promise.withResolvers<never>();
		const stop = () => interrupted.reject(controller.signal.reason);
		controller.signal.addEventListener("abort", stop, { once: true });
		try {
			const result = await Promise.race([
				run(engine === "grok" ? "xai" : engine, query, controller.signal),
				interrupted.promise,
			]);
			controller.signal.throwIfAborted();
			const sources = result.details.response.sources.filter(source => {
				try { return ["https:", "http:"].includes(new URL(source.url).protocol); } catch { return false; }
			}).slice(0, 10).map(source => ({
				url: source.url, title: source.title, ...(source.publishedDate ? { publicationDate: source.publishedDate } : {}),
				claims: source.snippet ? [source.snippet] : [],
				uncertainty: "Provider search excerpt; not independently verified or a full-page read",
			}));
			return { status: sources.length ? "OK" : "UNAVAILABLE", engine, sources,
				toolStatus: result.details.error ? "ERROR" : "SUCCEEDED", organizationStatus: "NOT_REQUIRED",
				...(result.details.error ? { reason: result.details.error } : {}), elapsedMs: Date.now() - started };
		} finally { controller.signal.removeEventListener("abort", stop); }
	} catch (error) {
		return { status: "UNAVAILABLE", engine, sources: [], toolStatus: timedOut ? "TIMEOUT" : signal?.aborted ? "CANCELLED" : "ERROR",
			organizationStatus: "NOT_REQUIRED", reason: timedOut ? "Provider deadline exceeded; cancellation requested, late results ignored" : error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started };
	} finally { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); }
}

let providerGlobals: Promise<void> | undefined;

async function initializeProviderGlobals(): Promise<void> {
	providerGlobals ??= Settings.init({ cwd: getProjectDir() })
		.then(settings => {
			applyProviderGlobalsFromSettings(settings);
		})
		.catch(error => {
			providerGlobals = undefined;
			throw error;
		});
	return providerGlobals;
}

async function search(provider: SearchProvider, query: string, signal?: AbortSignal) {
	if (signal?.aborted) throw new Error(`${provider} search cancelled`);
	await initializeProviderGlobals();
	if (signal?.aborted) throw new Error(`${provider} search cancelled`);
	return runSearchQuery({ query, provider, limit: 10 }, { signal });
}

export default function webResearchTools(pi: ExtensionAPI) {
	const z = pi.zod;
	const evidenceOwner = (ctx: any) => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		const init = ctx.sessionManager?.getEntries().findLast((entry: any) => entry.type === "session_init");
		return sessionId && (!init || init.agent === "pm-worker")
			? { sessionId, agent: init?.agent ?? "root" } : undefined;
	};
	const recorded = new Set<string>();
	const appendReceipt = (event: any, ctx: any) => {
		const owner = evidenceOwner(ctx);
		const key = `${owner?.sessionId}:${event.toolCallId}`;
		if (!owner || recorded.has(key) || typeof event.toolCallId !== "string") return;
		const native = unwrapToolResult(event.toolName, event.input, event.details);
		if (native.toolName === "web_research_v1") {
			recorded.add(key);
			pi.appendEntry(RESEARCH_EVIDENCE_TYPE, { ...compactSearchReceipt(event.toolCallId, native.input, native.details, event.isError), ...owner });
		}
		if ((native.toolName === "web_fetch" || native.toolName === "read") && sourceUrlForFetch(native.toolName, native.input)) {
			recorded.add(key);
			pi.appendEntry(RESEARCH_EVIDENCE_TYPE, { ...compactFetchReceipt(event.toolCallId, native.toolName, native.input, event.content, native.details, event.isError), ...owner });
		}
	};
	pi.on("tool_result", appendReceipt);
	pi.registerTool({
		name: "web_research_v1", label: "Web research", approval: "read",
		description: "Bounded web research. The only prose engine order is the harness note web-research-policy.md. Read key original pages with web_fetch when excerpts are insufficient.",
		parameters: z.object({
			query: z.string().min(1).max(4000).describe("Complete research question with names, dates, and disambiguating terms"),
			mode: z.enum(["quick", "cross_check"]).optional(),
			engine: z.enum(["exa", "tavily", "brave", "grok"]).optional().describe("Omit for default Exa + Brave; specify only for a single preferred engine with one fallback"),
		}),
		async execute(_id, { query, mode, engine }, signal) {
			const packet = await researchEvidence(query, mode, engine, signal);
			return { content: [{ type: "text", text: JSON.stringify(packet) }], details: { packet, readOnly: true } };
		},
	});
	pi.registerTool({
		name: "omp_research_evidence", label: "Research evidence", approval: "read", strict: true,
		description: "Root or pm-worker: record or inspect research evidence on your own native session branch. Status returns sessionId and actual receipt IDs for handoff. A decision is synthesis linked to real local search/fetch results; foreign-session IDs are not imported. Retrieval alone never verifies a claim. No web calls, report files, model turns or writes outside session history.",
		parameters: z.object({
			action: z.enum(["status", "record_decision"]),
			searchReceiptId: z.string().min(1).max(200).optional(),
			fetchReceiptIds: z.array(z.string().min(1).max(200)).max(6).optional(),
			decision: z.string().max(600).optional(),
			gaps: z.array(z.string().max(300)).max(4).optional(),
		}).strict(),
		async execute(_id, input, _signal, _onUpdate, ctx) {
			const owner = evidenceOwner(ctx);
			if (!owner) throw new Error("SUBAGENT_FORBIDDEN: research evidence requires root or pm-worker native session");
			const branch = ctx.sessionManager.getBranch();
			const results = currentBranchToolResults(branch);
			if (input.action === "status") {
				const records = branch.slice(branch.findLastIndex((entry: any) => entry.type === "reset_boundary") + 1)
					.filter((entry: any) => entry.type === "custom" && entry.customType === RESEARCH_EVIDENCE_TYPE)
					.slice(-12).map((entry: any) => entry.data);
				return { content: [{ type: "text", text: JSON.stringify({ status: "当前分支研究证据", ...owner, records }) }], details: { ...owner, records } };
			}
			const search = results.find(result => result.id === input.searchReceiptId && result.toolName === "web_research_v1");
			if (!search) throw new Error("RESEARCH_RECEIPT_REQUIRED: searchReceiptId must be a web_research_v1 result on the current branch after its latest reset");
			const fetchIds = [...new Set(input.fetchReceiptIds ?? [])];
			const fetches = fetchIds.map(id => results.find(result => result.id === id
				&& (result.toolName === "web_fetch" || result.toolName === "read") && sourceUrlForFetch(result.toolName, result.input)));
			if (fetches.some(fetch => !fetch)) throw new Error("RESEARCH_FETCH_RECEIPT_INVALID: every fetchReceiptId must be a successful-route web_fetch or URL-read result on the current branch after its latest reset");
			const searchSources = sourceUrlsFromSearch(search);
			const linkedFetchReceiptIds: string[] = [], unlinkedFetchReceiptIds: string[] = [], failedFetchReceiptIds: string[] = [], unconfirmedFetchReceiptIds: string[] = [];
			for (const fetch of fetches as NonNullable<typeof fetches[number]>[]) {
				if (fetch.isError) { failedFetchReceiptIds.push(fetch.id); continue; }
				if (!isFetchedOriginal(fetch)) { unconfirmedFetchReceiptIds.push(fetch.id); continue; }
				const url = sourceUrlForFetch(fetch.toolName, fetch.input);
				if (url && searchSources.has(url) && fetch.index > search.index) linkedFetchReceiptIds.push(fetch.id);
				else unlinkedFetchReceiptIds.push(fetch.id);
			}
			const receipt = compactSearchReceipt(search.id, search.input, search.details, search.isError);
			const gaps = [...new Set([...(input.gaps ?? []),
				...(search.isError ? ["检索收据执行失败，不能据此支持外部事实"] : []),
				...(failedFetchReceiptIds.length ? ["部分原始页面读取失败"] : []),
				...(unconfirmedFetchReceiptIds.length ? ["部分读取没有可确认的原始页面内容"] : []),
				...(unlinkedFetchReceiptIds.length ? ["部分原始页面未由该检索收据直接关联"] : []),
			])].map(value => value.slice(0, 300)).slice(0, 4);
			const record = { schema: 1 as const, kind: "decision" as const, ...owner, searchReceiptId: search.id,
				fetchedOriginalReceiptIds: linkedFetchReceiptIds, unlinkedFetchReceiptIds, failedFetchReceiptIds, unconfirmedFetchReceiptIds,
				decision: input.decision?.slice(0, 600) ?? "", gaps, evidenceStatus: "用户/模型综合；运行时仅证明检索或页面读取",
				verificationStatus: "未声明验证" };
			pi.appendEntry(RESEARCH_EVIDENCE_TYPE, record);
			return { content: [{ type: "text", text: JSON.stringify({ status: displayResearchStatus(receipt), decision: record }) }], details: { record } };
		},
	});
}

export async function researchEvidence(query: string, mode: "quick" | "cross_check" = "quick", engine?: Engine, signal?: AbortSignal, run: SearchRunner = search) {
	const engines: Engine[] = mode === "cross_check" ? ["exa", "tavily", "brave", "grok"] : engine ? [engine, engine === "tavily" ? "exa" : "tavily"] : ["exa", "brave"];
	const results: Awaited<ReturnType<typeof discoverEvidence>>[] = [];
	if (mode === "cross_check") results.push(...await Promise.all(engines.map(engine => discoverEvidence({ engine, query, timeoutMs: 30000 }, signal, run))));
	else if (!engine) {
		results.push(...await Promise.all(engines.map(engine => discoverEvidence({ engine, query, timeoutMs: 15000 }, signal, run))));
		if (!signal?.aborted && !results.some(result => result.status === "OK" && result.toolStatus === "SUCCEEDED"))
			results.push(await discoverEvidence({ engine: "tavily", query, timeoutMs: 15000 }, signal, run));
	}
	else for (const engine of engines) {
		if (signal?.aborted) break;
		const result = await discoverEvidence({ engine, query, timeoutMs: 15000 }, signal, run);
		results.push(result);
		if (result.status === "OK" && result.toolStatus === "SUCCEEDED") break;
	}
	const usable = results.filter(result => result.status === "OK" && result.toolStatus === "SUCCEEDED").length;
	const expected = mode === "quick" && engine ? 1 : engines.length;
	const status = signal?.aborted ? "CANCELLED" : usable === expected ? "OK" : usable ? "PARTIAL" : "UNAVAILABLE";
	const packet = { status,
		query, mode, evidence: Object.fromEntries(results.map(result => [result.engine, result])),
		reason: `${usable}/${results.length} attempted providers returned usable evidence; excerpts are not full-page verification` };
	return { ...packet, display: displayResearchStatus(compactSearchReceipt("runtime", { query }, { packet }, false)) };
}
