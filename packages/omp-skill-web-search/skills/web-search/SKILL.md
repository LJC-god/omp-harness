---
name: web-search
description: Compatibility note for OMP's bounded web_research_v1 tool.
---

# Web search

权威检索策略在 `~/.omp/agent/notes/web-research-policy.md`。本 skill 只保留兼容说明：现行 harness 不必为了检索加载它。调用 `web_research_v1`，需要原文时用 `web_fetch`，把综合和缺口连到当前分支收据时用 `omp_research_evidence`。不要在这里再写一套引擎顺序。
