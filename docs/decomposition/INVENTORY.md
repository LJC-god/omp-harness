# OMP 配置快照组件清单

盘点日期：2026-10-09。对象是本仓库截至 2026-09-24 的 OMP **18.2.6** 配置快照（`snapshot-manifest.json` 的 `ompVersion`，`omp/agent/lib/omp-runtime.ts` 的 `AUDITED_OMP_VERSIONS` 还接受 18.2.4 与 18.2.5）。`omp/` 对应本机 `~/.omp/`，共 673 个文件。`scripts/verify_snapshot.py` 要求 `omp/` 的路径集合与 SHA256 和清单一致；清单外的文件可以新增，改动 `omp/` 内任一字节都会让校验失败。

本清单只描述仓库里实际存在的组件。上游加载规则见 `PLAN.md`。

## 1. 模型路由

权威文件：`omp/agent/config.yml`。研究任务片段：`omp/agent/web-research-large.yml`（只覆盖 `task.maxRuntimeMs: 900000`）。

| 角色 | 选择器 | 回退 |
|---|---|---|
| `default` | `openai-codex/gpt-5.6-sol:high` | 空 |
| `smol` | `zhipu-coding-plan/glm-5.3:high` | Terra high |
| `task` | `xai-oauth/grok-4.6:xhigh` | Terra high |
| `slow` / `plan` | Terra max | 空 |
| `vision` | Luna max | Terra high |
| `commit` / `tiny` | Luna medium | Terra high |
| `advisor` | GLM max | Terra high |
| `implement` | Grok 4.6 xhigh | `cursor/cursor-grok-4.6-fast` |
| `review` / `repair` / `aesthetic` / `security` | Terra high | 空 |
| `scan` / `research` | GLM high | Terra high |
| `fast` | Luna max | Terra high |
| `frontend` / `synthesis` | `kimi-code/k3:high` | Terra high |
| `deepseek` | `opencode-go/deepseek-v4.1-flash:high` | Terra high |

`enabledModels` 另含尚未绑到角色的 `gpt-5.6` 以外条目：`openai-codex/gpt-6-astra`、`xai-oauth/grok-4.7`、`cursor/claude-4.6-opus-max`、`cursor/gemini-3.8-flash`。

任务参数：`task.batch: false`，`maxConcurrency: 8`，`maxRecursionDepth: 1`，`maxRuntimeMs: 1800000`，`softRequestBudget: 80`，`enableEffort: false`。`defaultThinkingLevel: high`。`retry.enabled`，最多 3 次，`waitForUsageReset: false`。`fallbackChains.default` 为空，注释写明这只阻止配置重试替换，不阻止运行时可用性选择。

内置 `web_search.enabled: false`。`providers.webSearchOrder` 是 `exa, tavily, brave, xai`，注释写明它喂给 OMP 搜索层，不喂给 `web_research_v1`。扩展自己的默认顺序是 Exa + Brave，Tavily 作后备。

技能发现被收成一条绝对路径：`skills.customDirectories: [~/.omp/agent/skills]`。Claude、Codex、Pi、Agents、OpenCode 的 user/project 技能和命令开关全部关闭。

其他本机项：`worktree.base: D:/OMPData/worktrees`，`browser.relay: true`，`dev.autoqaConsent: granted`，`setupVersion: 2`，压缩阈值 100000 / 保留 20000。

依赖：角色名被 agent frontmatter 的 `model: "@role"` 和 `task.agentModelOverrides` 引用。`tests/config-policy.test.ts` 锁住编排规则作用域、预算、Terra 回退和 reviewer 别名。`scripts/check-models.ts` 用 `lib/model-audit.ts` 对照已安装运行时。

耦合：这是 harness 核心，不是可单独发布的插件。路径和供应商登录都不能打进包。

## 2. 扩展

目录 `omp/agent/extensions/`。OMP 18.2.6 会自动加载这里的直接 `*.ts`。七个文件都 `export default function (pi: ExtensionAPI)`，类型来自 `@oh-my-pi/pi-coding-agent`。没有 `hooks/pre` 或 `hooks/post`。行为拦截都写在这些扩展里。

