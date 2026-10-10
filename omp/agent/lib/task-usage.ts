import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeModule } from "./omp-runtime.ts";
const { loadSessionFile } = await import(runtimeModule("pi-coding-agent/src/session/session-loader.ts"));

type Entry = Record<string, any>;
export const WINDOW = "omp-usage-window-v1";
export const REPORT = "omp-usage-report-v1";
export const SOURCE = "omp-usage-source-v1";
export const CHECKPOINT = "omp-continuity-v1";
export const asRecord = (v: unknown): Entry => v && typeof v === "object" && !Array.isArray(v) ? v as Entry : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const time = (e: Entry) => typeof e.timestamp === "number" ? e.timestamp : Date.parse(e.timestamp);
export const afterReset = (branch: Entry[]) => branch.slice(branch.findLastIndex(e => e.type === "reset_boundary") + 1);
export const latest = (branch: Entry[], kind: string) => afterReset(branch).findLast(e => e.type === "custom" && e.customType === kind);

export function startWindow(branch: Entry[], now: number) {
  const user = afterReset(branch).findLast(e => e.type === "message" && e.message?.role === "user");
  return { startId: user?.id, startedAt: user && finite(time(user)) ? time(user) : now };
}

type ModelRow = {
  model: string; requests: number; failedRequests: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  requestMs: number; timedRequests: number; missingUsage: number;
};
export type UsageReport = {
  schema: 1; sessionId: string; checkpointId?: string; startId?: string; startedAt: number; endedAt: number;
  elapsedMs: number; rows: ModelRow[]; notes: string[]; childSessions: number;
  coverage: "recorded-subtotal";
};

/** Selected ancestry only: forks and abandoned tails are not extra spend in this task scope. */
export function selectedBranch(entries: Entry[]): Entry[] {
  const indexed = new Map(entries.filter(e => typeof e.id === "string" && e.type !== "session").map(e => [e.id, e]));
  let entry = [...indexed.values()].at(-1);
  const result: Entry[] = [], seen = new Set<string>();
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id); result.push(entry); entry = indexed.get(entry.parentId);
  }
  return result.reverse();
}

