#!/usr/bin/env node
/**
 * Runnable swarm eval entry. This environment has no model credentials, so the
 * default path exits 2 and does not invent quality numbers.
 */
const keys = ["OMP_EVAL_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const present = keys.filter(name => process.env[name]);
const off = "omp --print --model <provider/model> <同一题目>";
const on = "OMP_SWARM=1 omp --swarm --print --model <provider/model> <同一题目>";
if (present.length === 0) {
	console.error("没有可用的模型凭证。检查过的变量：" + keys.join("、") + "。");
	console.error("本脚本不编造质量分数，也不用冒烟桩的 assigned 代替模型结果。");
	console.error("凭证到位后，对同一题目各跑一遍，再读 swarm_status 的 criticalSteps、finishRate、avgParallelism：");
	console.error("  " + off);
	console.error("  " + on);
	process.exit(2);
}
console.log("检测到凭证：" + present.join("、") + "。");
console.log("本仓库不在这里自动打分。请手动比较下面两次运行的 swarm_status，不要把桩冒烟当成质量结果。");
console.log("  " + off);
console.log("  " + on);
process.exit(0);