| 文件 | 做什么 | 注册的工具 / 命令 | 依赖 |
|---|---|---|---|
| `omp-control.ts`（4407 行） | 项目注册、worktree、任务图领取、合并队列、受控派发。SQLite 控制器 | `omp_control`；命令 `omp-resume-project`、`omp-recover-task` | `lib/task-health`、`task-graph`、`ambient-lab`、`omp-runtime`、`windows-directory-pin`；`bun:sqlite`、`bun:ffi`；运行时私有模块 `settings.ts`、`model-resolver.ts`、`session-manager.ts`、`task/discovery.ts` |
| `run-archiver.ts`（3553 行） | 把 run 归档到 D: 目录并发布 GitHub 索引 | `omp_archive` | `ambient-lab`；`bun:ffi`、`bun:sqlite`；硬编码归档根、索引目录和 `LJC-god/omp-archive-index` |
| `session-continuity.ts`（541 行） | 任务检查点、压缩后的延续、验收回执 | `omp_checkpoint`、`omp_history` | 直接 import `omp-control.ts` 的 `sourceFingerprint`；`lib/acceptance-evidence`；`pi-agent-core` 的 `src/compaction/messages.ts` |
| `task-health.ts`（218 行） | 监督子任务健康、派发通知、主模型失败提醒 | **重新注册内置 `task`**，再注册 `omp_task_metrics` | `lib/task-health`、`lib/task-dispatch`；`pi.pi.AgentRegistry.global()`；`toolCtx.invokeTool`；事件 `task:subagent:event`、`task:subagent:progress` |
| `web-research-tools.ts`（191 行） | Exa/Brave/Tavily/xAI 检索和回执 | `web_research_v1`、`omp_research_evidence` | `lib/research-evidence`、`lib/omp-runtime`；私有模块 `pi-utils`、`provider-globals.ts`、`settings.ts`、`web/search/index.ts` |
| `product-review.ts`（124 行） | 冻结 PM 文档快照并核对两位原生审查 | `omp_product_review` | `lib/product-review-evidence`；拦截名为 `task` 且 agent 为产品审查者的调用 |
| `task-usage.ts`（79 行） | 按检查点汇总 token / 请求 | `omp_usage_report` | `lib/task-usage`（再 import 运行时 `session-loader.ts`）、`lib/ambient-lab` |

`task-health.ts` 是本仓库里**唯一**调用 `registerTool({ name: "task" })` 的扩展。它在 `session_start` 里找到 `sourceInfo.source === "builtin"` 的 `task`，用同一 schema 再注册，`execute` 里调用 `toolCtx.invokeTool`。这是 2026-10-09 对照源码核实的，不是推断。第二个扩展如果也注册 `task`，会和这个 shadow 抢同一个工具名。计划里的编排层必须进这一个包装，不能再做一个包装。

`omp-control` 是另一条受控执行面（`project_spawn`、图、队列），不是原生 `task` 的 shadow。`product-review` 只在 `tool_call` 上拦截，不重新注册 `task`。

内部导入路径（都要先过 `inspectOmpRuntime` 的包名和版本门）：

- `pi-coding-agent/src/config/settings.ts`
- `pi-coding-agent/src/config/provider-globals.ts`
- `pi-coding-agent/src/config/model-resolver.ts`
- `pi-coding-agent/src/session/session-manager.ts`
- `pi-coding-agent/src/session/session-loader.ts`
- `pi-coding-agent/src/task/discovery.ts`
- `pi-coding-agent/src/web/search/index.ts`
- `pi-coding-agent/src/sdk.ts`（仅 `scripts/omp-ambient-smoke.ts`）
- `@oh-my-pi/pi-utils/src/index.ts`
- `@oh-my-pi/pi-agent-core/src/compaction/messages.ts`

这些是已安装包里的源码路径，不是稳定的插件公开面。

硬编码且不能进可发布包的值：

- `SYSTEM_DB_PATH = ~/.omp/agent/orchestration.sqlite`
- `WORKTREES_ROOT = D:/OMPData/worktrees`
- 保护根：`D:/OMPData`、`registry`、`archives`、`github`、`projects`、`github/omp-archive-index`
- `DEFAULT_ARCHIVE_ROOT = D:/OMPData/archives`
- `DEFAULT_INDEX_DIR = D:/OMPData/github/omp-archive-index`
- `CENTRAL_INDEX = LJC-god/omp-archive-index`，归档仓库名落到 `LJC-god/<repo>`

