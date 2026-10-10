> 本文是原私有仓库的 README，随公开快照归档到 `docs/`。原 `notes/` 实验记录目录已在公开版中删除，相关链接已去掉；文中路径已脱敏（`~` = 用户主目录，`<repo>` = 本仓库根目录）。
>
> This is the README of the original private repository, archived here. The `notes/` experiment directory was removed from the public snapshot and links to it were dropped; paths are sanitized (`~` = home directory, `<repo>` = repository root).

# OMP 私有配置快照

保存截至 **2026-09-24** 的 OMP 配置快照，运行版本 **18.2.6**；当前维护工作流策略见下文链接。它是配置、扩展和技能的备份，并附相关实验文档证据，不包含 OMP 程序、账号登录状态或真实业务数据。

## 架构图与流程图

查看 **[OMP 配置架构与开发流程](architecture/README.md)**：包含配置架构、产品开发主流程、worktree 执行机制和 Terra 缺陷修复四张图，可在 GitHub 直接查看 PNG。

克隆或下载仓库后，用浏览器打开 [图表总览](architecture/index.html) 可交互查看，无需启动服务。目录保留 JSON 源文件、明暗截图、校验回执和 Archify 许可；图对应配置提交 `18f18ab`，是当时的历史快照，不表示当前已实现持续补位。不要为本次策略更新重生成或改写这些归档图。

## 收录内容

`omp/` 对应本机 `~/.omp/` 的配置布局，共 **673 个文件**；快照内容与部署状态分别核验：

| 路径 | 内容 |
|---|---|
| `omp/agent/config.yml` | 当前模型角色、任务参数、重试、上下文压缩、浏览器及技能设置 |
| `omp/agent/web-research-large.yml` | 研究任务配置片段，保留原文件名和用途 |
| `omp/agent/agents/` | 19 个自定义代理 |
| `omp/agent/rules/` | 3 份全局规则：`harness-router`（全部 agent）、`main-agent-orchestrator`（仅 root，`agents: [main]`）、`communication`（语言与风格，全部 agent） |
| `omp/agent/notes/` | 18 份按需执行与验收说明 |
| `omp/agent/commands/` | 3 份命令说明 |
| `omp/agent/extensions/` | 7 个扩展：编排、产品审查证据、归档、会话延续、任务健康、任务用量和网络研究 |
| `omp/agent/lib/` | 12 个任务共享实现文件 |
| `omp/agent/skills/` | 16 个技能目录及其随附脚本、资源和依赖清单，共 606 个文件 |
| `omp/plugins/` | 插件清单及锁文件，不含下载后的 `node_modules` |

当前角色、努力级别及显式回退关系以 `config.yml` 和代理定义为准。新工作流以 [2026-09-21 工作流基线策略](../omp/agent/notes/workflow-baseline-v1-20260921.md) 为准；[历史工作流决策](../omp/agent/notes/workflow-decisions.md) 和 [2026-09-20 协调策略] 保留其原始依据与记录。

2026-09-23 的基础交接、条件式产品发现和前端并发指导，以及 `shadcn`、`ui-ux-design-audit` 两项技能，已部署并完成哈希核对；真实三作者并发产品已完成独立验收。自动候选集成因缺依赖失败后由协调者恢复，覆盖范围与保留问题见[实验记录]。

后续完整 PM 与有限收尾已按[实施计划](../plans/pm-product-closure-20260923.md)修改并部署；候选实际安装、原产品 71 项测试/构建与受控合并已在副本验证。新项目一句话实战自行完成 PM 和 PLAN，但基础/业务拆分未达组织目标，已在业务开工前停止并保留现场；详见[执行报告]。不能由工程回归推断无人干预完整交付成功。

PM 三方案 × 两个相同题目的隔离比较已完成：四组首次交付、两组原生恢复后交付，均停在产品实现前。建议保留现有发现主干并吸收关键验收场景检查；实验方案未覆盖全局。产物差异、Sol 收敛缺口、失败与验证范围见[实测报告]和[证据索引]。

