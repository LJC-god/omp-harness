import * as path from "node:path";
import { auditModelSelectors } from "../omp/agent/lib/model-audit.ts";
import { runtimePackageFile } from "../omp/agent/lib/omp-runtime.ts";

const home = process.env.OMP_TASK_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE}`;
const root = path.resolve(import.meta.dir, "..");
const report = await auditModelSelectors({
  configPath: path.join(root, "omp", "agent", "config.yml"),
  agentsRoot: path.join(root, "omp", "agent", "agents"),
  catalogPath: runtimePackageFile("pi-catalog", "src/models.json"),
  cachePath: path.join(home, ".omp", "agent", "models.db"),
});
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
