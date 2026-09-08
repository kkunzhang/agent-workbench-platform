# 第 3 天：Tools、Skills 与 MCP

## 学习目标

把三个常被混淆的概念分开：Tool 是可执行能力；Skill 是可复用的任务方法；MCP 是把外部能力以统一协议暴露出来的方式。它们可以组合，但不互相替代。

## 当前实现

- Tool registry：`src/services/toolService.js`。每个工具有描述、输入、side-effect 标记和 timeout 策略。
- Skill：`agentService.js` 中的 `SKILLS`，本质是任务结构提示，例如技术评审或证据报告的输出格式。
- MCP Server：`src/mcp/demoMcpServer.js`，通过 stdio 暴露 `echo` 和 `add`。
- MCP Client：`src/services/mcpClient.js`，实际用 `StdioClientTransport` 启动 Server 并执行 `client.callTool`，不是字符串 Mock。

## 动手步骤

1. 访问 `GET /api/lab/mcp/tools`，确认后端通过 Client 枚举到 MCP Server 的工具 schema。
2. 在聊天页发送“用 MCP 计算 19 和 23，并说明 Harness 的评测方案”。
3. 观察 `mcp_add` 的 tool card，结果应为 `42`；随后会有 `knowledge_search` 证据。
4. 在工作台打开这次 Trace，说明 `mcp_add` 的输入、输出、耗时和策略。
5. 单独运行 `npm run mcp:demo`，理解它是一个可被任意 MCP Client 连接的 Server。

## 安全与工程边界

工具策略不能只写在 system prompt：服务端必须有 allowlist、参数校验、超时、重试、权限和审计。当前示例工具均为只读；如果加入“发消息”“写工单”等副作用工具，应额外加用户确认、幂等键和审批记录。

## 验收标准

- 能在 Trace 中证明 `mcp_add` 经过真实 stdio MCP Client。
- 能解释 Skill 只影响任务方法，不直接拥有网络或数据库权限。
- 能列出写操作工具需要额外具备的三个保护：确认、幂等、审计。

## 面试口述要点

> Tool 是 Agent 的一个受控执行单元，Skill 是完成某类任务的可复用方法，MCP 是外部能力接入协议。本项目用 MCP Client 真正拉起 stdio Server，而不是在业务里伪造返回值。我的原则是：模型可以提议工具，但服务端 registry 决定工具是否存在、参数是否合法、是否有权限和是否要用户确认。
