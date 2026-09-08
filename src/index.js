import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import { config } from './config.js';
import { runAgent } from './services/agentService.js';
import { listTools } from './services/toolService.js';
import { listMcpTools, closeMcpClient } from './services/mcpClient.js';
import { listKnowledge } from './services/knowledgeService.js';
import { runEvalSuite } from './services/evalSuiteService.js';
import { createDatabase } from './platform/database.js';
import { ensureDemoUser, registerIdentityRoutes } from './platform/identity.js';
import { registerChatRoutes } from './platform/chatRoutes.js';
import { registerRuntimeRoutes } from './platform/runtimeRoutes.js';

const app = Fastify({ logger: true });
const robotId = 900001;

if (!config.databaseUrl) throw new Error('DATABASE_URL 必须配置；平台不再使用本地 JSON 状态文件');

await app.register(cors, { origin: true });
await app.register(fastifyJwt, { secret: config.jwtSecret });

const database = createDatabase(config.databaseUrl);
await database.ping();
await registerIdentityRoutes(app, { database, config });
await registerChatRoutes(app, { database });
await registerRuntimeRoutes(app, { database, config });
const compatibilityUser = await ensureDemoUser(database, config);

function ok(data) { return { code: 200, status: true, data }; }
function limit(value, fallback = 30) { return Math.min(Math.max(Number(value) || fallback, 1), 100); }
function writeSse(reply, payload) { reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`); }

async function defaultAgent() {
  const result = await database.query('SELECT id FROM agents WHERE enabled = true ORDER BY created_at ASC LIMIT 1');
  if (!result.rowCount) throw new Error('没有可用 Agent，请先执行数据库迁移');
  return result.rows[0];
}

async function ensureCompatibilitySession(sessionId, title = '新对话') {
  const found = await database.query('SELECT id, title, updated_at AS "updatedAt" FROM agent_sessions WHERE id = $1 AND user_id = $2', [sessionId, compatibilityUser.id]);
  if (found.rowCount) return found.rows[0];
  const agent = await defaultAgent();
  const created = await database.query(`
    INSERT INTO agent_sessions (id, user_id, agent_id, title)
    VALUES ($1, $2, $3, $4)
    RETURNING id, title, updated_at AS "updatedAt"
  `, [sessionId, compatibilityUser.id, agent.id, title]);
  return created.rows[0];
}

function sessionSummary(session) {
  return {
    sessionId: session.id, id: session.id, content: session.title || '新对话', title: session.title || '新对话',
    robotId, createTime: session.updatedAt, updateTime: session.updatedAt,
  };
}

function stepFromEvent(event, sequence) {
  const content = event.contents?.[0];
  if (content?.type === 12) {
    let payload = {};
    try { payload = JSON.parse(content.content); } catch { payload = { raw: content.content }; }
    return { sequence, kind: 'tool', name: payload.ToolName || 'tool', status: payload.ToolStatus === 'error' ? 'error' : 'completed', input: payload.ToolParams || {}, output: { result: payload.ToolResult || '' } };
  }
  if (event.msgStatus === 'FINISHED') return { sequence, kind: 'answer', name: 'finish', status: 'completed', input: {}, output: { evaluation: event.evaluation || null } };
  if (content?.history) return { sequence, kind: 'model', name: 'answer-chunk', status: 'completed', input: {}, output: { content: content.content || '' } };
  return { sequence, kind: 'planning', name: 'progress', status: 'completed', input: {}, output: { content: content?.content || '' } };
}

async function persistEvaluation(initiatedBy) {
  const started = await database.query(`INSERT INTO evaluation_runs (initiated_by, status) VALUES ($1, 'running') RETURNING id`, [initiatedBy]);
  const report = await runEvalSuite();
  for (const result of report.results) {
    const testCase = await database.query('SELECT id FROM evaluation_cases WHERE name = $1', [result.name]);
    await database.query(`
      INSERT INTO evaluation_results (evaluation_run_id, evaluation_case_id, status, actual, duration_ms)
      VALUES ($1, $2, $3, $4, $5)
    `, [started.rows[0].id, testCase.rows[0]?.id || null, result.passed ? 'passed' : 'failed', JSON.stringify(result), result.evaluation.durationMs]);
  }
  await database.query(`UPDATE evaluation_runs SET status = 'completed', summary = $1, completed_at = now() WHERE id = $2`, [JSON.stringify(report.summary), started.rows[0].id]);
  return { id: started.rows[0].id, ...report };
}

async function compatibilityTraces(maximum) {
  const result = await database.query(`
    SELECT agent_runs.id, agent_runs.input AS question, agent_runs.status, agent_runs.created_at AS "startedAt", agent_runs.duration_ms AS "durationMs",
      COALESCE(json_agg(json_build_object('id', agent_run_steps.id, 'kind', agent_run_steps.kind, 'name', agent_run_steps.name, 'status', agent_run_steps.status)
        ORDER BY agent_run_steps.sequence) FILTER (WHERE agent_run_steps.id IS NOT NULL), '[]'::json) AS spans
    FROM agent_runs LEFT JOIN agent_run_steps ON agent_run_steps.run_id = agent_runs.id
    WHERE agent_runs.user_id = $1 GROUP BY agent_runs.id ORDER BY agent_runs.created_at DESC LIMIT $2
  `, [compatibilityUser.id, maximum]);
  return result.rows;
}

app.get('/health', async () => ({
  ok: true,
  provider: config.llmProvider,
  model: config.llmProvider === 'ollama' ? config.ollamaModel : config.openaiModel,
  capabilities: ['sse', 'agent-loop', 'tool-policy', 'mcp-client', 'memory', 'pgvector-rag', 'trace', 'eval-suite'],
  platformDatabase: 'ready',
}));
app.get('/api/v1/platform/health', async () => ok({ database: 'ready', identity: true, storage: 'postgresql-pgvector' }));

// 既有 Vue 前端的兼容适配层；会话、消息、Trace 和评测仍全部写入 PostgreSQL。
app.get('/api/lab/lessons', async () => ok([
  { day: 1, topic: 'LLM API 与流式输出' }, { day: 2, topic: 'Agent Loop 与 Planning' }, { day: 3, topic: 'Tools、Skills 与 MCP' },
  { day: 4, topic: 'Context 与 Memory' }, { day: 5, topic: 'Subagent 与 Multi-Agent' }, { day: 6, topic: 'Harness Engineering 与评测' }, { day: 7, topic: '综合验收' },
]));
app.get('/api/lab/tools', async () => ok(listTools()));
app.get('/api/lab/mcp/tools', async () => ok(await listMcpTools()));
app.get('/api/lab/knowledge', async () => ok(listKnowledge()));
app.get('/api/lab/traces', async (request) => ok(await compatibilityTraces(limit(request.query.limit, 12))));
app.get('/api/lab/traces/:id', async (request, reply) => {
  const trace = await database.query('SELECT id, input AS question, status, created_at AS "startedAt", duration_ms AS "durationMs" FROM agent_runs WHERE id = $1 AND user_id = $2', [request.params.id, compatibilityUser.id]);
  if (!trace.rowCount) return reply.code(404).send({ code: 404, status: false, message: 'Trace 不存在' });
  const spans = await database.query('SELECT id, kind, name, status, input, output, duration_ms AS "durationMs" FROM agent_run_steps WHERE run_id = $1 ORDER BY sequence', [trace.rows[0].id]);
  return ok({ ...trace.rows[0], spans: spans.rows });
});
app.get('/api/lab/evals', async () => {
  const runs = await database.query('SELECT id, summary, created_at AS "createdAt" FROM evaluation_runs WHERE initiated_by = $1 ORDER BY created_at DESC LIMIT 30', [compatibilityUser.id]);
  const withResults = await Promise.all(runs.rows.map(async (run) => {
    const results = await database.query(`
      SELECT evaluation_results.id, evaluation_cases.name, evaluation_results.actual
      FROM evaluation_results LEFT JOIN evaluation_cases ON evaluation_cases.id = evaluation_results.evaluation_case_id
      WHERE evaluation_results.evaluation_run_id = $1 ORDER BY evaluation_results.created_at
    `, [run.id]);
    return { ...run, results: results.rows.map((item) => ({ id: item.id, name: item.name, ...(item.actual || {}) })) };
  }));
  return ok({ cases: [], runs: withResults, online: { total: 0, passRate: 0 } });
});
app.post('/api/lab/evals/run', async () => ok(await persistEvaluation(compatibilityUser.id)));
app.get('/api/lab/overview', async () => {
  const [sessionCount, memoryCount, traceCount, completedCount] = await Promise.all([
    database.query("SELECT COUNT(*)::int AS count FROM agent_sessions WHERE user_id = $1 AND status <> 'deleted'", [compatibilityUser.id]),
    database.query('SELECT COUNT(*)::int AS count FROM user_memories WHERE user_id = $1', [compatibilityUser.id]),
    database.query('SELECT COUNT(*)::int AS count FROM agent_runs WHERE user_id = $1', [compatibilityUser.id]),
    database.query("SELECT COUNT(*)::int AS count FROM agent_runs WHERE user_id = $1 AND status = 'completed'", [compatibilityUser.id]),
  ]);
  return ok({
    runtime: { provider: config.llmProvider, model: config.llmProvider === 'ollama' ? config.ollamaModel : config.openaiModel, maxSteps: config.agentMaxSteps, toolRetryCount: config.toolRetryCount },
    counts: { sessions: sessionCount.rows[0].count, memories: memoryCount.rows[0].count, traces: traceCount.rows[0].count, completedTraces: completedCount.rows[0].count },
    onlineEvaluation: { total: traceCount.rows[0].count, passRate: completedCount.rows[0].count / Math.max(traceCount.rows[0].count, 1) },
  });
});

app.post('/api/v3/robot/greet', async () => ok({ sessionId: crypto.randomUUID() }));
app.post('/api/v3/robot/stop', async () => ok({ stopped: true }));
app.get('/api/v3/robot/patterns/list', async () => ok([
  { businessId: 1, supportAppDesc: `极速 - ${config.ollamaModel}`, name: config.ollamaModel },
  { businessId: 2, supportAppDesc: '专家 - local-qwen35b-tools', name: 'local-qwen35b-tools' },
]));
app.get('/api/v2/robot/list', async () => ok({ list: [{ id: robotId, robotId, name: 'Agent 学习实验室' }], total: 1 }));
app.get('/api/v1/robot/getRobot', async () => ok({ id: robotId, robotId, name: 'Agent 学习实验室', robotName: 'Agent 学习实验室', description: '本地或 OpenAI 兼容模型驱动的 Agent 后端' }));
app.get('/api/v3/robot/app/whitelist/check', async () => ok({ allowed: true }));
app.get('/api/v3/robot/app/often/list', async () => ok({ list: [] }));
app.get('/api/v3/robot/checkAiModelLimit', async () => ok({ allowed: true, dailyLimit: 999999, usedCount: 0, remaining: 999999, exceeded: false }));
app.get('/api/v3/robot/log/session/group/list', async () => {
  const sessions = await database.query(`SELECT id, title, updated_at AS "updatedAt" FROM agent_sessions WHERE user_id = $1 AND status <> 'deleted' ORDER BY pinned DESC, updated_at DESC`, [compatibilityUser.id]);
  return ok({ list: sessions.rows.map(sessionSummary), total: sessions.rowCount });
});
app.get('/api/v3/robot/log', async (request) => {
  const messages = await database.query('SELECT id, role, plain_text, contents, created_at AS "msgTime" FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [request.query.sessionId]);
  return ok({ list: messages.rows.map((message) => ({
    id: message.id, role: message.role, content: message.plain_text, msgTime: message.msgTime,
    contents: message.role === 'assistant' ? [{ type: 0, history: true, content: message.plain_text }] : message.contents,
  })), total: messages.rowCount });
});
app.post('/api/v3/robot/run', async (request, reply) => {
  const body = request.body || {};
  const sessionId = body.sessionId || crypto.randomUUID();
  const question = String(body.question || '').trim();
  if (!question) return reply.code(400).send({ code: 400, status: false, message: 'question 不能为空' });
  const session = await ensureCompatibilitySession(sessionId, question.slice(0, 50));
  const agent = await defaultAgent();
  await database.query('INSERT INTO messages (session_id, role, plain_text) VALUES ($1, $2, $3)', [session.id, 'user', question]);
  const createdRun = await database.query(`
    INSERT INTO agent_runs (session_id, user_id, agent_id, input, status, model_provider, model_name, started_at)
    VALUES ($1, $2, $3, $4, 'running', $5, $6, now()) RETURNING id
  `, [session.id, compatibilityUser.id, agent.id, question, config.llmProvider, config.llmProvider === 'ollama' ? config.ollamaModel : config.openaiModel]);
  const runId = createdRun.rows[0].id;
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  let answer = '';
  let sequence = 0;
  const startedAt = Date.now();
  try {
    for await (const event of runAgent({ account: compatibilityUser.id, question, skillNames: body.skillNames || [], sessionId: session.id })) {
      const content = event.contents?.[0];
      if (content?.type === 0 && content.history) answer += content.content;
      const step = stepFromEvent(event, ++sequence);
      await database.query('INSERT INTO agent_run_steps (run_id, sequence, kind, name, status, input, output) VALUES ($1, $2, $3, $4, $5, $6, $7)', [runId, step.sequence, step.kind, step.name, step.status, JSON.stringify(step.input), JSON.stringify(step.output)]);
      writeSse(reply, { ...event, platformRunId: runId, sessionId: session.id, msgId: body.msgId || crypto.randomUUID(), seq: sequence });
    }
    await database.query("INSERT INTO messages (session_id, role, plain_text) VALUES ($1, 'assistant', $2)", [session.id, answer]);
    await database.query('UPDATE agent_sessions SET updated_at = now() WHERE id = $1', [session.id]);
    await database.query("UPDATE agent_runs SET status = 'completed', output = $1, duration_ms = $2, completed_at = now() WHERE id = $3", [answer, Date.now() - startedAt, runId]);
  } catch (error) {
    await database.query("UPDATE agent_runs SET status = 'failed', error_code = 'RUN_FAILED', error_message = $1, duration_ms = $2, completed_at = now() WHERE id = $3", [error.message, Date.now() - startedAt, runId]);
    writeSse(reply, { resultType: 'agent', msgStatus: 'FINISHED', id: crypto.randomUUID(), sessionId: session.id, contents: [{ type: 0, history: true, content: `本轮执行失败：${error.message}` }], seq: ++sequence });
  }
  reply.raw.end();
  return undefined;
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(500).send({ code: 500, status: false, message: error.message });
});
app.addHook('onClose', async () => {
  await closeMcpClient();
  await database.close();
});
await app.listen({ port: config.port, host: '127.0.0.1' });
