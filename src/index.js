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
import { persistMemory, retrieveKnowledge, retrieveMemories } from './platform/contextService.js';

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
const legacyActiveRuns = new Map();

function ok(data) { return { code: 200, status: true, data }; }
function limit(value, fallback = 30) { return Math.min(Math.max(Number(value) || fallback, 1), 100); }
function writeSse(reply, payload) { reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`); }

async function defaultAgent() {
  const result = await database.query('SELECT id FROM agents WHERE enabled = true ORDER BY created_at ASC LIMIT 1');
  if (!result.rowCount) throw new Error('没有可用 Agent，请先执行数据库迁移');
  return result.rows[0];
}

async function ensureCompatibilitySession(sessionId, title = '新对话', userId = compatibilityUser.id) {
  const found = await database.query('SELECT id, title, updated_at AS "updatedAt" FROM agent_sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
  if (found.rowCount) return found.rows[0];
  const agent = await defaultAgent();
  const created = await database.query(`
    INSERT INTO agent_sessions (id, user_id, agent_id, title)
    VALUES ($1, $2, $3, $4)
    RETURNING id, title, updated_at AS "updatedAt"
  `, [sessionId, userId, agent.id, title]);
  return created.rows[0];
}

function sessionSummary(session) {
  return {
    sessionId: session.id, id: session.id, content: session.title || '新对话', title: session.title || '新对话',
    robotId, pinned: Boolean(session.pinned), createTime: session.updatedAt, updateTime: session.updatedAt,
  };
}

function groupCompatibilitySessions(sessions) {
  const groups = {};
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const push = (name, item) => {
    if (!groups[name]) groups[name] = [];
    groups[name].push(item);
  };
  for (const session of sessions) {
    const item = sessionSummary(session);
    const updatedAt = new Date(session.updatedAt).getTime();
    if (session.pinned) push('置顶', item);
    else if (updatedAt >= todayStart) push('今天', item);
    else if (updatedAt >= weekStart) push('近七天', item);
    else push('更早', item);
  }
  return groups;
}

function legacyMessage(message) {
  const content = message.plain_text || '';
  return {
    id: message.id,
    role: message.role,
    content,
    msgTime: message.msgTime,
    robotId,
    businessId: robotId,
    contents: message.role === 'assistant'
      ? [{ type: 0, history: true, show: true, content }]
      : [{ type: 0, show: true, content }],
  };
}

async function ownedCompatibilitySession(sessionId, userId = compatibilityUser.id) {
  const result = await database.query(`
    SELECT id, title, pinned, status, updated_at AS "updatedAt"
    FROM agent_sessions WHERE id = $1 AND user_id = $2 AND status <> 'deleted'
  `, [sessionId, userId]);
  return result.rows[0] || null;
}

async function collectionTitle(sessionId, fallback = '') {
  const result = await database.query(`
    SELECT agent_sessions.title, messages.plain_text AS "firstMessage"
    FROM agent_sessions
    LEFT JOIN LATERAL (
      SELECT plain_text FROM messages WHERE session_id = agent_sessions.id AND role = 'user' ORDER BY created_at ASC LIMIT 1
    ) messages ON true
    WHERE agent_sessions.id = $1
  `, [sessionId]);
  return result.rows[0]?.title || result.rows[0]?.firstMessage || fallback || '收藏对话';
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

// 旧 Vue 接口把令牌放在 tokenId 查询参数中。新后端校验 JWT 并将会话、收藏和记忆按用户隔离；
// 未携带令牌时保留本地演示账号，方便首次启动和 API 调试。
app.addHook('preHandler', async (request) => {
  if (!request.url.startsWith('/api/v3/robot/')) return;
  const token = request.query?.tokenId || request.headers.tokenid;
  request.compatibilityUserId = compatibilityUser.id;
  if (!token) return;
  try {
    const payload = await app.jwt.verify(token);
    if (payload?.sub) request.compatibilityUserId = payload.sub;
  } catch {
    // 旧后端会在前端刷新令牌后重试；兼容层此处降级到演示账号，避免破坏本地启动流程。
  }
});

app.get('/health', async () => ({
  ok: true,
  provider: config.llmProvider,
  model: config.llmProvider === 'ollama' ? config.ollamaModel : config.openaiModel,
  capabilities: ['sse', 'agent-loop', 'tool-policy', 'mcp-client', 'memory', 'pgvector-rag', 'web-search', 'image-search', 'isolated-sandbox', 'trace', 'eval-suite'],
  platformDatabase: 'ready',
}));
app.get('/api/v1/platform/health', async () => ok({
  database: 'ready',
  identity: true,
  storage: 'postgresql-pgvector',
  webSearch: { provider: config.webSearchProvider, endpoint: config.searxngBaseUrl },
  sandbox: { endpoint: config.sandboxBaseUrl, configured: Boolean(config.sandboxRunnerToken), isolation: 'container+vm' },
}));

// 既有 Vue 前端的兼容适配层；会话、消息、Trace、反馈和收藏均映射到 PostgreSQL。
// 仅覆盖本项目选定的 A/B/C Agent 能力；云盘、工单、企业组织等外部业务接口不在这里伪造实现。
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
async function stopLegacyRun(request) {
  const msgId = request.query.msgId || request.body?.msgId;
  const active = legacyActiveRuns.get(msgId);
  if (!active) return ok({ stopped: false, message: '没有正在执行的消息' });
  if (active.userId !== request.compatibilityUserId) return ok({ stopped: false, message: '没有正在执行的消息' });
  active.controller.abort(new Error('用户停止生成'));
  return ok({ stopped: true, runId: active.runId });
}
app.post('/api/v3/robot/stop', stopLegacyRun);
app.delete('/api/v3/robot/stop', stopLegacyRun);
app.get('/api/v3/robot/patterns/list', async () => ok([
  { businessId: 1, supportAppDesc: `极速 - ${config.ollamaModel}`, name: config.ollamaModel },
  { businessId: 2, supportAppDesc: '专家 - local-qwen35b-tools', name: 'local-qwen35b-tools' },
]));
app.get('/api/v2/robot/list', async () => ok({ list: [{ id: robotId, robotId, name: 'Agent 学习实验室' }], total: 1 }));
app.get('/api/v1/robot/getRobot', async () => ok({ id: robotId, robotId, name: 'Agent 学习实验室', robotName: 'Agent 学习实验室', description: '本地或 OpenAI 兼容模型驱动的 Agent 后端' }));
app.get('/api/v3/robot/app/whitelist/check', async () => ok({ allowed: true }));
app.get('/api/v3/robot/app/often/list', async () => ok({ list: [] }));
app.get('/api/v3/robot/checkAiModelLimit', async () => ok({ allowed: true, dailyLimit: 999999, usedCount: 0, remaining: 999999, exceeded: false }));
app.get('/api/v3/robot/log/session/group/list', async (request) => {
  const userId = request.compatibilityUserId;
  const sessions = await database.query(`SELECT id, title, pinned, updated_at AS "updatedAt" FROM agent_sessions WHERE user_id = $1 AND status <> 'deleted' ORDER BY pinned DESC, updated_at DESC`, [userId]);
  return ok(groupCompatibilitySessions(sessions.rows));
});
app.get('/api/v3/robot/log', async (request) => {
  const session = await ownedCompatibilitySession(request.query.sessionId, request.compatibilityUserId);
  if (!session) return { status: false, code: 404, message: '会话不存在', page: { list: [], total: 0 } };
  const messages = await database.query('SELECT id, role, plain_text, contents, created_at AS "msgTime" FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [session.id]);
  const list = messages.rows.map(legacyMessage);
  return { code: 200, status: true, data: { list, total: list.length }, page: { list, total: list.length } };
});
app.get('/api/v3/robot/log/session/group/list/detail', async (request) => {
  const keyword = String(request.query.content || '').trim();
  if (!keyword) return ok({});
  const sessions = await database.query(`
    SELECT DISTINCT agent_sessions.id, agent_sessions.title, agent_sessions.pinned, agent_sessions.updated_at AS "updatedAt"
    FROM agent_sessions
    LEFT JOIN messages ON messages.session_id = agent_sessions.id
    WHERE agent_sessions.user_id = $1 AND agent_sessions.status <> 'deleted'
      AND (agent_sessions.title ILIKE $2 OR messages.plain_text ILIKE $2)
    ORDER BY agent_sessions.pinned DESC, agent_sessions.updated_at DESC
  `, [request.compatibilityUserId, `%${keyword}%`]);
  return ok(groupCompatibilitySessions(sessions.rows));
});
app.put('/api/v3/robot/log/session/pin', async (request, reply) => {
  const body = request.body || {};
  const session = await ownedCompatibilitySession(body.sessionId, request.compatibilityUserId);
  if (!session) return reply.code(404).send({ code: 404, status: false, message: '会话不存在' });
  await database.query('UPDATE agent_sessions SET pinned = $1, updated_at = now() WHERE id = $2', [Boolean(body.pinned), session.id]);
  return ok({ sessionId: session.id, pinned: Boolean(body.pinned) });
});
app.put('/api/v3/robot/log/session/rename', async (request, reply) => {
  const body = request.body || {};
  const title = String(body.sessionTitle || '').trim().slice(0, 120);
  const session = await ownedCompatibilitySession(body.sessionId, request.compatibilityUserId);
  if (!session) return reply.code(404).send({ code: 404, status: false, message: '会话不存在' });
  if (!title) return reply.code(422).send({ code: 422, status: false, message: '会话名称不能为空' });
  await database.query('UPDATE agent_sessions SET title = $1, updated_at = now() WHERE id = $2', [title, session.id]);
  return ok({ sessionId: session.id, title });
});
app.post('/api/v3/robot/del/log', async (request) => {
  const sessionIds = Array.isArray(request.body?.sessionIds) ? request.body.sessionIds : [];
  if (!sessionIds.length) {
    await database.query("UPDATE agent_sessions SET status = 'deleted', updated_at = now() WHERE user_id = $1 AND status <> 'deleted'", [request.compatibilityUserId]);
    return ok({ deleted: 'all' });
  }
  await database.query("UPDATE agent_sessions SET status = 'deleted', updated_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[])", [request.compatibilityUserId, sessionIds]);
  return ok({ deleted: sessionIds });
});
app.put('/api/v3/robot/log/like', async (request, reply) => {
  const body = request.body || {};
  const rating = body.mark === 'dislike' ? 'dislike' : 'like';
  const message = await database.query(`
    SELECT messages.id FROM messages JOIN agent_sessions ON agent_sessions.id = messages.session_id
    WHERE messages.id = $1 AND agent_sessions.user_id = $2
  `, [body.id, request.compatibilityUserId]);
  if (!message.rowCount) return reply.code(404).send({ code: 404, status: false, message: '消息不存在' });
  await database.query(`
    INSERT INTO message_feedback (message_id, user_id, rating) VALUES ($1, $2, $3)
    ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, created_at = now()
  `, [body.id, request.compatibilityUserId, rating]);
  return ok({ id: body.id, mark: rating });
});
app.post('/api/v3/robot/collection', async (request, reply) => {
  const body = request.body || {};
  const messageIds = Array.isArray(body.msgIds) ? body.msgIds.filter(Boolean) : [];
  let sessionId = body.sessionId;
  if (!sessionId && messageIds.length) {
    const first = await database.query(`
      SELECT messages.session_id AS "sessionId" FROM messages
      JOIN agent_sessions ON agent_sessions.id = messages.session_id
      WHERE messages.id = $1 AND agent_sessions.user_id = $2
    `, [messageIds[0], request.compatibilityUserId]);
    sessionId = first.rows[0]?.sessionId;
  }
  const session = await ownedCompatibilitySession(sessionId, request.compatibilityUserId);
  if (!session) return reply.code(404).send({ code: 404, status: false, message: '会话不存在' });
  const title = await collectionTitle(session.id, body.type === 'dialog' ? '收藏对话' : '收藏内容');
  const created = await database.query(`
    INSERT INTO legacy_collections (user_id, session_id, type, title, summary)
    VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at AS "createdAt"
  `, [request.compatibilityUserId, session.id, String(body.type || 'dialog').slice(0, 40), title.slice(0, 160), title.slice(0, 300)]);
  if (messageIds.length) {
    const ownedMessages = await database.query(`
      SELECT messages.id FROM messages JOIN agent_sessions ON agent_sessions.id = messages.session_id
      WHERE messages.id = ANY($1::uuid[]) AND messages.session_id = $2 AND agent_sessions.user_id = $3
    `, [messageIds, session.id, request.compatibilityUserId]);
    for (const message of ownedMessages.rows) {
      await database.query('INSERT INTO legacy_collection_messages (collection_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [created.rows[0].id, message.id]);
    }
  }
  return ok({ id: created.rows[0].id, sessionId: session.id, type: body.type || 'dialog' });
});
app.get('/api/v3/robot/collection', async (request) => {
  const page = Math.max(Number(request.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(request.query.pageSize) || 10, 1), 100);
  const type = String(request.query.type || 'all');
  const title = String(request.query.title || '').trim();
  const result = await database.query(`
    SELECT legacy_collections.id, legacy_collections.type, legacy_collections.title, legacy_collections.summary,
      legacy_collections.session_id AS "sessionId", legacy_collections.created_at AS "create_time",
      agent_sessions.title AS "sessionTitle", COUNT(*) OVER() AS total
    FROM legacy_collections JOIN agent_sessions ON agent_sessions.id = legacy_collections.session_id
    WHERE legacy_collections.user_id = $1
      AND ($2 = 'all' OR legacy_collections.type = $2)
      AND ($3 = '' OR legacy_collections.title ILIKE '%' || $3 || '%')
    ORDER BY legacy_collections.created_at DESC
    LIMIT $4 OFFSET $5
  `, [request.compatibilityUserId, type, title, pageSize, (page - 1) * pageSize]);
  const data = result.rows.map((item) => ({
    id: item.id, type: item.type, title: item.title || item.sessionTitle, summary: item.summary,
    sessionId: item.sessionId, robotId, robotName: 'Agent 学习实验室', resultType: 'agent', create_time: item.create_time,
  }));
  return ok({ data, total: Number(result.rows[0]?.total || 0), page, pageSize });
});
app.get('/api/v3/robot/collection/info', async (request, reply) => {
  const collection = await database.query(`
    SELECT id, session_id AS "sessionId", type, title, summary, created_at AS "create_time"
    FROM legacy_collections WHERE id = $1 AND user_id = $2
  `, [request.query.id, request.compatibilityUserId]);
  if (!collection.rowCount) return reply.code(404).send({ code: 404, status: false, message: '收藏不存在' });
  const item = collection.rows[0];
  const selected = await database.query('SELECT message_id AS "messageId" FROM legacy_collection_messages WHERE collection_id = $1', [item.id]);
  const messages = selected.rowCount
    ? await database.query('SELECT id, role, plain_text, created_at AS "msgTime" FROM messages WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC', [selected.rows.map((row) => row.messageId)])
    : await database.query('SELECT id, role, plain_text, created_at AS "msgTime" FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [item.sessionId]);
  return ok({ ...item, robotId, robotName: 'Agent 学习实验室', msg: messages.rows.map(legacyMessage) });
});
app.delete('/api/v3/robot/collection', async (request) => {
  const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter(Boolean) : [];
  if (!ids.length) return ok({ deleted: [] });
  await database.query('DELETE FROM legacy_collections WHERE user_id = $1 AND id = ANY($2::uuid[])', [request.compatibilityUserId, ids]);
  return ok({ deleted: ids });
});
app.post('/api/v3/robot/collection/dialog', async (request, reply) => {
  const collection = await database.query('SELECT session_id AS "sessionId" FROM legacy_collections WHERE id = $1 AND user_id = $2', [request.body?.id, request.compatibilityUserId]);
  if (!collection.rowCount) return reply.code(404).send({ code: 404, status: false, message: '收藏不存在' });
  return ok(collection.rows[0].sessionId);
});
app.post('/api/v3/robot/eval', async (request) => {
  await database.query('INSERT INTO audit_logs (actor_id, action, metadata) VALUES ($1, $2, $3)', [request.compatibilityUserId, 'legacy.evaluation.submit', JSON.stringify(request.body || {})]);
  return ok({ recorded: true });
});
app.post('/api/v3/robot/run', async (request, reply) => {
  const body = request.body || {};
  const sessionId = body.sessionId || crypto.randomUUID();
  const question = String(body.question || '').trim();
  if (!question) return reply.code(400).send({ code: 400, status: false, message: 'question 不能为空' });
  const userId = request.compatibilityUserId;
  const session = await ensureCompatibilitySession(sessionId, question.slice(0, 50), userId);
  const agent = await defaultAgent();
  await database.query('INSERT INTO messages (session_id, role, plain_text) VALUES ($1, $2, $3)', [session.id, 'user', question]);
  const createdRun = await database.query(`
    INSERT INTO agent_runs (session_id, user_id, agent_id, input, status, model_provider, model_name, started_at)
    VALUES ($1, $2, $3, $4, 'running', $5, $6, now()) RETURNING id
  `, [session.id, userId, agent.id, question, config.llmProvider, config.llmProvider === 'ollama' ? config.ollamaModel : config.openaiModel]);
  const runId = createdRun.rows[0].id;
  const streamMessageId = body.msgId || crypto.randomUUID();
  const controller = new AbortController();
  legacyActiveRuns.set(streamMessageId, { controller, runId, userId });
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  let answer = '';
  let sequence = 0;
  const startedAt = Date.now();
  try {
    let knowledgeContext = [];
    let memoryContext = [];
    try {
      [knowledgeContext, memoryContext] = await Promise.all([
        retrieveKnowledge(database, userId, question),
        retrieveMemories(database, userId, question),
      ]);
    } catch (error) {
      request.log.warn({ err: error, runId }, '兼容聊天上下文检索失败，继续执行 Agent');
    }
    if (knowledgeContext.length) {
      const retrievalStep = {
        sequence: ++sequence,
        kind: 'tool',
        name: 'platform_knowledge_retrieval',
        status: 'completed',
        input: { query: question },
        output: { count: knowledgeContext.length, files: knowledgeContext.map((item) => item.fileName) },
      };
      await database.query('INSERT INTO agent_run_steps (run_id, sequence, kind, name, status, input, output) VALUES ($1, $2, $3, $4, $5, $6, $7)', [runId, retrievalStep.sequence, retrievalStep.kind, retrievalStep.name, retrievalStep.status, JSON.stringify(retrievalStep.input), JSON.stringify(retrievalStep.output)]);
      writeSse(reply, {
        resultType: 'agent', msgStatus: 'GENERATING', platformRunId: runId, sessionId: session.id, msgId: streamMessageId, seq: sequence,
        contents: [{ type: 0, history: false, content: `已从用户知识库检索到 ${knowledgeContext.length} 段相关内容。` }],
      });
    }
    for await (const event of runAgent({
      account: userId,
      question,
      skillNames: body.skillNames || [],
      sessionId: session.id,
      signal: controller.signal,
      knowledgeContext,
      memoryContext,
      rememberMemory: (content) => persistMemory(database, userId, content),
    })) {
      const content = event.contents?.[0];
      if (content?.type === 0 && content.history) answer += content.content;
      const step = stepFromEvent(event, ++sequence);
      await database.query('INSERT INTO agent_run_steps (run_id, sequence, kind, name, status, input, output) VALUES ($1, $2, $3, $4, $5, $6, $7)', [runId, step.sequence, step.kind, step.name, step.status, JSON.stringify(step.input), JSON.stringify(step.output)]);
      writeSse(reply, { ...event, platformRunId: runId, sessionId: session.id, msgId: streamMessageId, seq: sequence });
    }
    await database.query("INSERT INTO messages (session_id, role, plain_text) VALUES ($1, 'assistant', $2)", [session.id, answer]);
    await database.query('UPDATE agent_sessions SET updated_at = now() WHERE id = $1', [session.id]);
    await database.query("UPDATE agent_runs SET status = 'completed', output = $1, duration_ms = $2, completed_at = now() WHERE id = $3", [answer, Date.now() - startedAt, runId]);
  } catch (error) {
    const cancelled = controller.signal.aborted || error.code === 'RUN_CANCELLED';
    await database.query("UPDATE agent_runs SET status = $1, error_code = $2, error_message = $3, duration_ms = $4, completed_at = now() WHERE id = $5", [cancelled ? 'cancelled' : 'failed', cancelled ? 'RUN_CANCELLED' : 'RUN_FAILED', error.message, Date.now() - startedAt, runId]);
    writeSse(reply, { resultType: 'agent', msgStatus: 'FINISHED', id: crypto.randomUUID(), sessionId: session.id, msgId: streamMessageId, contents: [{ type: 0, history: true, content: cancelled ? '本轮执行已取消。' : `本轮执行失败：${error.message}` }], seq: ++sequence });
  } finally {
    legacyActiveRuns.delete(streamMessageId);
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
