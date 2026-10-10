/** Session-monotonic stage ids. Host turn indexes that reset each agent loop are remapped here. */
export class TurnClock {
	private loopBase = 0;
	private highest = -1;
	current = 0;

	noteAgentStart(): void {
		this.loopBase = this.highest + 1;
	}

	noteTurnStart(turnIndex: number): void {
		this.current = this.loopBase + Math.max(0, turnIndex);
		if (this.current > this.highest) this.highest = this.current;
	}

	get started(): number {
		return this.highest + 1;
	}
}
