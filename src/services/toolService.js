import { config } from '../config.js';
import { callMcpTool } from './mcpClient.js';
import { searchKnowledge } from './knowledgeService.js';

const tools = [
  { name: 'get_current_time', description: '获取当前本地时间', input: {}, policy: { sideEffect: false, timeoutMs: 1000 } },
  { name: 'calculate', description: '执行受限四则运算', input: { expression: 'string' }, policy: { sideEffect: false, timeoutMs: 1000 } },
  { name: 'knowledge_search', description: '检索内置 Agent 工程知识库并返回可引用片段', input: { query: 'string' }, policy: { sideEffect: false, timeoutMs: 1000 } },
  { name: 'memory_search', description: '查询当前用户长期记忆', input: { query: 'string' }, policy: { sideEffect: false, timeoutMs: 3000 } },
  { name: 'mcp_echo', description: '通过 stdio MCP Client 调用本地 MCP 回显工具', input: { text: 'string' }, policy: { sideEffect: false, timeoutMs: 5000 } },
  { name: 'mcp_add', description: '通过 stdio MCP Client 调用本地 MCP 加法工具', input: { left: 'number', right: 'number' }, policy: { sideEffect: false, timeoutMs: 5000 } },
];

export function listTools() {
  return tools;
}

export function parseNumberExpression(expression) {
  const text = String(expression || '').replace(/\s+/g, '');
  if (!text || !/^[\d.+\-*/()]+$/.test(text)) throw new Error('表达式只允许数字、小数点、括号和四则运算符');
  let offset = 0;
  const peek = () => text[offset];
  const consume = () => text[offset++];
  const parseExpression = () => {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const operator = consume();
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const parseTerm = () => {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const operator = consume();
      const right = parseFactor();
      if (operator === '/' && right === 0) throw new Error('不允许除以 0');
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };
  const parseFactor = () => {
    if (peek() === '+' || peek() === '-') {
      const operator = consume();
      const value = parseFactor();
      return operator === '-' ? -value : value;
    }
    if (peek() === '(') {
      consume();
      const value = parseExpression();
      if (consume() !== ')') throw new Error('括号不匹配');
      return value;
    }
    const start = offset;
    while (/[\d.]/.test(peek() || '')) consume();
    const literal = text.slice(start, offset);
    if (!literal || !/^\d+(\.\d+)?$/.test(literal)) throw new Error('数字格式不正确');
    return Number(literal);
  };
  const result = parseExpression();
  if (offset !== text.length || !Number.isFinite(result)) throw new Error('表达式格式不正确或结果超出范围');
  return result;
}

export function chooseTool(question) {
  const text = String(question);
  const calls = [];
  const expression = text.match(/(?:计算|算一下|=)\s*([\d\s+\-*/().]+)/)?.[1];
  if (expression && !/mcp/i.test(text)) calls.push({ name: 'calculate', args: { expression } });
  if (/现在.*(时间|几点)|几点了|当前时间/.test(text)) calls.push({ name: 'get_current_time', args: {} });
  if (/mcp.*加|mcp.*计算/i.test(text)) {
    const numbers = text.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (numbers.length >= 2) calls.push({ name: 'mcp_add', args: { left: numbers[0], right: numbers[1] } });
  } else if (/mcp/i.test(text)) {
    calls.push({ name: 'mcp_echo', args: { text } });
  }
  if (/agent|智能体|mcp|harness|评测|memory|记忆|多.?agent|多智能体|方案|对比|报告/i.test(text)) {
    calls.push({ name: 'knowledge_search', args: { query: text } });
  }
  if (/之前|偏好|我喜欢|我的技术|记住/.test(text)) calls.push({ name: 'memory_search', args: { query: text } });
  return calls;
}

function withTimeout(task, timeoutMs, label) {
  return Promise.race([
    task(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs)),
  ]);
}

async function executeOnce(call, context) {
  if (call.name === 'get_current_time') return new Date().toLocaleString('zh-CN', { hour12: false });
  if (call.name === 'calculate') return String(parseNumberExpression(call.args.expression));
  if (call.name === 'knowledge_search') {
    const results = searchKnowledge(call.args.query);
    return results.length
      ? results.map((item) => `【${item.title}】${item.content}`).join('\n')
      : '知识库没有命中内容。';
  }
  if (call.name === 'memory_search') {
    const memories = await context.recall(call.args.query);
    return memories.length ? memories.map((item) => item.text).join('\n') : '没有命中长期记忆。';
  }
  if (call.name === 'mcp_echo') return callMcpTool('echo', { text: call.args.text });
  if (call.name === 'mcp_add') return callMcpTool('add', call.args);
  throw new Error(`未知工具：${call.name}`);
}

export async function executeTool(call, context) {
  const definition = tools.find((item) => item.name === call.name);
  if (!definition) throw new Error(`未注册工具：${call.name}`);
  const retryCount = Number(context.retryCount ?? config.toolRetryCount);
  let latestError;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const startedAt = Date.now();
      const result = await withTimeout(
        () => executeOnce(call, context),
        definition.policy.timeoutMs || config.toolTimeoutMs,
        definition.name,
      );
      return { output: String(result), attempt: attempt + 1, durationMs: Date.now() - startedAt, policy: definition.policy };
    } catch (error) {
      latestError = error;
    }
  }
  throw latestError;
}
