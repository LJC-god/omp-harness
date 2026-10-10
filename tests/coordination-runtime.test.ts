import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeModule } from "../omp/agent/lib/omp-runtime.ts";

const { findRetryFallbackCandidates, resolveRetryFallbackChainKey } = await import(
	runtimeModule("pi-coding-agent/src/session/retry-fallback-chains.ts"),
);
const { Semaphore } = await import(runtimeModule("pi-coding-agent/src/task/parallel.ts"));

type Config = {
	modelRoles: Record<string, string>;
	task: { maxConcurrency: number; agentModelOverrides: Record<string, string | string[]> };
	retry: { enabled: boolean; fallbackChains: Record<string, string[]> };
};

const root = path.resolve(import.meta.dir, "..");
const configPath = path.join(root, "omp", "agent", "config.yml");
const config = Bun.YAML.parse(fs.readFileSync(configPath, "utf8")) as Config;
// A fixed pre-regression revision keeps this assertion meaningful after the
// candidate configuration is committed; HEAD would become a self-comparison.
const PRIMARY_SELECTOR_BASELINE = "6e7b303ffe050384d8b519732b0270445fdf849f";

function baselineConfig(): Config {
	const result = Bun.spawnSync({
		cmd: ["git", "-C", root, "show", `${PRIMARY_SELECTOR_BASELINE}:omp/agent/config.yml`],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return Bun.YAML.parse(result.stdout.toString()) as Config;
}

function resolveRole(selector: string, seen = new Set<string>()): string {
	if (!selector.startsWith("@")) return selector;
	const role = selector.slice(1);
	if (seen.has(role)) throw new Error(`alias cycle at @${role}`);
	seen.add(role);
	const next = config.modelRoles[role];
	if (!next) throw new Error(`unknown role @${role}`);
	return resolveRole(next, seen);
}

function modelOf(selector: string) {
	const resolved = resolveRole(selector);
	const colon = resolved.lastIndexOf(":");
	const bare = colon === -1 ? resolved : resolved.slice(0, colon);
	const slash = bare.indexOf("/");
	if (slash <= 0 || slash === bare.length - 1) throw new Error(`invalid model selector: ${resolved}`);
	return { provider: bare.slice(0, slash), id: bare.slice(slash + 1) };
}

const available = new Map(
	Object.values(config.modelRoles).map(selector => {
		const model = modelOf(selector);
		return [`${model.provider}\u0000${model.id}`, model] as const;
	}),
);

const context = {
	chains: config.retry.fallbackChains,
	getModelRole: (role: string) => config.modelRoles[role],
	modelLookup: {
		find: (provider: string, id: string) => available.get(`${provider}\u0000${id}`),
		hasProvider: (provider: string) => [...available.values()].some(model => model.provider === provider),
	},
};

function candidates(role: string): string[] {
	const primary = resolveRole(config.modelRoles[role]);
	const model = modelOf(primary);
	const key = resolveRetryFallbackChainKey(context, primary, model, role);
	expect(key).toBe(role);
	return findRetryFallbackCandidates(context, key!, primary, model).map((candidate: { raw: string }) => candidate.raw);
}

test("candidate pins every role's fallback policy while preserving its primary selector and effort", () => {
	const baseline = baselineConfig();
	expect(config.retry.enabled).toBe(true);
	expect(config.retry.fallbackChains.default).toEqual([]);
	for (const [role, selector] of Object.entries(baseline.modelRoles)) {
		expect(config.modelRoles[role]).toBe(selector);
	}
	expect(config.modelRoles.deepseek).toBeDefined();
	for (const role of Object.keys(config.modelRoles)) {
		expect(Object.hasOwn(config.retry.fallbackChains, role)).toBe(true);
		expect(Array.isArray(config.retry.fallbackChains[role])).toBe(true);
	}
});

test("native fallback resolver keeps default empty and honors role-specific chains", () => {
	expect(candidates("default")).toEqual([]);
	expect(candidates("task")).toEqual(["openai-codex/gpt-5.6-terra:high"]);
	expect(candidates("frontend")).toEqual(["openai-codex/gpt-5.6-terra:high"]);
	expect(candidates("implement")).toEqual(["cursor/cursor-grok-4.6-fast"]);
	expect(candidates("repair")).toEqual([]);
	for (const role of Object.keys(config.modelRoles)) {
		if (modelOf(config.modelRoles[role]).provider === "openai-codex" && modelOf(config.modelRoles[role]).id === "gpt-5.6-terra") {
			expect(candidates(role)).toEqual([]);
		}
	}
});

test("native fallback resolution uses the role hint for shared primaries and ignores self-fallbacks", () => {
	const taskPrimary = resolveRole(config.modelRoles.task);
	const implementPrimary = resolveRole(config.modelRoles.implement);
	expect(taskPrimary).toBe(implementPrimary);
	const model = modelOf(taskPrimary);
	expect(resolveRetryFallbackChainKey(context, taskPrimary, model, "task")).toBe("task");
	expect(resolveRetryFallbackChainKey(context, implementPrimary, model, "implement")).toBe("implement");
	const selfContext = { ...context, chains: { default: [], task: [taskPrimary] } };
	expect(findRetryFallbackCandidates(selfContext, "task", taskPrimary, model)).toEqual([]);
	for (const value of Object.values(config.task.agentModelOverrides)) {
		for (const selector of Array.isArray(value) ? value : [value]) expect(resolveRole(selector)).toMatch(/^[^/]+\/.+/);
	}
});

test("installed Semaphore enforces the configured native per-session cap and cleans an aborted waiter", async () => {
	const cap = config.task.maxConcurrency;
	expect(cap).toBe(8);
	const semaphore = new Semaphore(cap);
	for (let index = 0; index < cap; index++) await semaphore.acquire();
	let admitted = false;
	const queued = semaphore.acquire().then(() => {
		admitted = true;
	});
	await Promise.resolve();
	expect(admitted).toBe(false);
	const controller = new AbortController();
	const aborted = semaphore.acquire(controller.signal);
	controller.abort(new Error("expected test cancellation"));
	await expect(aborted).rejects.toThrow("expected test cancellation");
	semaphore.release();
	await queued;
	expect(admitted).toBe(true);
	for (let index = 0; index < cap; index++) semaphore.release();
});
