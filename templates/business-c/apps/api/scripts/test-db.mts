import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL is required; tests never choose a database for you.");
if (process.env.TEST_DATABASE_ISOLATED !== "1") throw new Error("Set TEST_DATABASE_ISOLATED=1 only after selecting an isolated test database.");
const parsedTestUrl = new URL(testUrl);
for (const key of parsedTestUrl.searchParams.keys()) {
  if (["host", "port", "dbname", "database"].includes(key.toLowerCase())) throw new Error("TEST_DATABASE_URL may not use query parameters that override its target database.");
}
function sameDatabase(left: string, right: string) {
  const a = new URL(left); const b = new URL(right);
  const port = (value: URL) => value.port || "5432";
  const protocol = (value: URL) => value.protocol === "postgres:" ? "postgresql:" : value.protocol;
  return protocol(a) === protocol(b) && a.hostname.toLowerCase() === b.hostname.toLowerCase() && port(a) === port(b) && decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname);
}
if (process.env.DATABASE_URL && sameDatabase(testUrl, process.env.DATABASE_URL)) throw new Error("TEST_DATABASE_URL must target a different database than DATABASE_URL.");

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("Run this script through pnpm so npm_execpath identifies pnpm's JavaScript entry point.");
const migration = spawnSync(process.execPath, [pnpmCli, "exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: { ...process.env, DATABASE_URL: testUrl, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? "http://localhost:5173" },
  stdio: "inherit",
  windowsHide: true,
});
if (migration.status !== 0) process.exit(migration.status ?? 1);

const test = spawnSync(process.execPath, [pnpmCli, "exec", "tsx", "src/integration-test.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: { ...process.env, DATABASE_URL: testUrl, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? "http://localhost:5173" },
  stdio: "inherit",
  windowsHide: true,
});
process.exit(test.status ?? 1);
