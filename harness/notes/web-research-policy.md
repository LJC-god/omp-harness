# Web research policy

这是检索策略的唯一说明。规则、命令、skill 和工具描述只指向本文件，不再各写一套引擎顺序。

实现在 `web_research_v1`（扩展 `web-research-tools.ts`）。下面的顺序必须和那份实现一致。

- 内置 `web_search` 保持关闭。
- `providers.webSearchOrder` 只作用于 OMP 的搜索供应商层，不驱动这个扩展。
- 默认 `quick` 且不传 `engine`：并行查询 Exa 和 Brave，各 15 秒。两边都不可用时才回退 Tavily，15 秒。
- 指定 `engine`：先用该引擎，失败再用一个回退（指定 Tavily 时回退 Exa，否则回退 Tavily）。
- `cross_check`：Exa、Tavily、Brave、Grok 四个供应商并行，各 30 秒。只在来源冲突或明确需要独立覆盖时使用。
- 摘要不够时，用 `web_fetch` 或带 URL 的 `read` 读取原始页面。读到页面只证明读取完成，不证明主张成立。
- 用 `omp_research_evidence` 把当前分支上真实的检索或读取收据连到综合结论或缺口。它不发起新的网络请求。
- 供应商失败不是反面发现。检索不授予写权限。

不要再启动 discovery、audit 或 synthesis 代理来做例行检索。
