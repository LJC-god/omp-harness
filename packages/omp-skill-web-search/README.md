# omp-skill-web-search

OMP 18.2.6 的 skill-only 包。内容是 `web-search` 的兼容说明：现行研究入口是扩展工具 `web_research_v1`，这个 skill 只保留同名说明，避免检索策略散落在别处时失去对照。

## 布局

```text
skills/web-search/SKILL.md
```

这同时满足两套发现规则：

- 本快照实际使用的 `skills.customDirectories`：只扫描目录下一层 `*/SKILL.md`。
- 插件约定布局：`skills/<name>/SKILL.md`。18.2.6 的 `omp-plugins` provider 会扫描已安装插件旁的这个目录。当前 main 才有的 `omp.skills` 字段这里不使用。

`package.json` 不声明 `omp.extensions`。这不是扩展模块。

## 安装

```bash
node install.mjs --dest /path/to/skills-parent
```

安装器把 `skills/web-search/SKILL.md` 复制到 `<dest>/web-search/SKILL.md`。目标已有相同字节时直接成功。内容不同时拒绝覆盖。目标落在本仓库 `omp/` 快照树内时拒绝写入，避免改动现有 `config.yml` 的恢复副本。

冻结快照里的 `config.yml` 仍使用原来的绝对技能目录，本包不改那份文件。harness 安装器把本包装进新的 `OMP_HOME`，正文指向 `web-research-policy.md`，不再重复引擎顺序。

## 检查

```bash
node test/smoke.mjs
python scripts/verify_snapshot.py
```
