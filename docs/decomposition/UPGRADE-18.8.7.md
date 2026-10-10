# 从 18.2.6 升到 18.8.7 会断在哪里

日期：2026-10-09。本文只记录差异和升级步骤。**没有执行升级。** 安装器、`PINNED_OMP_VERSION` 和 harness 仍然只接受 18.2.6。

对照的是上游 tag `v18.8.7`（`can1357/oh-my-pi`）和 npm 上已发布的 `@oh-my-pi/pi-coding-agent@18.8.7`。tag 的 `package.json` 把 `bin` 写成 `src/cli.ts`；已发布的包和现在装的 18.2.6 一样，`bin` 是 `dist/cli.js`。升级探针必须以安装后的包为准，不能以 git 树的 `src/cli.ts` 为准。两边的 `engines.bun` 都是 `>=1.3.14`。

## 和我们直接相关的差异

### 版本门和加载

`packages/runtime/lib/host-apis.ts` 拒绝 18.2.6 以外的版本。安装器从 `omp` 真实路径向上找 `@oh-my-pi/pi-coding-agent`，版本不对就停。干净家目录里如果漏了 `OMP_RUNTIME_ROOT`，无版本的包名解析会把当前 `HOME` 下的缓存装成当时的最新版。这条在 18.8.7 上仍然成立，所以升级时仍然要先写绝对路径的 `OMP_RUNTIME_ROOT`，再按该目录的 `exports` 做文件 URL 导入。

已发布的 18.8.7 导出表仍把 `import` 指到 `./src/*.ts`，`types` 指到 `./dist/types/*.ts` 对应的声明。和 18.2.6 相比，导出键多了 5 个（`./extensibility/custom-commands/bundled/annotate`、`./ida`、`./ida/*`、`./tools/jfind`、`./tools/jfind/*`），少了 `./tools/hub` 和 `./tools/hub/*`。我们的 `loadExport` 用的子路径还在导出表里：`config/settings`、`config/model-resolver`、`session/session-manager`、`session/session-loader`、`task/discovery`、`web/search`。文件还在，不表示导出的函数签名没变。

tag 上这两处已经 404，18.2.6 的加载会直接失败：

- `packages/coding-agent/src/config/provider-globals.ts`。`loadResearchApis` 要 `applyProviderGlobalsFromSettings`。升级前要在安装好的 18.8.7 树里重新定位这个函数，再改 `host-apis.ts`。本次代码搜索被限流，没有把新路径写死。
- `packages/agent-core/src/compaction/messages.ts`。`loadContinuityApis` 要 `createCustomMessage`。tag 上这个符号在 `packages/agent/src/compaction/messages.ts`，编码包里还有一份 `packages/coding-agent/src/session/messages.ts`。已安装的 18.2.6 兄弟包仍是 `@oh-my-pi/pi-agent-core`，导出 `./compaction/*` → `./src/compaction/*.ts`。升级时要看 18.8.7 安装目录旁边的兄弟包还叫不叫这个名字，以及 `compaction/messages` 是否仍导出 `createCustomMessage`。

`config/settings-schema.ts` 在 tag 上 404。设置拆过。不要再假设旧的 schema 文件路径。

### 扩展 API

`invokeTool` 仍在扩展类型里，语义仍是 shadow 同名内置工具时的委托，不是 pi 的 `executeTool(name, args)`。`registerFlag(name, { type: "boolean" | "string" })` 和 `getFlag` 仍在。`before_agent_start` 仍可以用返回值替换 `systemPrompt` 数组。

`task.batch` 的门还在。设置关闭时，原生工具拒绝 `{ context, tasks }` 这种形状。我们的 swarm 在打开时由 shadow 把这种形状拆成多次扁平 `invokeTool`，所以升级不要求把 harness 的 `task.batch` 改成 true。门的报错文案如果改了，只影响关闭 swarm 时的原生拒绝，验收仍应看到同一次扁平调用成功。

`tools.xdev` 默认仍是 true。扩展工具挂在 `xd://`，不会出现在 openai-completions 的顶层 function 名单里。18.8.7 新增 `tools.xdevDocs`，默认 `catalog`。升级冒烟要继续按工具名断言执行结果，不要把“名单里看不见扩展工具”当成加载失败，也不要为了冒烟把 `tools.xdev` 设成 false。

### Skill 和插件发现

18.8.7 的 `docs/skills.md` 仍然是非递归的 `skills/<name>/SKILL.md`，`skills.customDirectories` 也仍是这一层。会改变我们这套安装结果的是后面的规则：

