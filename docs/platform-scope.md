# 展示版范围与边界

本仓库公开展示 A/B/C 三部分：本地身份权限、Agent 对话、Agent 工程运行时。SSO、企业 OA、工单、云盘和内部业务 Connector 不在公开仓库内。

生产环境需要把 `JWT_SECRET`、模型 API Key、MCP 凭据、对象存储凭据放在 Secret Manager；仓库不提交 `.env`、数据库数据、用户对话、Trace 或文档原文。

当前 Docker Compose 提供 PostgreSQL + pgvector、Redis、MinIO。API Server 可直接在宿主机运行，也可以基于 Dockerfile 构建；后续接入后台队列时使用 Redis 处理长文档解析和大规模评测。
