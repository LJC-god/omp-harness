# 完整 PM 与 OMP 开发交接：有限收尾计划

状态：本轮有限修改、部署与工程验证已完成；一句话新实战在组织契约阶段未达标并停止，长期自主交付目标未完成。用户于本会话明确授权落盘并实施。详细结果见 [执行报告](../notes/pm-product-closure-20260923.md)。

## 目标与范围

一句正常完整项目需求，在既有上下文和授权下，由 Sol 主动组织完整 PM 产品发现、需求与创新方案、工程决策落盘、最小基础交接、第一层业务并发、受控集成、独立验收、Terra 集中修复及文件式交付。PM 不止补字段或生成任务表，选入本轮的创新能力必须进入实现和验收。

保留现有角色、最多四个写入作者、独立 worktree、公共文件单一所有者、就绪补入、失败停止、串行集成及当前源验收机制。保留 shadcn/Radix/Lucide 与 UIUX。Matt 暂时搁置，不修改其方法库、不增加强制阶段；Grok 升级独立待办。不新增第二层代理、角色、审批或调度/监控平台，不提高并发、超时或请求预算，不重写产品或调度核心。

## 基线与证据

- 配置基线：`38ba294d55bcc52295636b5404b59ff4457009e0`，`https://github.com/LJC-god/omp-config`。
- 原实战证据：`https://github.com/LJC-god/omp-community-workbench-evidence-20260923`，`c672d0102606c5ab98b1141c925f2d30adec13c5`；原本地目录只读保留。
- 原执行已证明三作者真实并发及产品验收；候选缺少依赖导致 `vitest` 不可运行。紫队部分合法 PASS 因派发时 `deliveryReady=false` 记为 INCONCLUSIVE，不能误诊为仅 JSON 解析失败。
- 本轮运行根：`D:/Labs/omp/pm-product-closure-20260923-01`。全部新实验、缓存、临时文件、浏览器资料、日志、数据库及 worktree 在此目录。新完整实战另用其下独立目录与新会话，不改动旧产品。

## 工作包和交接

| 包 | 所有权 | 交付与验收 | 状态 |
|---|---|---|---|
| P0 计划与现状核对 | Sol；本计划及证据索引 | 确认已有能力、原始失败根因与本轮边界 | 已完成 |
| P1 PM 与开发指导 | 指导作者；PM agent/skill、product-planning、skill-routing、frontend-workflow、verification-evidence、workflow-baseline、task-plan-automation 文档 | 新完整项目一句话默认完整 PM；有依据的创新、需求与开发任务/验收可追溯；图表不阻塞已就绪业务；审查服务和回执顺序明确 | 修改已完成；独立核对后修正回执术语 |
| P2 候选环境准备 | runner 作者；runner 与聚焦测试 | 候选自己的目录内执行明确准备命令；冻结检查不变；失败/源码变更留证停止；保持调度逻辑 | 修改已完成；边界修复定向复验 2 pass |
| P3 独立核对与回归 | Sol/独立审查者 | 实际成功安装→检查→受控合并；准备失败与锁文件变更拒绝；预览与源身份/回执聚焦证明 | 已执行并保留成功/失败；原验收套件 1 项超时未解决 |
| P4 定向部署和版本归档 | Sol | 备份、前后哈希、快照审计、提交与按既有授权推送 | 9 个指导文件已部署并核对哈希；候选/部署审计通过 |
| P5 新项目一句话实战 | 新 OMP 会话自行组织 | 仅普通业务提示词，无 PM/拆包/runner/审查提醒；观察完整规划、创造力、开发与交付 | PM 自动调用并返回完整定义；组织契约未达标，业务开工前停止 |

P1/P2 路径独立可并行，作者不得覆盖他人修改。P3 使用隔离夹具/已有代码的独立副本，不重派旧业务作者。产品原始作者和历史回执只作为来源，不冒充本轮新执行证据。准备与项目检查分别记录命令、cwd、结果和诊断；恢复保留原失败关联，不覆盖原 attempt。

## PM 完成与开发放行

