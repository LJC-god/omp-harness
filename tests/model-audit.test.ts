import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { auditModelSelectors } from "../omp/agent/lib/model-audit.ts";

function fixture(config: string, agent = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-model-audit-"));
  fs.mkdirSync(path.join(root, "agents"));
  fs.writeFileSync(path.join(root, "config.yml"), config);
  fs.writeFileSync(path.join(root, "catalog.json"), JSON.stringify({ provider: { exact: {} } }));
  if (agent) fs.writeFileSync(path.join(root, "agents", "pinned.md"), agent);
  return root;
}

test("model audit accepts exact selectors and role aliases", async () => {
  const root = fixture("modelRoles:\n  role: provider/exact:high\ntask:\n  agentModelOverrides:\n    worker: '@role'\n");
  const report = await auditModelSelectors({ configPath: path.join(root, "config.yml"), agentsRoot: path.join(root, "agents"), catalogPath: path.join(root, "catalog.json") });
  expect(report.ok).toBe(true);
  expect(report.auth.status).toBe("not_checked");
  expect(report.live.status).toBe("not_run");
});

test("model audit rejects an exact provider/id mismatch instead of fuzzy resolution", async () => {
  const root = fixture("modelRoles:\n  role: provider/exactish:high\n", "---\nname: pinned\nmodel: provider/exactish:high\n---\n");
  const report = await auditModelSelectors({ configPath: path.join(root, "config.yml"), agentsRoot: path.join(root, "agents"), catalogPath: path.join(root, "catalog.json") });
  expect(report.ok).toBe(false);
  expect(report.catalog.failures.map(item => item.code)).toEqual(["MODEL_EXACT_MISMATCH", "MODEL_EXACT_MISMATCH"]);
});

test("model audit rejects an alias cycle because it has no final exact selector", async () => {
  const root = fixture("modelRoles:\n  first: '@second'\n  second: '@first'\ntask:\n  agentModelOverrides:\n    worker: '@first'\n");
  const report = await auditModelSelectors({ configPath: path.join(root, "config.yml"), agentsRoot: path.join(root, "agents"), catalogPath: path.join(root, "catalog.json") });
  expect(report.ok).toBe(false);
  expect(report.catalog.failures.every(item => item.code === "ROLE_UNRESOLVED")).toBe(true);
});

test("model audit checks enabled and concrete fallback selectors but permits OMP wildcard patterns", async () => {
  const root = fixture("enabledModels:\n  - provider/exact\n  - provider/*\nretry:\n  fallbackChains:\n    provider/exactish:\n      - provider/exact:high\n    provider/*:\n      - provider/*\n    role:\n      - provider/exactish\n");
  const report = await auditModelSelectors({ configPath: path.join(root, "config.yml"), agentsRoot: path.join(root, "agents"), catalogPath: path.join(root, "catalog.json") });
  expect(report.ok).toBe(false);
  expect(report.catalog.failures).toContainEqual(expect.objectContaining({ code: "MODEL_EXACT_MISMATCH", source: "fallback", name: "retry.fallbackChains.role[0]", selector: "provider/exactish" }));
  expect(report.catalog.failures).toContainEqual(expect.objectContaining({ code: "MODEL_EXACT_MISMATCH", source: "fallback", name: "retry.fallbackChains.provider/exactish", selector: "provider/exactish" }));
  expect(report.selectors.filter(item => item.source === "enabled").map(item => item.value)).toEqual(["provider/exact", "provider/*"]);
});

test("model audit fails when the configured agent definitions cannot be read", async () => {
  const root = fixture("enabledModels:\n  - provider/exact\n");
  const report = await auditModelSelectors({ configPath: path.join(root, "config.yml"), agentsRoot: path.join(root, "missing-agents"), catalogPath: path.join(root, "catalog.json") });
  expect(report.ok).toBe(false);
  expect(report.catalog.failures).toContainEqual(expect.objectContaining({ code: "AGENT_DISCOVERY_FAILED", source: "agent" }));
});