- 同名时，custom directory 仍然压过 provider，但被挤掉的那份如果正文不同，会留在 `<namespace>/<name>` 下；正文和 frontmatter 都相同则静默丢掉。
- 原始 `name` 不能含 `/` 或 `\`。
- 系统提示里的 skill 列表取决于某个工具声明了 `readsSkillUris`，否则退回到“有 `read` 工具”。只改发现规则、不改提示门，模型可能看不到原来的列表。
- 新增 `skillshare`（优先级 95）和 `agent-plugins`（优先级 75）。`omp-plugins` 的 skill 来自插件旁边的 `skills/` 目录，不是 `package.json` 里的 `omp.skills` 数组。tag 上的插件类型有 `extensions`、`hooks`、`commands`，没有 `omp.skills` 字段。

我们的 skill 包都是目录下一层 `SKILL.md`，名字不含斜杠。升级后要重跑现有 skill 冒烟，确认裸名还在，并且没有被同正文去重误删。不要在 18.2.6 的包清单里提前写 `omp.skills`。

### 插件和 task shadow

`@timiliang/pi-quotas@0.5.2` 没有在 18.8.7 上重新做过加载探针。升级步骤里要单独装一次并看它是否仍被 18.8.7 接受。Ponytail 仍然只作为 skill，不安装插件。

唯一的 `task` shadow 依赖 `sourceInfo.source === "builtin"` 和 `invokeTool`。这两点在 18.8.7 的类型里还在。升级后要重跑 shadow 冒烟：关闭 swarm 时结果形状不变；打开 swarm 时仍是这一处 `registerTool({ name: "task" })`，扇出仍走原生执行器。

## 升级步骤

每一步都在临时 `HOME` 里做。通过之前不改仓库里的 pin，也不改 `omp/`。

1. **探针，不切换 pin。** 在临时前缀安装 `@oh-my-pi/pi-coding-agent@18.8.7`，写出它的真实目录。断言包名、版本、`dist/cli.js`，以及兄弟包里 `createCustomMessage` 和 `applyProviderGlobalsFromSettings` 的实际文件。缺任何一个就停，先改 `host-apis.ts` 的导出子路径。这一步的测试是一个只读脚本：打印路径和导出的函数名，退出码非 0 即阻断。
2. **单测锁。** 把 pin 改成 18.8.7 的改动先放在分支上。`packages/runtime/test/acceptance.ts` 里“假 18.8.7 根必须拒绝”要改成“假版本必须拒绝，真 18.8.7 根必须接受”。swarm 单测不依赖运行时版本，应原样通过。
3. **导入。** 用第 1 步的路径改 `loadResearchApis` 和 `loadContinuityApis`。再跑 acceptance。禁止在扩展源码里写 `pi-coding-agent/src/` 这种私有路径字符串；继续走 `exports` 和文件 URL。
4. **Skill。** 对每个 skill 包跑现有 `install.mjs` 冒烟，并在 18.8.7 会话里确认 `<skills>` 列表仍有 `web-search`、`ponytail`、`matt`、`pm`、`caveman`。如果列表变空，先查 `readsSkillUris`，不要复制一份同正文 skill 去碰去重。
5. **扩展加载。** 安装器指向 18.8.7 的 `OMP_RUNTIME_ROOT`。干净家目录冒烟：无 `Failed to load extension`，`web_research_v1`、`omp_archive`、`OMP_TASK_SHADOW` 仍在。`tools.xdev` 保持默认。
6. **Swarm。** 同一套冒烟再跑 `OMP_SWARM=1`：至少 4 个只读子任务，`swarm_status` 带 `assigned` 和 `criticalSteps`，`registerTool({ name: "task" })` 仍是一处。
7. **配额插件。** 单独确认 `@timiliang/pi-quotas@0.5.2` 能被 18.8.7 加载。不能就先固定兼容版本，不要顺手升级别的插件。
8. **快照。** `python3 scripts/verify_snapshot.py` 必须仍然通过。`omp/` 的字节在安装器接管之前不变。
9. **文档和 pin 一起改。** acceptance、安装器、`DECISIONS.md` 和 harness 说明从 18.2.6 改到 18.8.7。在此之前的失败都回退到现在的 pin。

没有模型凭证时，不要为升级补一组编造的质量分数。`packages/runtime/swarm-control/eval/run-swarm-eval.mjs` 在缺少凭证时退出 2。
