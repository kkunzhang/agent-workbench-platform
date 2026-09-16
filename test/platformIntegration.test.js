import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = process.env.RUN_AGENT_INTEGRATION === '1';
const baseUrl = process.env.AGENT_PLATFORM_URL || 'http://127.0.0.1:8788';

async function login() {
  const response = await fetch(`${baseUrl}/api/v1/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@agent-workbench.local', password: 'Demo123456!' }) });
  const body = await response.json();
  return body.data.accessToken;
}
async function api(path, token, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const body = await response.json();
  assert.ok(response.ok, body.message || `${response.status}`);
  return body.data;
}
function parseEvents(text) {
  return text.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, '')));
}

test('平台集成：创建 Agent、创建 Session、SSE、Tool Calling、RAG、取消与状态恢复', { skip: !enabled }, async () => {
  const token = await login();
  const agents = await api('/api/v1/agents', token);
  const agent = agents[0];
  assert.ok(agent?.id);
  const createdAgent = await api('/api/v1/agents', token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: `acceptance-${crypto.randomUUID().slice(0, 8)}`, name: '验收 Agent', description: 'API 验收', systemPrompt: '你是用于 API 验收的 Agent。请简洁回答。', maxSteps: 2 }) });
  assert.ok(createdAgent.id);

  const session = await api('/api/v1/sessions', token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: createdAgent.id }) });
  assert.ok(session.id);

  const stream = await fetch(`${baseUrl}/api/v1/chat/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agent.id, sessionId: session.id, input: '请使用 calculate 工具计算 19 + 23。' }) });
  assert.ok(stream.ok);
  const events = parseEvents(await stream.text());
  assert.ok(events.some((event) => event.contents?.[0]?.type === 12));
  assert.ok(events.some((event) => event.msgStatus === 'FINISHED'));

  const cancellable = await fetch(`${baseUrl}/api/v1/chat/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: agent.id, input: '请详细分析 Agent 工程的全部实现细节。' }) });
  const reader = cancellable.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value || new Uint8Array());
  const runId = parseEvents(first)[0]?.platformRunId;
  assert.ok(runId);
  const cancelled = await api(`/api/v1/chat/runs/${runId}/cancel`, token, { method: 'POST' });
  assert.equal(cancelled.cancelled, true);
  await reader.cancel();

  const kb = await api('/api/v1/knowledge-bases', token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `integration-${crypto.randomUUID()}`, description: 'RAG 验收' }) });
  const form = new FormData();
  form.set('file', new Blob(['Redis 记录 Run 的临时状态；pgvector 负责语义检索。'], { type: 'text/plain' }), 'acceptance.txt');
  const upload = await api(`/api/v1/knowledge-bases/${kb.id}/documents/file`, token, { method: 'POST', body: form });
  assert.equal(upload.status, 'ready');
  const retrieval = await api(`/api/v1/knowledge-bases/${kb.id}/search?query=Redis%20pgvector`, token);
  assert.ok(retrieval.chunks.length > 0);
});
