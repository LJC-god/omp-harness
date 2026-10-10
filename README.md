# omp-harness

**中文** | [English](#english)

这是一个基于 [oh-my-pi（OMP / pi）](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) 编程代理的**个人 harness**：配置、扩展（插件）、技能（skills）、安装器，以及一个默认关闭的 swarm（并行子任务）策略层。

> **这是脱敏后的公开快照。** 它由私有仓库 `omp-config` 的一个分支导出（只导出文件树，不含 git 历史）。本机绝对路径已替换为 `~` / `$HOME` / 环境变量或占位符（`<repo>` = 本仓库根目录），实验记录目录 `notes/` 已删除，无许可证的第三方技能已补上上游 LICENSE（见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。不包含任何密钥、登录状态或会话数据。

## 目录

| 路径 | 内容 |
|---|---|
| `harness/` | 安装器 `bootstrap/install.mjs`、干净家目录冒烟 `bootstrap/smoke.mjs`、配置/规则/agent 投影 |
| `packages/runtime/` | 运行时扩展与共享库（钉在 OMP **18.2.6**），含 `swarm-control/` |
| `packages/extensions/`、`packages/skills/`、`packages/omp-skill-web-search/` | 可单独安装的扩展与技能包 |
| `omp/` | 原 `~/.omp/` 配置布局的**参考快照**（已脱敏）；`scripts/verify_snapshot.py` 核对其哈希 |
| `docs/` | 拆分、决策、swarm、升级风险与架构图；`docs/PRIVATE-SNAPSHOT-README.md` 为原 README 存档 |
| `scripts/`、`tests/` | 拆分脚本与 Windows 实验室工具（多数依赖原机器的 `D:` 盘布局，仅供参考） |

## 安装

需要 Bun、Node 20+、Python 3。

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g @oh-my-pi/pi-coding-agent@18.2.6   # 不要用 18.8.x
export OMP_HOME="$HOME/.omp"
export OMP_DATA_ROOT="/绝对路径/omp-data"
export OMP_ARCHIVE_GITHUB_REPO="owner/omp-archive-index"
node harness/bootstrap/install.mjs
. "$OMP_HOME/agent/harness.env" && omp
```

Swarm **默认关闭**；仅在设置 `OMP_SWARM=1` 时启用（见 `docs/decomposition/SWARM.md`）。

## 检查 / 冒烟

```bash
(cd packages/runtime && bun install)
bun packages/runtime/test/acceptance.ts
bun packages/runtime/swarm-control/test/core.test.ts
for t in packages/omp-skill-web-search/test/smoke.mjs packages/skills/*/test/smoke.mjs; do node "$t"; done
node harness/bootstrap/smoke.mjs        # 安装到临时 HOME，用本地模型桩跑一遍（swarm 关/开各一次）
python3 scripts/verify_snapshot.py
```

## 许可证

本仓库自有代码采用 [MIT 许可证](LICENSE)（Copyright (c) 2026 LJC-god）。第三方技能遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`ui-ux-design-audit` 技能目录（`omp/agent/skills/ui-ux-design-audit/` 与 `packages/skills/omp-skill-ui-ux-design-audit/`）来源不明，在来源确认前不适用 MIT 许可，见其 `SOURCE.md`。

---

## English

A **personal harness** for the [oh-my-pi (OMP / pi)](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) coding agent: configuration, extensions (plugins), skills, an installer, and a swarm (parallel sub-task) policy layer that is **off by default**.

> **This is a sanitized public snapshot** exported (file tree only, no git history) from a branch of the private `omp-config` repository. Machine-specific absolute paths were replaced with `~` / `$HOME` / environment variables or placeholders (`<repo>` = repository root), the `notes/` experiment-artifact directory was removed, and upstream LICENSE files were added to third-party skills (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). It contains no secrets, logins or session data.

Layout: `harness/` (installer and clean-home smoke test), `packages/` (runtime extensions pinned to OMP 18.2.6, swarm-control, skill packages), `omp/` (sanitized reference snapshot of the original `~/.omp` layout, hash-checked by `scripts/verify_snapshot.py`), `docs/`, and `scripts/` + `tests/` (Windows lab tooling, mostly tied to the original machine's drive layout; reference only).

Install: see the commands above (`bun install -g @oh-my-pi/pi-coding-agent@18.2.6`, set `OMP_HOME`, `OMP_DATA_ROOT`, `OMP_ARCHIVE_GITHUB_REPO`, then `node harness/bootstrap/install.mjs`). Swarm is enabled only with `OMP_SWARM=1`.

Smoke tests: `bun packages/runtime/test/acceptance.ts`, `bun packages/runtime/swarm-control/test/core.test.ts`, the package `test/smoke.mjs` files, `node harness/bootstrap/smoke.mjs` (installs into a temporary HOME against a local stub model) and `python3 scripts/verify_snapshot.py`.

License: the original code in this repository is released under the [MIT License](LICENSE) (Copyright (c) 2026 LJC-god). Third-party skills keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The `ui-ux-design-audit` skill directories (`omp/agent/skills/ui-ux-design-audit/` and `packages/skills/omp-skill-ui-ux-design-audit/`) have unknown provenance and are excluded from the MIT license until it is confirmed; see their `SOURCE.md`.
