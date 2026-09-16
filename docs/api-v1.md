# Platform API v1

所有平台 API 统一返回：`{ code, status, data }`。除注册、登录、刷新和 Demo 登录外，接口使用 `Authorization: Bearer <accessToken>`。

## A. Identity

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | 注册本地用户，默认 member 角色。 |
| POST | `/api/v1/auth/login` | 邮箱密码登录，返回 access/refresh token。 |
| POST | `/api/v1/auth/demo-login` | 创建或登录 Demo Admin，仅开发展示环境启用。 |
| POST | `/api/v1/auth/refresh` | 刷新 token，并撤销旧 refresh token。 |
| GET | `/api/v1/me` | 返回当前用户、角色和权限。 |

## B. Agents and chat

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/agents` | `agent:read` | 智能体列表。 |
| GET | `/api/v1/agents/:id` | `agent:read` | 智能体详情。 |
| POST | `/api/v1/agents` | `agent:manage` | 创建智能体。 |
| POST | `/api/v1/sessions` | `agent:run` | 创建会话。 |
| GET | `/api/v1/sessions` | `agent:read` | 分页、关键词查询会话。 |
| PATCH | `/api/v1/sessions/:id` | `agent:run` | 重命名、置顶、归档或删除。 |
| GET | `/api/v1/sessions/:id/messages` | `agent:read` | 会话消息。 |
| POST | `/api/v1/chat/runs` | `agent:run` | 创建 Agent Run，自动注入当前用户命中的知识库片段，响应为 SSE。 |
| POST | `/api/v1/chat/runs/:id/cancel` | `agent:run` | 取消仍在运行的 Agent Run。 |
| POST/DELETE | `/api/v1/favorites` | `agent:read` | 收藏或取消收藏会话。 |
| POST | `/api/v1/feedback` | `agent:read` | 对回答点赞或点踩。 |

`POST /api/v1/chat/runs` 请求示例：

```json
{
  "agentId": "UUID",
  "sessionId": "UUID，可选",
  "input": "用 MCP 计算 19 和 23，并说明 Harness 的评测方案",
  "skillNames": ["evidence-report"],
  "images": [{ "mimeType": "image/png", "data": "不含 data: 前缀的 Base64，可选" }]
}
```

`images` 最多 4 张、总大小不超过 12MB。Ollama 请求会映射为 `messages[].images`；OpenAI 兼容请求会映射为 `image_url` data URL。图片只用于本次模型调用，不写入对话数据库。

请求响应为 `text/event-stream`。模型返回的文本增量使用 `contents[0].type = 0` 且 `history = true`；模型 Tool Calling 的运行、完成和失败事件使用 `contents[0].type = 12`，内容是包含 `ToolName`、`ToolParams`、`ToolStatus`、`ToolResult` 的 JSON。前端必须把 type 12 作为执行状态渲染，不能当普通文本输出。

模型根据工具 JSON Schema 自主决定是否调用 `web_search`、`image_search`、`sandbox_javascript`、PPT、RAG 或动态 MCP 工具。工具输入、输出摘要、超时、重试和最终状态均进入 Run Trace。

## C. Runtime

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/traces` | 当前用户的运行列表。 |
| GET | `/api/v1/traces/:id` | 一个 Run 与完整步骤 Trace。 |
| GET/POST/DELETE | `/api/v1/memories` | 管理显式长期记忆。 |
| GET/POST | `/api/v1/knowledge-bases` | 知识库列表与创建。 |
| GET | `/api/v1/knowledge-bases/:id/documents` | 知识库文档列表。 |
| POST | `/api/v1/knowledge-bases/:id/documents/text` | 文本分块与 embedding 入库。 |
| POST | `/api/v1/knowledge-bases/:id/documents/file` | `multipart/form-data` 上传 `file`，支持 TXT、MD、CSV、PDF、DOCX；原件进 MinIO。 |
| GET | `/api/v1/knowledge-bases/:id/search?query=...` | pgvector 检索；embedding 不可用时回退全文检索。 |
| GET/POST | `/api/v1/mcp/servers` | MCP Server 配置管理，配置密文存储。 |
| POST | `/api/v1/mcp/servers/:id/refresh` | 连接 Server 执行 `listTools`，同步工具定义与连接状态。 |
| GET | `/api/v1/mcp/tools` | 获取当前用户可用的动态 MCP 工具列表。 |
| GET | `/api/v1/evaluations/cases` | 固定评测用例。 |
| POST | `/api/v1/evaluations/runs` | 运行评测并记录结果。 |
| GET | `/api/v1/metrics` | Run 数量、平均耗时、P95 耗时。 |

## 错误约定

- `401`：token 不存在、失效或刷新 token 已撤销。
- `403`：角色权限不足。
- `404`：资源不存在，或资源不属于当前用户。
- `409`：唯一资源冲突，例如邮箱或 Agent slug 已存在。
- `422`：请求体不符合 schema。
- `503`：基础设施不可用，例如 PostgreSQL 未启动。

## D. MCP 配置示例

```json
{
  "name": "local-files",
  "transport": "stdio",
  "config": {
    "command": "node",
    "args": ["/absolute/path/to/mcp-server.js"],
    "env": { "WORKSPACE": "/absolute/path/to/workspace" }
  }
}
```

提交后调用 `POST /api/v1/mcp/servers/:id/refresh`。HTTP MCP 使用 `transport: "sse"` 或 `"streamable-http"`，配置中提供 `url`。配置密文存储，列表接口只返回是否配置了命令、环境变量数量和 URL，不返回环境变量原文。

## E. 文件 RAG 示例

```bash
curl -X POST "http://127.0.0.1:8788/api/v1/knowledge-bases/<id>/documents/file" \
  -H "Authorization: Bearer <accessToken>" \
  -F "file=@./design.pdf;type=application/pdf"
```

成功后响应中包含 `storageKey`、`status: "ready"` 与 `chunkCount`。随后可用 `GET /api/v1/knowledge-bases/<id>/search?query=...` 检查检索结果。