PM 已采用 A 方法并接入文件落盘、两位独立产品审查及真实回执/版本检查，已定向部署。三个一句话新项目都自动调用 PM 研究、写文件和双审；维修店、译者项目取得当前 PM 双 PASS，志愿服务项目达到有限观察上限仍有缺口。三个样本均出现过校验顺序问题，试验后仅澄清引文和裁决顺序，文字改善尚待自然任务验证。详见[本轮报告与证据]，不能将结果概括为无人干预完整产品交付成功。

快照包含最近补充的主模型终止错误通知与恢复提醒、Windows 命令规范，以及托盘和图片复制粘贴的实际验收要求。配置中的自动重试设置与健康扩展的终止通知是不同机制；健康扩展不会自行发起新模型请求。

## 未收录内容

- API 密钥、OAuth 登录信息、浏览器 Cookie 和认证数据库。
- 原始会话、历史、日志、编排数据库、运行目录、缓存、备份及用户文档。
- 本机 PowerShell 启动包装器：其中存在本机凭据配置，未复制进仓库。
- 历史工程实验项目与 MoJian 源码。本仓库另收录配置相关实验报告和筛选后的 PM 文档证据，不包含完整原始会话或可运行产品项目。
- OMP 安装包、Bun/Node 程序、已下载的插件依赖。

第三方技能保留其原有说明、署名和许可信息。唯一内容替换是 CloudBase 技能 `adapter-coze.md` 的两处固定示例密钥改为 `<COZE_API_KEY>`，原机器文件未改动。此替换及原始哈希记录在清单中，其余配置文件按字节保留。

`ponytail` 在本机 `.omp/agent/skills/` 下是指向 `~/.codex/skills/ponytail` 的已知 junction。快照将其目标内容导出为 6 个普通文件，不复制 junction；清单为这些文件记录了实际来源路径。

## 核对快照

需要 Python 3，仅使用标准库：

```powershell
python scripts/verify_snapshot.py
```

Strict root startup: `omp --model openai-codex/gpt-5.6-sol --thinking high`. It prevents automatic route substitution: an unresolved selector fails at startup, while a resolved unauthenticated Sol remains selected and its request fails. Bare `omp` cannot guarantee startup identity.

`snapshot-manifest.json` 记录每个文件的 SHA256、大小和来源版本。上传前使用 Gitleaks 8.30.1 扫描导出目录，未发现密钥；扫描工具及临时报告不入库。该扫描不保证识别所有未知格式凭据，后续更新仍需检查新增内容。

## 恢复与迁移

这是**当前 Windows 机器的配置快照**，不是跨平台的一键安装器。恢复前先关闭 OMP，并备份目标机器已有配置；不要删除或覆盖账号数据库和用户数据。

1. 安装匹配的 OMP 18.2.6 及其 Bun 运行环境（18.2.4 保留为已验证回退版本）。扩展直接引用 OMP 内部模块，换版本后需要重新验证兼容性。
2. 核对并复制 `omp/agent/` 下列项目到目标 `.omp/agent/`：`config.yml`、`web-research-large.yml`、`agents/`、`commands/`、`extensions/`、`lib/`、`notes/`、`rules/`、`skills/`。这是文件合并，不是镜像删除。
3. 将 `omp/plugins/` 中三个清单/锁文件复制至目标 `.omp/plugins/`。需要恢复插件时，在目标插件目录使用 Bun 按锁文件安装依赖；这会下载并安装其中列出的插件。
4. 在本地重新配置供应商登录及研究服务所需凭据。凭据不从 Git 仓库恢复，也不要写入此仓库。原本机启动包装器如需迁移，应在本地重建并从环境变量或凭据管理器取值。
5. 启动新的 OMP 会话，检查扩展加载、模型可用性及所需能力；需要编排或归档功能时，再核对其数据目录和 GitHub 权限。