## 3. 共享库 `omp/agent/lib/`

| 文件 | 作用 | 被谁用 |
|---|---|---|
| `omp-runtime.ts` | 只从 `OMP_RUNTIME_ROOT` 或 Bun global 解析 `@oh-my-pi/pi-coding-agent`，版本必须是 18.2.4–18.2.6 | 扩展和多数脚本 |
| `task-health.ts` | 阶段计时、`guardedSubprocess` | `task-health` 扩展、`omp-control` |
| `task-dispatch.ts` | 模型派发通知文案 | `task-health` 扩展 |
| `task-graph.ts` | 任务图解析、路径重叠 | `omp-control`、`scripts/task-plan-automation.ts` |
| `task-usage.ts` | 从 session branch 和子 transcript 收集用量 | `task-usage` 扩展 |
| `ambient-lab.ts` | 把控制器 / 归档 / session 根限制在带 marker 的 D: 实验目录 | control、archiver、usage |
| `windows-directory-pin.ts` | Windows 目录句柄身份，`bun:ffi` | `omp-control`、`check-runtime-smoke.ts` |
| `research-evidence.ts` | 检索 / 抓取回执压缩 | `web-research-tools` |
| `product-review-evidence.ts` | 产品审查快照和校验 | `product-review` |
| `acceptance-evidence.ts` | 验收 schema、审查裁决 | `session-continuity` |
| `model-audit.ts` | 用 `bun:sqlite` 审计模型选择器 | `check-models.ts`、`tests/model-audit.test.ts` |
| `workspace-preflight.py` | 只读检查注册重叠和占用。默认库是 `~/.omp/agent/orchestration.sqlite` | 由 `notes/workspace-lifecycle.md` 点名，没有被 TypeScript import |

`session-continuity.ts` 跨文件 import `./omp-control.ts`，所以延续层和控制器还没有干净边界。

## 4. Agents

`omp/agent/agents/` 有 19 个 Markdown。OMP 从 agent 目录发现它们。`task.agentModelOverrides` 把内置名和这些文件绑到角色。没有对应文件、只在规则和 overrides 里出现的内置名：`scout` → `@scan`，`reviewer` → `@review`，`security-reviewer` → `@security`。

| Agent | 模型绑定 | 职责 |
|---|---|---|
| `task` | frontmatter `@implement`，override 同名 | 复杂后端、持久化、协议 |
| `sonic` | `@smol` | 有界非 UI 逻辑和测试 |
| `frontend-worker` | `@frontend` | UI 实现 |
| `baoyu-design-worker` | `@frontend` | 设计产物，读 `skill://baoyu-design` |
| `fast-worker` | override `@fast` | 机械编辑 |
| `repair-worker` | `@repair` | 已确认缺陷的 Terra 修复 |
| `pm-worker` | override `@plan` | 产品文档，读 `skill://pm` |
| `librarian` | override `@research` | 只读仓库研究 |
| `verifier` | `@review` | 技术门禁 |
| `purple-reviewer` | `@review` | PLAN / DELIVERY 证据 |
| `product-reviewer` | `@review` | BMAD 产品文档审查 |
| `product-rules-reviewer` | `@review` | pm-critic 规则审查 |
| `experience-reviewer` | frontmatter `@review`，**没有** override 条目 | 真实用户旅程验收 |
| `gpt-visual-director` | `@aesthetic` | 截图视觉审查 |
| `aesthetic-reviewer` | `@aesthetic` | 可选的另一块视觉范围 |
| `visual-reviewer` | override `@vision` | 客观渲染 / a11y |
| `daily-worker` | override `@scan` | DAILY 文本 |
| `daily-research` | override `@research` | DAILY 本地材料 |
| `deepseek-worker` | override `@deepseek` | 待命的补充任务 |

