# YAgent Agent Platform

一个可自托管、可观察的 Agent 平台后端。它包含本地身份权限、SSE 对话、工具策略、真实 MCP Client、知识检索、长期记忆、执行 Trace 和固定评测集；运行状态统一存入 PostgreSQL + pgvector，不依赖本地 JSON 文件。

## 范围

- **A. 身份与权限**：本地注册登录、JWT access/refresh token、角色权限、Demo 登录和审计日志。
- **B. Agent 对话**：Agent 配置、会话、消息、SSE Run、收藏、反馈、搜索、重命名、置顶和配额数据模型。
- **C. Agent 运行时**：计划、工具策略、Memory、知识库分块/embedding、MCP 配置、Trace、评测与指标。

不包含公司 SSO、企业 OA、工单、云盘以及任何内部业务 Connector。详见 [展示范围](docs/platform-scope.md)。

## 架构

```text
Vue / REST client
       │ JWT + SSE
       ▼
Fastify API ── PostgreSQL + pgvector ── Redis / MinIO
       │
       ├── Identity and RBAC
       ├── Agent sessions and runs
       ├── Tool policy / MCP Client
       ├── SearXNG web / image search
       ├── Container sandbox (JavaScript)
       ├── Memory and knowledge retrieval
       └── Trace and evaluation
       │
       ▼
Ollama or OpenAI-compatible model provider
```

## 快速启动

要求：Node.js 22+、Docker Desktop 或任意可用 Docker daemon、Ollama（可选）。

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm start
```

首次启动后：

```bash
# 本地展示账号，默认开启
curl -X POST http://127.0.0.1:8788/api/v1/auth/demo-login

# 服务状态
curl http://127.0.0.1:8788/health
```

开发模式可运行 `npm run dev`。数据库、缓存和对象存储通过 `docker compose` 提供；停止基础设施运行 `npm run db:down`。

### 联网搜索与图片搜索

`npm run db:up` 同时启动本机的 SearXNG（仅绑定 `127.0.0.1:8081`）。Agent 收到“联网搜索…”或“搜图片…”时会调用 `web_search` / `image_search`，并把标题、来源页和图片 URL 写入工具 Trace；图片搜索的最终回答会直接带可预览图片和来源链接。

SearXNG 是本地的聚合器，不需要搜索 API Key，但它会访问公开搜索引擎，因此运行电脑需要联网。打开 `http://127.0.0.1:8081` 可以单独检查搜索服务。

### 代码沙盒

`sandbox` 执行容器通过一个仅绑定 `127.0.0.1:8790` 的网关接收后端请求。执行容器使用只读根文件系统、非 root 用户、无 Linux capabilities、进程/内存/CPU 限制和 `internal` Docker 网络；容器内再用 Node `vm` 暴露有限的 JavaScript 表达式能力。Agent 只有在用户明确要求“沙盒运行 JavaScript：…”时才会调用它。

示例：`沙盒运行 JavaScript：input.values.reduce((sum, value) => sum + value, 0)`。生产多租户场景应改用 gVisor、Kata 或 Firecracker 等更强隔离方案，并把 `SANDBOX_RUNNER_TOKEN` 交给密钥管理服务；Node `vm` 本身不是安全边界。

## 本机模型与 OpenAI 兼容模型

默认使用 Ollama：

```bash
ollama serve
```

切换 OpenAI 或任意兼容网关时，在 `.env` 配置：

```dotenv
LLM_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4.1-mini
```

模型 Key 只由服务端读取，前端不会获得。

`qwen3.5:0.8b` 可接收图像输入，平台 API 的 `images` 字段最多接受 4 张 PNG、JPEG 或 WebP 图片，总大小不超过 12MB。0.8B 更适合演示和轻量任务；需要更高视觉理解准确度时，可在 `.env` 将 `OLLAMA_MODEL` 改为本机已拉取的更大视觉模型，重启服务即可。

## API、文档和演示

- [Platform API v1](docs/api-v1.md)
- [架构说明](docs/architecture.md)
- [评测与可观测性](docs/evaluation-and-observability.md)
- [面试演示提纲](docs/interview-playbook.md)
- [面试口述要点](docs/interview-speaking-points.md)
- [联网搜索与沙盒](docs/day-6-harness-and-evaluation.md)
- [旧 Vue 前端兼容与迁移范围](docs/frontend-compatibility.md)

旧版 Vue 前端可通过 `npm run dev:agent` 启动本地 Agent 模式；平台 V1 API 使用 Bearer Token，是给新展示页或后续前端适配使用的正式接口。

## 验证

```bash
npm run check
npm test
```

CI 会执行语法检查、单元测试和 Docker Compose 配置校验。

## 公开发布前检查

- 不提交 `.env`、模型 Key、MCP 凭据和对话数据。
- 用 `.env.example` 说明所有必要环境变量。
- 使用 `docker compose config`、`npm run check`、`npm test` 完成验证。
- 推送前确认前端、截图、文档和示例数据不含公司名称、员工信息或内部服务地址。
