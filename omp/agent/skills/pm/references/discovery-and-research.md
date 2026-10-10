# PM：发现与研究

对一句话完整产品，先按 `method-a.md` 的 A 路由完成发现框架；本文件定义其中的直接研究与证据落盘。其他问题从当前问题选择一个起始叶子；确有新证据问题时再按需选择相关研究叶子，不预读整个库。

| 目标 | 官方叶子 |
|---|---|
| 从假设到访谈、综合与实验的完整发现循环 | `discovery-process` |
| 准备问题验证、流失或新产品访谈 | `discovery-interview-prep` |
| 写清用户、阻碍、目标和情绪 | `problem-statement` |
| 提炼客户任务、痛点与收益 | `jobs-to-be-done` |
| 从现有证据形成暂定客户画像 | `proto-persona` |
| 从公开评论和社区中挖掘客户之声 | `voice-of-customer-miner` |
| 绘制市场分层、玩家、替代品和空白 | `market-landscape-scan` |
| 完成带引证的竞争格局快照 | `competitive-research-snapshot` |
| 执行六步完整竞争分析 | `competitive-analysis-process` |
| 研究公司、行业或竞品集合 | `company-intel` |
| 为单家公司形成高管、战略和组织简报 | `company-research` |
| 选择合适的竞争情报采集纪律 | `intel-discipline-advisor` |

官方叶子路径统一为：
`~/.omp/agent/git/github.com/deanpeters/Product-Manager-Skills/skills/<skill-name>/SKILL.md`。
PM 直接执行有界产品调研，复用共享 `web_research_v1`：先 read `xd://web_research_v1` 查看 schema，再 write JSON（如 `{"query":"具体研究问题"}`）到同一路由；默认不指定 engine，沿用 Exa + Brave 与既有回退。使用 read 读取原始 HTTP(S) 页面。无需新搜索引擎、shell 或子代理。

一句话新产品默认由 PM 先界定研究问题，探索实际替代做法、使用阻碍、公开用户反馈及潜在价值，再综合成完整定义。A 路由先使用 discovery-process，并按具体问题连接 jobs-to-be-done、voice-of-customer-miner、opportunity-solution-tree 与 user-story；需要公开用户声音或市场证据时按问题选择对应叶子，不逐项跑完整个技能库。充分适用的已有证据、明确禁网或无产品决策价值时记录实际理由，不重复搜索。公开评论需注明样本偏差，厂商文档不能冒充用户访谈；无访谈条件时保留待验证假设，不模拟已完成访谈。

通过 `xd://omp_research_evidence` 的 status 获取本 PM 会话的实际 sessionId 和搜索/原页回执，再以 record_decision 关联会改变产品判断的结论与缺口。回执只在产生它的当前会话分支、最近 reset 之后有效。将来源 URL、局限、产品影响及实际 sessionId/receipt IDs 写入 `docs/product/research.md`，并将它们关联到 PRD 的稳定需求 ID 或决策；Sol 可核读原生 agent 产物/子会话记录，不把子回执注册成根会话回执。每条材料标为用户原文、Sol 决定、PM 推断、搜索摘要、原页读取或外部来源；后三类均不等于目标用户验证。研究文件末尾保留未解决问题及其影响。

达到有依据的产品选择或既有预算边界就停止；供应商失败明确保留，继续不依赖该证据的工作，关键未知在依赖它的范围冻结前解决。仅在工具不可用、证据不可访问或关键问题未解决时向 Sol 返回 WEB_RESEARCH_REQUIRED 及影响，不建立另一个研究团队或审批循环。
