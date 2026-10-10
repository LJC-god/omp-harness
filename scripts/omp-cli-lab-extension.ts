import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
const { default: control, SYSTEM_DB_PATH, setControlTestDb } = await import(`${process.env.HOME ?? process.env.USERPROFILE}/.omp/agent/extensions/omp-control.ts`);

const LAB_ROOT = path.resolve("D:/Labs/omp/omp-field-lab-20260918");
const MARKER = path.join(LAB_ROOT, ".omp-experiment-root");
const CONTROL_DB = path.join(LAB_ROOT, "cli-entry", "controller.sqlite");

function inside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertLab(): void {
	if (!fs.existsSync(MARKER) || fs.readFileSync(MARKER, "utf8").trim() !== "omp-dependency-lab/v1") {
		throw new Error("OMP_FIELD_LAB_MARKER_INVALID");
	}
	const actualRoot = fs.realpathSync.native(LAB_ROOT);
	if (!/^[dD]:[\\/]/.test(actualRoot)) throw new Error(`OMP_FIELD_LAB_NOT_ON_D: ${actualRoot}`);
	let existingParent = path.dirname(CONTROL_DB);
	while (!fs.existsSync(existingParent)) {
		const next = path.dirname(existingParent);
		if (next === existingParent) throw new Error(`OMP_FIELD_LAB_NO_PARENT: ${CONTROL_DB}`);
		existingParent = next;
	}
	if (!inside(fs.realpathSync.native(existingParent), actualRoot)) throw new Error(`OMP_FIELD_LAB_JUNCTION_ESCAPE: ${existingParent}`);
	if (fs.existsSync(CONTROL_DB) && !inside(fs.realpathSync.native(CONTROL_DB), actualRoot)) {
		throw new Error(`OMP_FIELD_LAB_JUNCTION_ESCAPE: ${CONTROL_DB}`);
	}
	const dbParent = path.dirname(CONTROL_DB);
	fs.mkdirSync(dbParent, { recursive: true });
	const actualParent = fs.realpathSync.native(dbParent);
	if (!inside(actualParent, actualRoot)) throw new Error(`OMP_FIELD_LAB_JUNCTION_ESCAPE: ${actualParent}`);
	if (path.resolve(CONTROL_DB).toLowerCase() === path.resolve(SYSTEM_DB_PATH).toLowerCase()) {
		throw new Error("OMP_FIELD_LAB_REFUSES_SYSTEM_DB");
	}
}

/** Exact trusted loader: imports the deployed controller and changes only its test DB binding. */
export default function ompCliLabExtension(pi: ExtensionAPI): void {
	assertLab();
	setControlTestDb(CONTROL_DB);
	control(pi);
}
