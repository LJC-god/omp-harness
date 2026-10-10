# Swarm 宿主接口

日期：2026-10-09。核心在 `packages/runtime/swarm-control/src`。把这个目录挪到独立插件仓库时，`src/` 保持零宿主依赖，pi 适配器以后加在 `adapters/` 旁边。本仓库只实现了 OMP 适配器。

pi 1.1.0 的参照实现是 https://github.com/LJC-god/pi-swarm-control/pull/1 里的 `prototypes/parl-swarm/`。那里的进程启动、命令行和 pi 工具注册不要搬进 `src/`。

## 核心拥有的语义

- `create_subagent`：只保存配置，不运行。pi 路径只接受 `read`、`grep`、`find`、`ls`。
- `assign_task`：占一个名额，调用宿主的 `runSubtask`，失败重试一次，中止不重试，结果收成最多 6 KB 的 JSON。
- `swarm_status`：读预算和 Critical steps，不派工。
- 预算：编排步、每阶段人数、全程人数。OMP 的一批 `tasks` 用 `reserveBatch`，要么全部占上，要么一个都不占。
- 写者：同一阶段最多一个，且必须带隔离标记。只读工人可以跟它一起跑。pi 路径上的 `create_subagent` 一律只读，所以这条规则主要约束 OMP 的原生 agent。
- Critical steps：`assistant_llm_turns`。有工人的阶段贡献 `1 + 最慢工人`，没有工人的编排轮贡献 1。缺用量就标 `unreported` 或 `partial`，不用 0 填洞。
- JSONL 跟踪。OMP 适配器在策略关闭时不创建这次运行的目录。

## SwarmHost

宿主实现这五个方法。核心调用它们。

| 方法 | 核心期望 | pi 适配器以后要做的 | OMP 现在做的 |
| --- | --- | --- | --- |
| `registerTool` | 按给定名字注册工具 | 注册 `create_subagent`、`assign_task`、`swarm_status`。不要注册名为 `task` 的工具 | 只注册 `swarm_status` |
| `hookToolCall` | 在工具真正执行前拦截 | 拦截 `assign_task`。核心返回 `block` 时不要启动进程 | 不拦截别的工具。`task` 的拦截在 shadow 的 `beforeInvoke` |
| `runSubtask` | 跑完一个工人并返回步数、工具次数、状态、正文。没有用量就省略 `usage` | 启动 `pi --mode json` 子进程，工具限制为只读四件，环境加上工人标记以免子进程再装同一套工具 | 调用原生 `task` 的 `invokeTool`。参数只有 `agent`、`task`，写者再加 `isolated: true`。不传 `tools`、`tasks`、`context` |
| `reportUsage` | 收下一次调用的用量覆盖情况 | 把子进程 JSON 里的 usage 交回来；没有就报 `unreported` | 从原生 `results[].usage` 读取。对象不存在就不报 |
| `injectSystemPrompt` | 换成当前策略段；关闭时传空字符串 | 在 `before_agent_start` 写入 pi 的 `agent_swarm` 段 | `before_agent_start` 把 OMP 段落追加到已有 system prompt。关闭时不改 |

可选：`getFlag(name)` 和 `registerCommand(name, handler)`。核心用它们读 `--swarm` 和注册 `/swarm`。

`attachSwarm(host, { surface, home, limits, env })` 负责把会话接到宿主上。

- `surface: "pi"` 注册三个工具，并在 `assign_task` 上挂准入钩子。测试用假宿主覆盖了这条路径。
- `surface: "omp"` 只注册 `swarm_status`。OMP 适配器没有走这条注册去派发，派发用的是下面的原生批次。

## OMP 适配器

文件：`packages/runtime/extensions/task-orchestration.ts` 和 `packages/runtime/swarm-control/adapters/omp.ts`。

1. `session_start` 只在根会话上记住 `--swarm` 或 `OMP_SWARM`。子会话不改父会话的开关，也不再注册 `task`。
2. `beforeInvoke` 在关闭时返回空。打开时解析扁平参数或 `{ context, tasks }`，做写者检查和整批占位，返回 `run`。
3. shadow 对每个子项调用原生 `invokeTool`。并发上限沿用核心的调度器，原生 `task.maxConcurrency` 仍作用在每一次单独调用上。
4. 结果交回核心记账。shadow 把指标和各工人的 6 KB 信封合成一次工具结果。
5. `turn_start` / `agent_start` 只在根会话上推动阶段时钟。宿主如果把轮次号在每个 agent 循环里清零，核心用 `TurnClock` 把它改成单调编号。

安装器把 `packages/runtime/swarm-control` 的 `package.json`、`src` 和 `adapters` 复制到 `$OMP_HOME/agent/swarm-control`。扩展用相对路径 `../swarm-control/adapters/omp.ts`，仓库里和安装后的目录都对得上。

## pi 适配器还要补的部分

核心已经能通过 `attachSwarm(host, { surface: "pi" })` 驱动三个工具。独立仓库里的 `adapters/pi.ts` 需要自己做这些宿主细节，本仓库没有做：

1. 依赖 `@earendil-works/pi-coding-agent` 1.1.0，而不是 OMP。`executeTool(name, args)` 不等于 OMP 的 `invokeTool`。
2. `runSubtask` 启动参照实现里的 `pi --mode json` 子进程。工人环境要能让插件直接返回，避免工人再注册 swarm 工具。参照实现用的是工人环境变量。
3. 把 `--swarm`、`--swarm-worker-model` 和各项预算 flag 交给 `getFlag`。环境变量沿用 `PARL_SWARM_*`，核心的 `resolveLimits` 已经同时认识 `OMP_SWARM_*` 和 `PARL_SWARM_*`。
4. 在 `agent_start` 调用 `noteAgentStart`，在 `turn_start` 调用 `noteTurnStart(turnIndex)`，在每次提示前调用 `refreshPrompt`。
5. 子进程的步数按助手消息计，工具调用另计。超时和中止抛 `AbortError`，这样核心不会重试。
6. 不要把 OMP 的 `scout` / `isolated` 规则塞进 pi 的 `create_subagent`。pi 工人保持只读。写者规则留在 OMP 的原生批次里。

## 抽取

把 `packages/runtime/swarm-control` 整目录移出后，OMP 适配器仍只依赖 `src/` 的公开导出和原生 `invokeTool`。pi 适配器只依赖 `attachSwarm` 和 `SwarmHost`。两边不共享入口文件。