### 需要核对的本机路径

配置和扩展保留了 `~`、`~/.bun/install/global/node_modules`、`~/.omp`、`D:/OMPData` 等绝对路径。归档扩展还引用本机归档索引目录及对应的 GitHub 仓库。

在其他账号或机器上恢复时，逐项修改这些路径并检查引用关系。`omp-control.ts`、`run-archiver.ts` 包含 Windows 原生文件身份与 D 盘边界检查，不能靠全局替换盘符就认定迁移完成。缺失的数据库、注册记录和归档状态不会由此快照重建。

快照校验只能证明仓库文件与清单一致，不代表新环境已经可以运行。原环境此前通过的 19 项健康/执行器测试和一次真实模型请求，不应被当作新机器的验收结果。

## 后续更新

从上述明确列出的配置目录重新导出，先排除凭据和运行数据，再更新清单、核对差异并扫描后提交。不要直接对整个 `.omp`、PowerShell 配置目录或用户主目录执行 Git 全量添加。

## 2026-09-18: Standard CLI isolated-controller proof

`scripts/omp-cli-smoke.ts` and `scripts/omp-cli-lab-extension.ts` provide a D:-only lab entry for the deployed controller. The retained evidence in `D:/Labs/omp/omp-field-lab-20260918/cli-entry/evidence/` records real `omp.exe --mode json --print` tool calls for register, resumed get, and resumed health. All three used the same persisted root session, `openai-codex/gpt-5.6-sol`, and a transcripted `thinkingLevel: high`; the production controller database plus WAL/SHM hashes were unchanged for every turn.

The lab loader is passed with `--trusted-extension`, so it intentionally proves the exact trusted loader plus normal CLI/model/tool loop. It does not prove behavior for the complete ambient plugin/extension set, native child extension discovery, or child-process propagation. It imports the deployed controller and redirects it to the D: controller database through `setControlTestDb`; no global runtime source was edited.

## 2026-09-18: SDK task-plan recovery boundary

This is separate from the standard-CLI proof. The SDK task-plan recovery attempt `b47cafc0-7974-4299-b5e8-6db9da73717d` is settled: its independent `reviewer-recovery-summary.json` and `.md` report no running or interrupted tasks, workspace writers, or active graph leases. Authors A and B produced successful commits, but their graph nodes were settled failed after the security-gate worker interruption and claim reconciliation; C was never claimed. The first zero-model recovery diagnostic is discarded because its worker did not inherit `FIELD_CONTROL_DB` and read a fallback empty D: database. The loader now rejects a missing explicit controller DB before a model request and records `controllerDb`; accepted recovery status is taken from the original DB and matches the original session, project, and run.

Security review is read-only and runs no tests. Parallel author outcomes are collected with `allSettled`, and an orphan is reconciled from evidence before a new graph is used; the old graph stays retained. The completed `a8dd0edc-3b33-4f9a-8628-762a54fa8437` trial merged three queue entries and cancelled two, with no remaining lock. Its final target `8a31e94e58fab4d1c4b29d3340831c07bb54980d` passed target verification and security; the root CLI check passed 11 tests for three modules. The first readiness candidate instead retained a strict security receipt that lacked four required receipt fields: `status`, `runId`, `generation`, and `findings`; its cancelled candidate and failure record remain part of the result. This establishes neither a generic scheduler, full ambient-plugin behavior, nor a serial comparison. Evidence: `D:/Labs/omp/omp-field-lab-20260918/field-project/attempts/a8dd0edc-3b33-4f9a-8628-762a54fa8437/` and `D:/Labs/omp/omp-field-lab-20260918/field-project/attempts/b47cafc0-7974-4299-b5e8-6db9da73717d/`.

## 2026-09-18: 单任务 worktree 交付方法