默认完整 PM 适用于新完整项目，尤其一句话 brief；明确的小维护不套用全套流程。PM 完成用户/场景/问题、针对性调研、定位与创新推荐、完整旅程、角色/数据/业务规则、状态与异常/取消/恢复、体验方向、范围优先级、验收和关键未知。充分资料可复用，事实、推断和假设区分；不伪造用户研究，不按功能数量评价创新。

Sol 接受有明确用户价值的创新进入范围；普通可逆工程决定自行处理，仅重大业务歧义、新授权或不能安全解决的阻断返回用户。PM 使用现有研究交接路线，不能另开调度层。产品方案、架构接口、工作包和验收在既有文档保持追溯，不增设强制模板审批。最小基础是里程碑，不是缩减最终产品范围。

基础达到可运行工程、必要公共组件、稳定接口、持久化底层、聚焦检查及可提交状态即可放行。图表语义矛盾阻断对应依赖；单纯渲染排版并行完成，作者计入四人额度。最终图表仍须齐备准确可读。

## 审查与验收

协调者指定预览服务唯一负责人、源码/构建版本和消费者，保持服务至依赖审查结束。证据在源码外，已知忽略规则和启动说明尽量在冻结前完成。引用程序读取的提交与源指纹；标准顶层 status/summary/evidence/findings 回执与现有门禁一致；不将 JSON 塞进 summary，不手抄 SHA。当前源前置回执未就绪时不可用重发 PASS 关闭交付。保持独立复验、失败历史、指纹和未跟踪文件检查。

工程验证与实战结论分开：规范明确提示过步骤的本轮回归，不证明一句话自主组织。新项目实战只给业务要求；必要业务澄清、环境干预、工程提醒分别记录。无自然补位机会记未覆盖，无对照不声称提速。各调整报告“修改已完成 / 本轮运行已验证 / 后续真实任务尚待覆盖”，附提交、命令、结果、证据位置和边界。

## 实施记录

2026-09-23：P1/P2 已完成修改。PM 默认完整定义、创新追溯和开发放行规则已接入现有指导。未修改 Matt、模型配置、调度核心和验收门禁。

隔离工程验证记录：

- 配置与模型回归：`bun test tests/config-policy.test.ts tests/model-audit.test.ts`，19 pass；`checks/config-model-final.log`。先前旧文案断言失败保留在 `checks/config-model.log`。
- Runner 完整回归：`bun test tests/task-plan-automation.test.ts`，11 pass，保留四作者、补位、冲突隔离和失败停止；`checks/runner-final.log`。审查后新增边界断言另作定向复验。
- 原产品只读克隆实际安装链路：attempt `9bea46ef-351e-4c98-84a4-54712e1e62b2`，新候选运行 `bun install --frozen-lockfile`；作者、候选及目标的实际 `bun run check` 各 71 tests + build 通过，受控合并至 `bf904f03a98e0929a78d2c208d491c773eb8bb4d`。业务作者和模型门禁使用显式 mock，Git/controller/安装/项目检查实际执行；不作为新产品独立验收。命令适配脚本仅为模拟作者准备作者环境，不在候选代装。完整日志在 `candidate-real/`、`checks/real-project-*.json` 和该 attempt。
- 上述成功关联先前 attempt `a66e92b5-a774-4aa4-8b39-486ba94f2b33`：候选安装与合并已发生，但目标未准备依赖且候选探针检查过弱，末尾检查失败。保留原现场，修正隔离验证前置条件及检查后在新克隆执行；没有覆盖成一次成功。
- 预览聚焦验证：`bun <运行根>/preview/verify-preview.ts` 通过；构建 HTML/资源实际 HTTP 哈希匹配、消费者期间可达、源码指纹前后相同；`evidence/preview.json`。仅证明版本与生命周期，不冒充全量产品体验审查。
- 原验收套件冷启动钩子超时；相同限制重跑 47 pass、1 项 5 秒超时；定向重跑仍失败。未增加超时、修改门禁或清除失败。独立提取同一场景诊断显示旧 PASS 不覆盖新待结算审查，正确拒绝完成；该诊断不替代整套测试 PASS。见 `checks/acceptance-*.log` 与 `checks/acceptance-fixture-race-diagnostic.json`。
- 独立审查发现并修复超长输出截断后的字段尾部泄露、workspace 根漏判依赖两处边界。旧诊断失败记录保留，不包含真实凭据。
- 隔离偏差：审查者误启动未传实验根的测试，使用旧自动化实验目录（非旧实战产品）。协调者停止准确识别的测试进程树；保留 `checks/orphan-test-stop.json` 和影响清单。不能宣称本轮所有命令均遵守了新目录隔离。

