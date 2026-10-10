# Swarm 策略层

日期：2026-10-09。运行时仍是 OMP 18.2.6。这一层默认关闭。

策略和记账在 `packages/runtime/swarm-control/src`。该目录不导入 pi，也不导入 OMP。OMP 只在 `adapters/omp.ts` 里把同一套策略接到现有的 `task` shadow。宿主接口和将来的 pi 适配器见 `SWARM-HOST-INTERFACE.md`。

## 怎么打开

三者任一即可：

- 启动参数 `--swarm`
- 会话命令 `/swarm`（再执行一次就关掉）
- 环境变量 `OMP_SWARM=1` 或 `OMP_SWARM=true`

关掉时，`beforeInvoke` 什么都不做，`task` 仍是一次原生 `invokeTool`。`task.batch` 保持 false。安装树里 `registerTool({ name: "task" })` 仍然只有 `task-orchestration.ts` 一处。`swarm_status` 是另一个只读工具，不是第二个 `task`。

## 打开之后

模型继续调用原生 `task`。shadow 把一次调用拆成若干扁平的 `{ agent, task, isolated? }`，再交给原生执行器。因此不需要把 `task.batch` 设成 true，也能在一次调用里放 `tasks` 数组。

- 没写 `agent` 时用 `scout`。
- `scout` 和 `security-reviewer` 是只读。
- 其他 agent 都当成会写。同一阶段最多一个会写的，而且必须 `isolated: true`。只读任务可以和这一个写者并行。两个写者、或者写者没有 `isolated`，整次调用直接挡住，不占名额。
- 名额是整批成功或整批拒绝：编排步数、每阶段人数、全程人数。拒绝的那一批不占槽。
- 每个失败的子任务重试一次。中止不重试。
- 每个子任务结果收成最多 6 KB 的 JSON。
- Critical steps 按阶段算：有子任务的阶段是 `1 + 最慢子任务的助手轮数`，没派子任务的编排轮再加 1。助手轮数不是工具调用次数。
- 跟踪文件在 swarm 打开后才创建，路径是 `$OMP_SWARM_HOME`，否则是 `$OMP_HOME/agent/swarm/runs/<id>/trace.jsonl`。

`swarm_status` 返回这些计数。冒烟桩能证明扇出和计数，不能证明模型质量。

## 检查

```bash
bun packages/runtime/swarm-control/test/core.test.ts
bun packages/runtime/test/acceptance.ts
python3 scripts/verify_snapshot.py
node harness/bootstrap/smoke.mjs
node packages/runtime/swarm-control/eval/run-swarm-eval.mjs
```

前四项是策略、原有运行时、快照字节和干净家目录冒烟。最后一项在没有模型凭证时退出码 2，并且不编造分数。