本快照增加了 `omp/agent/notes/worktree-delivery.md`：它把现有 OMP 控制能力串成一个串行闭环——实际进入已注册的任务 worktree、受控作者提交、以当前目标分支构造并验证候选结果、由唯一 Git 所有者在实际目标根目录执行 fast-forward 合并。使用前先按 `notes/workspace-lifecycle.md` 完成目标与 worktree 的 preflight；原生 task 没有每次调用的 cwd 参数，因此不能用派发文本或伪造 host cwd 代替 `/move` 后的真实 cwd。

该方法不提供自动依赖领取、跨 worktree 合并锁、合并队列、自动重试或清理。目标分支前进、冲突、脏工作区、未知写入者或无法解释的中断都必须停止检查；不得 force、reset 或删除未知 worktree。

在串行步骤 2 之后，`omp/agent/notes/task-graph.md` 提供可选的步骤 3：目标根创建不可变任务图，每个参与 session 必须真实位于其已注册的 task worktree，再原子领取自己声明的路径、资源和依赖节点。`task_deliver` 只登记已验证提交；不会合并到目标分支，也不会完成产品。图本身不自动跨 root 派发、不自动创建/清理 worktree、无自动 retry，且不提供 OS 隔离。

已交付节点可按 `omp/agent/notes/merge-queue.md` 进入可选步骤 4：实际目标根显式入队，按目标 ref 的 FIFO 与共用 Git 目录锁构造并验证实际 candidate，再只在实际目标根 apply。candidate 的当前门禁只证明 candidate；目标根当前门禁与产品 checkpoint 仍独立。中断或不确定 Git 阶段必须 reconcile 后停止并保留证据，只能显式 cancel 或用新 key requeue；不自动 retry、reset、abort、cleanup 或跨 root 派发模型。`D:/Labs/omp/omp-merge-lab-20260918/merge-queue-tests.log` 记录了 5 个隔离 Git/SQLite 控制器测试（163 个断言）通过，包括 FIFO、CAS 准入、候选和目标固定、冲突保留、取消及跨 runtime 恢复证明。`pilot-stage5/attempts/1a0ab2a6-5459-482d-a42c-4dd168d24368` 另记录一例真实模型的两作者并行、两次候选合并和目标门禁；它不是产品验收或普遍并行/恢复结论。回滚前先结清图节点和队列尝试，再一起恢复 controller、导入库和任务图/队列/交付/规则/决策/维护文档；保留控制数据库、分支、worktree 和证据。

隔离方法测试命令：

前置：已在 D 盘新建独立实验目录，并创建文件名为 `.omp-experiment-root`、内容为 `omp-dependency-lab/v1` 的 marker；其他环境请自建独立目录和 marker。

```powershell
$env:OMP_EXPERIMENT_ROOT='D:/Labs/omp/omp-merge-lab-20260918'
bun test tests/worktree-workflow.test.ts
bun test tests/task-graph.test.ts
bun test tests/task-graph-recovery.test.ts
```

这些测试使用 mock 模型、真实 Git fixture、隔离 SQLite 和两个独立进程，只是隔离方法验证，不证明真实项目已自动并行、自动合并或完成产品验收。`tests/task-graph-recovery.test.ts` 已完成控制器模拟中断恢复和未派发 claim cancel 回归；它不执行真实模型，也不证明真实子进程强杀或外部副作用检查。

## 2026-09-18: Generic task-plan automation

`scripts/task-plan-automation.ts` is a user-authorized, plan-driven runner for independently scoped code tasks, including frontend-worker UI branches. It validates a strict local plan, creates real D: worktrees and root sessions, schedules ready non-conflicting waves, uses the existing graph, standard verification/security gates, and merge queue, and records durable receipts. It has no automatic retry, reconciliation, cleanup, OS sandbox claim, fault-injection command, or performance claim. The manual graph route remains available. Full product and UI acceptance remain with the parent workflow after integration.

