# 第 6 天：Harness Engineering 与评测

## 学习目标

Harness 是把模型的不确定性放进工程边界的系统。它不等于 Prompt，也不等于一个日志库；它应覆盖输入、执行、预算、失败恢复、可观测性和回归验证。

## 当前 Harness 能力

- 输入边界：计算器使用递归下降解析器，不执行 `eval` 或 `Function`。
- 工具策略：每个工具有 side-effect、timeout；执行器统一重试。
- 联网能力：`web_search` 与 `image_search` 只经由本机 SearXNG 聚合公开搜索结果；Trace 保存查询、来源页和结果摘要。
- 沙盒：`sandbox_javascript` 只在独立容器中执行表达式。容器无外网、只读、非 root，并限制 CPU、内存和进程数；Node `vm` 只作为第二层语言运行时限制，不当作安全边界。
- Agent 预算：`AGENT_MAX_STEPS` 限制计划步数，模型调用有 `MODEL_TIMEOUT_MS`。
- 可观测性：`traceService.js` 保存 planning、tool、model、subagent、answer Span。
- 失败恢复：模型服务异常会产生 fallback 来源；工具错误会作为 error event 和 Trace 留存。
- 评测：`evalSuiteService.js` 固定覆盖计算、时间、知识检索和真实 MCP；每轮对话也有在线评测。

## 动手步骤

1. 打开 `/#/agent-workbench`，点击“运行固定评测集”。
2. 查看 4 个用例是否全部通过，并理解它们验证的是能力回归，不是语言表达质量。
3. 修改一个计算表达式或停止 MCP Server，故意让评测失败；查看 failed case 的 actual、Trace 和错误原因。
4. 在聊天页完成一次工具调用，查看在线评测的非空、工具结果、延迟、步骤预算和 Trace 检查。
5. 输入“联网搜索 PostgreSQL pgvector 官方文档”或“联网搜个猫的图片”，检查最终回答中的来源链接和图片，以及 Trace 的 `web_search` / `image_search` Span。
6. 输入“沙盒运行 JavaScript：(19 + 23) * 2”，查看 `sandbox_javascript` 的受限执行结果。沙盒 API 也支持传入 JSON `input`，供后续 UI 接入结构化输入。

## 指标设计

离线评测关注固定任务集是否回归；在线指标关注真实请求质量。生产还应补充任务正确率、引用正确率、工具成功率、P95 延迟、Token 成本、用户采纳率和人工偏好。不要只用“模型回答非空”宣称系统质量好。

## 验收标准

- `npm test` 通过计算器、工具选择和评测逻辑测试。
- `POST /api/lab/evals/run` 返回全部用例和 passRate。
- 工作台可查看一条 Trace 的 plan、Span、耗时、结果和最终评测。

## 面试口述要点

> Harness 的作用是让 Agent 可控、可观察、可回归。我把模型输出放在受限执行器外面：工具有 allowlist、参数校验、超时和重试；Loop 有步骤预算；每轮有 Trace 和在线检查；提交前跑固定评测集。离线评测告诉我版本是否回归，在线 Trace 告诉我某一次请求为什么失败，这两个层次不能互相替代。

> 对需要联网或运行代码的能力，我没有把权限交给模型。网页和图片检索只能走本机 SearXNG，返回结果带来源 URL；代码只发给独立的无外网容器，容器有只读文件系统、非 root、capability drop、资源上限和 token 认证。`vm` 不是安全边界，所以生产多租户会升级为 gVisor 或 MicroVM。
