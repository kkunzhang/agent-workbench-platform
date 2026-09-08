# 第 7 天：综合联调、验收与面试演示

## 学习目标

把前六天的概念收敛成一个可演示、可复现、可解释的项目。面试时不需要展示所有代码，而是要用一条真实任务证明从前端、模型、工具到评测的完整闭环。

## 启动清单

```bash
# 终端 1：本机模型
ollama serve

# 终端 2：后端
npm start
```

- 后端健康检查：`http://127.0.0.1:8788/health`
- API 文档：`docs/api-v1.md`

## 10 分钟演示脚本

1. **1 分钟**：打开 Swagger、Postman 或配套前端，介绍模型、工具、Trace 和评测指标都来自本地后端。
2. **2 分钟**：发送“用 MCP 计算 19 和 23，并说明 Harness 的评测方案”，展示 SSE 事件、结果 `42` 和结构化证据回答。
3. **2 分钟**：查询该 Run 的 Trace，解释 plan、MCP tool、knowledge search、answer 和评测的关系。
4. **2 分钟**：发送“记住：我偏好 TypeScript 和 Fastify”，再跨会话提问偏好，讲 Context 与 Memory 边界。
5. **2 分钟**：发送多 Agent 会议纪要问题，展示 planner/reviewer/synthesis Span，说明什么时候不该用多 Agent。
6. **1 分钟**：点击固定评测，展示 `4/4` 用例，并说明离线回归与在线 Trace 的区别。

## 发布前验证

```bash
npm test
npm run check
docker compose config
```

## 面试验收标准

- 能画出 Client → Fastify → Agent Loop → Tool/MCP/Model → SSE 的链路。
- 能从一条 Trace 判断问题来自模型、工具、知识、预算还是前端传输。
- 能说出当前 JSON 存储为何适合本地演示，以及生产如何替换为 Postgres/pgvector。
- 能讲明技术取舍，而不把“用了多 Agent、RAG、MCP”当作卖点本身。

## 面试口述要点

> 这个项目的目标不是做一个聊天 Demo，而是做一个可工程化的 Agent 平台。后端把本地身份、模型、工具、MCP、记忆、Trace 和评测分层；任何 Vue、React 或命令行客户端都可以通过 REST 和 SSE 接入。演示时我会从一次 MCP 任务开始，先证明工具真的执行，再打开 Trace 解释每一步，最后用固定评测证明改动不会只是在某一次对话中碰巧成功。