The lab-only focused suite (`bun test tests/task-plan-automation.test.ts`) passed four checks: two distinct DAG/scope plans with concurrency 1 and 2, fail-sibling stopping, identity/dirty/path/history/native-negative guards, and normal validation leaving the production DB plus WAL/SHM untouched. A no-model root-session smoke at `D:/Labs/omp/omp-automation-lab-20260918/automation/plugin-smoke/f082a015-4c2c-4f1c-9176-006969dd2f91/` loaded the extension, persisted its session and command evidence, and called only `project_register`. Usage and limits are in `omp/agent/notes/task-plan-automation.md`.

## 2026-09-18: Full ambient-extension lab proof

This is separate from the trusted-loader standard-CLI proof. `scripts/omp-ambient-smoke.ts` uses the installed SDK's normal `createAgentSession` discovery path, while `omp/agent/lib/ambient-lab.ts` fixes the experiment's mutable controller, archive, session, and work roots below an explicitly marked D: lab. The required root is `D:/Labs/omp/omp-automation-lab-20260918`, with `.omp-automation-lab-root` containing exactly `omp-automation-lab/v1`; set `OMP_AMBIENT_LAB_ROOT` to that root before the no-model entry points:

```powershell
$env:OMP_AMBIENT_LAB_ROOT = 'D:/Labs/omp/omp-automation-lab-20260918'
bun scripts/omp-ambient-smoke.ts --preflight
bun scripts/omp-ambient-smoke.ts --probe
```

The retained final probe discovered 13 entries: the six configured OMP extensions, six `pi-quotas` extensions, and one inline extension. It reported zero known and connected MCP servers in this installed configuration. The accepted run used a root `openai-codex/gpt-5.6-sol` session at `high`, prepared only local D: archive artifacts, and spawned an in-process native `verifier` child using `openai-codex/gpt-5.6-terra` at `high`. The child made a real `omp_control` `health` call and received `SUBAGENT_FORBIDDEN` from `project_get`, proving the root-only control boundary. It was a native OMP task, not an OS-worker isolation proof.

All evidence is retained under `D:/Labs/omp/omp-automation-lab-20260918/ambient/evidence/`, including three non-acceptance runs, the accepted native-child run, and one evidence-bound historical orphan reconciliation. Every recorded run/reconciliation compared the production controller DB, WAL, and SHM before and after and found them unchanged. Source/deployed parity is recorded there for the ambient helper and controller/archive/session seams. No remote archive publish was attempted. `final-summary.json` and `final-summary.md` give the exact source hashes, attempts, raw transcript usage fields, and limits; usage-entry counts are not provider-request counts.

## 2026-09-18: Automation fault-matrix boundary

`D:/Labs/omp/omp-automation-lab-20260918/faults/automation-faults-matrix-summary.json` records three focused fault tests with 46 assertions, plus a targeted cleanup-release check with one test and four assertions. They exercise real owned-process identity checks and real Git checkpoints against isolated D: controller databases. Task and merge receipts are explicitly deterministic mocks, so the matrix does not independently establish native provider behavior.

A later historical-fixture cleanup supplies the missing full CIM evidence: four exact owned hosts/helpers remained under an abandoned fixture. Two cooperative release markers were issued; all four exited, and the final source-path-based CIM scan found zero. The earlier inventory's cause is unknown and is not inferred here. The cleanup used no guarded kill or manual database edit. Evidence: `D:/Labs/omp/omp-automation-lab-20260918/faults/author-sibling-14bfabe7-2b96-4747-aea5-0ca68d3dc2ab/cleanup-20260918-1840/cleanup-summary.json` and `.md`.

## 2026-09-18: Native cancellation and recovery probe

