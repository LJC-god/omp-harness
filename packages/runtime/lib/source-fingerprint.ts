import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function fail(message: string): never {
	throw new Error(`SOURCE_SNAPSHOT: ${message}`);
}

function resolveGit(): string {
	if (process.platform === "win32") {
		const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((value): value is string => !!value);
		for (const root of roots) {
			for (const rel of ["Git/cmd/git.exe", "Git/bin/git.exe"]) {
				const candidate = path.join(root, rel);
				if (fs.existsSync(candidate)) return candidate;
			}
		}
		fail("GIT_UNAVAILABLE");
	}
	return "git";
}

function gitEnv(git: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.platform === "win32" ? path.dirname(git) : process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		LANG: process.env.LANG ?? "C.UTF-8",
	};
	if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
	return env;
}

/** Fingerprint actual non-ignored source, including dirty and untracked files. Never execute diff drivers. */
export function sourceFingerprint(root: string): string {
	const git = resolveGit();
	const run = (args: string[], optional = false) => {
		const result = Bun.spawnSync({ cmd: [git, "-C", root, ...args], cwd: root, env: gitEnv(git), stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0 && !optional) fail(args[0] ?? "git");
		return result.exitCode === 0 ? result.stdout : Buffer.from("UNBORN");
	};
	const hash = crypto.createHash("sha256");
	hash.update(run(["rev-parse", "--verify", "HEAD"], true));
	hash.update(run(["ls-files", "--stage", "-z"]));
	const names = new Set(run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean));
	for (const name of [...names].sort()) {
		const file = path.resolve(root, name);
		if (!file.startsWith(path.resolve(root) + path.sep)) fail("path escaped root");
		for (let parent = path.dirname(file); parent !== path.resolve(root); parent = path.dirname(parent)) {
			if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) fail("linked source ancestor");
		}
		hash.update(JSON.stringify(name));
		if (!fs.existsSync(file) && !fs.lstatSync(file, { throwIfNoEntry: false })) { hash.update("missing"); continue; }
		const stat = fs.lstatSync(file);
		if (stat.isSymbolicLink()) hash.update(`link:${fs.readlinkSync(file)}`);
		else if (stat.isFile()) hash.update(crypto.createHash("sha256").update(fs.readFileSync(file)).digest());
		else fail(`unsupported source entry: ${name}`);
	}
	return hash.digest("hex");
}
