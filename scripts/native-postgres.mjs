#!/usr/bin/env node
/** Lab-only PostgreSQL lifecycle; all mutable files use its explicit root. */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const requestedRuntimeRoot = process.env.OMP_POSTGRES_RUNTIME_ROOT;
const requestedBin = process.env.OMP_POSTGRES_BIN;
const runtimeRoot = path.resolve(requestedRuntimeRoot || here);
const dataDir = path.join(runtimeRoot, 'data');
const logFile = path.join(runtimeRoot, 'postgres.log');
const markerFile = path.join(runtimeRoot, '.omp-native-postgres.json');
const credentialsFile = path.join(runtimeRoot, 'credentials.json');
const port = Number(process.env.OMP_POSTGRES_PORT || 55440);
const binDir = path.resolve(requestedBin || '.');
const provenance = 'operator-supplied OMP_POSTGRES_BIN';

function fail(message) { throw new Error(message); }
function inside(root, target) {
  const a = root.toLowerCase();
  const b = target.toLowerCase();
  return b === a || b.startsWith(`${a}${path.sep}`);
}
async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
async function findLabRoot(start) {
  const allowed = await fs.realpath('D:\\Labs\\omp');
  let current = start;
  while (true) {
    const candidate = path.join(current, '.omp-automation-lab-root');
    if (await exists(candidate)) {
      if ((await fs.readFile(candidate, 'utf8')).trim() !== 'omp-automation-lab/v1') fail(`invalid lab marker: ${candidate}`);
      const real = await fs.realpath(current);
      if (real === allowed || !inside(allowed, real)) fail(`lab marker must be below D:\\Labs\\omp: ${candidate}`);
      return real;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail('no valid .omp-automation-lab-root found above this harness');
}
const labRoot = await findLabRoot(here);

function bin(name) { return path.join(binDir, `${name}.exe`); }
function env() { return { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, LC_MESSAGES: 'C' }; }
function usage() { console.error('Usage: node scripts/native-postgres.mjs <start|stop|status|url|with -- command...>'); process.exitCode = 2; }
async function safeRuntimeRoot() {
  if (!requestedRuntimeRoot) fail('OMP_POSTGRES_RUNTIME_ROOT is required and must name a dedicated new lab runtime directory');
  if (!requestedBin) fail('OMP_POSTGRES_BIN is required and must name a verified PostgreSQL bin directory');
  if (!path.isAbsolute(requestedRuntimeRoot) || !path.isAbsolute(requestedBin)) fail('OMP_POSTGRES_RUNTIME_ROOT and OMP_POSTGRES_BIN must be absolute paths');
  if (runtimeRoot === path.parse(runtimeRoot).root) fail('OMP_POSTGRES_RUNTIME_ROOT cannot be a filesystem root');
  if (!inside(labRoot, runtimeRoot)) fail(`OMP_POSTGRES_RUNTIME_ROOT must be inside the marked lab root: ${labRoot}`);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`invalid OMP_POSTGRES_PORT: ${port}`);
  let current = path.parse(runtimeRoot).root;
  for (const part of path.relative(current, runtimeRoot).split(path.sep)) {
    current = path.join(current, part);
    if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) fail(`refusing reparse-point runtime path: ${current}`);
  }
}
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: runtimeRoot, env: env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}
async function owned() {
  if (!(await exists(markerFile))) fail(`refusing an unmarked runtime root: ${runtimeRoot}`);
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  if (marker.dataDir !== dataDir) fail(`runtime ownership marker does not match ${dataDir}`);
  if (marker.runtimeRealpath !== await fs.realpath(runtimeRoot)) fail(`runtime root changed since ownership marker was written: ${runtimeRoot}`);
  if (await exists(dataDir) && (await fs.lstat(dataDir)).isSymbolicLink()) fail(`refusing reparse-point data directory: ${dataDir}`);
}
async function setupOwnership() {
  await fs.mkdir(runtimeRoot, { recursive: true });
  if (await exists(markerFile)) return owned();
  if ((await fs.readdir(runtimeRoot)).length !== 0) fail(`refusing nonempty unmarked runtime root: ${runtimeRoot}`);
  const runtimeRealpath = await fs.realpath(runtimeRoot);
  if (!inside(labRoot, runtimeRealpath)) fail(`runtime root resolves outside marked lab root: ${runtimeRealpath}`);
  await fs.writeFile(markerFile, `${JSON.stringify({ schema: 1, dataDir, runtimeRealpath, createdAt: new Date().toISOString() }, null, 2)}\n`);
}
async function readCredentials() {
  if (!(await exists(credentialsFile))) fail(`missing credentials for owned runtime root: ${runtimeRoot}`);
  return JSON.parse(await fs.readFile(credentialsFile, 'utf8'));
}
async function createCredentials() {
  if (await exists(credentialsFile)) return readCredentials();
  const value = { user: 'omp_lab', password: crypto.randomBytes(24).toString('base64url'), database: 'postgres' };
  await fs.writeFile(credentialsFile, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
function databaseUrl(creds) { return `postgresql://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@127.0.0.1:${port}/${creds.database}`; }
async function initialized() { return exists(path.join(dataDir, 'PG_VERSION')); }
async function initdb(creds) {
  if (await initialized()) return;
  await fs.mkdir(dataDir, { recursive: true });
  const passwordFile = path.join(runtimeRoot, `.initdb-password-${process.pid}`);
  await fs.writeFile(passwordFile, `${creds.password}\n`);
  try {
    const result = await run(bin('initdb'), ['-D', dataDir, '--username', creds.user, '--pwfile', passwordFile, '--auth-host', 'scram-sha-256', '--auth-local', 'trust', '--encoding', 'UTF8', '--locale', 'C']);
    if (result.code !== 0) fail(`initdb failed (${result.code}): ${result.output}`);
  } finally { await fs.rm(passwordFile, { force: true }); }
}
async function pgStatus() {
  if (!(await initialized())) return false;
  return (await run(bin('pg_ctl'), ['status', '-D', dataDir])).code === 0;
}
async function portListening() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(false)));
  });
}
async function postmasterInfo() {
  try {
    const lines = (await fs.readFile(path.join(dataDir, 'postmaster.pid'), 'utf8')).split(/\r?\n/);
    return { pid: Number(lines[0]), port: Number(lines[3]) };
  } catch { return { pid: null, port: null }; }
}
async function start() {
  await setupOwnership();
  const creds = await createCredentials();
  if (await pgStatus()) {
    const active = await postmasterInfo();
    if (active.port !== port) fail(`owned cluster is running on port ${active.port}, not requested port ${port}`);
    return { action: 'start', reused: true, pid: active.pid, port, database: creds.database };
  }
  if (await portListening()) fail(`port ${port} is already in use; refusing to touch an unowned process`);
  await initdb(creds);
  const result = await run(bin('pg_ctl'), ['start', '-D', dataDir, '-l', logFile, '-w', '-t', '30', '-o', `-p ${port} -c listen_addresses=127.0.0.1`]);
  if (result.code !== 0) {
    if (await pgStatus()) await run(bin('pg_ctl'), ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '30']);
    fail(`pg_ctl start failed (${result.code}): ${result.output}`);
  }
  if (!(await pgStatus())) fail('pg_ctl start exited successfully but this owned cluster is not running');
  return { action: 'start', reused: false, pid: (await postmasterInfo()).pid, port, database: creds.database };
}
async function stop() {
  await owned();
  if (!(await pgStatus())) return { action: 'stop', stopped: false };
  const result = await run(bin('pg_ctl'), ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '30']);
  if (result.code !== 0) fail(`pg_ctl stop failed (${result.code}): ${result.output}`);
  if (await pgStatus()) fail('owned cluster remained running after pg_ctl stop');
  return { action: 'stop', stopped: true };
}
async function status() {
  await owned();
  const creds = await readCredentials();
  const active = await postmasterInfo();
  return { action: 'status', running: await pgStatus(), pid: active.pid, port, activePort: active.port, dataDir, database: creds.database, user: creds.user, binary: binDir, provenance };
}
function runConsumer(argv, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: process.cwd(), env: { ...process.env, ...extraEnv }, stdio: 'inherit', windowsHide: true, shell: false });
    let signal = null;
    const forward = (value) => { signal = value; child.kill('SIGTERM'); };
    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));
    child.once('error', reject);
    child.once('exit', (code) => resolve(signal ? 130 : (code ?? 1)));
  });
}
async function startInterruptibly() {
  let cancelled = false;
  let started = null;
  const onSignal = () => { cancelled = true; if (started && !started.reused) void stop().catch(() => {}); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    started = await start();
    if (cancelled) { if (!started.reused) await stop(); process.exitCode = 130; return null; }
    return started;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
async function withConsumer(argv) {
  if (argv.length === 0) fail('with requires `-- command ...`');
  const started = await startInterruptibly();
  if (!started) return;
  try { process.exitCode = await runConsumer(argv, { DATABASE_URL: databaseUrl(await readCredentials()) }); }
  finally { if (!started.reused) await stop(); }
}
async function main() {
  await safeRuntimeRoot();
  for (const name of ['initdb', 'pg_ctl', 'postgres']) if (!(await exists(bin(name)))) fail(`missing ${bin(name)}`);
  const command = process.argv[2];
  if (command === 'with') { if (process.argv[3] !== '--') return usage(); await withConsumer(process.argv.slice(4)); return; }
  const result = command === 'start' ? await startInterruptibly() : command === 'stop' ? await stop() : command === 'status' ? await status() : command === 'url' ? (await owned(), { databaseUrl: databaseUrl(await readCredentials()) }) : null;
  if (command === 'start' && !result) return;
  if (!result) return usage();
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
