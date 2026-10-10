---
name: cloudbase
description: Route Tencent CloudBase/TCB work to one matching reference for platform selection, CLI, authentication, databases, cloud functions, CloudRun, WeChat integration, built-in AI, operations, specifications, and CloudBase-specific review. Use only when CloudBase is actually in scope; do not use for generic Mini Program tooling, generic product design, or non-CloudBase backends. Invoke with /skill:cloudbase.
---

# CloudBase 路由

主编排器只路由。先判断用户当前要解决的唯一主问题，然后只读下表命中的一个 reference。命中后用 `task` 派专职工人执行；并发协调用 `hub`。现网资料用 `web_search`。不要预加载整个 `references/`；只有命中的 reference 明确要求另一个依赖文件时，才继续读取它。

| 用户要什么 | 只读哪个文件 | 何时不要用 |
|---|---|---|
| 先判断 CloudBase 能力、平台边界或总体方案 | `references/cloudbase-platform/reference.md` | 已明确具体实现域时 |
| Web BaaS 页面与 SDK 开发 | `references/web-development/reference.md` | 原生小程序或纯后端 |
| 微信小程序中的 CloudBase 开发 | `references/miniprogram-development/reference.md` | 不使用 `wx.cloud` / CloudBase 的普通小程序 |
| `tcb` CLI、部署或资源管理 | `references/cloudbase-cli/reference.md` | 微信开发者工具内的日常调试 |
| Web 登录、注册、OAuth 与认证界面 | `references/auth-tool-cloudbase/reference.md` | 小程序原生身份 |
| Web SDK 认证实现细节 | `references/auth-web-cloudbase/reference.md` | 只需配置认证提供方时 |
| 小程序 OPENID、UNIONID 与原生认证 | `references/auth-wechat-miniprogram/reference.md` | Web 或服务端认证 |
| 小程序文档数据库 CRUD、查询与聚合 | `references/cloudbase-document-database-in-wechat-miniprogram/reference.md` | Web SDK 或关系型数据库 |
| Web 文档数据库 | `references/cloudbase-document-database-web-sdk/reference.md` | 小程序 SDK 或关系型数据库 |
| PostgreSQL 应用开发 | `references/postgresql-development-cloudbase/reference.md` | MySQL 或文档数据库 |
| MySQL/关系型数据库的管理面操作 | `references/relational-database-mcp-cloudbase/reference.md` | 应用侧 SQL 调用 |
| MySQL/关系型数据库的 Web 应用调用 | `references/relational-database-web-cloudbase/reference.md` | 建库、建表等管理面操作 |
| 云函数开发、部署或调试 | `references/cloud-functions/reference.md` | 容器化常驻后端 |
| CloudRun/云托管容器后端 | `references/cloudrun-development/reference.md` | 事件函数或简单 HTTP 函数 |
| 云存储上传、下载与域名配置 | `references/cloud-storage-web/reference.md` | 数据库或函数问题 |
| Web 端内置大模型调用 | `references/ai-model-web/reference.md` | Node.js 或小程序运行时 |
| Node.js/服务端内置大模型调用 | `references/ai-model-nodejs/reference.md` | 浏览器或小程序运行时 |
| 小程序 `wx.cloud.extend.AI` | `references/ai-model-wechat/reference.md` | Web、Node.js 或图片生成 |
| CloudBase AI Agent / AG-UI | `references/cloudbase-agent/reference.md` | 只是单次模型 API 调用 |
| 微信支付、公众号 OAuth 或 Integration Center | `references/cloudbase-wechat-integration/reference.md` | 普通小程序登录或数据库 |
| 线上巡检、日志与故障诊断 | `references/ops-inspector/reference.md` | 尚未进入运行或排障阶段 |
| CloudBase 需求、架构与任务拆分 | `references/spec-workflow/reference.md` | 非 CloudBase 产品需求或市场研究 |
| CloudBase 代码审查与已知陷阱检查 | `references/cloudbase-code-review/reference.md` | 通用代码审查或尚未产出代码 |
