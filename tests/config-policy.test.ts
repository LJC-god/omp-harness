import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Policy invariants for the repository copy of the global OMP configuration.
// See openspec/changes/optimize-global-config/specs/global-config-policy/spec.md.

const root = path.resolve(import.meta.dir, "..", "omp", "agent");
const rulesDir = path.join(root, "rules");
const agentsDir = path.join(root, "agents");

type Config = {
	modelRoles?: Record<string, string>;
	enabledModels?: string[];
	task?: { softRequestBudget?: number; maxConcurrency?: number; agentModelOverrides?: Record<string, string> };
	retry?: { fallbackChains?: Record<string, string[]> };
};

function readConfig(): Config {
	return Bun.YAML.parse(fs.readFileSync(path.join(root, "config.yml"), "utf8")) as Config;
}

function frontmatter(file: string): Record<string, unknown> {
	const text = fs.readFileSync(file, "utf8");
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) throw new Error(`missing frontmatter: ${file}`);
	return Bun.YAML.parse(match[1]) as Record<string, unknown>;
}

function effort(selector: string): string | undefined {
	const idx = selector.lastIndexOf(":");
	return idx === -1 ? undefined : selector.slice(idx + 1);
}

function resolveRole(config: Config, selector: string, seen = new Set<string>()): string {
	if (!selector.startsWith("@")) return selector;
	const role = selector.slice(1);
	if (seen.has(role)) throw new Error(`alias cycle at @${role}`);
	seen.add(role);
	const next = config.modelRoles?.[role];
	if (!next) throw new Error(`unknown role @${role}`);
	return resolveRole(config, next, seen);
}

test("coordinator-only orchestrator rule is scoped to the main session and stays always-on", () => {
	const fm = frontmatter(path.join(rulesDir, "main-agent-orchestrator.md"));
	expect(fm.alwaysApply).toBe(true);
	expect(fm.agents).toEqual(["main"]);
});

test("current workflow baseline keeps PLAN before dependent work and diagrams scoped to product complexity", () => {
	const orchestrator = fs.readFileSync(path.join(rulesDir, "main-agent-orchestrator.md"), "utf8");
	const planning = fs.readFileSync(path.join(root, "notes", "product-planning.md"), "utf8");
	const evidence = fs.readFileSync(path.join(root, "notes", "verification-evidence.md"), "utf8");
	const purple = fs.readFileSync(path.join(agentsDir, "purple-reviewer.md"), "utf8");
	const baseline = fs.readFileSync(path.join(root, "notes", "workflow-baseline-v1-20260921.md"), "utf8");
	expect(orchestrator).toContain("do not dispatch a separate plan-transcription author");
	expect(planning).toContain("Do not create a separate plan-transcription assignment");
	for (const policy of [orchestrator, planning, evidence, baseline]) {
		expect(policy).toMatch(/Purple PLAN[\s\S]{0,1000}before dependent implementation/i);
	}
	expect(purple).toMatch(/PLAN:[\s\S]{0,1000}before dependent implementation/i);
	expect(baseline).toContain("Text is the contract authority.");
	expect(planning).toMatch(/Simple single-owner work may use one compact view or no new diagram/i);
	expect(purple).toMatch(/simple work may use its sufficient existing representation/i);
	expect(baseline).toContain("no separate permanent or mandatory diagram author exists");
	expect(evidence).toMatch(/does not wait for rendered diagrams/i);
});

test("baseline v1 preserves bounded refill, full final collection, and incremental current-source receipts", () => {
	const baseline = fs.readFileSync(path.join(root, "notes", "workflow-baseline-v1-20260921.md"), "utf8");
	const evidence = fs.readFileSync(path.join(root, "notes", "verification-evidence.md"), "utf8");
	const runner = fs.readFileSync(path.join(root, "notes", "task-plan-automation.md"), "utf8");
	expect(baseline).toContain("Keep at most four active writing authors.");
	expect(baseline).toContain("there is no automatic retry, cleanup, repair continuation, or resume");
	expect(baseline).toContain("Purple DELIVERY collects and reconciles");
	expect(baseline).toContain("every mandatory final role issues a new current-source incremental receipt");
	expect(baseline).toContain('executionPolicy: "integration-v1"');
	expect(baseline).toContain('requiredGates: ["integration_check"]');
	expect(evidence).toContain("Do not cancel an accepted final role because another review fails");
	expect(evidence).toContain("every mandatory role to produce a new current-source incremental receipt");
	expect(runner).toContain("refills a free slot with the next dependency-ready, non-conflicting task");
});

