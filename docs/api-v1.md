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

当输入包含“联网搜索 / 搜图片”时，Agent 会执行受限工具：`web_search` 调用本地 SearXNG 并返回网页标题、摘要和来源 URL；`image_search` 返回图片 URL 和来源页。用户明确提出“沙盒运行 JavaScript：…”时，才会执行 `sandbox_javascript`。工具输入、输出摘要、超时与策略均进入 Run Trace。

## C. Runtime

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/traces` | 当前用户的运行列表。 |
| GET | `/api/v1/traces/:id` | 一个 Run 与完整步骤 Trace。 |
| GET/POST/DELETE | `/api/v1/memories` | 管理显式长期记忆。 |
| GET/POST | `/api/v1/knowledge-bases` | 知识库列表与创建。 |
| GET | `/api/v1/knowledge-bases/:id/documents` | 知识库文档列表。 |
| POST | `/api/v1/knowledge-bases/:id/documents/text` | 文本分块与 embedding 入库。 |
| GET | `/api/v1/knowledge-bases/:id/search?query=...` | pgvector 检索；embedding 不可用时回退全文检索。 |
| GET/POST | `/api/v1/mcp/servers` | MCP Server 配置管理，配置密文存储。 |
| GET | `/api/v1/mcp/demo/tools` | 枚举真实 stdio Demo MCP 的工具。 |
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
