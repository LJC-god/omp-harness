#!/usr/bin/env node
/**
 * Copy this package's skill into a skills parent directory.
 *
 * OMP 18.2.6 discovers skills.customDirectories as one level of star/SKILL.md.
 * The same tree also matches a plugin's skills/web-search/SKILL.md layout.
 * This installer does not edit config.yml and refuses the snapshot tree under omp/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(packageRoot, "..", "..");
const snapshotRoot = path.join(repoRoot, "omp");
const source = path.join(packageRoot, "skills", "web-search", "SKILL.md");

function destFromArgs(argv) {
  const index = argv.indexOf("--dest");
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error("usage: node install.mjs --dest <skills-parent>");
  }
  return path.resolve(value);
}

function assertOutsideSnapshot(dest) {
  const relative = path.relative(snapshotRoot, dest);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (inside) {
    throw new Error(`refusing to write inside the snapshot tree: ${dest}`);
  }
}

export function installSkill(dest) {
  const resolved = path.resolve(dest);
  assertOutsideSnapshot(resolved);
  const targetDir = path.join(resolved, "web-search");
  const target = path.join(targetDir, "SKILL.md");
  const bytes = readFileSync(source);
  mkdirSync(targetDir, { recursive: true });
  try {
    const existing = readFileSync(target);
    if (Buffer.compare(existing, bytes) !== 0) {
      throw new Error(`refusing to overwrite different skill: ${target}`);
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    writeFileSync(target, bytes);
  }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = installSkill(destFromArgs(process.argv.slice(2)));
  process.stdout.write(`${target}\n`);
}
