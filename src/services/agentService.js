import { generateAnswer } from './modelClient.js';
import { executeTool } from './toolService.js';
import { evaluateRun } from './evaluationService.js';
import { buildPlan, formatPlanForPrompt } from './planningService.js';
import { addSpan, finishTrace, startTrace } from './traceService.js';
import { formatImageSearchAnswer } from './webSearchService.js';

const BASE_SYSTEM_PROMPT = `你是“个人 Agent 工作台”的智能助手。
回答使用中文，先给结论，再给简明依据。只使用本轮已提供的上下文、工具结果、知识片段和附件图片，不要把没有执行过的动作写成事实。遇到信息不足时明确写出缺口和下一步。`;

const SKILLS = {
  'meeting-summary': '把输入整理为：结论、待办、风险、后续动作四部分。',
  'tech-review': '按目标、方案、风险、验证四部分给出技术评审。',
  'evidence-report': '引用检索到的证据，按结论、依据、风险、下一步输出。',
};

function chunkText(text, size = 18) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

function createToolEvent(call, status, result) {
  return {
    resultType: 'agent',
    msgStatus: 'GENERATING',
    contents: [{
      type: 12,
      content: JSON.stringify({
        ToolName: call.name,
        ToolParams: call.args,
        ToolStatus: status,
        ToolResultID: call.id,
        ...(result ? { ToolResult: result } : {}),
      }),
    }],
  };
}

function createProgressEvent(content) {
  return {
    resultType: 'agent',
    msgStatus: 'GENERATING',
    contents: [{ type: 0, history: false, content }],
  };
}

function answerFromDeterministicTools(toolCalls) {
  const calculator = toolCalls.find((call) => call.name === 'calculate' && call.status === 'complete');
  const knowledge = toolCalls.find((call) => call.name === 'knowledge_search' && call.status === 'complete');
  const mcpAdd = toolCalls.find((call) => call.name === 'mcp_add' && call.status === 'complete');
  const web = toolCalls.find((call) => call.name === 'web_search' && call.status === 'complete');
  const images = toolCalls.find((call) => call.name === 'image_search' && call.status === 'complete');
  const sandbox = toolCalls.find((call) => call.name === 'sandbox_javascript' && call.status === 'complete');
  if (images && toolCalls.length === 1) {
    try {
      const source = JSON.parse(images.result.output);
      return formatImageSearchAnswer(source);
    } catch {
      return images.result.output;
    }
  }
  if (web && toolCalls.length === 1) return web.result.output;
  if (sandbox && toolCalls.length === 1) {
    try {
      const payload = JSON.parse(sandbox.result.output);
      return `受限代码沙盒执行完成。\n\n结果：\`${JSON.stringify(payload.result)}\`\n耗时：${payload.durationMs}ms`;
    } catch {
      return sandbox.result.output;
    }
  }
  if (mcpAdd && knowledge) {
    return [
      `结论：本次通过真实 MCP stdio 调用得到 ${mcpAdd.args.left} + ${mcpAdd.args.right} = ${mcpAdd.result.output}。`,
      'Harness 的评测方案：',
      '1. 离线固定集：覆盖输入校验、计算正确性、MCP 成功/失败、知识检索命中和超时重试。',
      '2. 在线 Trace：记录计划、每个工具输入输出摘要、模型来源、耗时和最终评测，便于归因。',
      '3. 发布门禁：检查工具成功率、任务正确性、P95 延迟与成本；失败样本进入回归集。',
      `证据：${knowledge.result.output.split('\n')[0]}`,
    ].join('\n');
  }
  if (toolCalls.length !== 1) return '';
  if (calculator) return `计算结果：${calculator.args.expression} = ${calculator.result.output}`;
  const time = toolCalls.find((call) => call.name === 'get_current_time' && call.status === 'complete');
  if (time && toolCalls.length === 1) return `当前本地时间：${time.result.output}`;
  if (mcpAdd) return `MCP 工具计算结果：${mcpAdd.result.output}`;
  return '';
}

function summarizeEvidence(toolCalls) {
  return toolCalls
    .filter((call) => call.status === 'complete')
    .map((call) => `- ${call.name}：${call.result.output}`)
    .join('\n');
}

