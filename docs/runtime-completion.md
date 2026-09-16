# 运行时收口：五项能力与验收

本版本到此冻结功能范围，只维护缺陷与安全更新。

## 1. 真正的模型流式输出

`src/services/modelClient.js` 直接消费 Ollama NDJSON 或 OpenAI-compatible SSE，并把每个模型 delta 原样写入前端 SSE。服务端不再先得到完整文本后按字符切片。

本机 34B 工具模型的首次装载可能超过 8 秒，`.env` 的 `MODEL_TIMEOUT_MS` 默认设为 `60000`。

## 2. 模型驱动的 Tool Calling / Agent Loop

`src/services/agentService.js` 每一轮把工具 JSON Schema 交给模型。模型返回 `tool_calls` 后，平台执行工具，把 observation 作为 `tool` 消息回写，再请求模型得到最终答案。最大步骤数由 `agents.max_steps` 限制。

工具选择不再依赖聊天输入的关键词规则；旧的 `chooseTool` 仅保留给历史教学评测，不参与运行时链路。

## 3. Redis Run State

`src/platform/runStore.js` 使用 Redis 保存 Run 的短期事件、最后事件、取消标记和 MCP 工具缓存。`agent_runs`、消息和步骤仍落 PostgreSQL；服务启动时 `src/platform/runRecovery.js` 会把遗留的 `running` Run 标记为 `interrupted`，所以重启不会丢失可追溯状态。

## 4. 动态 MCP

在 `POST /api/v1/mcp/servers` 保存 Server 配置后，调用：

```text
POST /api/v1/mcp/servers/:id/refresh
GET  /api/v1/mcp/tools
```

平台会按数据库配置以 stdio、SSE 或 streamable HTTP 建连，执行 `list_tools`，并把所得工具动态注入当前 Agent 的工具列表。工具调用完成后连接关闭；没有固定常驻 demo MCP Server。

## 5. 文件 RAG

`POST /api/v1/knowledge-bases/:id/documents/file` 接收 `multipart/form-data` 的 `file` 字段，支持 TXT、MD、CSV、PDF、DOCX：

```text
文件 → MinIO 原文件 → 文本解析 → overlap chunk → Ollama embedding → pgvector → retrieval
```

对象键保存在 `knowledge_documents.storage_key`，检索优先使用向量相似度；embedding 服务不可用时上传会明确失败，不会伪造检索结果。

## 启动与验收

```bash
ollama serve
ollama list                     # 需要 local-qwen35b-tools:latest、nomic-embed-text:latest
npm run db:up
npm run db:migrate
npm start
npm run check
npm test
```

需要运行依赖本机 Docker、PostgreSQL、Redis、MinIO、Ollama 的全链路测试时：

```bash
npm run test:integration
```

测试覆盖：创建 Agent、创建 Session、发送消息、SSE 真流式、Tool Calling、动态 MCP、RAG、取消 Run、失败重试、服务重启后的状态恢复。
