# 第 6 天：Harness Engineering 与评测

## 学习目标

Harness 是把模型的不确定性放进工程边界的系统。它不等于 Prompt，也不等于一个日志库；它应覆盖输入、执行、预算、失败恢复、可观测性和回归验证。

## 当前 Harness 能力

- 输入边界：计算器使用递归下降解析器，不执行 `eval` 或 `Function`。
- 工具策略：每个工具有 side-effect、timeout；执行器统一重试。
- Agent 预算：`AGENT_MAX_STEPS` 限制计划步数，模型调用有 `MODEL_TIMEOUT_MS`。
- 可观测性：`traceService.js` 保存 planning、tool、model、subagent、answer Span。
- 失败恢复：模型服务异常会产生 fallback 来源；工具错误会作为 error event 和 Trace 留存。
- 评测：`evalSuiteService.js` 固定覆盖计算、时间、知识检索和真实 MCP；每轮对话也有在线评测。

## 动手步骤

1. 打开 `/#/agent-workbench`，点击“运行固定评测集”。
2. 查看 4 个用例是否全部通过，并理解它们验证的是能力回归，不是语言表达质量。
3. 修改一个计算表达式或停止 MCP Server，故意让评测失败；查看 failed case 的 actual、Trace 和错误原因。
4. 在聊天页完成一次工具调用，查看在线评测的非空、工具结果、延迟、步骤预算和 Trace 检查。

## 指标设计

离线评测关注固定任务集是否回归；在线指标关注真实请求质量。生产还应补充任务正确率、引用正确率、工具成功率、P95 延迟、Token 成本、用户采纳率和人工偏好。不要只用“模型回答非空”宣称系统质量好。

## 验收标准

- `npm test` 通过计算器、工具选择和评测逻辑测试。
- `POST /api/lab/evals/run` 返回全部用例和 passRate。
- 工作台可查看一条 Trace 的 plan、Span、耗时、结果和最终评测。

## 面试口述要点

> Harness 的作用是让 Agent 可控、可观察、可回归。我把模型输出放在受限执行器外面：工具有 allowlist、参数校验、超时和重试；Loop 有步骤预算；每轮有 Trace 和在线检查；提交前跑固定评测集。离线评测告诉我版本是否回归，在线 Trace 告诉我某一次请求为什么失败，这两个层次不能互相替代。