`scripts/omp-native-cancel-smoke.ts` (reviewed SHA-256 `4a631867950cbb312163d2951f90f3f9df27e4299f9e63e994a86268c1a2c349`) records an isolated D: native task cancellation boundary. The retained accepted chain is `D:/Labs/omp/omp-automation-lab-20260918/faults/native-cancel/bf94a9fb-c0b0-44f1-92cb-14f3ca4c94cb/`, with final recovery evidence at `recovery-e9e6beb9-ddcc-4183-bdc4-9418e9706265/recovery-completed.json`. A real Terra/high native task was aborted by its `AbortController` after the first observed assistant response. The original task is therefore correctly settled as `failed` through evidence-bound reconciliation and requires a new generation; it is not a business-task success. The recovery verifier succeeded with an empty findings array, and final controller reads recorded no running or interrupted task, workspace writer, or process inventory entry. Production controller DB, WAL, and SHM hashes were unchanged.

Two failed attempts remain as evidence: an earlier over-constrained trigger did not cancel after a response, and the first verifier on the retained run put observations in an informational finding, which the controller correctly rejected as `RECONCILIATION_REQUIRED`. The accepted recovery used a new verifier receipt bound to the retained run and evidence; it did not recancel the native task, manually edit receipts, or weaken controller validation.

```powershell
bun scripts/omp-native-cancel-smoke.ts --preflight
$env:OMP_NATIVE_CANCEL_ARM = '1'
bun scripts/omp-native-cancel-smoke.ts --run
```

The recovery command is intentionally not a general launch recipe: it is hard-bound to the retained evidence. This probe uses the installed in-process native-task contract with isolated D: controller/session artifacts; it does not establish OS-process isolation, arbitrary cancellation safety, external-side-effect handling, or business delivery.

## 2026-09-18: Failed paired task-plan trial

The ordered pair at `D:/Labs/omp/omp-automation-lab-20260918/comparison/pair-20260918-i/` is inconclusive. Its original reporter pause is retained: `extension-registrations.jsonl` was incorrectly counted as a second serial attempt. A coordinator-approved, pair-specific reporter correction re-assessed the already completed serial evidence without re-running it, preserving the original `397916` ms wall time and both reporter hashes in `serial-reassessed.json`.

The serial leg completed with 12 successful native receipts, 48 durable provider requests, and Terra/high transcript identity. Its recorded assistant-usage subtotal is 221,349 input, 12,288 output, and 480,256 cache-read tokens (713,893 total); the recorded runtime usage estimate is USD 0.6862052, not a provider invoice. The production controller DB, WAL, and SHM were unchanged.

The parallel leg started only after the preserved seed, fixture, and production-DB checks, then stopped after `274826` ms. That duration is a failed-leg time, not a speed result. Its slug candidate verifier emitted a P1 claim that the boundary regex lacked `g`, but the retained transcript's `read` result contains `replace(/^-|-$/g, "")`; the serial and candidate files have the same SHA-256, and both return `hello` for `--Hello--`. The controller correctly stopped on the stored failing receipt rather than bypassing it. The run therefore ended with label merged, slug delivered, and `CONTROLLER_NEGATIVE_RESULT:run_complete`; `comparison-continuation-failure.json` retains the 10 terminal receipts and 44 durable requests. No retry, reconciliation, cleanup, or completed serial-versus-parallel performance claim followed.

## 2026-09-18: Rejected Unicode-boundary trial

Pair k is also inconclusive and retains its serial failure at `D:/Labs/omp/omp-automation-lab-20260918/comparison/pair-20260918-k/`. This was a source-backed defect rather than the earlier false-positive receipt: the slug candidate used `value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")`, which folds non-ASCII characters before the ASCII-only normalization rule. Its actual outputs were Kelvin sign `K → k`, dotted I `İ → i`, and `AKB → akb`; the frozen ASCII-only requirement expects empty, empty, and `a-b` respectively. The controller correctly stopped on the failing gate: label was delivered, slug remained claimed, and no parallel leg ran.

