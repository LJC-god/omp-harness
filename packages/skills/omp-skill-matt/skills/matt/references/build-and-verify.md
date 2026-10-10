# Matt 构建与验证

只从本页选择一个叶子。候选确认前不要读取叶子正文。

| 情况 | 官方叶子 | 官方路径 |
|---|---|---|
| 按批准的规格或票据完成实现 | `implement` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 只需在已确认测试 seam 上红绿循环 | `tdd` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 对固定点到 HEAD 做 Standards + Spec 双轴评审 | `code-review` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 难复现故障、性能回退或复杂根因诊断 | `diagnosing-bugs` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |
| 用一次性代码回答状态/逻辑设计问题 | `prototype` | `SKILL_UNAVAILABLE (SKILL.md upstream leaf is not shipped)` |

执行 `implement` 时复用已有范围与计划，明确实际行为和相关测试。Sol 选择已分配作者和原生/受控路线并核验结果；该作者实现，前端源码必须交给 Kimi。不要求先建票据，不固定派发通用 task。审查同时考虑规范与需求，但不因此强制两个 reviewer；复用当前候选代码的有效证据，保留已有受控门禁。难复现失败先取证并用 `diagnosing-bugs` 定位，是否派 scout 由实际独立工作决定。

`prototype` 可用于必要的设计验证，前端原型仍由 Kimi 编写。Figma/OpenDesign 按需使用，不构成独立流程或批准门。官方叶子的流程、角色和授权约定以 Matt 入口的 OMP 集成约束为准。
