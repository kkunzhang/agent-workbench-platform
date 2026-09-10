# 旧 Vue 前端与新 Platform 后端对接

本项目不再依赖原机器人服务。本地模式下，Vite 的 `/agent-lab-api` 代理将旧 Vue 的 Agent 请求转发给 `yagent-agent-platform`。

## 已完成映射

| 前端能力 | 旧调用路径 | 新后端实现 | 持久化位置 |
| --- | --- | --- | --- |
| 本地身份 | local-agent 启动态 | `POST /api/v1/auth/demo-login`，前端后台换取 JWT | PostgreSQL `users`、`refresh_tokens` |
| 对话与流式输出 | `/api/v3/robot/run` | 新 Agent Loop 的兼容入口 | `agent_sessions`、`messages`、`agent_runs` |
| 历史、搜索、置顶、重命名、删除 | `/api/v3/robot/log/*` | PostgreSQL 会话映射 | `agent_sessions`、`messages` |
| 点赞、点踩 | `/api/v3/robot/log/like` | 反馈映射 | `message_feedback` |
| 会话和选中消息收藏 | `/api/v3/robot/collection*` | 收藏兼容层 | `legacy_collections`、`legacy_collection_messages` |
| Trace、知识库、记忆、MCP、评测 | `/api/lab/*` 与 `/api/v1/*` | 新 Platform 原生能力 | PostgreSQL + pgvector |

旧 Vue 仍会将 JWT 放在 `tokenId` 查询参数中。兼容层会校验该 JWT，并按其 `sub` 隔离会话、消息、收藏、反馈、知识库检索和记忆；无令牌请求只用于本地首次启动，会退回演示账号。新页面接入时应优先使用标准的 `Authorization: Bearer <JWT>` 和 `/api/v1/*`。

## 保留但未迁移的外部业务接口

云盘、工单、企业组织、邮件、工作流、业务插件等不属于 A/B/C 范围。前端保留其原有调用和代码，不删除、不以假数据替代；本地 Agent 模式只将机器人相关请求改为新后端。

后续若要扩展，应按独立领域服务迁移，并先确定数据模型、权限和文件存储策略，避免把企业业务接口混进 Agent Runtime。

## 已保留的后续项

- 旧聊天输入组件目前没有把本地图片二进制编码进 `/api/v3/robot/run`；因此兼容入口按现有文本协议运行。平台 V1 已支持 `images`，后续接入图片选择器时应直接切到 V1 请求格式，而不是把文件内容拼到 Prompt。
- SSO、企业租户、业务 Connector、写操作审批和生产级队列没有在展示版实现；对应前端与外部接口代码保留，并在本地模式配置中标记为后续独立迁移，未删除也未伪造结果。
