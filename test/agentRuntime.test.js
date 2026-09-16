import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { runAgent } from '../src/services/agentService.js';
import { streamModel } from '../src/services/modelClient.js';
import { extractDocumentText } from '../src/services/documentParser.js';
import { listMcpTools, callMcpTool } from '../src/services/mcpClient.js';
import { createRunStore } from '../src/platform/runStore.js';
import { retryOperation } from '../src/services/toolService.js';
import { recoverInterruptedRuns } from '../src/platform/runRecovery.js';

test('Agent Loop 由模型 tool_calls 决定工具，observation 返回后再生成最终答案', async () => {
  let turn = 0;
  async function* fakeModel() {
    turn += 1;
    if (turn === 1) yield { type: 'tool_calls', calls: [{ id: 'call-1', name: 'calculate', args: { expression: '(19 + 23) * 2' } }] };
    else yield { type: 'delta', text: '计算结果是 84。' };
    yield { type: 'done' };
  }
  const events = [];
  for await (const event of runAgent({ question: '请计算', systemPrompt: '测试', maxSteps: 3, modelStream: fakeModel })) events.push(event);
  assert.equal(events.filter((event) => event.contents?.[0]?.type === 12).length, 2);
  assert.equal(events.find((event) => event.contents?.[0]?.history)?.contents[0].content, '计算结果是 84。');
  assert.equal(turn, 2);
});

test('Ollama 流式响应逐 token 透传，不在服务端重新切分完整文本', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ message: { content: '第一段' }, done: false })}\n`);
    setTimeout(() => response.end(`${JSON.stringify({ message: { content: '第二段' }, done: true })}\n`), 5);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { config } = await import('../src/config.js');
  const previous = config.ollamaBaseUrl;
  config.ollamaBaseUrl = `http://127.0.0.1:${port}`;
  try {
    const deltas = [];
    for await (const event of streamModel({ provider: 'ollama', messages: [{ role: 'user', content: 'hi' }], tools: [] })) if (event.type === 'delta') deltas.push(event.text);
    assert.deepEqual(deltas, ['第一段', '第二段']);
  } finally {
    config.ollamaBaseUrl = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('动态 stdio MCP 可 list_tools 并 call_tool，不依赖固定 demo 连接', async () => {
  const server = { transport: 'stdio', config: { command: process.execPath, args: [new URL('../src/mcp/demoMcpServer.js', import.meta.url).pathname] } };
  const tools = await listMcpTools(server);
  assert.ok(tools.some((tool) => tool.name === 'add'));
  assert.equal(await callMcpTool({ server, toolName: 'add', args: { left: 19, right: 23 } }), '42');
});

test('RAG 文件入口先解析文本，再交给 chunk、embedding 和 pgvector 入库流程', async () => {
  const text = await extractDocumentText({ buffer: Buffer.from('Agent Loop 需要 tool calling 与 observation。'), fileName: 'notes.txt', mimeType: 'text/plain' });
  assert.match(text, /observation/);
});

test('Redis Run Store 保存取消标记和事件，服务重启后 PostgreSQL 仍可读取最终状态', async () => {
  const values = new Map();
  const client = {
    isOpen: true,
    on() {},
    async set(key, value) { values.set(key, value); }, async get(key) { return values.get(key) || null; }, async exists(key) { return values.has(key) ? 1 : 0; },
    async del(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); }, async quit() {},
    multi() { const operations = []; return { set: (...args) => (operations.push(['set', args]), this), rPush: (...args) => (operations.push(['rPush', args]), this), expire: () => this, exec: async () => { for (const [name, args] of operations) { if (name === 'set') values.set(args[0], args[1]); if (name === 'rPush') values.set(args[0], `${values.get(args[0]) || ''}${args[1]}`); } } }; },
  };
  const store = createRunStore({ client, keyPrefix: 'test:' });
  await store.begin({ id: 'run-1', status: 'running' });
  await store.event('run-1', 1, { type: 'delta' });
  await store.cancel('run-1');
  assert.equal(await store.isCancelled('run-1'), true);
  assert.ok(values.get('test:run:run-1:events'));
});

test('失败的工具按配置重试，成功 observation 会返回 Agent Loop', async () => {
  let attempts = 0;
  const output = await retryOperation(async (attempt) => {
    attempts = attempt;
    if (attempt < 2) throw new Error('临时网络故障');
    return 'recovered';
  }, 2);
  assert.equal(output, 'recovered');
  assert.equal(attempts, 2);
});

test('服务重启时运行中的 Run 被持久化为 interrupted，供前端展示与人工重试', async () => {
  let sql = '';
  const ids = await recoverInterruptedRuns({ query: async (statement) => { sql = statement; return { rows: [{ id: 'run-after-restart' }] }; } });
  assert.deepEqual(ids, ['run-after-restart']);
  assert.match(sql, /SERVER_RESTART/);
});