多数文件要求去读 `~/.omp/agent/rules/` 和 `~/.omp/agent/notes/`。这是提示词耦合，不是 import。`experience-reviewer`、`product-reviewer`、`product-rules-reviewer`、`purple-reviewer`、`deepseek-worker` 被规则标成只走原生 task，不走 `omp_control.project_spawn`。

重复：`gpt-visual-director`、`aesthetic-reviewer`、`visual-reviewer` 三份都做可见 UI 判断，范围靠提示词区分。`product-reviewer` 与 `product-rules-reviewer` 共用快照协议，评审材料不同。

## 5. 规则

`omp/agent/rules/`。OMP 把 `rules/*.{md,mdc}` 当规则，frontmatter 支持 `alwaysApply`、`agents`、`description`。

| 文件 | frontmatter | 作用 |
|---|---|---|
| `communication.md` | `alwaysApply: true` | 对用户用中文；执行合同用英文；聊天默认 Caveman lite |
| `harness-router.md` | `alwaysApply: true` | CODING / DAILY 分类；研究必须走 `web_research_v1`；含 `D:/Labs/omp` |
| `main-agent-orchestrator.md` | `alwaysApply: true`，`agents: [main]` | Sol 的所有权、模型职责表、派发和验收。只注入根会话 |

`tests/config-policy.test.ts` 锁定 orchestrator 只作用于 `main`。这三份是 harness，不是可关的技能。

## 6. 命令

`omp/agent/commands/` 是给模型读的 Markdown，不是可执行 hook。

| 文件 | 作用 | 问题 |
|---|---|---|
| `coding-procedure.md` | 编码流程备忘 | 多处本机路径 |
| `maintenance-cleanup.md` | 清理已授权的测试残留 | 指向仓库外的 `D:/OMPData/registry/workflow-recovery-20260908/residue-manifest.ts` |
| `web-research-v1.md` | 检索命令说明 | 与 `web-search` skill、`harness-router`、扩展 description 重复 |

## 7. 按需笔记

`omp/agent/notes/` 有 18 份。OMP 不会把 notes 目录自动注入系统提示。规则和 agent 写明“需要时再 read”。

| 文件 | 作用 |
|---|---|
| `workflow-baseline-v1-20260921.md` | 当前工作流策略 |
| `workflow-decisions.md` | 历史决策，含大量 `D:/OMPData/registry` 和备份路径 |
| `product-planning.md` | PM、研究和并行策略 |
| `skill-routing.md` | 何时读哪个 skill |
| `architecture-catalog.md` | A/B/C/D 架构路线，指向 `templates/` |
| `verification-evidence.md` | 六字段派发和证据合同 |
| `frontend-workflow.md` | UI 作者和一次视觉审查 |
| `browser-verification.md` | 浏览器验收 |
| `git-checkpoints.md` | 本地提交节奏 |
| `workspace-lifecycle.md` | preflight 和注册重叠 |
| `worktree-delivery.md` | 单任务 worktree 闭环 |
| `task-graph.md` | 可选任务图 |
| `merge-queue.md` | 可选合并队列 |
| `task-plan-automation.md` | 计划驱动 runner 的用法和限制 |
| `session-handoff.md` | 会话交接 |
| `archive-procedure.md` | 归档步骤 |
| `omp-upgrade.md` | 升级核对 |
| `omp-evaluation.md` | 评估备注 |

仓库根 `notes/` 和 `plans/` 是实验报告和计划，OMP 不加载。`docs/architecture/` 是冻结的 Archify 图（对应提交 `18f18ab`），README 禁止为策略更新重画。

## 8. Skills

发现入口只有 `config.yml` 的那条 custom directory。16 个目录、606 个文件。嵌套的 `SKILL.md`（例如 PM 审查材料里的叶子）不会被非递归扫描发现，只有顶层 `skills/<name>/SKILL.md` 会。

### 8.1 本仓库自己的 skill

