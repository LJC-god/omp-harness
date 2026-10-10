#!/usr/bin/env node
/**
 * Clean-home smoke: install the harness, start OMP 18.2.6 against a local model,
 * then exercise the same session twice: swarm off, then swarm on.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(path.join(tmpdir(), "omp-clean-"));
const home = path.join(root, "home");
const data = path.join(root, "data");
const work = path.join(root, "work");
mkdirSync(home, { recursive: true });
mkdirSync(work, { recursive: true });
const ompHome = path.join(home, ".omp");
const logDir = path.join(repo, "docs", "decomposition");
const env = {
	...process.env,
	HOME: home,
	OMP_HOME: ompHome,
	OMP_DATA_ROOT: data,
	OMP_ARCHIVE_GITHUB_REPO: "local/omp-archive-index",
	OMP_ARCHIVE_INDEX_DIR: path.join(data, "github", "archive-index"),
	OMP_CONTROL_DB: path.join(ompHome, "agent", "orchestration.sqlite"),
	PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
};

function chunk(delta, finish) {
	return {
		id: "chatcmpl-smoke",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, finish_reason: finish ?? null }],
	};
}
function sse(payload) {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const prompt = "Call web_research_v1, then task, then omp_archive status, then stop. Do not use any other tool.";
const swarmPrompt = "SWARM_FANOUT. Call task once with four read-only scout tasks, then call swarm_status, then stop. Do not call web_research_v1.";
const scoutAnswer = JSON.stringify({ summary: "smoke", files: [{ path: "README.md", description: "smoke" }], architecture: "smoke" });
const calls = [];
const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", chunk => chunks.push(chunk));
	req.on("end", () => {
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		const names = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
		const text = JSON.stringify(body.messages ?? []);
		const researchRoot = text.includes("Call web_research_v1");
		const swarmRoot = text.includes("SWARM_FANOUT");
		const root = researchRoot || swarmRoot;
		const skills = text.match(/<skills>[\s\S]*?<\/skills>/)?.[0] ?? "";
		calls.push({ url: req.url, root, swarmRoot, tools: names, messages: body.messages?.length ?? 0, skills });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const toolMessages = (body.messages ?? []).filter(message => message.role === "tool").length;
		const swarmTasks = {
			context: "Read only fan-out",
			tasks: [1, 2, 3, 4].map(n => ({ agent: "scout", task: `SWARM_SCOUT ${n}: list the repository layout.` })),
		};
		const next = researchRoot ? [
			{ name: "web_research_v1", arguments: JSON.stringify({ query: "omp harness smoke" }) },
			{ name: "task", arguments: JSON.stringify({ agent: "task", task: "Reply with the single word shadowed." }) },
			{ name: "omp_archive", arguments: JSON.stringify({ action: "status", projectId: "missing", runId: "run1" }) },
		][toolMessages] : swarmRoot ? [
			{ name: "task", arguments: JSON.stringify(swarmTasks) },
			{ name: "swarm_status", arguments: "{}" },
		][toolMessages] : undefined;
		if (!next) {
			res.write(sse(chunk({ role: "assistant" })));
			const content = researchRoot ? "SMOKE_OK" : swarmRoot ? "SWARM_SMOKE_OK" : text.includes("SWARM_SCOUT") ? scoutAnswer : "CHILD_OK";
			res.write(sse(chunk({ content })));
			res.write(sse(chunk({}, "stop")));
			res.end("data: [DONE]\n\n");
			return;
		}
		res.write(sse(chunk({ role: "assistant" })));
		res.write(sse(chunk({
			tool_calls: [{ index: 0, id: `call_${toolMessages}`, type: "function", function: { name: next.name, arguments: next.arguments } }],
		})));
		res.write(sse(chunk({}, "tool_calls")));
		res.end("data: [DONE]\n\n");
	});
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const install = spawnSync(process.execPath, [path.join(repo, "harness", "bootstrap", "install.mjs")], {
	cwd: repo,
	env,
	encoding: "utf8",
});
if (install.status !== 0) {
	console.error(install.stdout);
	console.error(install.stderr);
	process.exit(install.status ?? 1);
}
const models = `providers:
  smoke:
    baseUrl: http://127.0.0.1:${port}/v1
    api: openai-completions
    apiKey: smoke-local
    models:
      - id: smoke-model
        name: Smoke
        input: [text]
        contextWindow: 32000
        maxTokens: 2048
        supportsTools: true
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
`;
writeFileSync(path.join(ompHome, "agent", "models.yml"), models);
const overlay = path.join(root, "smoke-overlay.yml");
writeFileSync(overlay, `enabledModels:
  - smoke/smoke-model
modelRoles:
  default: smoke/smoke-model
`);
function readHarnessEnv(file) {
	const parsed = {};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 1) continue;
		parsed[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
	}
	return parsed;
}
const harnessEnv = readHarnessEnv(path.join(ompHome, "agent", "harness.env"));
const ompEnv = { ...env, ...harnessEnv, HOME: home, PATH: env.PATH };
delete ompEnv.OMP_SWARM;
delete ompEnv.PARL_SWARM;
const started = new Date().toISOString();
const wrapper = path.join(ompHome, "bin", "omp-with-harness");
function runOmp(promptText, extra = {}) {
	const childEnv = { ...ompEnv, ...extra };
	const omp = spawn(wrapper, [
		"--model", "smoke/smoke-model",
		"--config", overlay,
		"--mode", "json",
		"--print",
		"--no-session",
		"--no-title",
		"--thinking", "off",
		"--auto-approve",
		"--allow-home",
		"--cwd", work,
		"--max-time", "3m",
		promptText,
	], { cwd: work, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	omp.stdout.on("data", buf => { stdout += buf.toString("utf8"); });
	omp.stderr.on("data", buf => { stderr += buf.toString("utf8"); });
	return new Promise(resolve => omp.on("close", exitCode => resolve({ stdout, stderr, exitCode })));
}
const offRun = await runOmp(prompt);
const callMark = calls.length;
const swarmRun = await runOmp(swarmPrompt, { OMP_SWARM: "1" });
server.close();
const { stdout, stderr, exitCode } = offRun;
const combined = `${stdout}\n${stderr}`;
const rootCalls = calls.slice(0, callMark).filter(call => call.root);
const skillText = rootCalls.map(call => call.skills).join("\n");
const requiredSkills = ["web-search", "ponytail", "matt", "pm", "caveman"];
const failures = [];
if (install.status !== 0) failures.push(`installer exit ${install.status}`);
if (exitCode !== 0) failures.push(`omp exit ${exitCode}`);
if (!harnessEnv.OMP_RUNTIME_ROOT) failures.push("harness.env missing OMP_RUNTIME_ROOT");
if (stderr.includes("Failed to load extension")) failures.push("extension failed to load");
if (combined.includes("Tool web_research_v1 not found")) failures.push("web_research_v1 was not registered");
if (combined.includes("Tool omp_archive not found")) failures.push("omp_archive was not registered");
if (!combined.includes("OMP_TASK_SHADOW")) failures.push("task shadow did not run");
if (!/"toolName":"web_research_v1"/.test(stdout) || !/"status":"(PARTIAL|UNAVAILABLE|OK)"/.test(stdout)) {
	failures.push("web_research_v1 did not return a research packet");
}
if (!/"toolName":"omp_archive"/.test(stdout) || !/NOT_FOUND|INVALID|UNINITIALIZED|NOT_REGISTERED/.test(stdout)) {
	failures.push("archive status was not a structured result");
}
if (!/"toolName":"task"/.test(stdout)) failures.push("task tool did not execute");
const skillNames = [...new Set([...skillText.matchAll(/- ([a-z0-9-]+):/g)].map(match => match[1]))];
for (const name of requiredSkills) {
	if (!skillNames.includes(name)) failures.push(`skill ${name} was not listed`);
}
if (!combined.includes("SMOKE_OK")) failures.push("session did not finish with SMOKE_OK");
const report = {
	started,
	exitCode,
	runtimeRoot: harnessEnv.OMP_RUNTIME_ROOT,
	failures,
	calls: calls.slice(0, callMark).map(({ skills, ...call }) => call),
	skillNames,
	stdout,
	stderr,
};
writeFileSync(path.join(root, "smoke-report.json"), JSON.stringify(report, null, 2));
const markdown = `# 干净安装运行记录

时间：${started}
临时家目录：\`${home}\`（运行后删除；本记录只保留命令和日志）
数据根：\`${data}\`

## 命令

\`\`\`bash
export PATH="$HOME/.bun/bin:$PATH"
export HOME=${home}
export OMP_HOME=${ompHome}
export OMP_DATA_ROOT=${data}
export OMP_ARCHIVE_GITHUB_REPO=local/omp-archive-index
export OMP_ARCHIVE_INDEX_DIR=${path.join(data, "github", "archive-index")}
export OMP_CONTROL_DB=${path.join(ompHome, "agent", "orchestration.sqlite")}
node harness/bootstrap/install.mjs
set -a
. ${ompHome}/agent/harness.env
set +a
# 安装器写入 $OMP_HOME/agent/models.yml 的本地 smoke 供应商后：
${wrapper} --model smoke/smoke-model --config ${overlay} --mode json --print --no-session --no-title --thinking off --auto-approve --allow-home --cwd ${work} --max-time 3m ${JSON.stringify(prompt)}
\`\`\`

安装器退出码：${install.status}
OMP 退出码：${exitCode}
OMP_RUNTIME_ROOT：${harnessEnv.OMP_RUNTIME_ROOT ?? ""}
验收：${failures.length ? failures.join("；") : "通过"}

18.2.6 默认把扩展工具挂在 xd://，顶层 function 名单只有内置工具。下面的 stdout 是按工具名调用之后的执行记录。

## 安装器输出

\`\`\`text
${install.stdout}
${install.stderr}
\`\`\`

## 根会话发现的 skill

\`\`\`text
${skillNames.join("\n") || "(none)"}
\`\`\`

## 模型请求

\`\`\`json
${JSON.stringify(report.calls, null, 2)}
\`\`\`

## OMP stdout

\`\`\`text
${stdout}
\`\`\`

## OMP stderr

\`\`\`text
${stderr}
\`\`\`
`;
writeFileSync(path.join(logDir, "clean-run.md"), markdown);
const swarmStdout = swarmRun.stdout;
const swarmStderr = swarmRun.stderr;
const swarmCombined = `${swarmStdout}\n${swarmStderr}`;
const swarmFailures = [];
if (swarmRun.exitCode !== 0) swarmFailures.push(`omp exit ${swarmRun.exitCode}`);
if (swarmStderr.includes("Failed to load extension")) swarmFailures.push("extension failed to load");
if (!swarmCombined.includes("OMP_TASK_SHADOW")) swarmFailures.push("task shadow did not run");
if (!/"toolName":"task"/.test(swarmStdout)) swarmFailures.push("task tool did not execute");
if (!/"toolName":"swarm_status"/.test(swarmStdout)) swarmFailures.push("swarm_status did not execute");
const assigned = [...swarmStdout.matchAll(/"assigned":\s*(\d+)/g)].map(match => Number(match[1]));
if (!assigned.some(value => value >= 4)) swarmFailures.push("swarm did not report assigned >= 4");
if (!/"criticalSteps":\s*\d+/.test(swarmStdout)) swarmFailures.push("swarm did not report criticalSteps");
if (!swarmCombined.includes("SWARM_SMOKE_OK")) swarmFailures.push("session did not finish with SWARM_SMOKE_OK");
const swarmCalls = calls.slice(callMark).map(({ skills, ...call }) => call);
const swarmMarkdown = `# Swarm 干净安装运行记录

时间：${started}
临时家目录：\`${home}\`（运行后删除；本记录只保留命令和日志）
关闭 swarm 的同一轮记录在 \`docs/decomposition/clean-run.md\`。验收：${failures.length ? failures.join("；") : "通过"}。

这一轮设置 \`OMP_SWARM=1\`，用同一个本地模型桩。桩按名字调用一次 \`task\`，里面有 4 个只读 \`scout\`，然后再调用 \`swarm_status\`。没有真实模型凭证，这里不记录质量分数。

## 命令

\`\`\`bash
export OMP_SWARM=1
${wrapper} --model smoke/smoke-model --config ${overlay} --mode json --print --no-session --no-title --thinking off --auto-approve --allow-home --cwd ${work} --max-time 3m ${JSON.stringify(swarmPrompt)}
\`\`\`

OMP 退出码：${swarmRun.exitCode}
验收：${swarmFailures.length ? swarmFailures.join("；") : "通过"}
assigned 样本：${assigned.join(", ") || "(none)"}

## 模型请求

\`\`\`json
${JSON.stringify(swarmCalls, null, 2)}
\`\`\`

## OMP stdout

\`\`\`text
${swarmStdout}
\`\`\`

## OMP stderr

\`\`\`text
${swarmStderr}
\`\`\`
`;
writeFileSync(path.join(logDir, "clean-run-swarm.md"), swarmMarkdown);
process.stdout.write(markdown);
process.stdout.write(swarmMarkdown);
if (failures.length || swarmFailures.length) {
	console.error([...failures, ...swarmFailures].join("\n"));
	process.exit(2);
}
