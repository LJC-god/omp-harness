# 已采纳的保守决定

日期：2026-10-09。这些选择会改变行为或丢掉一条来源时，只保留更接近现行快照的一边，并继续把安装器跑通。主人之后可以改。

## 运行时钉在 18.2.6

快照审计版本是 18.2.6。2026-10-09 的上游 main 是 18.8.7。升级会改变扩展加载和 skill 发现，所以 harness 拒绝其他版本。

安装器从 `omp` 可执行文件的真实路径向上找到 `@oh-my-pi/pi-coding-agent@18.2.6`，把目录写进 `OMP_RUNTIME_ROOT`。宿主模块优先用这个目录，按 `package.json` 的 `exports` 做文件 URL 导入。不在扩展源码里写私有路径，也不从家目录之外的文件对包名做无版本解析：那样会让加载器把当前 `HOME` 下的缓存装成 18.8.7。未设置 `OMP_RUNTIME_ROOT` 时，只接受从本包依赖解析到的 18.2.6。

宿主模块按导出表加载这些公开入口：

- `@oh-my-pi/pi-coding-agent/config/settings`
- `@oh-my-pi/pi-coding-agent/config/provider-globals`
- `@oh-my-pi/pi-coding-agent/config/model-resolver`
- `@oh-my-pi/pi-coding-agent/session/session-manager`
- `@oh-my-pi/pi-coding-agent/session/session-loader`
- `@oh-my-pi/pi-coding-agent/task/discovery`
- `@oh-my-pi/pi-coding-agent/web/search`
- `@oh-my-pi/pi-utils`
- `@oh-my-pi/pi-agent-core/compaction/messages`

CLI 仍是打包后的 `dist/cli.js`。扩展走这些导出时会再加载一份 `src` 模块。任务 shadow 继续使用 `pi.pi.AgentRegistry.global()`，不另建注册表。

## 路径从环境变量来

| 变量 | 用途 |
|---|---|
| `OMP_HOME` | 安装根，默认是目标用户的 `~/.omp` |
| `OMP_DATA_ROOT` | 代替写死的数据盘。归档、worktree、保留目录都在它下面 |
| `OMP_CONTROL_DB` | 控制库。未设置时用 `$OMP_HOME/agent/orchestration.sqlite` |
| `OMP_ARCHIVE_INDEX_DIR` | 归档索引目录 |
| `OMP_ARCHIVE_GITHUB_REPO` | `owner/omp-archive-...`。没有默认远程 |
| `OMP_SKILLS_DIR` | 安装器写入配置的技能目录 |
| `OMP_RUNTIME_ROOT` | 已安装的 `@oh-my-pi/pi-coding-agent@18.2.6` 目录。安装器写入，扩展导入前核对版本 |

缺 `OMP_DATA_ROOT` 或合格的归档远程时，安装器失败退出。扩展在导入时读取这些变量，不用快照里的绝对路径当默认值。

## Windows 句柄与 Linux 替代

`directory-pin.ts` 在导入时不调用 `dlopen`。Windows 上才懒加载 `directory-pin-win32.ts`，盘符来自 `OMP_DATA_ROOT`。因此把数据根放在原来的 D: 上时，句柄身份与快照相同；换盘会失败关闭，而不是静默改语义。

非 Windows 上，目录 pin、归档根和索引目录只做 `OMP_DATA_ROOT` 下的词法约束，并拒绝已有符号链接。`run-archiver.ts` 里的 `walkDir` 仍要求盘符 D:，Linux 加载和 `status` 不调用它。会话结束时的自动归档在非 Windows 上直接跳过。控制库的 Windows ACL 在非 Windows 上改为 `chmod 0600`。

`sourceFingerprint` 在 Windows 上只接受 Program Files 里的 Git；其他系统使用 `PATH` 上的 `git`。这避开了在导入时打开 `shell32.dll`。

## 插件、Ponytail、matt、pm

- 安装器只 `bun install` `@timiliang/pi-quotas@0.5.2`，并在锁文件里启用它。
- 不安装 `@dietrichgebert/ponytail`。活的 Ponytail 是 `packages/skills/omp-skill-ponytail` 里的 skill 文件，与快照正文一致。
- `matt` 和 `pm` 不附带上游叶子仓库。包内路径改成 `SKILL_UNAVAILABLE`，并写明叶子没有随包分发。不要把这当成已经读过官方叶子。
- `caveman`、设计类 skill、`archify`、`baoyu-design`、`cloudbase` 仍以冻结快照字节为锁。安装器原样复制。`cloudbase` 没有单独再打一份包。

## 检索策略只有一份说明

`harness/notes/web-research-policy.md` 是唯一的散文说明。harness 规则、斜杠命令和 `web-search` skill 只指向它。工具实现里的引擎数组仍是行为本身。`providers.webSearchOrder` 继续只作用于供应商层。

`web-search` 包不再要求与快照字节相同。快照里的那份文件保持原样，由 `verify_snapshot.py` 守住。

## 编排

`packages/runtime/extensions/task-orchestration.ts` 是安装树里唯一的 `registerTool({ name: "task" })`。它导出 `registerTaskHooks` 的 `beforeInvoke` / `afterInvoke`。没有 `create_subagent`，也没有把 `task.batch` 改成 true。冻结快照里的 `task-health.ts` 仍在，安装器不部署它。

`sourceFingerprint` 从控制器文件拆到 `packages/runtime/lib/source-fingerprint.ts`。延续扩展不再导入整份控制器。

## 没有移动的东西

实验室脚本仍留在 `scripts/`。根目录 `notes/` 和 `plans/` 仍留在原地。移动它们会改掉现有测试和证据路径。安装器不把它们放进启动路径。

冻结的 `omp/` 不作为新家目录的来源，除了第三方 skill 字节和需要投影的历史笔记、命令。投影时替换本机路径。历史笔记里的盘符句子不再是这台机器的默认盘。

## 冒烟模型

干净运行使用本地 OpenAI 兼容桩和 `--config` 覆盖，只为了让 18.2.6 走完一轮。harness 的 `config.yml` 角色表不变。覆盖文件不属于安装结果。

18.2.6 的 `tools.xdev` 默认是 true。扩展工具挂在 `xd://`，不会出现在 openai-completions 请求的顶层 function 名单里。冒烟脚本按工具名调用 `web_research_v1`、`task` 和 `omp_archive`，用来证明它们已经注册并且能执行。没有把 `tools.xdev` 改成 false，因为那会改变模型看到的工具面。