test("product discovery and UI handoff stay concrete without adding a controller", () => {
	const orchestrator = fs.readFileSync(path.join(rulesDir, "main-agent-orchestrator.md"), "utf8");
	const planning = fs.readFileSync(path.join(root, "notes", "product-planning.md"), "utf8");
	const catalog = fs.readFileSync(path.join(root, "notes", "architecture-catalog.md"), "utf8");
	const routing = fs.readFileSync(path.join(root, "notes", "skill-routing.md"), "utf8");
	expect(orchestrator).toContain("one-sentence request to build a new complete product");
	expect(orchestrator).toContain("pm-worker` full product definition by default");
	expect(orchestrator).toContain("maps selected innovations to implementation and observable acceptance");
	expect(planning).toContain("The foundation handoff is concrete");
	expect(planning).toContain("a task table or a later reassessment alone is not dispatch");
	expect(catalog).toContain("Tailwind, shadcn/ui configured for the Radix base, and `lucide-react`");
	expect(catalog).toContain("does not provide the Tailwind, shadcn/Radix, or Lucide baseline");
	expect(routing).toContain("`ui-ux-design-audit` has two separate uses");
});

test("new integration runs use one frozen root-observed check while legacy and high-risk routes stay frozen", () => {
	const procedure = fs.readFileSync(path.join(root, "commands", "coding-procedure.md"), "utf8");
	const worktree = fs.readFileSync(path.join(root, "notes", "worktree-delivery.md"), "utf8");
	const graph = fs.readFileSync(path.join(root, "notes", "task-graph.md"), "utf8");
	const queue = fs.readFileSync(path.join(root, "notes", "merge-queue.md"), "utf8");
	for (const policy of [procedure, worktree, graph, queue]) expect(policy).toContain("integration-v1");
	expect(procedure).toContain("frozen argv `checkCommand`");
	expect(procedure).toContain("High-risk work rejects this policy");
	expect(worktree).toContain("High-risk, omitted-policy, and already-frozen runs retain their existing required gates");
	expect(graph).toContain("legacy/frozen runs");
	expect(queue).toContain("legacy required gates");
});

test("harness router remains always-on for every agent", () => {
	const fm = frontmatter(path.join(rulesDir, "harness-router.md"));
	expect(fm.alwaysApply).toBe(true);
	expect(fm.agents).toBeUndefined();
});

test("communication guidance is a single always-on rule and the two legacy rules are gone", () => {
	const names = fs.readdirSync(rulesDir).sort();
	expect(names).toContain("communication.md");
	expect(names).not.toContain("caveman-default.md");
	expect(names).not.toContain("chinese-language-preference.md");
	const fm = frontmatter(path.join(rulesDir, "communication.md"));
	expect(fm.alwaysApply).toBe(true);
	expect(fm.agents).toBeUndefined();
	const body = fs.readFileSync(path.join(rulesDir, "communication.md"), "utf8");
	for (const phrase of [
		"Use Chinese for every response and every question to the user",
		"Use English for maintained OMP execution rules",
		"Default is Caveman lite",
		"/caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|off",
		"Keep code, API names, CLI commands, identifiers, and exact error messages unchanged",
		"Persisted documents, code comments, reports, issues and external messages use ordinary professional prose",
		"Use full clear sentences for security, destructive actions, complex instructions",
		"When the user writes Cantonese, reply in Cantonese",
		"English Conventional Commit messages stay English",
		"never translate Chinese UI strings into English",
		"Classical Chinese only on explicit wenyan modes",
		"Never add a mode announcement or duplicate answer",
		"This style never suppresses authorization checks, limitations, verification results or user-requested detail",
		"Switch to another language only when the user explicitly requests it",
		"Remove filler, repeated summaries and decorative formatting; do not invent abbreviations or break grammar to shorten text",
	]) {
		expect(body).toContain(phrase);
	}
});

