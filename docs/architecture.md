# Agent Workbench 架构

```text
Vue Chat / Workbench
        │  SSE + REST
        ▼
 Fastify compatibility layer
        │
        ▼
 Planner → Tool policy/executor → Observation → Synthesizer
   │           │                       │              │
   │           ├── safe calculator      ├── Trace       └── Ollama / OpenAI-compatible
   │           ├── knowledge retrieval  ├── Evaluation
   │           ├── memory retrieval     └── JSON local store
   │           └── real MCP stdio Client → MCP Server
```

执行计划由 `planningService.js` 创建，最多执行 `AGENT_MAX_STEPS` 个步骤。当前的规则规划器是刻意可审查的基线：它确保演示稳定、工具权限可预测；随后可在不改执行器的前提下替换为模型原生 tool calling。

每一个工具都有 side-effect、timeout 和 retry 配置。演示工具全部是只读的；若增加写操作，应在 registry 中增加显式审批、幂等键和审计字段，而不是只靠 Prompt 限制。

Trace 保存 plan、每个 Span 的输入摘要、输出摘要、耗时、状态和评测结果。开发环境使用原子写入 JSON 存储；生产迁移路径是把 `JsonStore` 替换成 Postgres repository，并将向量存入 pgvector 或独立向量库。
