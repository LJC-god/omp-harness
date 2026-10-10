# OMP 配置拆分计划

日期：2026-10-09。目标是把这份越长越缠的快照拆成可以独立安装的插件、skill 和一个薄 harness。现有 `omp/` 在每一步完成前仍是可恢复的 18.2.6 配置。本文件的安装契约以 **OMP 18.2.6** 为准；上游更新只作为兼容风险，不作为这一步的依赖。

## 1. 已核对的加载机制

### OMP 18.2.6（本快照的运行时）

包名 `@oh-my-pi/pi-coding-agent`。仓库 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)。下面几条对照了 tag `v18.2.6` 的 `docs/skills.md` 和 `src/extensibility/extensions/types.ts`，以及本仓库源码。

扩展模块从这些地方加载，按绝对路径去重，先看到的生效：

1. 项目 `<cwd>/.omp/extensions/`
2. 当前 agent 目录的 `extensions/`，默认 `~/.omp/agent/extensions/`（本快照就是这 7 个 `.ts`）
3. `settings.json` 里遗留的 `extensions` 列表
4. `config.yml` 的 `extensions:`，以及 CLI `--extension` / `-e`（`--hook` 是同一条加载面）
5. 已启用插件在 `package.json` 的 `omp.extensions`（旧字段 `pi.extensions` 仍接受）

目录入口顺序：带非空 `omp.extensions` 的 `package.json`，然后 `index.ts`，然后 `index.js`。自动扫描只认 `.ts` / `.js`。

插件用 `omp plugin install <npm|git>` 或 `omp plugin link` 装到 `~/.omp/plugins`，锁文件是 `omp-plugins.lock.json`。装好的包如果带有同级目录，`omp-plugins` provider 会发现：

| 路径 | 发现结果 |
|---|---|
| `skills/<name>/SKILL.md` | skill。非递归。`description` 必填 |
| `rules/*.{md,mdc}` | 规则。native provider 优先级 100，插件 90 |
| `commands/*.md` | 斜杠命令 |
| `hooks/pre/*.{ts,js}`、`hooks/post/*.{ts,js}` | 直接子文件，不递归 |
| `agents/` | task agent |
| `prompts/`、`tools/`、`.mcp.json` | 提示、自定义工具、MCP |

Skill 还有第二条路，也是**这份配置实际在用的路**：`skills.customDirectories` 用同样的非递归 `*/SKILL.md` 扫描，并且在 18.2.6 里覆盖同名的 provider skill。本仓库把 Claude / Codex / Pi / Agents 的开关都关了，只留 `~/.omp/agent/skills`。

`SKILL.md` 需要 frontmatter `name` 和 `description`。模型通过系统提示里的名字加描述发现它，用 `read` 的 `skill://<name>` 读取正文。`/skill:<name>` 在 `skills.enableSkillCommands` 打开时才注册。

规则 frontmatter 使用 `alwaysApply`、`agents`、`globs`、`description`。`main-agent-orchestrator.md` 的 `agents: [main]` 已经按这个机制把编排限制在根会话。

扩展工厂签名是 `export default function (pi: ExtensionAPI)`。工具用 `pi.registerTool`，命令用 `pi.registerCommand`，事件用 `pi.on`。18.2.6 的工具上下文有可选的 `invokeTool`，用来在 shadow 同名内置工具时调用原生实现。本仓库 `task-health.ts` 已经这样包装 `task`。

本快照没有 `hooks/` 目录。新的拦截应写成扩展，而不是再引入一套 hook 文件。

### 当前 OMP main，不是本快照

2026-10-09 读取 main 的 `packages/coding-agent/package.json`：版本 **18.8.7**，包名仍是 `@oh-my-pi/pi-coding-agent`。`invokeTool` 仍在 main 的扩展类型里。main 的 skill 文档比 18.2.6 多了 skillshare、agent-plugins、`omp.skills`、相同正文的静默去重，以及更细的命名空间冲突。这些字段**不要**写进面向 18.2.6 的 `package.json`。`lib/omp-runtime.ts` 会拒绝 18.2.6 以外的版本，所以现有扩展在 18.8.7 上会在导入私有模块之前失败。

### pi（另一条产品线）

