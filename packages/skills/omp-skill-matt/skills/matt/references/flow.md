# Matt 主流程

只从本页选择一个叶子。候选确认前不要读取叶子正文。

| 情况 | 官方叶子 | 官方路径 |
|---|---|---|
| 用户明确要求安装或配置 Matt（首次使用不触发） | `setup-matt-pocock-skills` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 有工作目录，要访谈并沉淀词汇表/ADR | `grill-with-docs` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 没有工作目录，只需拷打想法 | `grill-me` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 已讨论清楚，要合成为工程规格 | `to-spec` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 要把规格拆成带阻塞边的纵向票据 | `to-tickets` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 工程过大、路径仍在迷雾中 | `wayfinder` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 不确定该用哪个 Matt 流程 | `ask-matt` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 要跨目录、会话或执行器交接上下文 | `handoff` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |

只选择当前需要的一步，没有默认串行链路。需求已清楚时不要访谈；已有可执行计划时不要重新写规格或拆票。仅在多阶段依赖确实需要时使用 `to-tickets` 的拆解方法，复用现有计划，不自动发布 Issue。小改动跳过 Matt。遵循入口的 OMP 集成约束，不因官方叶子提到其他流程而自动加载它们。