The retained failed serial leg took `222386` ms, with six terminal receipts, 26 durable requests, 59,701 input, 7,233 output, and 343,552 cache-read tokens (410,486 total), plus a recorded USD 0.2749084 runtime estimate rather than an invoice. Production controller DB, WAL, and SHM hashes remained unchanged. The failure is not a performance result, and no retry, reconciliation, cleanup, or comparison claim followed.

## 2026-09-18: Rejected gate-schema trial

Pair l is inconclusive and retains its serial failure at `D:/Labs/omp/omp-automation-lab-20260918/comparison/pair-20260918-l/`. Both task deliveries succeeded, but a candidate security receipt used structured status `complete` with no findings. The controller requires `PASS` for a gate, so it correctly rejected `run_complete` rather than interpreting a generic status string as acceptance. This was a runner prompt/schema-contract defect, unresolved at the time of the retained failure; no force-PASS or finding suppression was used. Label and slug were delivered, but the run stopped before a parallel leg.

The retained failed serial leg took `273637` ms, with eight terminal receipts, 35 durable requests, 105,555 input, 8,190 output, and 407,040 cache-read tokens (520,785 total), plus a recorded USD 0.390798 runtime estimate rather than an invoice. Production controller DB, WAL, and SHM hashes remained unchanged. The failure is not a performance result, and no retry, reconciliation, cleanup, or comparison claim followed.

## 2026-09-18: Rejected label-input-domain trial

Pair m at `D:/Labs/omp/omp-automation-lab-20260918/comparison/pair-20260918-m/` confirms that the repaired gate status contract works: the label verifier returned `PASS`, while security returned a valid, explicit `FAIL`. Its finding was functional rather than security-related: the frozen broad label requirement permits alphabetic Unicode input, but the candidate title-cased the first UTF-16 code unit and therefore leaves a lowercase supplementary-plane Deseret letter unchanged. The controller correctly retained `CONTROLLER_NEGATIVE_RESULT:run_complete`; label remained claimed, slug was never started, and no parallel leg ran.

The failed serial leg took `121157` ms, with three terminal receipts, 13 durable requests, 55,884 input, 4,362 output, and 145,920 cache-read tokens (206,166 total), plus a recorded USD 0.193296 runtime estimate rather than an invoice. Production controller DB, WAL, and SHM hashes remained unchanged. This is not a performance result. A subsequent pair uses a separately frozen ASCII-only label contract, so it will not be compared with pair m; the retained failure has no retry, reconciliation, cleanup, or further dispatch.

## 2026-09-18: Accepted ASCII-only paired observation

Pair n at `D:/Labs/omp/omp-automation-lab-20260918/comparison/pair-20260918-n/` is one ordered observation of the same frozen, tiny two-utility task: its label prompt explicitly limits benchmark inputs to ASCII, and its serial and parallel targets began from the same clean seed. Both legs completed target validation, both queues merged label then slug with no lock, and all 24 native transcripts record Terra/high. The source binding includes comparison runner `ce813f4fe564c32ca029dfb2a9f8e5d30591d1d3a6486cf9c4e5cbe9baf85ce6` and automation runner `35ab0853a593657fb0bf0d17ede764d84e32dc77544ea88443065ad918bf465a`; the strict gate-status repair is `f4a2b8d` and its captured focused suite passed 4/4 in 90.46 seconds.

| Leg | Wall time | Durable requests | Assistant token subtotal | Runtime usage estimate |
| --- | ---: | ---: | ---: | ---: |
| Serial | 392,801 ms | 48 | 718,158 | USD 0.6161328 |
| Parallel | 306,765 ms | 50 | 729,859 | USD 0.5844832 |

Parallel finished 21.9% sooner in this one ordered observation. The token subtotals include message assistant entries only: serial recorded 179,704 input, 12,630 output, and 525,824 cache-read tokens; parallel recorded 166,098 input, 11,825 output, and 551,936 cache-read tokens. The dollar values are recorded runtime usage estimates, not provider invoices. Production controller DB, WAL, and SHM hashes were unchanged before, between, and after the legs. This does not generalize to a full project or establish a statistical performance result; earlier failed trials i, k, l, and m remain retained above with their original evidence.
## OMP runtime compatibility

