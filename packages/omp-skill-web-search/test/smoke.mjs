import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installSkill } from "../install.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const skillPath = path.join(packageRoot, "skills", "web-search", "SKILL.md");
const snapshotPath = path.join(repoRoot, "omp", "agent", "skills", "web-search", "SKILL.md");

const packaged = readFileSync(skillPath);
const snapshot = readFileSync(snapshotPath);
const text = packaged.toString("utf8");
const snapshotText = snapshot.toString("utf8");
assert.match(snapshotText, /Exa \+ Brave/, "frozen snapshot skill keeps its historical wording");
assert.match(text, /web-research-policy\.md/);
assert.doesNotMatch(text, /Exa \+ Brave/);
const front = (value) => /^---\n([\s\S]*?)\n---\n/.exec(value)[1];
assert.equal(
  front(text).match(/^description: .+$/m)[0],
  front(snapshotText).match(/^description: .+$/m)[0],
);
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
assert.ok(frontmatter, "SKILL.md needs YAML frontmatter");
assert.match(frontmatter[1], /^name: web-search$/m);
assert.match(frontmatter[1], /^description: \S+/m);
assert.doesNotMatch(text, /C:[/\\]Users|D:[/\\]|api[_-]?key\s*[:=]|LJC-god/i);

const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "omp-skill-web-search");
assert.equal(manifest.version, "0.1.0");
assert.equal(manifest.private, true);
assert.equal(manifest.omp, undefined, "18.2.6 does not use an omp.extensions or omp.skills manifest");
assert.deepEqual(manifest.ompConfig, {
  kind: "skill",
  skillName: "web-search",
  runtime: "18.2.6",
  install: "custom-directory",
});

const dest = mkdtempSync(path.join(tmpdir(), "omp-skill-web-search-"));
try {
  const installed = installSkill(dest);
  assert.equal(installed, path.join(dest, "web-search", "SKILL.md"));
  assert.deepEqual(readFileSync(installed), packaged);
  assert.equal(installSkill(dest), installed, "install is idempotent when bytes match");
  assert.equal(existsSync(path.join(dest, "group", "web-search", "SKILL.md")), false);

  assert.throws(
    () => installSkill(path.join(repoRoot, "omp", "agent", "skills")),
    /refusing to write inside the snapshot tree/,
  );

  const cliDest = path.join(dest, "cli");
  const cli = spawnSync(process.execPath, [path.join(packageRoot, "install.mjs"), "--dest", cliDest], {
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(readFileSync(path.join(cliDest, "web-search", "SKILL.md")).toString("utf8"), text);
} finally {
  rmSync(dest, { recursive: true, force: true });
}

process.stdout.write("PASS omp-skill-web-search\n");