| Skill | 文件数 | 做什么 | 耦合 |
|---|---|---|---|
| `web-search` | 1 | 说明现行入口是 `web_research_v1`，并写明 live harness 不需要靠加载这个 skill 来检索 | 无运行时 import，无本机路径。正文与命令、规则重复 |
| `fixed-route` | 1 | 从架构目录选 profile | 读 `architecture-catalog.md` 和全局编排规则 |
| `product-testing` | 1 | 关键路径回归 | `D:/Labs/omp`、`browser-verification.md`、`repair-worker` |
| `ui-ux-design-audit` | 2 | 设计前简报或独立审计 | 审查角色在 agent / notes 里。来源不明的原始文本已移除；本目录不适用根 MIT 许可，见其 `SOURCE.md` |
| `matt` | 4 | 工程方法路由 | 叶子在仓库外：`~/.omp/agent/git/github.com/mattpocock/skills/` |
| `pm` | 14 | 产品定义和双审材料 | 叶子在仓库外的 Dean Peters 路径；内含 BMAD 与 pm-critic 副本；绑定 `pm-worker`、`web_research_v1`、产品审查扩展 |
| `cloudbase` | 139 | CloudBase 路由到一份 reference | 上游技能加本地中文路由。`adapter-coze.md` 的示例密钥已换成 `<COZE_API_KEY>`。其余示例口令仍是文档占位，不是本机凭据 |

`matt` 和 `pm` 在别的机器上是不完整的：快照没有 `agent/git/`。

### 8.2 第三方原文，应改为锁版本而不是继续抄进快照

| Skill | 文件数 | 来源 |
|---|---|---|
| `caveman` | 1 | 压缩文风。`communication.md` 只引用模式名 |
| `ponytail` | 6 | DietrichGebert/ponytail。本机曾是 junction；插件锁里同包 `enabled: false` |
| `frontend-design` | 2 | 带 `LICENSE.txt` |
| `emil-design-eng` | 1 | Emil Kowalski 设计工程笔记 |
| `fixing-accessibility` | 1 | 无障碍修补规则 |
| `fixing-motion-performance` | 1 | 动效性能规则 |
| `shadcn` | 16 | shadcn/ui skill。`allowed-tools` 在 OMP 里不执行 |
| `archify` | 218 | tt-a1i，MIT，`metadata.version` 2.17。自带测试和渲染器 |
| `baoyu-design` | 197 | JimLiu/baoyu-design，commit `026d4ea` 曾核对过。自带测试 |

这些目录没有 import 本仓库的 lib。体积大，和编排逻辑耦合低。

## 9. 插件锁

`omp/plugins/package.json`、`omp-plugins.lock.json`、`bun.lock`。没有 `node_modules`。

| 包 | 锁版本 | 开关 | 现状 |
|---|---|---|---|
| `@timiliang/pi-quotas` | 0.5.2 | `enabled: true` | README 的 ambient 探针在已安装机器上看到 6 个 pi-quotas 扩展。克隆本仓库不会带上这些文件，不执行 `bun install` 就加载不到 |
| `@dietrichgebert/ponytail` | 4.9.0 | `enabled: false` | 活的是 `skills/ponytail` 那 6 个文件 |

## 10. 脚本、测试、模板

### 脚本（`scripts/`）

| 脚本 | 分类 | 说明 |
|---|---|---|
| `verify_snapshot.py` | 仓库门禁 | 标准库。核对 `omp/` 与清单 |
| `verify_architecture_docs.py` | 仓库门禁 | 冻结架构图的哈希和链接 |
| `check-upgrade.ts` | 升级门禁 | 运行时身份和源码哈希 |
| `check-runtime-smoke.ts` | 实验室 | 固定 D: 环境后跑隔离测试 |
| `check-models.ts` | 实验室 | 默认 home `~` |
| `omp-ambient-smoke.ts` | 实验室 | SDK `createAgentSession`，要已安装的 18.2.6 |
| `omp-cli-smoke.ts` / `omp-cli-lab-extension.ts` | 实验室 | D: CLI 探针 |
| `omp-native-cancel-smoke.ts` | 实验室 | 绑定既有证据目录的取消探针 |
| `omp-automation-faults.ts` | 实验室 | **直接写死** `~/.bun/install/global/node_modules/@oh-my-pi/...` |
| `task-graph-live-extension.ts` / `task-plan-field-extension.ts` | 实验室 | 同样写死 Bun global 路径，并 import `omp-control` |
| `task-graph-live-pilot.ts` / `task-plan-field-pilot.ts` / `task-plan-automation.ts` / `task-plan-automation-extension.ts` / `task-plan-comparison.ts` / `task-plan-progress.ts` | 实验室 | 计划 runner 和现场试点。`task-plan-comparison.ts` 把仓库钉在 `<repo>` |
| `native-postgres.mjs` | 实验室 | 显式根目录下的 PostgreSQL 生命周期 |