Internal OMP imports resolve only from `OMP_RUNTIME_ROOT` or Bun's global installation after the installed `@oh-my-pi/pi-coding-agent` identity and audited version are checked. Run `bun scripts/check-upgrade.ts` before an upgrade; use `OMP_DEPLOY_ROOT` with `--deployed` to audit a deployed mirror. The checker fails closed when reviewed source hashes change before importing an extension.

An active OMP session continues using code loaded when that session started. Begin a new session after an approved deployment. Rollback requires settled work and matching deployed postimage hashes; it never modifies controller databases, session records, authentication, or other runtime state.

The 2026-09-18 hardening adds observed model/effort dispatch notices, branch-bound research receipts, and versioned product acceptance receipts. Existing concurrency, budgets, and reasoning strengths are unchanged. Run lifecycle checks through `bun scripts/check-runtime-smoke.ts`, which fixes the D: lab environment before starting each isolated test process. The final repaired run passed 28 tests and preserved production DB/WAL/SHM byte hashes during that run. An earlier combined test command accidentally created a test project and run in the production controller; the exact retained records and cause are documented in [the smoke incident note].

The actual 18.2.4 → 18.2.5 upgrade, initial unknown-version rejection, per-version tests, global CLI canary, and rollback artifacts are recorded in [the upgrade verification]. Both reviewed versions remain accepted; mixed sibling versions and unreviewed releases are rejected.

The [2026-09-19 global configuration optimization] scopes the orchestrator rule to the root session, merges the two communication rules into `communication.md`, lowers `commit`/`tiny` to `medium`, re-enables the subagent request guard (`task.softRequestBudget: 80`), adds Terra fallbacks for `default`/`frontend`, and makes the three previously pinned reviewer agents reference role aliases. `tests/config-policy.test.ts` enforces these invariants; the planning record is `openspec/changes/optimize-global-config/`.

The [2026-09-19 product planning update] defaults complete products to bounded Exa + Brave research, a task table, module/dependency diagrams and an explicit parallelism decision. The existing branch runner now accepts frontend-worker and writes receipt-based task progress while leaving parent product acceptance pending. Six automation tests, 30 runtime smoke tests and one real two-author branch/integration experiment passed; no performance or full-product acceptance claim is made.

The [2026-09-20 repair routing update] adds a distinct Terra/high repair owner for confirmed post-implementation defects. It keeps initial author self-checking, the native four-task ceiling, runner waves, frozen controlled gates and all independent final acceptance roles unchanged.

The [2026-09-23 three-project PM study] retains three one-sentence native OMP sessions, their PM definitions, Sol contracts, source hashes, and independent quality review. All three automatically used the existing PM route; all three still need bounded product-definition revisions. The experiment stopped before engineering review or implementation and makes no full-product, general reliability, or speed claim.

The [research-first PM follow-up] deploys the existing Sol/PM guidance and observes one fresh one-sentence session. Research preceded PM; the final contract still needs scope, provenance and privacy revisions. No product implementation or new PM team was introduced.

The [PM direct research follow-up] lets the existing PM use shared search and own session-scoped research evidence. A fresh native session performed three PM searches and seven source reads; Sol consumed the product document. One receipt typo in the returned PM summary remains recorded separately from the accurate document references. No product implementation or general-autonomy claim is made.

The [2026-09-24 focused hybrid PM trial] reuses A's discovery backbone and selectively applies acceptance scenarios in two isolated one-sentence runs. Both PMs researched and delivered on their first attempt; important provenance and business-rule gaps remain. Historical A/B originals were independently compared, with bounded review corrections retained. No product implementation or global deployment occurred.
