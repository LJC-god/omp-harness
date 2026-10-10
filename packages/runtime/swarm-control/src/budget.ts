import { ORCH_BUDGET_REASON, STAGE_CAP_REASON, TOTAL_CAP_REASON } from "./schema.ts";
import type { Limits } from "./limits.ts";

export interface Admit {
	ok: true;
	turn: number;
}

export interface Reject {
	ok: false;
	reason: string;
}

/**
 * Admission control for one orchestrator stage.
 * `turn` is session-monotonic. A stage may reserve several native task children
 * at once; the reserve is all-or-nothing so a rejected batch leaves no slots held.
 */
export class BudgetGuard {
	readonly stageCounts = new Map<number, number>();
	assigned = 0;
	private readonly limits: Pick<Limits, "orchSteps" | "perStage" | "totalAgents">;

	constructor(limits: Pick<Limits, "orchSteps" | "perStage" | "totalAgents">) {
		this.limits = limits;
	}

	tryReserve(turn: number): Admit | Reject {
		return this.reserveBatch(turn, 1);
	}

	reserveBatch(turn: number, count: number): Admit | Reject {
		if (!Number.isInteger(count) || count < 1) return { ok: false, reason: STAGE_CAP_REASON };
		if (turn >= this.limits.orchSteps) return { ok: false, reason: ORCH_BUDGET_REASON };
		if ((this.stageCounts.get(turn) ?? 0) + count > this.limits.perStage) {
			return { ok: false, reason: STAGE_CAP_REASON };
		}
		if (this.assigned + count > this.limits.totalAgents) return { ok: false, reason: TOTAL_CAP_REASON };
		this.stageCounts.set(turn, (this.stageCounts.get(turn) ?? 0) + count);
		this.assigned += count;
		return { ok: true, turn };
	}
}
