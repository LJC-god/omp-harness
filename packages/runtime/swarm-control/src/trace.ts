import * as fs from "node:fs";
import * as path from "node:path";

export class TraceLog {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	}

	write(event: Record<string, unknown>): void {
		const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
		fs.appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
	}
}
