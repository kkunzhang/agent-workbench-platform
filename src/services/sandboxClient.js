import { config } from '../config.js';

export async function executeSandbox({ code, input = {} }) {
  if (!config.sandboxRunnerToken) throw new Error('未配置 SANDBOX_RUNNER_TOKEN，代码沙盒未启用');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.sandboxTimeoutMs);
  try {
    const response = await fetch(new URL('/run', config.sandboxBaseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-token': config.sandboxRunnerToken,
      },
      body: JSON.stringify({ language: 'javascript', code, input }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `沙盒返回 ${response.status}`);
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`代码沙盒超时（${config.sandboxTimeoutMs}ms）`);
    throw new Error(`代码沙盒不可用：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}
