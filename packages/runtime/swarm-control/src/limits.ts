export interface RampUp {
	initial: number;
	intervalMs: number;
}

export interface Limits {
	orchSteps: number;
	subSteps: number;
	perStage: number;
	totalAgents: number;
	concurrency: number;
	answerBytes: number;
	rampUp: RampUp | null;
	workerTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
	orchSteps: 15,
	subSteps: 50,
	perStage: 16,
	totalAgents: 64,
	concurrency: 8,
	answerBytes: 6 * 1024,
	rampUp: null,
	workerTimeoutMs: 0,
};

export interface LimitSources {
	flag?: (name: string) => boolean | string | undefined;
	env?: NodeJS.ProcessEnv;
	override?: Partial<Limits>;
}

function positiveInt(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value !== "string" || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function nonNegativeInt(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	if (typeof value !== "string" || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) return fallback;
	return parsed;
}

function envValue(env: NodeJS.ProcessEnv, ompName: string, parlName: string): string | undefined {
	if (env[ompName] !== undefined) return env[ompName];
	return env[parlName];
}

export function resolveLimits(sources: LimitSources = {}): Limits {
	const env = sources.env ?? {};
	const flag = sources.flag;
	const pick = (flagName: string, ompName: string, parlName: string, fallback: number, parse = positiveInt) => {
		const fromFlag = flag?.(flagName);
		if (typeof fromFlag === "string" && fromFlag.trim() !== "") return parse(fromFlag, fallback);
		const fromEnv = envValue(env, ompName, parlName);
		if (fromEnv !== undefined) return parse(fromEnv, fallback);
		return fallback;
	};

	const rampRequested =
		flag?.("swarm-ramp-up") === true ||
		env.OMP_SWARM_RAMP_UP === "1" ||
		env.OMP_SWARM_RAMP_UP === "true" ||
		env.PARL_SWARM_RAMP_UP === "1" ||
		env.PARL_SWARM_RAMP_UP === "true";

	const limits: Limits = {
		orchSteps: pick("swarm-orch-steps", "OMP_SWARM_ORCH_STEPS", "PARL_SWARM_ORCH_STEPS", DEFAULT_LIMITS.orchSteps),
		subSteps: pick("swarm-sub-steps", "OMP_SWARM_SUB_STEPS", "PARL_SWARM_SUB_STEPS", DEFAULT_LIMITS.subSteps),
		perStage: pick("swarm-per-stage", "OMP_SWARM_PER_STAGE", "PARL_SWARM_PER_STAGE", DEFAULT_LIMITS.perStage),
		totalAgents: pick("swarm-total-agents", "OMP_SWARM_TOTAL_AGENTS", "PARL_SWARM_TOTAL_AGENTS", DEFAULT_LIMITS.totalAgents),
		concurrency: pick("swarm-concurrency", "OMP_SWARM_CONCURRENCY", "PARL_SWARM_CONCURRENCY", DEFAULT_LIMITS.concurrency),
		answerBytes: pick("swarm-answer-bytes", "OMP_SWARM_ANSWER_BYTES", "PARL_SWARM_ANSWER_BYTES", DEFAULT_LIMITS.answerBytes),
		workerTimeoutMs: pick(
			"swarm-worker-timeout-ms",
			"OMP_SWARM_WORKER_TIMEOUT_MS",
			"PARL_SWARM_WORKER_TIMEOUT_MS",
			DEFAULT_LIMITS.workerTimeoutMs,
			nonNegativeInt,
		),
		rampUp: rampRequested
			? {
				initial: pick("swarm-ramp-initial", "OMP_SWARM_RAMP_INITIAL", "PARL_SWARM_RAMP_INITIAL", 5),
				intervalMs: pick("swarm-ramp-interval-ms", "OMP_SWARM_RAMP_INTERVAL_MS", "PARL_SWARM_RAMP_INTERVAL_MS", 700),
			}
			: null,
	};

	return { ...limits, ...cleanOverride(sources.override) };
}

function cleanOverride(override: Partial<Limits> | undefined): Partial<Limits> {
	if (!override) return {};
	const next: Partial<Limits> = {};
	for (const key of ["orchSteps", "subSteps", "perStage", "totalAgents", "concurrency", "answerBytes", "workerTimeoutMs", "rampUp"] as const) {
		if (override[key] !== undefined) next[key] = override[key] as never;
	}
	return next;
}

export function swarmRequested(env: NodeJS.ProcessEnv = process.env, flag?: boolean): boolean {
	if (flag === true) return true;
	return env.OMP_SWARM === "1" || env.OMP_SWARM === "true";
}
