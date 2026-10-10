#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "..", "..", "..");
const skillName = "matt";
export function installSkill(dest) {
  const resolved = path.resolve(dest);
  const snapshot = path.join(repoRoot, "omp");
  const relative = path.relative(snapshot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("refusing to write inside the snapshot tree: " + resolved);
  }
  const target = path.join(resolved, skillName);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true });
  cpSync(path.join(packageRoot, "skills", skillName), target, { recursive: true });
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--dest");
  const dest = process.argv[index + 1];
  if (!dest) throw new Error("usage: node install.mjs --dest <skills-parent>");
  process.stdout.write(installSkill(dest) + "\n");
}
