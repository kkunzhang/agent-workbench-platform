import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { JsonStore } from './services/jsonStore.js';
import { runAgent } from './services/agentService.js';
import { listTools } from './services/toolService.js';
import { listMcpTools, closeMcpClient } from './services/mcpClient.js';
import { listKnowledge } from './services/knowledgeService.js';
import { getEvalReport, runEvalSuite } from './services/evalSuiteService.js';
import { listTraces } from './services/traceService.js';
import { summarizeEvaluations } from './services/evaluationService.js';
import { createDatabase } from './platform/database.js';
import { registerIdentityRoutes } from './platform/identity.js';
import { registerChatRoutes } from './platform/chatRoutes.js';
import { registerRuntimeRoutes } from './platform/runtimeRoutes.js';

const app = Fastify({ logger: true });
const directory = dirname(fileURLToPath(import.meta.url));
const store = new JsonStore(join(directory, '../data/state.json'));
const robotId = 900001;

await app.register(cors, { origin: true });
await app.register(fastifyJwt, { secret: config.jwtSecret });

let platformDatabase = null;
let platformDatabaseStatus = 'not-configured';
if (config.databaseUrl) {
  try {
    platformDatabase = createDatabase(config.databaseUrl);
    await platformDatabase.ping();
    await registerIdentityRoutes(app, { database: platformDatabase, config });
    await registerChatRoutes(app, { database: platformDatabase, store });
    await registerRuntimeRoutes(app, { database: platformDatabase, store, config });
    platformDatabaseStatus = 'ready';
  } catch (error) {
    platformDatabaseStatus = 'unavailable';
    app.log.warn({ err: error }, '平台数据库不可用，身份模块未启用');
    await platformDatabase?.close();
    platformDatabase = null;
  }
}

function ok(data) {
  return { code: 200, status: true, data };
}

function sessionSummary(sessionId, session) {
  return {
    sessionId,
    id: sessionId,
    content: session.title || '新对话',
    title: session.title || '新对话',
    robotId,
    createTime: session.updatedAt,
    updateTime: session.updatedAt,
  };
}

