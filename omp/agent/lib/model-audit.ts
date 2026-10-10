import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Database } from "bun:sqlite";

type Config = {
  modelRoles?: Record<string, string | string[]>;
  enabledModels?: string[];
  retry?: { fallbackChains?: Record<string, string | string[]> };
  task?: { agentModelOverrides?: Record<string, string | string[]> };
};
type Source = "role" | "override" | "agent" | "enabled" | "fallback";
export type ModelSelector = { source: Source; name: string; value: string; selector?: string; role?: string };
export type AuditFailure = { code: string; source: Source; name: string; value: string; detail: string };
export type ModelAudit = {
  ok: boolean;
  parse: { ok: boolean; error?: string };
  catalog: { ok: boolean; selectorCount: number; sources: string[]; failures: AuditFailure[] };
  auth: { status: "not_checked"; detail: string };
  live: { status: "not_run"; detail: string };
  selectors: ModelSelector[];
};

const levels = new Set(["low", "medium", "high", "xhigh", "max", "off", "auto", "inherit"]);
const selectorWithoutThinking = (value: string) => {
  const colon = value.lastIndexOf(":");
  return colon > value.indexOf("/") && levels.has(value.slice(colon + 1)) ? value.slice(0, colon) : value;
};
const values = (value: string | string[] | undefined) => value === undefined ? [] : Array.isArray(value) ? value : [value];

export async function readExactCatalog(options: { catalogPath: string; cachePath?: string }): Promise<{ selectors: Set<string>; sources: string[] }> {
  const selectors = new Set<string>();
  const sources: string[] = [];
  const catalog = JSON.parse(await fs.readFile(options.catalogPath, "utf8")) as Record<string, Record<string, unknown>>;
  for (const [provider, models] of Object.entries(catalog)) for (const id of Object.keys(models)) selectors.add(`${provider}/${id}`);
  sources.push(options.catalogPath);
  if (!options.cachePath) return { selectors, sources };
  try {
    const db = new Database(options.cachePath, { readonly: true });
    try {
      const rows = db.query<{ models: string }, []>("SELECT models FROM model_cache").all();
      for (const row of rows) for (const model of JSON.parse(row.models) as Array<{ provider?: unknown; id?: unknown }>) {
        if (typeof model.provider === "string" && typeof model.id === "string") selectors.add(`${model.provider}/${model.id}`);
      }
      sources.push(options.cachePath);
    } finally { db.close(); }
  } catch { /* A missing/stale cache is observation-only; the bundled catalog remains authoritative for this offline check. */ }
  return { selectors, sources };
}

async function pinnedAgents(agentsRoot: string): Promise<ModelSelector[]> {
  const found: ModelSelector[] = [];
  const visit = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const text = await fs.readFile(file, "utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
        const match = frontmatter && /^model:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(frontmatter);
        if (match?.[1]) found.push({ source: "agent", name: path.relative(agentsRoot, file).replaceAll("\\", "/"), value: match[1].trim() });
      }
    }
  };
  await visit(agentsRoot);
  return found;
}

export async function auditModelSelectors(options: { configPath: string; agentsRoot: string; catalogPath: string; cachePath?: string }): Promise<ModelAudit> {
  let config: Config;
  try { config = Bun.YAML.parse(await fs.readFile(options.configPath, "utf8")) as Config; }
  catch (error) { return { ok: false, parse: { ok: false, error: String(error) }, catalog: { ok: false, selectorCount: 0, sources: [], failures: [] }, auth: { status: "not_checked", detail: "配置未解析，未读取凭据。" }, live: { status: "not_run", detail: "未发送模型请求。" }, selectors: [] }; }
  const catalog = await readExactCatalog({ catalogPath: options.catalogPath, cachePath: options.cachePath });
  const selectors: ModelSelector[] = [];
  for (const [name, value] of Object.entries(config.modelRoles ?? {})) for (const item of values(value)) selectors.push({ source: "role", name, value: item });
  for (const [index, value] of values(config.enabledModels).entries()) selectors.push({ source: "enabled", name: `enabledModels[${index}]`, value });
  for (const [name, value] of Object.entries(config.task?.agentModelOverrides ?? {})) for (const item of values(value)) selectors.push({ source: "override", name, value: item });
  const failures: AuditFailure[] = [];
  for (const [name, value] of Object.entries(config.retry?.fallbackChains ?? {})) {
    // Bare keys are model roles; slash-qualified keys select a concrete model or a runtime wildcard pattern.
    if (name.includes("/")) selectors.push({ source: "fallback", name: `retry.fallbackChains.${name}`, value: name });
    for (const [index, item] of values(value).entries()) selectors.push({ source: "fallback", name: `retry.fallbackChains.${name}[${index}]`, value: item });
  }
  try { selectors.push(...await pinnedAgents(options.agentsRoot)); }
  catch (error) { failures.push({ code: "AGENT_DISCOVERY_FAILED", source: "agent", name: options.agentsRoot, value: "", detail: `无法读取代理定义：${String(error)}` }); }
  const resolveRole = (role: string, chain: string[]): string[] | undefined => {
    const configured = values(config.modelRoles?.[role]);
    if (!configured.length) return;
    const resolved: string[] = [];
    for (const value of configured) {
      if (!value.startsWith("@")) { resolved.push(value); continue; }
      const next = selectorWithoutThinking(value.slice(1));
      if (chain.includes(next)) return;
      const nested = resolveRole(next, [...chain, next]);
      if (!nested) return;
      resolved.push(...nested);
    }
    return resolved;
  };
  for (const item of selectors) {
    if (item.value.startsWith("@")) {
      const role = selectorWithoutThinking(item.value.slice(1));
      const resolved = resolveRole(role, [role]);
      if (!resolved) failures.push({ code: "ROLE_UNRESOLVED", ...item, detail: `模型角色 @${role} 不存在或存在循环引用。` });
      else {
        item.role = role;
        for (const value of resolved) {
          const selector = selectorWithoutThinking(value);
          if (!catalog.selectors.has(selector)) failures.push({ code: "MODEL_EXACT_MISMATCH", ...item, selector, detail: `角色 @${role} 最终解析为 ${selector}；未在安装目录的精确目录中找到它。` });
        }
      }
      continue;
    }
    item.selector = selectorWithoutThinking(item.value);
    // OMP expands model/provider wildcards at runtime; they are not exact ids.
    if (item.selector.includes("*")) continue;
    if (!catalog.selectors.has(item.selector)) failures.push({ code: "MODEL_EXACT_MISMATCH", ...item, detail: `未在安装目录的精确目录中找到 ${item.selector}；不会使用模糊匹配。` });
  }
  return { ok: failures.length === 0, parse: { ok: true }, catalog: { ok: failures.length === 0, selectorCount: catalog.selectors.size, sources: catalog.sources, failures }, auth: { status: "not_checked", detail: "离线审核未读取或输出认证材料。" }, live: { status: "not_run", detail: "离线审核未发送模型请求。" }, selectors };
}