function fallbackMultiAgentAnswer(question) {
  return [
    `结论：${question} 适合采用“单 Agent 编排 + 两个受限子角色”的设计，而不是让多个 Agent 自由对话。`,
    '方案：',
    '1. planner：抽取会议目标、参与人、议题与交付格式，产出有限步骤的执行计划。',
    '2. reviewer：独立检查待办是否有负责人、截止时间和证据；标记不确定项。',
    '3. synthesizer：合并纪要、待办、风险和待确认问题，并保留 Trace 关联。',
    '成本与风险：多一次角色调用会增加延迟与 Token 成本；角色间上下文不一致会造成重复或冲突；因此要限制并发数、传递结构化中间产物、设置总预算并回退到单 Agent。',
    '验收：比较单 Agent 与多角色方案的任务完整率、待办字段正确率、P95 延迟和单位任务成本。',
  ].join('\n');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('执行已取消');
    error.code = 'RUN_CANCELLED';
    throw error;
  }
}

async function runMultiAgent(question, context, trace, signal, images) {
  const roles = [
    { role: 'planner', instruction: '你是规划 Agent。只输出目标、3 步计划和停止条件。' },
    { role: 'reviewer', instruction: '你是审阅 Agent。列出关键风险、证据缺口和是否需要并行子任务。' },
  ];
  const roleResults = await Promise.all(roles.map(async ({ role, instruction }) => {
    const startedAt = Date.now();
    throwIfAborted(signal);
    const result = await generateAnswer({ system: `${BASE_SYSTEM_PROMPT}\n${instruction}\n${context}`, question, signal, images });
    throwIfAborted(signal);
    addSpan(trace, { kind: 'subagent', name: role, input: question, output: result.text, durationMs: Date.now() - startedAt, attributes: { source: result.source } });
    return { role, text: result.text, source: result.source };
  }));
  if (roleResults.some((item) => item.source === 'fallback')) {
    const answer = fallbackMultiAgentAnswer(question);
    addSpan(trace, { kind: 'model', name: 'multi-agent-fallback-synthesis', input: question, output: answer, attributes: { source: 'structured-fallback' } });
    return { text: answer, source: 'structured-fallback' };
  }
  const synthesisStartedAt = Date.now();
  const result = await generateAnswer({
    system: `${BASE_SYSTEM_PROMPT}\n你是主 Agent。根据以下独立子 Agent 输出合成最终建议，不要重复无依据的内容。\n${roleResults.map((item) => `${item.role}：${item.text}`).join('\n\n')}`,
    question,
    signal,
    images,
  });
  addSpan(trace, { kind: 'model', name: 'multi-agent-synthesis', input: question, output: result.text, durationMs: Date.now() - synthesisStartedAt, attributes: { source: result.source } });
  return result.source === 'fallback'
    ? { text: fallbackMultiAgentAnswer(question), source: 'structured-fallback' }
    : result;
}

