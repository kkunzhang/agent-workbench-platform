# 第 2 天：Agent Loop 与 Planning

## 学习目标

理解 Agent 不是“更长的 Prompt”。它是一个带停止条件的控制循环：准备上下文 → 模型选择工具 → 执行工具 → 观察结果 → 模型综合答案。当前项目已采用模型原生 Tool Calling，平台负责步骤预算、超时、重试和取消。

## 关键代码

- `src/services/modelClient.js`：把 Ollama NDJSON / OpenAI-compatible SSE 统一为 delta 和 tool_calls。
- `src/services/agentService.js`：循环执行模型返回的 tool_calls；每个工具步骤都会产生 running、complete 或 error 事件。
- `src/platform/chatRoutes.js`：把 Run、步骤和 SSE 事件持久化，`agents.max_steps` 为循环硬上限。

## 动手步骤

1. 发送“请使用 calculate 工具计算 `(23 + 7) * 4`”，观察模型返回的 `tool_calls`、工具卡片和最终结果 `120`。
2. 发送“现在几点了”，观察 `get_current_time` 的工具卡片和 observation。
3. 将某个 Agent 的 `maxSteps` 设为 2，再发需要连续工具调用的任务，理解为什么循环需要预算。
4. 打开 `/#/agent-workbench`，查看 Run 中模型增量、tool event 与 FINISHED 的顺序。

## 设计取舍

模型原生 Tool Calling 让工具选择适配开放任务；但模型不拥有执行权。平台仍校验工具是否注册、参数是否符合 schema、是否有权限、是否超时和是否超过步骤预算。这样既避免关键词路由无法覆盖新表达，又保留工程控制边界。

## 验收标准

- 每次执行都有可追溯的模型 delta、tool call 和 observation，且最大步骤数可配置。
- 工具失败不会中断 SSE；Trace 中能看到 error Span。
- 能说明 plan、执行器、观察结果和停止条件分别在哪一层实现。

## 面试口述要点

> 我把 Agent Loop 当作工作流运行时，而不是 Prompt 模板。模型提出下一步 tool call，Executor 负责策略校验和执行，Observation 回填模型继续判断。这样可以设置最大步骤数、工具超时和重试，也能在 Trace 中看到每一步。模型负责推理，安全和预算约束仍由服务端决定。
