# 第 1 天：LLM API 与流式输出

## 学习目标

把“页面输入一句话，模型回一句话”拆成可以定位的四段：浏览器请求、后端适配、模型调用、SSE 回传。完成后你应能解释 Ollama 与 OpenAI 兼容接口为什么能放在同一个适配层后面。

## 先运行

```bash
# 在本仓库根目录
ollama serve
npm start
```

使用任意 SSE 客户端或配套前端发送“介绍一下 Agent Loop”。Network 中找到 `run` 请求，查看 `EventStream`。

## 代码阅读顺序

1. `src/services/modelClient.js`：`generateAnswer` 根据 `LLM_PROVIDER` 调用 Ollama `/api/chat` 或 OpenAI 兼容的 `/chat/completions`。
2. `src/index.js`：`POST /api/v3/robot/run` 建立 `text/event-stream` 响应，并把 Agent 事件包装成 SSE frame。
3. `src/services/agentService.js`：最终文本按小块 yield；前端现有的 SSE 消费逻辑逐段渲染。
4. 客户端适配层：将浏览器的 SSE 请求代理或直连到 `127.0.0.1:8788`，不把模型 Key 暴露到浏览器。

## 动手步骤

1. 访问 `GET http://127.0.0.1:8788/health`，确认 provider 和模型名称。
2. 在聊天页发送普通问题，观察 EventStream 中 `GENERATING` 与 `FINISHED`。
3. 暂停 Ollama，再发一次相同问题，观察 `modelClient` 的内置教学降级回复。
4. 在 `.env` 把 `LLM_PROVIDER` 改为 `openai-compatible`，填入 OpenAI 或任何兼容网关的地址、Key、模型名，然后重启后端。

## 验收标准

- 能说清浏览器请求可经由前端代理转发，服务端实际监听地址是 `8788`。
- 能在 Trace 里指出 `model` Span 的 `source` 是 `ollama`、`openai-compatible` 或 `fallback`。
- 关闭模型服务时，聊天请求仍会正常 SSE 收尾，而不是浏览器一直 loading。

## 面试口述要点

> 我没有把模型 SDK 直接写进路由。路由只处理 SSE 协议，`modelClient` 负责供应商差异，因此本地 Ollama 和 OpenAI 兼容服务可以切换。流式输出不是模型一定要 token stream；即使后端先拿到完整结果，也可以按统一事件协议逐段发送，保证前端消费逻辑稳定。模型不可用时我保留可识别的 fallback 来源，并把它落到 Trace，便于定位是模型问题还是工具问题。