实验室脚本不是 OMP 启动时加载的扩展。它们依赖本机 D: marker 和已安装运行时。

### 测试（`tests/`）

`config-policy.test.ts` 只读仓库里的 yml / 规则 / agent。其余测试驱动 lib 和扩展：任务图、合并队列、worktree、研究回执、产品审查、验收、运行时兼容、派发通知、自动化故障。它们使用 `bun:test`，本环境没有 Bun，不能在这里重跑。隔离实验还要求 D: marker。这些测试锁的是控制器行为，第一步 skill 包不碰它们。

### 模板

`templates/business-c`：React + Vite、NestJS、Prisma、pnpm workspace。`architecture-catalog.md` 的 profile C 指向它。它是产品脚手架，不是 OMP 插件。README 写明没有默认口令；凭据走 `apps/api/.env`，示例文件可以留，真实 `.env` 被 gitignore。

## 11. 恢复笔记

OMP 不把这些当扩展加载。它们记录已经发生的实验和回滚条件。

- 根 `README.md`：恢复步骤、CLI / SDK / ambient / 取消 / 配对实验 i、k、l、m、n。证据目录在 `D:/Labs/omp/...`，不在 git 里。
- 根 `notes/*.md` 与子目录：升级、运行时事故、全局配置、协调策略、多轮 PM 实验。
- `plans/pm-*.md`：这些实验的计划。
- `openspec/`：只有已归档的 `optimize-global-config` 和现行 spec `global-config-policy`。
- `omp/agent/notes/omp-upgrade.md`、`archive-procedure.md`、`session-handoff.md`。

恢复动作是关闭 OMP、备份目标配置、按文件合并 `omp/agent/`、在插件目录用 Bun 装锁文件、在本地重新登录。快照校验不等于新机器可运行。

## 12. 重复、失效和不能发布的内容

重复：

- 检索策略同时写在 `harness-router.md`、`skills/web-search`、`commands/web-research-v1.md`、`web-research-tools.ts` 的 description、`config.yml` 注释。
- Ponytail 同时是禁用插件和一份 skill 副本。
- Caveman 的模式名写在规则里，正文又是一份 skill。
- PM 方法在 `omp/agent/skills/pm` 和 `notes/pm-*-study-*` 里各有一份。
- 视觉审查有三个 agent。

失效或不完整：

- `web-search` 自己写明 live harness 不必靠它检索。它仍会被 custom directory 扫进技能列表，描述会出现在提示里。
- `matt` / `pm` 指向的 git 叶子不在快照中。
- `maintenance-cleanup.md` 指向的 residue parser 不在快照中。
- `@timiliang/pi-quotas` 标记为启用，但依赖没有入库。
- `ponytail` 插件关闭，skill 副本才是活的。
- 三个脚本绕过 `omp-runtime.ts`，把 Bun global 路径写死。换账号或换版本会直接失败。
- 扩展 import 的 `src/**` 在 18.2.6 与上游 18.8.7 之间没有兼容承诺。

不能打进可发布包：

- `~`、`.omp`、`.bun/install/global/node_modules`。
- `D:/OMPData/**`、`D:/Labs/omp/**`、`<repo>`、`D:/plans/`。
- 控制库、WAL、session、归档索引、GitHub 账号 `LJC-god` 的默认远程。
- 供应商登录、API key、Cookie。CloudBase 文档里的 `your-api-key`、`editor123` 是上游示例，不是本机秘密，但仍不应被当成可用凭据。
- README 已排除的 PowerShell 启动包装器没有入库。仓库 `.gitignore` 还排除 `.env`、`*.pem`、`auth.json`、`*.db`、`node_modules/` 和 `omp/agent/sessions/` 等运行数据。

没有发现本机真实 API key。Gitleaks 记录在 README，扫描器本身未入库。
