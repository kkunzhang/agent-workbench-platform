# 第 2 天：Agent Loop 与 Planning

## 学习目标

理解 Agent 不是“更长的 Prompt”。它是一个带停止条件的控制循环：理解目标 → 生成计划 → 执行工具 → 观察结果 → 综合答案。当前项目采用可审查的规则规划器作为稳定基线，执行器与规划器已解耦，可替换为模型原生 Tool Calling。

## 关键代码

- `src/services/planningService.js`：根据问题生成 `goal`、`steps`、`strategy`，并受 `AGENT_MAX_STEPS` 限制。
- `src/services/agentService.js`：只执行 `kind === tool` 的计划步骤；每个工具步骤都会产生 running、complete 或 error 事件。
- `src/services/traceService.js`：把计划和每个执行步骤保存为 Span。

## 动手步骤

1. 发送“计算 `(23 + 7) * 4`”，观察计划中出现 `calculate`，最终答案为 `120`。
2. 发送“现在几点了”，观察 `get_current_time` 的工具卡片和结果。
3. 在 `.env` 将 `AGENT_MAX_STEPS=2`，重启服务，再发包含多个工具意图的问题，理解为什么计划需要预算。
4. 打开 `/#/agent-workbench`，查看 Trace 中 planning Span、tool Span 和 final-answer Span 的顺序。

## 设计取舍

规则规划不是为了回避模型，而是为了让第一个版本可预测：你可以确认工具是否会被调用、是否超预算、是否遵守权限。生产演进方式是让模型提出候选 tool calls，再由同一个 planner/executor 校验工具是否注册、参数是否符合 schema、是否还有预算；不要让模型直接拥有执行权。

## 验收标准

- 每次执行都有显式 plan，且最大步骤数可配置。
- 工具失败不会中断 SSE；Trace 中能看到 error Span。
- 能说明 plan、执行器、观察结果和停止条件分别在哪一层实现。

## 面试口述要点

> 我把 Agent Loop 当作工作流运行时，而不是 Prompt 模板。Planner 只决定下一步候选动作，Executor 负责策略校验和执行，Observation 将工具结果回填给回答层。这样可以设置最大步骤数、工具超时和重试，也能在 Trace 中看到每一步。规则规划器是稳定基线，后续可替换为模型 Tool Calling，但安全和预算约束不应交给模型自己决定。
