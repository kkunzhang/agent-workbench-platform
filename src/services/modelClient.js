import { config } from '../config.js';

function fallbackReply(question) {
  return [
    '当前没有可用的模型服务，因此返回的是内置教学回复。',
    `你问的是：${question}`,
    '启动 Ollama 后，服务会自动改为真实模型回答：执行 `ollama serve`，然后重新发送这条消息。',
  ].join('\n\n');
}

async function requestJson(url, options, parentSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.modelTimeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

export async function generateAnswer({ system, question, modelHint, signal }) {
  try {
    if (config.llmProvider === 'openai-compatible') {
      if (!config.openaiBaseUrl || !config.openaiApiKey || !config.openaiModel) {
        throw new Error('缺少 OpenAI 兼容服务配置');
      }
      const body = await requestJson(`${config.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: modelHint || config.openaiModel,
          messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
          temperature: 0.2,
        }),
      }, signal);
      return { text: body.choices?.[0]?.message?.content || fallbackReply(question), source: 'openai-compatible' };
    }

    const body = await requestJson(`${config.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelHint || config.ollamaModel,
        stream: false,
        think: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
        options: { temperature: 0.2 },
      }),
    }, signal);
    return { text: body.message?.content || fallbackReply(question), source: 'ollama' };
  } catch (error) {
    return { text: fallbackReply(question), source: 'fallback', error: error.message };
  }
}

export async function embed(text, signal) {
  try {
    const body = await requestJson(`${config.ollamaBaseUrl.replace(/\/$/, '')}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text:latest', input: text }),
    }, signal);
    return body.embeddings?.[0] || null;
  } catch {
    return null;
  }
}
