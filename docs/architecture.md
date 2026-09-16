# Agent Workbench Platform 架构

当前运行时采用**模型原生 Tool Calling**：模型接收工具 JSON Schema，自主决定是否调用；平台执行后把 observation 回写模型，直到得到最终回答或达到 `agents.max_steps`。规则 `planningService.js` 只保留给旧教学评测，不参与聊天运行时。

```text
Vue Workbench ── JWT / REST / SSE ── Fastify API
                                      │
                           ┌──────────┼──────────┐
                           │          │          │
                   PostgreSQL +     Redis       MinIO
                     pgvector     短期 Run      原始文件
                           │
                    Agent Loop ── Ollama / OpenAI-compatible
                           │
            内置工具 / 动态 MCP / SearXNG / 隔离沙盒
```

PostgreSQL 保存用户、Agent、会话、消息、Run、步骤、权限和向量；Redis 保存取消标记、临时事件和 MCP 工具缓存；MinIO 保存上传原件。服务重启时，遗留 `running` Run 会被标记为 `interrupted`，已有步骤仍可追溯。

完整的模块职责、数据流、关键取舍和排障方式见 [项目总说明](project-guide.md)。