function writeSse(reply, payload) {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.get('/health', async () => ({
  ok: true,
  provider: config.llmProvider,
  model: config.ollamaModel,
  capabilities: ['sse', 'agent-loop', 'tool-policy', 'mcp-client', 'memory', 'trace', 'eval-suite'],
  platformDatabase: platformDatabaseStatus,
}));

app.get('/api/v1/platform/health', async (request, reply) => {
  if (platformDatabaseStatus !== 'ready') {
    return reply.code(503).send({ code: 503, status: false, message: `平台数据库状态：${platformDatabaseStatus}` });
  }
  return { code: 200, status: true, data: { database: platformDatabaseStatus, identity: true } };
});

app.get('/api/lab/lessons', async () => ok([
  { day: 1, topic: 'LLM API 与流式输出' },
  { day: 2, topic: 'Agent Loop 与 Planning' },
  { day: 3, topic: 'Tools、Skills 与 MCP' },
  { day: 4, topic: 'Context 与 Memory' },
  { day: 5, topic: 'Subagent 与 Multi-Agent' },
  { day: 6, topic: 'Harness Engineering 与评测' },
  { day: 7, topic: '综合验收' },
]));

app.get('/api/lab/tools', async () => ok(listTools()));
app.get('/api/lab/mcp/tools', async () => ok(await listMcpTools()));
app.get('/api/lab/knowledge', async () => ok(listKnowledge()));
app.get('/api/lab/traces', async (request) => ok(await listTraces(store, request.query)));
app.get('/api/lab/traces/:id', async (request, reply) => {
  const traces = await listTraces(store, { limit: 100 });
  const trace = traces.find((item) => item.id === request.params.id);
  return trace ? ok(trace) : reply.code(404).send({ code: 404, status: false, message: 'Trace 不存在' });
});
app.get('/api/lab/evals', async () => ok(await getEvalReport(store)));
app.post('/api/lab/evals/run', async () => ok(await runEvalSuite(store)));
app.get('/api/lab/overview', async () => {
  await store.load();
  const traces = store.state.traces || [];
  return ok({
    runtime: {
      provider: config.llmProvider,
      model: config.llmProvider === 'ollama' ? config.ollamaModel : config.openaiModel,
      maxSteps: config.agentMaxSteps,
      toolRetryCount: config.toolRetryCount,
    },
    counts: {
      sessions: Object.keys(store.state.sessions || {}).length,
      memories: (store.state.memories || []).length,
      traces: traces.length,
      completedTraces: traces.filter((item) => item.status === 'completed').length,
    },
    onlineEvaluation: summarizeEvaluations(store.state.evaluations || []),
    latestTrace: traces[0] || null,
  });
});

app.post('/api/v3/robot/greet', async () => ok({ sessionId: crypto.randomUUID() }));
app.post('/api/v3/robot/stop', async () => ok({ stopped: true }));
app.get('/api/v3/robot/patterns/list', async () => ok([
  { businessId: 1, supportAppDesc: '极速 - qwen3.5:0.8b', name: 'qwen3.5:0.8b' },
  { businessId: 2, supportAppDesc: '专家 - local-qwen35b-tools', name: 'local-qwen35b-tools' },
]));
app.get('/api/v2/robot/list', async () => ok({ list: [{ id: robotId, robotId, name: 'Agent 学习实验室' }], total: 1 }));
app.get('/api/v1/robot/getRobot', async () => ok({ id: robotId, robotId, name: 'Agent 学习实验室', robotName: 'Agent 学习实验室', description: '本地 Ollama 驱动的 7 天 Agent 实战后端' }));
app.get('/api/v3/robot/app/whitelist/check', async () => ok({ allowed: true }));
app.get('/api/v3/robot/app/often/list', async () => ok({ list: [] }));
app.get('/api/v3/robot/checkAiModelLimit', async () => ok({
  allowed: true,
  dailyLimit: 999999,
  usedCount: 0,
  remaining: 999999,
  exceeded: false,
}));

app.get('/api/v3/robot/log/session/group/list', async () => {
  await store.load();
  const list = Object.entries(store.state.sessions).map(([sessionId, session]) => sessionSummary(sessionId, session));
  return ok({ list, total: list.length });
});

app.get('/api/v3/robot/log', async (request) => {
  await store.load();
  const session = store.state.sessions[request.query.sessionId] || { messages: [] };
  return ok({ list: session.messages || [], total: session.messages?.length || 0 });
});

app.post('/api/v3/robot/run', async (request, reply) => {
  const body = request.body || {};
  const sessionId = body.sessionId || crypto.randomUUID();
  const question = String(body.question || '').trim();
  const account = request.headers.tokenid || 'local-agent-user';
  if (!question) return reply.code(400).send({ code: 400, status: false, message: 'question 不能为空' });

  await store.load();
  store.state.sessions[sessionId] ||= { title: question.slice(0, 30), messages: [], updatedAt: new Date().toISOString() };
  store.state.sessions[sessionId].messages.push({ role: 'user', content: question, createdAt: new Date().toISOString() });

  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  let answer = '';
  let seq = 0;
  try {
    for await (const event of runAgent({ store, account, question, skillNames: body.skillNames || [], sessionId })) {
      if (event.contents?.[0]?.type === 0 && event.contents[0].history === true) answer += event.contents[0].content;
      writeSse(reply, { ...event, sessionId, msgId: body.msgId || crypto.randomUUID(), seq: ++seq });
    }
  } catch (error) {
    request.log.error(error);
    writeSse(reply, {
      resultType: 'agent',
      msgStatus: 'FINISHED',
      id: crypto.randomUUID(),
      sessionId,
      contents: [{ type: 0, history: true, content: `本轮执行失败：${error.message}` }],
      seq: ++seq,
    });
  }
  store.state.sessions[sessionId].messages.push({ role: 'assistant', content: answer, createdAt: new Date().toISOString() });
  store.state.sessions[sessionId].updatedAt = new Date().toISOString();
  await store.save();
  reply.raw.end();
  return undefined;
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(500).send({ code: 500, status: false, message: error.message });
});

app.addHook('onClose', async () => {
  await closeMcpClient();
  await platformDatabase?.close();
});

await store.load();
await app.listen({ port: config.port, host: '127.0.0.1' });
