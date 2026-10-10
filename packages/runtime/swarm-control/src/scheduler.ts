import type { RampUp } from "./limits.ts";

export class AbortError extends Error {
	steps = 0;
	toolCalls = 0;

	constructor(message = "Subagent was aborted") {
		super(message);
		this.name = "AbortError";
	}
}

export interface SchedulerOptions {
	concurrency: number;
	rampUp?: RampUp | null;
	sleep?: (ms: number) => Promise<void>;
}

/** Local concurrency cap. Native task.maxConcurrency still applies inside each spawn. */
export class Scheduler {
	readonly cap: number;
	inUse = 0;
	highWater = 0;
	private launchIndex = 0;
	private readonly waiters: Array<() => void> = [];
	private readonly rampUp: RampUp | null;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: SchedulerOptions) {
		if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
			throw new Error("concurrency cap must be a positive integer");
		}
		this.cap = options.concurrency;
		this.rampUp = options.rampUp ?? null;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		const ticket = this.launchIndex;
		this.launchIndex += 1;
		await this.waitRamp(ticket, signal);
		await this.waitSlot(signal);
		return () => this.release();
	}

	private async waitRamp(ticket: number, signal?: AbortSignal): Promise<void> {
		const ramp = this.rampUp;
		if (!ramp || ticket < ramp.initial) return;
		const delay = (ticket - ramp.initial + 1) * ramp.intervalMs;
		await abortableDelay(delay, this.sleep, signal);
	}

	private waitSlot(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (this.inUse < this.cap) {
			this.take();
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			const grant = () => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => {
				if (settled) return;
				settled = true;
				const index = this.waiters.indexOf(grant);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new AbortError());
			};
			this.waiters.push(grant);
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	private take(): void {
		this.inUse += 1;
		if (this.inUse > this.highWater) this.highWater = this.inUse;
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.inUse = Math.max(0, this.inUse - 1);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AbortError();
}

async function abortableDelay(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (ms <= 0) return;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new AbortError());
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([sleep(ms), aborted]);
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}
