import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installSkill } from "../install.mjs";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillName = "pm";
const skillDir = path.join(packageRoot, "skills", skillName);
function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}
const texts = files(skillDir).filter(file => file.endsWith(".md")).map(file => readFileSync(file, "utf8"));
const front = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
assert.match(front, new RegExp("^name: " + skillName + "$", "m"));
assert.match(front, /^description: \S+/m);
for (const text of texts) {
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]+Users[\\/]|D:\/OMPData|D:\/Labs|LJC-god/);
}
assert.ok(texts.some(text => text.includes("SKILL_UNAVAILABLE")));

const dest = mkdtempSync(path.join(tmpdir(), "omp-skill-pm-"));
try {
  const installed = installSkill(dest);
  assert.equal(path.basename(installed), skillName);
  assert.throws(() => installSkill(path.resolve(packageRoot, "..", "..", "..", "omp", "agent", "skills")), /snapshot tree/);
} finally { rmSync(dest, { recursive: true, force: true }); }
process.stdout.write("PASS omp-skill-pm\n");