初始观察记录：新项目实战于 2026-09-23 19:19（北京时间）启动，会话 `01a0cdfd-e2e8-7728-b1d3-a31413115fe3`，严格选择 `openai-codex/gpt-5.6-sol --thinking high`；配置实现提交 `ed8ad9245268bcf07270c29213eec72b73dc1372` 已推送。提示词文件 `equipment-trial/prompt.txt` SHA256 为 `404021cb41b50961a3652f44ccb4532af9ac2c2d38f53acf01582f6b39ddfdf3`，仅含一句共享设备借还业务需求。当时已观察到自行读取新指导并派发 `pm-worker / EquipmentProductDefinition`，要求完整旅程、状态/不变量、异常恢复、验收及创新推荐；其余结论以末尾实战停止记录为准。

修复后验证：`bun test tests/task-plan-automation.test.ts -t 'candidate-only setup|candidate setup failure'`，2 pass；`checks/runner-repair-focused.log`。覆盖长输出字段尾部不泄露、workspace 缺命令停止、安装退出失败、锁文件变更拒绝和现场保留。独立复审未发现剩余具体问题。

部署：9 个既有指导文件定向更新，前像与 `38ba294d` 一致后备份；`evidence/deployment.json` 记录前后 SHA256。runner 仍使用既有仓库脚本路径；未替换认证、配置或运行时扩展。`python scripts/verify_snapshot.py` 通过（660 文件）；`bun scripts/check-upgrade.ts` 与 `OMP_DEPLOY_ROOT=~/.omp bun scripts/check-upgrade.ts --deployed` 均通过，仅代表结构兼容性检查。

协调者另行核对真正旧实战目录 `D:/Labs/omp/foundation-handoff-20260923-01/product`：工作树干净，HEAD 仍为 `2276e74bb7b344d7d7d4cea6410e31211720c240`。

实战结论（2026-09-23 19:44，北京时间）：PM 已返回完整定义，Sol 落盘契约并取得 Purple PLAN PASS。原 F1 包含全部领域 API，U1 包含全部工作台；审查后改成同一所有者 F1a→F1b→F1c 串行，U1 仍需等待全部后端及 F1c 图表收据。没有纠正基础过大、业务包未独立释放的问题。PM 还将部分 Sol 假设及“无外部研究必要”的判断误归为用户事实。工程规则已修改不等于实战组织已达标。

协调者据此在业务作者派发前结束这次有界观察，仅停止经进程树确认的实验 Bun PID 22420，未停止 Codex 或其它项目，未清除现场/重新提示/自动恢复；`evidence/trial-stop.json` 记录原因，启动器退出 1 是观察者主动停止，不是产品自然运行失败。当前产品只有 Git 与文档；HEAD `0de41e3bca89fb16cd3913714029d87fc584b1ec`，审查后的契约修订以未提交状态保留。此次没有可交付业务系统，也没有并发/完整验收成功结论。

下一小块仅应聚焦 Sol 与 Purple PLAN 对基础/业务/图表依赖的实际判断，以及 PM 假设来源追溯；不引入 Matt、不提高预算、不扩建调度系统。本轮不擅自开展该后续规则改造或重启实战。

最终 runner 完整链路复验：attempt `689e81f4-4980-4801-84f5-c38d8b26cee9`，SHA256 `2ccfd73fa224d2d54537228d87608630cdcd1ffbd41a1eafdff1c13f5137dbd7` 与已提交版本一致。真实冻结安装、原产品 71 tests/build、受控合并及目标检查均通过；候选 HEAD/index/source/lockfiles 未改变，合并 HEAD `1f99f833615a914d9e6b88e57077c1f90466408e`。仍显式使用 mock 模型作者/门禁，不作为新实战产品验收。见 `candidate-real/plan-final.json` 和 `checks/candidate-real-final.log`。
