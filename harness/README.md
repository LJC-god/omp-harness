# Harness

这是拆分后的安装面。冻结的 `omp/` 快照保持原字节；本目录加上 `packages/` 才是新家目录的来源。

运行时钉在 **OMP 18.2.6**。不要用 18.8.7 安装这套扩展。决定和取舍写在 `docs/decomposition/DECISIONS.md`。

## 安装

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g @oh-my-pi/pi-coding-agent@18.2.6
export OMP_HOME="$HOME/.omp"
export OMP_DATA_ROOT="/绝对路径/omp-data"
export OMP_ARCHIVE_GITHUB_REPO="owner/omp-archive-index"
node harness/bootstrap/install.mjs
```

安装器把配置、规则、agent、扩展和 skill 写到 `OMP_HOME`，在 `OMP_HOME/plugins` 安装 `@timiliang/pi-quotas@0.5.2`，并且不安装 Ponytail 插件。它拒绝写入本仓库的 `omp/`。

之后先载入安装器写下的环境（里面有 `OMP_RUNTIME_ROOT`），再启动：

```bash
. "$OMP_HOME/agent/harness.env"
omp
```

或 `$OMP_HOME/bin/omp-with-harness`。

`harness/bootstrap/local.example.yml` 只是变量示例。真实本地文件不要提交。

## 检查

```bash
bun packages/runtime/test/acceptance.ts
node packages/omp-skill-web-search/test/smoke.mjs
node packages/skills/omp-skill-ponytail/test/smoke.mjs
python3 scripts/verify_snapshot.py
```

干净家目录的脚本化冒烟是 `node harness/bootstrap/smoke.mjs`。它会安装到临时 `HOME`，先用本地模型桩调用 `web_research_v1`、唯一的 `task` shadow 和 `omp_archive`（swarm 关闭），再用 `OMP_SWARM=1` 做一次至少 4 个只读子任务的扇出。行为说明在 `docs/decomposition/SWARM.md`。
