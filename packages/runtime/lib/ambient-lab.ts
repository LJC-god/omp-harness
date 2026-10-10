import * as fs from "node:fs";
import * as path from "node:path";

export const AMBIENT_LAB_ENV = "OMP_AMBIENT_LAB_ROOT";
export const AMBIENT_LAB_MARKER = ".omp-automation-lab-root";
export const AMBIENT_LAB_MARKER_VALUE = "omp-automation-lab/v1";

export type AmbientLabPaths = Readonly<{
	root: string;
	controllerDb: string;
	archiveRoot: string;
	sessionsRoot: string;
	workRoot: string;
}>;

function fail(message: string): never {
	throw new Error(`OMP_AMBIENT_LAB_${message}`);
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase();
}

function isUnder(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertExistingPathIsDirect(abs: string, label: string): string {
	const lexical = path.resolve(abs);
	const stat = fs.lstatSync(lexical, { throwIfNoEntry: false });
	if (!stat) fail(`${label}_MISSING`);
	if (stat.isSymbolicLink()) fail(`${label}_REPARSE`);
	const real = fs.realpathSync.native(lexical);
	if (!samePath(real, lexical)) fail(`${label}_JUNCTION_ESCAPE`);
	return real;
}

function resolveAmbientLabPaths(): AmbientLabPaths | null {
	if (!(AMBIENT_LAB_ENV in process.env)) return null;
	const configured = process.env[AMBIENT_LAB_ENV];
	if (!configured || !configured.trim()) fail("ROOT_EMPTY");
	if (!path.isAbsolute(configured)) fail("ROOT_NOT_ABSOLUTE");
	const root = assertExistingPathIsDirect(configured, "ROOT");
	if (!/^D:[\\/]/i.test(root)) fail("ROOT_NOT_D");
	if (!fs.statSync(root).isDirectory()) fail("ROOT_NOT_DIRECTORY");
	const marker = path.join(root, AMBIENT_LAB_MARKER);
	if (!fs.statSync(marker, { throwIfNoEntry: false })?.isFile()
		|| fs.readFileSync(marker, "utf8").trim() !== AMBIENT_LAB_MARKER_VALUE) fail("MARKER_INVALID");
	const paths: AmbientLabPaths = {
		root,
		controllerDb: path.join(root, "ambient", "controller", "orchestration.sqlite"),
		archiveRoot: path.join(root, "ambient", "archives"),
		sessionsRoot: path.join(root, "ambient", "sessions"),
		workRoot: path.join(root, "ambient", "archive-work"),
	};
	for (const [label, target] of Object.entries(paths)) {
		if (label !== "root" && !isUnder(root, target)) fail(`PATH_ESCAPE_${label.toUpperCase()}`);
	}
	return Object.freeze(paths);
}

// Resolve once so a later environment mutation cannot move an already-loaded extension.
const LAB_PATHS = resolveAmbientLabPaths();

export function ambientLabPaths(): AmbientLabPaths | null {
	return LAB_PATHS;
}

/** Reject an existing junction in the path that will be created beneath the pinned lab root. */
export function assertAmbientLabTarget(target: string): string {
	const lab = LAB_PATHS;
	if (!lab) fail("NOT_ENABLED");
	const lexical = path.resolve(target);
	if (!isUnder(lab.root, lexical)) fail("PATH_ESCAPE");
	let parent = lexical;
	while (!fs.existsSync(parent)) {
		const next = path.dirname(parent);
		if (next === parent) fail("NO_PARENT");
		parent = next;
	}
	const pinnedParent = assertExistingPathIsDirect(parent, "PARENT");
	if (!isUnder(lab.root, pinnedParent)) fail("PARENT_ESCAPE");
	if (fs.existsSync(lexical)) {
		const pinnedTarget = assertExistingPathIsDirect(lexical, "TARGET");
		if (!isUnder(lab.root, pinnedTarget)) fail("TARGET_ESCAPE");
	}
	return lexical;
}
