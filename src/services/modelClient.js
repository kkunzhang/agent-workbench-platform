import { config } from '../config.js';

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('模型请求已取消');
    error.code = 'RUN_CANCELLED';
    throw error;
  }
}

async function request(url, options, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('模型请求超时')), config.modelTimeoutMs);
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`模型服务返回 ${response.status}: ${await response.text()}`);
    return response;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

function parseArguments(value) {
  if (typeof value === 'object' && value) return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function normalizeToolCalls(rawCalls = []) {
  return rawCalls.map((item, index) => {
    const fn = item.function || item;
    return { id: item.id || `tool-${index}-${crypto.randomUUID()}`, name: fn.name, args: parseArguments(fn.arguments ?? fn.parameters) };
  }).filter((call) => call.name);
}

async function* readNdjson(response, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const block of response.body) {
    throwIfAborted(signal);
    buffer += decoder.decode(block, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

async function* streamOllama({ messages, tools, modelHint, signal }) {
  const response = await request(`${config.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelHint || (tools.length ? config.ollamaToolModel : config.ollamaModel), stream: true, think: false, messages,
      ...(tools.length ? { tools } : {}), options: { temperature: 0.2 },
    }),
  }, signal);
  for await (const part of readNdjson(response, signal)) {
    const message = part.message || {};
    if (message.content) yield { type: 'delta', text: message.content };
    const calls = normalizeToolCalls(message.tool_calls);
    if (calls.length) yield { type: 'tool_calls', calls };
    if (part.done) yield { type: 'done', usage: { promptTokens: part.prompt_eval_count || 0, completionTokens: part.eval_count || 0 } };
  }
}

async function* streamOpenAI({ messages, tools, modelHint, signal }) {
  if (!config.openaiBaseUrl || !config.openaiApiKey || !config.openaiModel) throw new Error('缺少 OpenAI 兼容模型配置');
  const response = await request(`${config.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiApiKey}` },
    body: JSON.stringify({ model: modelHint || config.openaiModel, messages, tools: tools.length ? tools.map((tool) => ({ type: 'function', function: tool.function || tool })) : undefined, stream: true, stream_options: { include_usage: true }, temperature: 0.2 }),
  }, signal);
  const decoder = new TextDecoder();
  let buffer = '';
  const pending = new Map();
  for await (const block of response.body) {
    throwIfAborted(signal);
    buffer += decoder.decode(block, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.split('\n').find((item) => item.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      const part = JSON.parse(payload);
      const delta = part.choices?.[0]?.delta || {};
      if (delta.content) yield { type: 'delta', text: delta.content };
      for (const call of delta.tool_calls || []) {
        const saved = pending.get(call.index) || { id: call.id, name: '', arguments: '' };
        saved.id ||= call.id;
        saved.name += call.function?.name || '';
        saved.arguments += call.function?.arguments || '';
        pending.set(call.index, saved);
      }
      if (part.usage) yield { type: 'usage', usage: { promptTokens: part.usage.prompt_tokens || 0, completionTokens: part.usage.completion_tokens || 0 } };
      if (part.choices?.[0]?.finish_reason === 'tool_calls') yield { type: 'tool_calls', calls: normalizeToolCalls([...pending.values()]) };
    }
  }
  yield { type: 'done' };
}

/** 每个 delta 均直接来自模型响应，禁止用完整答案二次切片伪造流式。 */
export async function* streamModel(input) {
  const provider = input.provider || config.llmProvider;
  if (provider === 'openai-compatible') yield* streamOpenAI(input);
  else yield* streamOllama(input);
}

export async function generateAnswer({ system, question, modelHint, signal, images = [] }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: images.length ? [{ type: 'text', text: question }, ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] : question },
  ];
  let text = '';
  for await (const event of streamModel({ messages, tools: [], modelHint, signal })) if (event.type === 'delta') text += event.text;
  return { text, source: config.llmProvider };
}

export async function embed(text, signal) {
  const response = await request(`${config.ollamaBaseUrl.replace(/\/$/, '')}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.embeddingModel, input: text }),
  }, signal);
  const body = await response.json();
  return body.embeddings?.[0] || null;
}