test("commit and tiny roles do not run at maximum effort", () => {
	const config = readConfig();
	for (const role of ["commit", "tiny"]) {
		const selector = config.modelRoles?.[role];
		expect(selector).toBeDefined();
		expect(["low", "medium"]).toContain(effort(selector as string));
	}
});

test("subagent soft request budget guard is enabled within the bundled ceiling", () => {
	const budget = readConfig().task?.softRequestBudget;
	expect(typeof budget).toBe("number");
	expect(budget as number).toBeGreaterThan(0);
	expect(budget as number).toBeLessThanOrEqual(200);
});

test("native task concurrency is a per-session ceiling", () => {
	expect(readConfig().task?.maxConcurrency).toBe(8);
});

test("every configured role has an explicit fallback chain of enabled exact selectors", () => {
	const config = readConfig();
	const chains = config.retry?.fallbackChains ?? {};
	const enabled = new Set(config.enabledModels ?? []);
	expect(Object.keys(chains).sort()).toEqual(Object.keys(config.modelRoles ?? {}).sort());
	expect(chains.default).toEqual([]);
	for (const role of Object.keys(config.modelRoles ?? {})) {
		const chain = chains[role];
		expect(Array.isArray(chain)).toBe(true);
		for (const selector of chain as string[]) {
			expect(selector.startsWith("@")).toBe(false);
			const base = selector.includes(":") ? selector.slice(0, selector.lastIndexOf(":")) : selector;
			expect(enabled.has(base)).toBe(true);
		}
	}
});

test("agent definitions with a model field use a configured role alias", () => {
	const config = readConfig();
	for (const name of fs.readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
		const fm = frontmatter(path.join(agentsDir, name));
		if (typeof fm.model !== "string") continue;
		expect(fm.model.startsWith("@")).toBe(true);
		expect(config.modelRoles?.[fm.model.slice(1)]).toBeDefined();
	}
	expect(config.task?.agentModelOverrides?.["deepseek-worker"]).toBe("@deepseek");
	expect(resolveRole(config, "@deepseek")).toBe("opencode-go/deepseek-v4.1-flash:high");
});

test("review and aesthetic aliases resolve to the previously pinned Terra selector", () => {
	const config = readConfig();
	expect(resolveRole(config, "@review")).toBe("openai-codex/gpt-5.6-terra:high");
	expect(resolveRole(config, "@aesthetic")).toBe("openai-codex/gpt-5.6-terra:high");
	for (const name of ["verifier.md", "experience-reviewer.md", "purple-reviewer.md"]) {
		expect(frontmatter(path.join(agentsDir, name)).model).toBe("@review");
	}
	expect(config.task?.agentModelOverrides?.["purple-reviewer"]).toBe("@review");
	expect(frontmatter(path.join(agentsDir, "aesthetic-reviewer.md")).model).toBe("@aesthetic");
});

test("product document reviewers stay native-only and outside final product acceptance", () => {
	const router = fs.readFileSync(path.join(rulesDir, "harness-router.md"), "utf8");
	const continuity = fs.readFileSync(path.join(root, "extensions", "session-continuity.ts"), "utf8");
	const config = readConfig();
	for (const name of ["product-reviewer", "product-rules-reviewer"]) {
		expect(frontmatter(path.join(agentsDir, `${name}.md`)).model).toBe("@review");
		expect(config.task?.agentModelOverrides?.[name]).toBe("@review");
		expect(router).toContain(name);
	}
	expect(continuity).not.toContain('"product-reviewer"');
	expect(continuity).not.toContain('"product-rules-reviewer"');
});

test("repair worker has its own Terra alias and native override", () => {
	const config = readConfig();
	expect(resolveRole(config, "@repair")).toBe("openai-codex/gpt-5.6-terra:high");
	expect(config.task?.agentModelOverrides?.["repair-worker"]).toBe("@repair");
	expect(frontmatter(path.join(agentsDir, "repair-worker.md")).model).toBe("@repair");
	expect(config.retry?.fallbackChains?.repair).toEqual([]);
});