export async function collectUsage(options: {
  branch: Entry[]; sessionId: string; sessionsRoot: string; sessionFile?: string; endedAt?: number;
}): Promise<UsageReport> {
  const branch = afterReset(options.branch);
  const checkpoint = latest(branch, CHECKPOINT);
  const window = latest(branch, WINDOW)?.data;
  const fallback = startWindow(branch, options.endedAt ?? Date.now());
  const start = window ?? fallback;
  const startIndex = branch.findIndex(e => e.id === start.startId);
  const scoped = startIndex >= 0 ? branch.slice(startIndex) : branch;
  const endedAt = options.endedAt ?? Date.now();
  const notes = new Set<string>();
  notes.add("完整性：仅为可核对记录小计；当前运行时可能不记录独立截图分析、附件描述和模型压缩调用，相关 token 与耗时无法保证覆盖。");
  if (!window || startIndex < 0) notes.add("缺少完整任务起点；本表仅覆盖当前可定位的会话范围。");
  const models = new Map<string, ModelRow>();
  const sources = new Set<string>();
  const counted = new Set<string>();
  const canonical = (p: string) => path.resolve(p).toLowerCase();
  const sessionsRoot = canonical(fs.realpathSync(options.sessionsRoot));
  const inRoot = (p: string) => p.startsWith(sessionsRoot + path.sep);
  if (options.sessionFile) sources.add(canonical(options.sessionFile));
  let childSessions = 0;

  function add(message: Entry, key: string) {
    if (counted.has(key)) return;
    counted.add(key);
    const model = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
    let row = models.get(model);
    if (!row) { row = { model, requests: 0, failedRequests: 0, input: 0, output: 0, cacheRead: 0,
      cacheWrite: 0, totalTokens: 0, requestMs: 0, timedRequests: 0, missingUsage: 0 }; models.set(model, row); }
    row.requests++;
    if (["error", "aborted"].includes(message.stopReason)) row.failedRequests++;
    const usage = asRecord(message.usage);
    const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
    for (const field of fields) if (finite(usage[field])) row[field] += usage[field];
    if (fields.some(field => !finite(usage[field]))) row.missingUsage++;
    if (finite(message.duration)) { row.requestMs += message.duration; row.timedRequests++; }
    // Zero usage on an aborted/error request does not establish zero provider billing.
    if (["error", "aborted"].includes(message.stopReason) && !usage.totalTokens)
      notes.add("部分失败请求没有返回 token 用量；零记录不等于供应商未计费。");
  }

  async function readChild(file: unknown) {
    if (typeof file !== "string" || !path.isAbsolute(file)) { notes.add("存在无法定位的子会话，用量可能不完整。"); return; }
    const normalized = canonical(file.replace(/\.md$/i, ".jsonl"));
    if (sources.has(normalized)) return;
    sources.add(normalized);
    if (!inRoot(normalized)) { notes.add("子会话位于统计允许范围之外，已跳过。"); return; }
    try {
      const real = canonical(fs.realpathSync(normalized));
      if (!inRoot(real)) throw new Error("outside session root");
      if (real !== normalized && sources.has(real)) return;
      sources.add(real);
      const loaded = await loadSessionFile(real, undefined, { throwIfMissing: true });
      if (loaded.invalidHeader) throw new Error("invalid session header");
      if (loaded.malformedRecords) notes.add("部分会话记录损坏，统计仅包含可读记录。");
      const entries = selectedBranch(loaded.entries);
      // Reused child transcripts can contain earlier/later tasks. Include only this task's interval.
      const scopedChild = entries.filter(e => time(e) >= start.startedAt && time(e) <= endedAt);
      childSessions++;
      await scan(scopedChild, real);
    } catch { notes.add("有子会话日志缺失或不可读；未用最终模型名猜测整段用量。"); }
  }

  async function scan(entries: Entry[], source: string) {
    for (const entry of entries) {
      if (entry.type === "model_usage") add(entry, source + ":" + entry.id);
      if (entry.type === "custom" && entry.customType === SOURCE) await readChild(entry.data?.sessionFile);
      if (entry.type === "custom" && entry.customType === "omp-task-health-v1" && entry.data?.sessionFile)
        await readChild(entry.data.sessionFile);
      if (entry.type !== "message") continue;
      const message = asRecord(entry.message);
      if (message.role === "assistant") add(message, source + ":" + entry.id);
      if (message.role !== "toolResult") continue;
      const details = asRecord(message.details);
      if (message.toolName === "task") {
        const results = Array.isArray(details.results) ? details.results : [];
        if (!results.length) notes.add("有 task 回执未列出子会话；统计可能不完整。");
        for (const result of results) await readChild(result.outputPath);
        // Never also add details.usage: it duplicates the child assistant records.
      }
      if (message.toolName === "omp_control") {
        const receipt = asRecord(details.result);
        const execution = asRecord(details.execution);
        const file = details.sessionFile ?? receipt.sessionFile ?? execution.sessionFile;
        if (file) await readChild(file);
      }
    }
  }
  await scan(scoped, options.sessionFile ? canonical(options.sessionFile) : options.sessionId);
  const rows = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  if (rows.some(r => r.missingUsage)) notes.add("部分请求缺少 token 字段，表中为已记录小计。");
  if (rows.some(r => r.timedRequests < r.requests)) notes.add("部分请求（包括可能的压缩/辅助调用）未记录耗时，模型时间为已记录小计。");
  return { schema: 1, coverage: "recorded-subtotal", sessionId: options.sessionId, checkpointId: checkpoint?.id, startId: start.startId,
    startedAt: start.startedAt, endedAt, elapsedMs: Math.max(0, endedAt - start.startedAt), rows, notes: [...notes], childSessions };
}

export function renderUsage(report: UsageReport): string {
  const number = (n: number) => n.toLocaleString("en-US");
  const duration = (ms: number) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} 分钟` : `${(ms / 1000).toFixed(1)} 秒`;
  const lines = ["**本次大任务用量（已记录小计）**", "", `整轮历时：${duration(report.elapsedMs)}（含工具执行与轮间等待）；子会话：${report.childSessions}。`, "",
    "| 模型 | 请求 / 失败 | 输入 | 输出 | 缓存读 / 写 | token 小计 | 已记录请求耗时 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const row of report.rows) lines.push(`| ${row.model.replaceAll("|", "/")} | ${row.requests} / ${row.failedRequests} | ${number(row.input)} | ${number(row.output)} | ${number(row.cacheRead)} / ${number(row.cacheWrite)} | ${number(row.totalTokens)} | ${row.timedRequests ? duration(row.requestMs) : "未记录"}${row.timedRequests < row.requests && row.timedRequests ? "（部分）" : ""} |`);
  if (!report.rows.length) lines.push("", "没有可用的模型用量记录。");
  lines.push("", "耗时按各模型请求累计，不能相加当作整轮耗时；token 采用 OMP 记录口径，缓存已单列，失败/重试的已记录消耗也计入。统计不是供应商账单，不换算订阅金额。仅覆盖当前任务的所选会话分支，不追溯其他会话或被放弃的分支。");
  lines.push("");
  for (const note of report.notes) lines.push(`- ${note}`);
  return lines.join("\n");
}
