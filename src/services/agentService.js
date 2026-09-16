import { streamModel } from './modelClient.js';
import { executeTool, modelToolDefinitions } from './toolService.js';

const BASE_SYSTEM_PROMPT = `你是“个人 Agent 工作台”的智能助手。用中文回答，并且只把实际执行过工具得到的结果当作事实。
当需要实时信息、检索、计算、文件生成、代码执行或 MCP 能力时，调用已提供的工具。工具返回后继续判断是否需要下一步；信息充分时再输出最终回答。`;

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('执行已取消');
    error.code = 'RUN_CANCELLED';
    throw error;
  }
}

function toolEvent(call, status, result) {
  return {
    resultType: 'agent', msgStatus: 'GENERATING',
    contents: [{ type: 12, content: JSON.stringify({ ToolName: call.name, ToolParams: call.args, ToolStatus: status, ToolResultID: call.id, ...(result ? { ToolResult: result } : {}) }) }],
  };
}

function progress(content) { return { resultType: 'agent', msgStatus: 'GENERATING', contents: [{ type: 0, history: false, content }] }; }

function assistantMessage(text, calls, provider) {
  if (!calls.length) return { role: 'assistant', content: text };
  if (provider === 'ollama') return { role: 'assistant', content: text, tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.args } })) };
  return { role: 'assistant', content: text || null, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) };
}

function buildSystem({ systemPrompt, knowledgeContext, memoryContext, skillNames }) {
  const knowledge = knowledgeContext.length ? `\n已检索到的知识片段：\n${knowledgeContext.map((item) => `来源：${item.fileName}\n${item.content}`).join('\n\n')}` : '';
  const memory = memoryContext.length ? `\n长期记忆：\n${memoryContext.map((item) => item.content || item.text).join('\n')}` : '';
  const skills = skillNames.length ? `\n用户选择的技能：${skillNames.join('、')}` : '';
  return `${BASE_SYSTEM_PROMPT}\n${systemPrompt || ''}${knowledge}${memory}${skills}`;
}

/**
 * 模型原生 tool_calls 驱动的 Agent Loop：模型决定调用，工具 observation 回写消息后再请求模型。
 * 没有任何关键词工具选择或答案切片逻辑。
 */
export async function* runAgent({
  question, systemPrompt, modelProvider, modelHint, maxSteps = 4, skillNames = [], signal, knowledgeContext = [], memoryContext = [], images = [],
  mcpTools = [], runStore, runId, modelStream = streamModel,
}) {
  const provider = modelProvider || 'ollama';
  const messages = [
    { role: 'system', content: buildSystem({ systemPrompt, knowledgeContext, memoryContext, skillNames }) },
    { role: 'user', content: question, ...(images.length && provider === 'ollama' ? { images: images.map((image) => image.data) } : {}) },
  ];
  const tools = modelToolDefinitions({ mcpTools });
  let finalAnswer = '';
  let usage = { promptTokens: 0, completionTokens: 0 };
  yield progress(`Agent 已开始执行，模型将自主决定是否调用 ${tools.length} 个工具。`);

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(signal);
    if (runStore && await runStore.isCancelled(runId)) {
      const error = new Error('执行已取消'); error.code = 'RUN_CANCELLED'; throw error;
    }
    let answerPart = '';
    let calls = [];
    for await (const event of modelStream({ provider, messages, tools, modelHint, signal })) {
      throwIfAborted(signal);
      if (event.type === 'delta' && event.text) {
        answerPart += event.text;
        // 模型端原始 token 增量，直接透传到 SSE。
        yield { resultType: 'agent', msgStatus: 'GENERATING', contents: [{ type: 0, history: true, content: event.text }] };
      }
      if (event.type === 'tool_calls') calls = event.calls || [];
      if (event.usage) usage = event.usage;
    }
    messages.push(assistantMessage(answerPart, calls, provider));
    if (!calls.length) {
      finalAnswer += answerPart;
      break;
    }
    for (const call of calls) {
      throwIfAborted(signal);
      yield toolEvent(call, 'running');
      try {
        const result = await executeTool(call, { mcpTools, retryCount: 1 });
        yield toolEvent(call, 'complete', result.output);
        messages.push(provider === 'ollama'
          ? { role: 'tool', tool_name: call.name, content: result.output }
          : { role: 'tool', tool_call_id: call.id, content: result.output });
      } catch (error) {
        if (error.code === 'RUN_CANCELLED') throw error;
        const observation = `工具失败：${error.message}`;
        yield toolEvent(call, 'error', observation);
        messages.push(provider === 'ollama'
          ? { role: 'tool', tool_name: call.name, content: observation }
          : { role: 'tool', tool_call_id: call.id, content: observation });
      }
    }
    if (step === maxSteps) {
      const error = new Error(`已达到最大工具步骤数 ${maxSteps}，任务未产生最终回答`);
      error.code = 'AGENT_MAX_STEPS';
      throw error;
    }
  }
  if (!finalAnswer.trim()) {
    const error = new Error('模型未返回最终回答'); error.code = 'MODEL_EMPTY_RESPONSE'; throw error;
  }
  yield { resultType: 'agent', msgStatus: 'FINISHED', id: crypto.randomUUID(), usage, contents: [] };
}