2026-10-09 核对：`https://github.com/badlogic/pi-mono` 返回 301，落到 [earendil-works/pi](https://github.com/earendil-works/pi)。main 的 coding-agent `package.json` 是 **`@earendil-works/pi-coding-agent` 1.1.0**。安装面是 `pi install` 和 `package.json` 的 `"pi": { "extensions", "skills", "prompts", "themes" }`，配置目录是 `.pi`，不是 `.omp`。

pi 的工具上下文方法是 `executeTool(name, args)`，用来按名字嵌套调用工具。OMP 的 `invokeTool(params)` 是 shadow **同名**内置工具时的委托。两套不能互换。pi 不内置 sub-agent；OMP 的原生 `task` 已经是执行器。因此 pi 上的 swarm 包和 OMP 上的 task shadow 是两个包，只共享无宿主的记账类型，不共享入口文件。

## 2. 版本漂移

| 线 | 本仓库锁定 | 2026-10-09 上游 | 风险 |
|---|---|---|---|
| OMP | 18.2.6（允许 18.2.4、18.2.5） | 18.8.7 | 扩展 import 的 `src/config/*`、`src/session/*`、`src/task/discovery.ts`、`src/web/search/index.ts` 是私有路径。18.8.7 的 export map 仍把 `./*` 指到 `src`，但文件可以改名。先跑 `check-upgrade.ts` 的哈希门，再考虑抬运行时 |
| pi | 本仓库不依赖 pi 包 | `@earendil-works/pi-coding-agent` 1.1.0 | 与 OMP 18.x 不是同一版本序列。`executeTool` 不等于 `invokeTool`。`"pi"` manifest 不等于 `"omp"` manifest |
| 插件 | `pi-quotas` 0.5.2 启用但未入库；`ponytail` 4.9.0 关闭 | 未在本步升级 | 换 OMP 小版本后要重新 `plugin doctor`。不能假设 0.5.2 在 18.8.7 上仍加载 |

每个以后要执行代码的包必须声明 `ompConfig.runtime: "18.2.6"`，并在安装说明里写明它不支持 18.8.7，直到有一次对照该版本的加载探针。Skill-only 包不 import 运行时，漂移只影响发现规则；所以第一步选 skill。

私有源码路径以后收成一个兼容表：包在加载时检查 `AUDITED_OMP_VERSIONS` 和一组文件指纹，对不上就拒绝启动，而不是在半初始化后抛 `OMP_RUNTIME_MODULE_MISSING`。这张表属于 harness，不属于每一个 skill。

## 3. 目标布局

```text
omp-config/
├── harness/                          # 薄核心，仍对应 ~/.omp/agent 的一小部分
│   ├── config/
│   │   ├── config.yml                # 角色、预算、技能开关。无绝对路径、无密钥
│   │   └── web-research-large.yml
│   ├── rules/                        # communication, harness-router, main-agent-orchestrator
│   ├── agents/                       # 19 个角色提示
│   ├── notes/                        # 仍被规则点名的现行策略
│   └── bootstrap/
│       ├── install-layout.mjs       # 以后把各包装进目标 .omp
│       └── local.example.yml        # OMP_DATA_ROOT、技能目录、归档远程。真实 local.yml 不入库
├── packages/
│   ├── skills/
│   │   ├── omp-skill-web-search/     # 第一步，已落地
│   │   ├── omp-skill-fixed-route/    # 以后，连同 templates/business-c 的指针
│   │   ├── omp-skill-product-testing/
│   │   ├── omp-skill-ui-ux-design-audit/
│   │   ├── omp-skill-matt/           # 只留路由；上游叶子用锁，不把 git clone 写进包
│   │   └── omp-skill-pm/
│   ├── extensions/
│   │   ├── omp-web-research/         # web_research_v1 + omp_research_evidence
│   │   ├── omp-task-usage/           # omp_usage_report。不注册 task
│   │   ├── omp-product-continuity/   # product-review + session-continuity + 两份 evidence lib
│   │   ├── omp-task-orchestration/   # 唯一的 task shadow。见第 4 节
│   │   ├── omp-run-archiver/         # 路径和 GitHub 远程由环境注入
│   │   └── omp-control/              # 最后才动。SQLite 控制器，不是 swarm 执行器
│   └── third-party/                  # 只保留锁和许可证记录
│       ├── pins.lock.json            # archify, baoyu-design, shadcn, caveman, ponytail, ...
│       └── pi-quotas.json
├── lab/                              # 现有 scripts/ 里的 D: 探针。不随 omp 启动
├── archive/                          # 根 notes/、plans/、冻结的 docs/architecture
└── omp/                              # 在切换安装器之前保留的字节级快照
```

四类归属：

| 归类 | 内容 |
|---|---|
| (a) OMP 扩展 / 插件 | 七个 `.ts` 扩展，按上表拆包。第三方 `pi-quotas` 保持锁文件安装。每个包是一个插件根：代码放 `src/index.ts`，`package.json` 在确认目标运行时之后再写 `omp.extensions` |
| (b) 独立 skill | `web-search` 以及后面的自有 skill。第三方 skill 不复制进包，只锁版本，用 `omp plugin install` 或复制进 custom directory |
| (c) harness | `config.yml`、三条规则、19 个 agent、仍被引用的 notes、运行时版本门、路径注入 |
| (d) 删除或只归档 | 根目录 PM 实验笔记和计划；冻结架构图不再当现行设计；禁用的 ponytail 插件条目（活的是 skill 锁）；与扩展重复的 `web-research-v1` 命令，等扩展包成为唯一说明后再删；写死 Bun 路径的脚本，收进 `lab/` 并改走 `omp-runtime.ts`，不能改的就标成不可移植证据 |

`templates/business-c` 留在 fixed-route 的配方旁，不装进 `~/.omp`。

## 4. 编排层的位置

Kimi 式 swarm 调研（2026-10-09）建议在 OMP 上做策略和记账，并复用原生 `task`，不要做第三套执行器。这一点和仓库事实一致，采纳为边界，不在本步实现。

已核实：

- `omp/agent/extensions/task-health.ts` 在 `session_start` 找到内置 `task`，`registerTool({ name: "task" })`，`execute` 调用 `toolCtx.invokeTool`。全仓库只有这一处。
- 同文件另外注册的 `omp_task_metrics` 是只读工具，不占用 `task` 这个名字。
- `omp-control` 的工具名是 `omp_control`。受控 `project_spawn`、任务图和合并队列继续走它。swarm 的只读扇出不调用它。
- `product-review.ts` 在 `tool_call` 里拦截审查者的 `task` 调用，它不是第二个 shadow。
- OMP 18.2.6 和 18.8.7 的类型里都有 `invokeTool`。pi 1.1.0 的对应能力是 `executeTool(name, args)`，语义不同。
- 本仓库没有 OMP 的工具冲突实现。pi 的 resource loader 会记录同名工具冲突。因此“两个扩展都 shadow `task`，`invokeTool` 会不会穿透到另一个 shadow”在 18.2.6 和 18.8.7 上都还没有本仓库的测试。计划直接禁止第二种 shadow。

以后的家是一个包：`packages/extensions/omp-task-orchestration/`。它是唯一调用 `registerTool({ name: "task" })` 的地方。抽出 `task-health` 时，健康监督变成这个包装内部的一个步骤，而不是另一个扩展。

包装对后续 swarm 只暴露钩子，不暴露第二次注册：

```text
builtin task
    ↑ invokeTool
omp-task-orchestration          # 唯一 shadow
    ├── health                  # 今天 task-health.ts 的监督、派发通知、失败提醒
    └── swarm                   # 以后才接。create_subagent / 阶段记账 / 预算
                                # 通过 beforeInvoke / afterInvoke 走同一个 execute
```

约束：

- swarm 默认关闭。打开它用会话级 flag 或命令，不用 `alwaysApply: true` 的规则。`main-agent-orchestrator` 继续管普通产品所有权。
- worker 不再注册 swarm 工具。现有 `task.maxRecursionDepth: 1` 已经是“子任务不再派生子任务”。
- 写文件的并行仍走现有 worktree / 单写者规则。swarm 钩子的第一形态只做只读扇出。
- `task.batch` 今天是 `false`。要不要在 swarm 会话里打开 batch，留到编排包自己的探针，不在拆分 skill 时改 `config.yml`。
- pi 侧如果要做 PARL profile，那个包依赖 `@earendil-works/pi-coding-agent`，manifest 用 `"pi"`。它可以和 OMP 包共享纯数据类型（阶段、critical steps）。它不 import `@oh-my-pi/*`，也不注册 OMP 的 `task`。
- 在 `omp-task-orchestration` 落地之前，不新增任何 `registerTool({ name: "task" })`。

`session-continuity.ts` 今天 import `omp-control.ts` 的 `sourceFingerprint`。抽包时把这个函数挪到两边都能依赖的小模块，避免延续包整份吃进 4400 行控制器。

## 5. 包名、版本、安装、密钥

命名：自有包用 `omp-skill-<skill>` 或 `omp-ext-<能力>`，不加 npm scope，`"private": true`。Skill 的发现名保持目录名，例如包 `omp-skill-web-search` 里面仍是 `skills/web-search/SKILL.md`。

版本：每个包独立 semver，从 `0.1.0` 起。harness 用一份锁记录包版本和 OMP 运行时 `18.2.6`。不把这些包发到公共 registry。换运行时是 harness 的版本门事件，不是给每个 skill 自动升 major。

安装，按 18.2.6 实际会加载的方式：

1. Skill：`node install.mjs --dest <skills 父目录>`，得到 `<dest>/<skill>/SKILL.md`。这和 `skills.customDirectories` 一致。
2. 等目标机器可以跑 `omp` 之后，同一个目录也可以 `omp plugin link`。在 custom directory 里还有同名副本时，18.2.6 会让 custom directory 覆盖插件，并可能对冲突发出警告。所以切换安装方式时要先移走快照副本，而不是两处同时当权威。
3. 扩展：包根提供 `src/index.ts`。在运行时探针通过之前，不把 `omp.extensions` 写进会让 18.2.6 误解析的字段。探针就是新会话里 `/extensions` 看得到该入口，且 `check-upgrade.ts` 仍接受部署哈希。
4. 第三方：只提交锁。`omp/plugins` 里执行 Bun 安装。不把 `node_modules` 入库。

密钥和本机路径：

- 供应商登录、Cookie、控制库留在本机。包内不出现 `~`、`D:/OMPData`、`D:/Labs`、`LJC-god`。
- harness 读取环境变量：`OMP_RUNTIME_ROOT`、`OMP_DATA_ROOT`（代替写死的 `D:/OMPData`）、`OMP_SKILLS_DIR`、`OMP_ARCHIVE_INDEX_DIR`、`OMP_ARCHIVE_GITHUB_REPO`。
- 缺变量时扩展失败并退出，不用清单里的绝对路径当默认值。
- `local.yml` 被 gitignore。仓库只提供 `local.example.yml`。

## 6. 抽取顺序

从耦合最低的开始。每一步的现存配置要么字节不变，要么有明确的清单更新。回滚都是 revert 该提交；没有数据库迁移。

| 步 | 组件 | 验收 | 回滚 |
|---|---|---|---|
| 1 | `web-search` → `packages/omp-skill-web-search` | `node packages/omp-skill-web-search/test/smoke.mjs`；`python scripts/verify_snapshot.py` 仍通过。`omp/` 无 diff | revert。快照 skill 没动过 |
| 2 | `caveman` 改为上游锁，快照副本保留到安装器切换 | 锁里的 `name` 仍是 `caveman`；`communication.md` 原文不变 | revert 锁 |
| 3 | `frontend-design`、`emil-design-eng`、两份 fixing、`shadcn`、`archify`、`baoyu-design` 改成版本锁 | 每个 skill 的发现名不变；记录上游 commit；本仓库不再改它们的字节 | 恢复快照副本 |
| 4 | Ponytail 只留一条来源。插件条目保持 `enabled: false`，直到 skill 锁装好再删插件依赖 | 编码 agent 仍能 `skill://ponytail`；不会同时从插件和 custom directory 加载两份不同正文 | 恢复锁里的旧条目 |
| 5 | `ui-ux-design-audit`、`product-testing`、`fixed-route` | 包内无本机盘符；安装到临时目录后 frontmatter 与快照一致；`architecture-catalog.md` 仍指向模板 | revert |
| 6 | `matt`、`pm` | 路由 skill 独立成包；上游叶子写进锁，并在验收里断言“叶子缺失时报告 SKILL_UNAVAILABLE，而不是假装读过” | revert |
| 7 | `omp-web-research` | 现有 `tests/research-evidence.test.ts` 通过；工具名仍是 `web_research_v1` 和 `omp_research_evidence`；加载前版本门拒绝非 18.2.x | 把 `.ts` 放回 `omp/agent/extensions/` |
| 8 | `omp-task-usage` | `omp_usage_report` 仍在；不注册 `task` | 同上 |
| 9 | `omp-product-continuity` | `product-review` 与 `acceptance-evidence` 测试通过；`sourceFingerprint` 从控制器文件中拆出后，两边引用同一模块 | 恢复原来的相对 import |
| 10 | `omp-task-orchestration` | 全仓库仍只有一个 `registerTool({ name: "task" })`；`tests/task-health-model-notices.test.ts` 通过；包导出 `beforeInvoke` / `afterInvoke`，测试用一个空钩子证明第二个扩展不需要再注册 `task` | 把 `task-health.ts` 放回 extensions |
| 11 | `omp-run-archiver` | 缺 `OMP_DATA_ROOT` 时拒绝启动；测试用临时根，不写 `D:/OMPData` | 恢复扩展文件 |
| 12 | `omp-control` 与 `task-graph`、目录 pin | 现有 task-graph、merge-queue、worktree 测试在隔离库上通过；生产库路径只来自环境 | 恢复扩展和 lib |
| 13 | 实验室脚本进 `lab/`，根笔记进 `archive/` | `verify_snapshot.py` 与 `config-policy.test.ts` 通过；README 的恢复步骤改为指向 harness 安装器 | revert |

第 10 步之前不做 swarm 行为。第 10 步只把钩子位置留出来。真正的 `create_subagent`、critical steps 和 Kimi 路由是编排包的后续变更，要单独写验收，并且先在 18.2.6 上探针，而不是直接对着 18.8.7 改。

删除只发生在对应的包已经是安装源、并且快照副本被安装器生成之后。历史实验笔记移动到 `archive/`，不从 git 历史抹掉。

## 7. 第一步（本变更）

抽出 `web-search`。它是自有的、单文件的、没有 OMP import、没有盘符的 skill。正文写明检索不依赖加载它。因此它适合作为包装模式的证明，又不会改变现行工具。

落地：

- 权威副本：`packages/omp-skill-web-search/skills/web-search/SKILL.md`
- 快照副本：`omp/agent/skills/web-search/SKILL.md`，字节保持原样
- 安装器把包复制到调用者指定的 skills 父目录，并拒绝写入本仓库 `omp/`
- `package.json` 不包含 `omp.extensions` 或 `omp.skills`

没有改 `config.yml`。custom directory 继续发现快照里的那份文件。两份字节相同，所以现在安装到别的目录也不会改变模型看到的正文。

以后的包沿用同一模式：包是编辑处，快照是部署处，测试锁住字节；直到安装器接管，才允许快照路径变成生成物并更新 `snapshot-manifest.json`。

## 8. 回滚

本步只增加 `docs/decomposition/` 和 `packages/omp-skill-web-search/`。`git revert` 该提交后，`omp/` 与清单仍一致，OMP 启动路径不变。

后续任何一步如果必须改 `omp/`，同一提交里更新 `snapshot-manifest.json`，并跑 `python scripts/verify_snapshot.py`。运行中的 OMP 进程仍使用启动时加载的扩展；回滚文件之后要新开会话。回滚不修改控制库、session 或登录状态。

## 9. 安装器接管后的状态

主人要求在同一分支上继续，直到干净家目录能跑通。保守决定写在 `docs/decomposition/DECISIONS.md`。摘要：

- 运行时钉死 18.2.6，不升到 18.8.7。
- 抽出的扩展通过 `packages/runtime/lib/host-apis.ts` 导入公开子路径。安装器把 `omp` 二进制所在的 18.2.6 包目录写入 `OMP_RUNTIME_ROOT`，加载时按导出表做文件 URL 导入。
- 本机路径改由 `OMP_HOME`、`OMP_DATA_ROOT`、`OMP_CONTROL_DB`、`OMP_ARCHIVE_INDEX_DIR`、`OMP_ARCHIVE_GITHUB_REPO`、`OMP_RUNTIME_ROOT` 注入。
- 安装器是 `harness/bootstrap/install.mjs`。它写新的家目录，不改 `omp/`。
- 检索说明只留 `harness/notes/web-research-policy.md`。
- Ponytail 只安装 skill。`pi-quotas@0.5.2` 由安装器装进 `$OMP_HOME/plugins`。
- `matt` / `pm` 的上游叶子标成 `SKILL_UNAVAILABLE`。
- `task` 的安装副本只有 `task-orchestration.ts` 一处，并导出 `beforeInvoke` / `afterInvoke`。
- 实验室脚本和根笔记没有挪目录。

`web-search` 包的正文改为指向检索政策。快照里的同名文件仍由清单守住原字节。

第 2 到第 12 步的包和验收已经落到 `packages/` 与 `harness/`。第 13 步的物理移动没有做。干净运行的命令和日志在 `docs/decomposition/clean-run.md`（冒烟脚本生成）。
