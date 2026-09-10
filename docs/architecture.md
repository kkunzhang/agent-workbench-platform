# Agent Workbench Platform 架构

```text
Client / Vue Workbench
        │  JWT + REST / SSE
        ▼
Fastify API
        │
        ├── Identity / RBAC / Audit ──────────────── PostgreSQL
        ├── Session / Message / Agent Run ────────── PostgreSQL
        └── Agent Loop
              │
              ├── Planner → Tool policy → Tool / MCP Client
              ├── Memory retrieval ───────────────── PostgreSQL + pgvector
              ├── Knowledge retrieval ────────────── PostgreSQL + pgvector
              ├── Trace / Evaluation ─────────────── PostgreSQL
              └── Synthesizer ────────────────────── Ollama / OpenAI-compatible
```

执行计划由 `planningService.js` 创建，最多执行 `AGENT_MAX_STEPS` 个步骤。当前的规则规划器是刻意可审查的基线：它确保演示稳定、工具权限可预测；随后可在不改执行器的前提下替换为模型原生 tool calling。

每一个工具都有 side-effect、timeout 和 retry 配置。演示工具全部是只读的；若增加写操作，应在 registry 中增加显式审批、幂等键和审计字段，而不是只靠 Prompt 限制。

每轮 Run 会先按当前用户权限从知识库取 Top-K 片段，再把片段和长期记忆加入模型上下文；该检索步骤也会写入 SSE 事件和 `agent_run_steps`，方便从 Trace 检查 RAG 是否实际参与回答。Trace 保存 plan、每个步骤的输入摘要、输出摘要、耗时、状态和评测结果。兼容旧 Vue 的 `/api/v3/robot/*` 接口同样映射到 PostgreSQL + pgvector，数据不再写入本地 JSON 文件。
