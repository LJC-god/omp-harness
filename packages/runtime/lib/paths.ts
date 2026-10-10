import * as fs from "node:fs";
import * as path from "node:path";

function unset(name: string): never {
	throw new Error(`${name}_UNSET`);
}

export function ompHome(): string {
	const value = process.env.OMP_HOME;
	if (!value || !path.isAbsolute(value)) unset("OMP_HOME");
	return path.resolve(value);
}

export function dataRoot(): string {
	const value = process.env.OMP_DATA_ROOT;
	if (!value || !path.isAbsolute(value)) unset("OMP_DATA_ROOT");
	return path.resolve(value);
}

export function controlDbFile(): string {
	const explicit = process.env.OMP_CONTROL_DB;
	if (explicit) {
		if (!path.isAbsolute(explicit)) throw new Error("OMP_CONTROL_DB_NOT_ABSOLUTE");
		return path.resolve(explicit);
	}
	return path.join(ompHome(), "agent", "orchestration.sqlite");
}

export function worktreesRoot(): string {
	return path.join(dataRoot(), "worktrees");
}

export function archiveRootPath(): string {
	return path.join(dataRoot(), "archives");
}

export function indexDirPath(): string {
	const explicit = process.env.OMP_ARCHIVE_INDEX_DIR;
	if (explicit) {
		if (!path.isAbsolute(explicit)) throw new Error("OMP_ARCHIVE_INDEX_DIR_NOT_ABSOLUTE");
		return path.resolve(explicit);
	}
	return path.join(dataRoot(), "github", "archive-index");
}

export function reservedTrees(): string[] {
	const root = dataRoot();
	return [
		root,
		path.join(root, "registry"),
		path.join(root, "archives"),
		path.join(root, "github"),
		path.join(root, "projects"),
		path.join(root, "github", "archive-index"),
		path.join(root, "worktrees"),
	];
}

/** Windows drive letter of OMP_DATA_ROOT. Empty on platforms without a drive letter. */
export function dataDrive(): string {
	const match = dataRoot().match(/^([A-Za-z]):/);
	return match ? match[1].toUpperCase() : "";
}

/**
 * Lexical confinement for non-Windows hosts. Rejects paths outside OMP_DATA_ROOT
 * and any symlink already present on the path. Creates the target only when asked.
 */
export function confineDataPath(abs: string, create = false): string {
	const root = dataRoot();
	const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
	if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error("OMP_DATA_ROOT_MISSING");
	}
	const target = path.resolve(abs);
	const rel = path.relative(root, target);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("PATH_ESCAPE");
	const parts = rel === "" ? [] : rel.split(path.sep).filter(Boolean);
	let cur = root;
	for (const part of parts) {
		if (part === "." || part === "..") throw new Error("PATH_ESCAPE");
		cur = path.join(cur, part);
		const stat = fs.lstatSync(cur, { throwIfNoEntry: false });
		if (stat?.isSymbolicLink()) throw new Error("PATH_ESCAPE");
	}
	if (create) fs.mkdirSync(target, { recursive: true });
	return target;
}