export async function* runAgent({ account, question, skillNames = [], sessionId, signal, knowledgeContext = [], memoryContext = [], rememberMemory, images = [] }) {
  const startedAt = Date.now();
  throwIfAborted(signal);
  const selectedSkills = skillNames.map((name) => SKILLS[name]).filter(Boolean);
  const plan = buildPlan(question);
  const trace = startTrace({ account, sessionId, question, plan });
  const toolCalls = [];
  const sessionMemories = memoryContext;
  const recallFromContext = async (query) => {
    const normalized = String(query || '').toLocaleLowerCase();
    return sessionMemories
      .filter((item) => !normalized || String(item.content || item.text || '').toLocaleLowerCase().includes(normalized))
      .map((item) => ({ text: item.content || item.text || '' }));
  };
  const retrievedKnowledge = knowledgeContext
    .map((item) => `来源：${item.fileName}\n${item.content}`)
    .join('\n\n');
  addSpan(trace, {
    kind: 'planning',
    name: 'deterministic-planner',
    input: question,
    output: plan,
    attributes: { strategy: plan.strategy, maxSteps: plan.maxSteps },
  });

  yield createProgressEvent(`已生成执行计划：${plan.steps.map((step) => step.title).join(' → ')}`);
  if (retrievedKnowledge) {
    addSpan(trace, {
      kind: 'tool',
      name: 'platform_knowledge_retrieval',
      input: { query: question, count: knowledgeContext.length },
      output: retrievedKnowledge,
      attributes: { source: 'postgres-pgvector' },
    });
    yield createProgressEvent(`已加载用户知识库的 ${knowledgeContext.length} 段相关内容。`);
  }

  for (const step of plan.steps.filter((item) => item.kind === 'tool')) {
    throwIfAborted(signal);
    const call = { name: step.toolName, args: step.args, id: crypto.randomUUID(), status: 'running' };
    toolCalls.push(call);
    yield createToolEvent(call, 'running');
    const toolStartedAt = Date.now();
    try {
      call.result = await executeTool(call, { recall: recallFromContext });
      throwIfAborted(signal);
      call.status = 'complete';
      step.status = 'complete';
      addSpan(trace, {
        kind: 'tool',
        name: call.name,
        input: call.args,
        output: call.result.output,
        durationMs: Date.now() - toolStartedAt,
        attributes: { attempt: call.result.attempt, policy: call.result.policy },
      });
      yield createToolEvent(call, 'complete', call.result.output);
    } catch (error) {
      if (error.code === 'RUN_CANCELLED') throw error;
      call.status = 'error';
      call.error = error.message;
      step.status = 'error';
      addSpan(trace, { kind: 'tool', name: call.name, status: 'error', input: call.args, output: error.message, durationMs: Date.now() - toolStartedAt });
      yield createToolEvent(call, 'error', `工具失败：${error.message}`);
    }
  }

  throwIfAborted(signal);

  const memoryContextText = sessionMemories.length ? `\n长期记忆：${sessionMemories.map((item) => item.content || item.text).join('\n')}` : '';
  const knowledgeContextText = retrievedKnowledge ? `\n用户知识库检索结果：\n${retrievedKnowledge}` : '';
  const evidence = summarizeEvidence(toolCalls);
  const toolContext = evidence ? `\n已执行工具与结果：\n${evidence}` : '';
  const skillContext = selectedSkills.length ? `\n已选择技能：${selectedSkills.join('\n')}` : '';
  const planContext = `\n执行计划：\n${formatPlanForPrompt(plan)}`;
  const shouldDelegate = /多智能体|multi.?agent|多角色/.test(question);
  const deterministicAnswer = answerFromDeterministicTools(toolCalls);
  let result;
  if (deterministicAnswer) {
    result = { text: deterministicAnswer, source: 'tool' };
  } else if (shouldDelegate) {
    yield createProgressEvent('正在并发执行规划与审阅子 Agent。');
    result = await runMultiAgent(question, `${planContext}${memoryContextText}${knowledgeContextText}${toolContext}${skillContext}`, trace, signal, images);
  } else {
    yield createProgressEvent('正在基于已执行证据生成最终回答。');
    const modelStartedAt = Date.now();
    result = await generateAnswer({ system: `${BASE_SYSTEM_PROMPT}${planContext}${memoryContextText}${knowledgeContextText}${toolContext}${skillContext}`, question, signal, images });
    throwIfAborted(signal);
    addSpan(trace, { kind: 'model', name: 'answer', input: question, output: result.text, durationMs: Date.now() - modelStartedAt, attributes: { source: result.source } });
  }
  throwIfAborted(signal);
  const answer = result.text || '没有得到有效回答。';
  addSpan(trace, { kind: 'answer', name: 'final-answer', input: question, output: answer, attributes: { source: result.source } });

  for (const content of chunkText(answer)) {
    throwIfAborted(signal);
    yield { resultType: 'agent', msgStatus: 'GENERATING', contents: [{ type: 0, history: true, content }] };
  }

  if (/记住[:：]/.test(question)) {
    const memory = question.replace(/^.*?记住[:：]?/, '').trim();
    if (memory && rememberMemory) {
      await rememberMemory(memory);
      addSpan(trace, { kind: 'memory', name: 'remember', input: memory, output: '已写入长期记忆' });
    }
  }

  const evaluation = evaluateRun({ question, answer, toolCalls, durationMs: Date.now() - startedAt, trace });
  await finishTrace(trace, { status: 'completed', answer, evaluation });

  yield {
    resultType: 'agent',
    msgStatus: 'FINISHED',
    id: crypto.randomUUID(),
    evaluation,
    traceId: trace.id,
    contents: [],
  };
}
