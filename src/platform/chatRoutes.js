import { z } from 'zod';
import { runAgent } from '../services/agentService.js';
import { embed } from '../services/modelClient.js';
import { requirePermission } from './identity.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().max(120).optional(),
});
const createSessionSchema = z.object({ agentId: z.string().uuid() });
const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  status: z.enum(['active', 'archived', 'deleted']).optional(),
}).refine((value) => Object.keys(value).length > 0, '至少提交一个更新字段');
const createRunSchema = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  input: z.string().trim().min(1).max(20_000),
  skillNames: z.array(z.string().max(80)).max(8).default([]),
});
const feedbackSchema = z.object({ messageId: z.string().uuid(), rating: z.enum(['like', 'dislike']), reason: z.string().trim().max(500).optional() });
const favoriteSchema = z.object({ sessionId: z.string().uuid() });
const runIdSchema = z.object({ id: z.string().uuid() });
const createAgentSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]{3,64}$/),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  systemPrompt: z.string().trim().min(10).max(10_000),
  maxSteps: z.number().int().min(1).max(20).default(4),
  toolPolicy: z.record(z.unknown()).default({}),
});

function ok(data) {
  return { code: 200, status: true, data };
}

function parse(schema, value, reply) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  reply.code(422).send({ code: 422, status: false, message: '请求参数不合法', errors: parsed.error.flatten() });
  return null;
}
function parseId(value, reply) {
  return parse(runIdSchema, { id: value }, reply)?.id;
}

async function audit(database, actorId, action, targetType, targetId, metadata = {}) {
  await database.query(
    'INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, targetType, targetId, JSON.stringify(metadata)],
  );
}

async function getOwnedSession(database, sessionId, userId) {
  const result = await database.query(`
    SELECT id, user_id AS "userId", agent_id AS "agentId", title, pinned, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM agent_sessions WHERE id = $1 AND user_id = $2
  `, [sessionId, userId]);
  return result.rows[0] || null;
}

async function getAgent(database, agentId) {
  const result = await database.query(`
    SELECT agents.id, agents.slug, agents.name, agents.description, agents.system_prompt AS "systemPrompt",
      agents.max_steps AS "maxSteps", agents.tool_policy AS "toolPolicy", agents.enabled,
      ai_models.provider AS "modelProvider", ai_models.model_key AS "modelKey", ai_models.display_name AS "modelName"
    FROM agents LEFT JOIN ai_models ON ai_models.id = agents.model_id
    WHERE agents.id = $1 AND agents.enabled = true
  `, [agentId]);
  return result.rows[0] || null;
}

function writeSse(reply, event) {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function eventToStep(event, sequence) {
  const content = event.contents?.[0];
  if (content?.type === 12) {
    let payload = {};
    try { payload = JSON.parse(content.content); } catch { payload = { raw: content.content }; }
    return { sequence, kind: 'tool', name: payload.ToolName || 'tool', status: payload.ToolStatus === 'error' ? 'error' : 'completed', input: payload.ToolParams || {}, output: payload.ToolResult ? { result: payload.ToolResult } : {}, durationMs: null };
  }
  if (event.msgStatus === 'FINISHED') return { sequence, kind: 'answer', name: 'finish', status: 'completed', input: {}, output: { evaluation: event.evaluation || null }, durationMs: null };
  if (content?.history) return { sequence, kind: 'model', name: 'answer-chunk', status: 'completed', input: {}, output: { content: content.content }, durationMs: null };
  return { sequence, kind: 'planning', name: 'progress', status: 'completed', input: {}, output: { content: content?.content || '' }, durationMs: null };
}

function toVectorLiteral(vector) {
  return `[${vector.map((item) => Number(item).toFixed(8)).join(',')}]`;
}

async function retrieveKnowledge(database, userId, query) {
  const available = await database.query(`
    SELECT 1
    FROM knowledge_bases
    JOIN knowledge_documents ON knowledge_documents.knowledge_base_id = knowledge_bases.id
    WHERE knowledge_bases.owner_id = $1 AND knowledge_documents.status = 'ready'
    LIMIT 1
  `, [userId]);
  if (!available.rowCount) return [];

  const vector = await embed(query);
  const result = await database.query(`
    SELECT knowledge_chunks.content, knowledge_documents.file_name AS "fileName",
      CASE
        WHEN $2::vector IS NOT NULL AND knowledge_chunks.embedding IS NOT NULL
          THEN 1 - (knowledge_chunks.embedding <=> $2::vector)
        ELSE ts_rank(to_tsvector('simple', knowledge_chunks.content), plainto_tsquery('simple', $3))
      END AS score
    FROM knowledge_chunks
    JOIN knowledge_documents ON knowledge_documents.id = knowledge_chunks.document_id
    JOIN knowledge_bases ON knowledge_bases.id = knowledge_documents.knowledge_base_id
    WHERE knowledge_bases.owner_id = $1 AND knowledge_documents.status = 'ready'
    ORDER BY score DESC, knowledge_chunks.chunk_index ASC
    LIMIT 5
  `, [userId, vector ? toVectorLiteral(vector) : null, query]);
  return result.rows;
}

export async function registerChatRoutes(app, { database, store }) {
  const activeRuns = new Map();
  app.get('/api/v1/agents', { preHandler: requirePermission('agent:read') }, async () => {
    const result = await database.query(`
      SELECT agents.id, agents.slug, agents.name, agents.description, agents.max_steps AS "maxSteps",
        agents.tool_policy AS "toolPolicy", ai_models.display_name AS "modelName", ai_models.provider AS "modelProvider"
      FROM agents LEFT JOIN ai_models ON ai_models.id = agents.model_id
      WHERE agents.enabled = true ORDER BY agents.created_at ASC
    `);
    return ok(result.rows);
  });

  app.get('/api/v1/agents/:id', { preHandler: requirePermission('agent:read') }, async (request, reply) => {
    const agentId = parseId(request.params.id, reply);
    if (!agentId) return;
    const agent = await getAgent(database, agentId);
    return agent ? ok(agent) : reply.code(404).send({ code: 404, status: false, message: '智能体不存在' });
  });

  app.post('/api/v1/agents', { preHandler: requirePermission('agent:manage') }, async (request, reply) => {
    const input = parse(createAgentSchema, request.body, reply);
    if (!input) return;
    const model = await database.query('SELECT id FROM ai_models WHERE enabled = true ORDER BY created_at LIMIT 1');
    const result = await database.query(`
      INSERT INTO agents (slug, name, description, system_prompt, model_id, tool_policy, max_steps, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
    `, [input.slug, input.name, input.description, input.systemPrompt, model.rows[0]?.id || null, JSON.stringify(input.toolPolicy), input.maxSteps, request.user.sub]);
    await audit(database, request.user.sub, 'agent.create', 'agent', result.rows[0].id, { slug: input.slug });
    return reply.code(201).send(ok(await getAgent(database, result.rows[0].id)));
  });

  app.post('/api/v1/sessions', { preHandler: requirePermission('agent:run') }, async (request, reply) => {
    const input = parse(createSessionSchema, request.body, reply);
    if (!input) return;
    const agent = await getAgent(database, input.agentId);
    if (!agent) return reply.code(404).send({ code: 404, status: false, message: '智能体不存在或已禁用' });
    const result = await database.query(`
      INSERT INTO agent_sessions (user_id, agent_id) VALUES ($1, $2)
      RETURNING id, agent_id AS "agentId", title, pinned, status, created_at AS "createdAt", updated_at AS "updatedAt"
    `, [request.user.sub, agent.id]);
    return reply.code(201).send(ok(result.rows[0]));
  });

  app.get('/api/v1/sessions', { preHandler: requirePermission('agent:read') }, async (request, reply) => {
    const query = parse(listQuerySchema, request.query, reply);
    if (!query) return;
    const offset = (query.page - 1) * query.pageSize;
    const values = [request.user.sub, query.keyword ? `%${query.keyword}%` : null, query.pageSize, offset];
    const result = await database.query(`
      SELECT agent_sessions.id, agent_sessions.agent_id AS "agentId", agent_sessions.title, agent_sessions.pinned,
        agent_sessions.status, agent_sessions.updated_at AS "updatedAt", agents.name AS "agentName",
        COUNT(*) OVER() AS total
      FROM agent_sessions JOIN agents ON agents.id = agent_sessions.agent_id
      WHERE agent_sessions.user_id = $1 AND agent_sessions.status <> 'deleted'
        AND ($2::text IS NULL OR agent_sessions.title ILIKE $2)
      ORDER BY agent_sessions.pinned DESC, agent_sessions.updated_at DESC
      LIMIT $3 OFFSET $4
    `, values);
    return ok({ list: result.rows, total: Number(result.rows[0]?.total || 0), page: query.page, pageSize: query.pageSize });
  });

  app.patch('/api/v1/sessions/:id', { preHandler: requirePermission('agent:run') }, async (request, reply) => {
    const input = parse(updateSessionSchema, request.body, reply);
    if (!input) return;
    const sessionId = parseId(request.params.id, reply);
    if (!sessionId) return;
    const session = await getOwnedSession(database, sessionId, request.user.sub);
    if (!session) return reply.code(404).send({ code: 404, status: false, message: '会话不存在' });
    const updated = await database.query(`
      UPDATE agent_sessions SET
        title = COALESCE($1, title), pinned = COALESCE($2, pinned), status = COALESCE($3, status), updated_at = now()
      WHERE id = $4
      RETURNING id, agent_id AS "agentId", title, pinned, status, updated_at AS "updatedAt"
    `, [input.title ?? null, input.pinned ?? null, input.status ?? null, session.id]);
    await audit(database, request.user.sub, 'session.update', 'session', session.id, input);
    return ok(updated.rows[0]);
  });

  app.get('/api/v1/sessions/:id/messages', { preHandler: requirePermission('agent:read') }, async (request, reply) => {
    const sessionId = parseId(request.params.id, reply);
    if (!sessionId) return;
    const session = await getOwnedSession(database, sessionId, request.user.sub);
    if (!session) return reply.code(404).send({ code: 404, status: false, message: '会话不存在' });
    const result = await database.query(`
      SELECT id, role, plain_text AS "plainText", contents, model_name AS "modelName", created_at AS "createdAt"
      FROM messages WHERE session_id = $1 ORDER BY created_at ASC
    `, [session.id]);
    return ok(result.rows);
  });

  app.post('/api/v1/favorites', { preHandler: requirePermission('agent:read') }, async (request, reply) => {
    const input = parse(favoriteSchema, request.body, reply);
    if (!input) return;
    const session = await getOwnedSession(database, input.sessionId, request.user.sub);
    if (!session) return reply.code(404).send({ code: 404, status: false, message: '会话不存在' });
    await database.query('INSERT INTO session_favorites (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [session.id, request.user.sub]);
    await audit(database, request.user.sub, 'session.favorite', 'session', session.id);
    return ok({ sessionId: session.id, favorited: true });
  });

  app.delete('/api/v1/favorites/:sessionId', { preHandler: requirePermission('agent:read') }, async (request, reply) => {
    const sessionId = parseId(request.params.sessionId, reply);
    if (!sessionId) return;
    await database.query('DELETE FROM session_favorites WHERE session_id = $1 AND user_id = $2', [sessionId, request.user.sub]);
    return ok({ sessionId, favorited: false });
  });

  app.post('/api/v1/feedback', { preHandler: requirePermission('agent:read') }, async (request, reply) => {
    const input = parse(feedbackSchema, request.body, reply);
    if (!input) return;
    const message = await database.query(`
      SELECT messages.id FROM messages
      JOIN agent_sessions ON agent_sessions.id = messages.session_id
      WHERE messages.id = $1 AND agent_sessions.user_id = $2
    `, [input.messageId, request.user.sub]);
    if (!message.rowCount) return reply.code(404).send({ code: 404, status: false, message: '消息不存在' });
    const result = await database.query(`
      INSERT INTO message_feedback (message_id, user_id, rating, reason) VALUES ($1, $2, $3, $4)
      ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, reason = EXCLUDED.reason, created_at = now()
      RETURNING id, rating, reason, created_at AS "createdAt"
    `, [input.messageId, request.user.sub, input.rating, input.reason || null]);
    await audit(database, request.user.sub, 'message.feedback', 'message', input.messageId, { rating: input.rating });
    return ok(result.rows[0]);
  });

  app.post('/api/v1/chat/runs', { preHandler: requirePermission('agent:run') }, async (request, reply) => {
    const input = parse(createRunSchema, request.body, reply);
    if (!input) return;
    const agent = await getAgent(database, input.agentId);
    if (!agent) return reply.code(404).send({ code: 404, status: false, message: '智能体不存在或已禁用' });
    let session = input.sessionId ? await getOwnedSession(database, input.sessionId, request.user.sub) : null;
    if (input.sessionId && !session) return reply.code(404).send({ code: 404, status: false, message: '会话不存在' });
    if (!session) {
      const created = await database.query(`
        INSERT INTO agent_sessions (user_id, agent_id, title) VALUES ($1, $2, $3)
        RETURNING id, agent_id AS "agentId", title, pinned, status
      `, [request.user.sub, agent.id, input.input.slice(0, 50)]);
      session = created.rows[0];
    }
    await database.query('INSERT INTO messages (session_id, role, plain_text) VALUES ($1, $2, $3)', [session.id, 'user', input.input]);
    const createdRun = await database.query(`
      INSERT INTO agent_runs (session_id, user_id, agent_id, input, status, model_provider, model_name, started_at)
      VALUES ($1, $2, $3, $4, 'running', $5, $6, now()) RETURNING id
    `, [session.id, request.user.sub, agent.id, input.input, agent.modelProvider, agent.modelKey]);
    const runId = createdRun.rows[0].id;
    let knowledgeContext = [];
    try {
      knowledgeContext = await retrieveKnowledge(database, request.user.sub, input.input);
    } catch (error) {
      request.log.warn({ err: error, runId }, '知识库检索失败，继续执行 Agent');
    }
    const controller = new AbortController();
    activeRuns.set(runId, { controller, userId: request.user.sub });

    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
    let answer = '';
    let sequence = 0;
    const startedAt = Date.now();
    try {
      if (knowledgeContext.length) {
        const retrievalStep = {
          sequence: ++sequence,
          kind: 'tool',
          name: 'platform_knowledge_retrieval',
          status: 'completed',
          input: { query: input.input },
          output: { count: knowledgeContext.length, files: knowledgeContext.map((item) => item.fileName) },
          durationMs: null,
        };
        await database.query(`
          INSERT INTO agent_run_steps (run_id, sequence, kind, name, status, input, output, duration_ms)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [runId, retrievalStep.sequence, retrievalStep.kind, retrievalStep.name, retrievalStep.status, JSON.stringify(retrievalStep.input), JSON.stringify(retrievalStep.output), retrievalStep.durationMs]);
        writeSse(reply, {
          resultType: 'agent',
          msgStatus: 'GENERATING',
          platformRunId: runId,
          sessionId: session.id,
          seq: sequence,
          contents: [{ type: 0, history: false, content: `已从用户知识库检索到 ${knowledgeContext.length} 段相关内容。` }],
        });
      }
      for await (const event of runAgent({ store, account: request.user.sub, question: input.input, skillNames: input.skillNames, sessionId: session.id, signal: controller.signal, knowledgeContext })) {
        const content = event.contents?.[0];
        if (content?.type === 0 && content.history) answer += content.content;
        const step = eventToStep(event, ++sequence);
        await database.query(`
          INSERT INTO agent_run_steps (run_id, sequence, kind, name, status, input, output, duration_ms)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [runId, step.sequence, step.kind, step.name, step.status, JSON.stringify(step.input), JSON.stringify(step.output), step.durationMs]);
        writeSse(reply, { ...event, platformRunId: runId, sessionId: session.id, seq: sequence });
      }
      if (controller.signal.aborted) throw Object.assign(new Error('执行已取消'), { code: 'RUN_CANCELLED' });
      await database.query("INSERT INTO messages (session_id, role, plain_text, model_name) VALUES ($1, 'assistant', $2, $3)", [session.id, answer, agent.modelKey]);
      await database.query('UPDATE agent_sessions SET updated_at = now() WHERE id = $1', [session.id]);
      await database.query(
        "UPDATE agent_runs SET status = 'completed', output = $1, duration_ms = $2, completed_at = now() WHERE id = $3",
        [answer, Date.now() - startedAt, runId],
      );
      await audit(database, request.user.sub, 'agent.run.complete', 'run', runId, { agentId: agent.id, sessionId: session.id });
    } catch (error) {
      const cancelled = controller.signal.aborted || error.code === 'RUN_CANCELLED';
      await database.query(`UPDATE agent_runs SET status = $1, error_code = $2, error_message = $3, duration_ms = $4, completed_at = now() WHERE id = $5`, [cancelled ? 'cancelled' : 'failed', cancelled ? 'RUN_CANCELLED' : 'RUN_FAILED', error.message, Date.now() - startedAt, runId]);
      writeSse(reply, { resultType: 'agent', msgStatus: 'FINISHED', platformRunId: runId, sessionId: session.id, contents: [{ type: 0, history: true, content: cancelled ? '本轮执行已取消。' : `本轮执行失败：${error.message}` }] });
    } finally {
      activeRuns.delete(runId);
    }
    reply.raw.end();
    return undefined;
  });

  app.post('/api/v1/chat/runs/:id/cancel', { preHandler: requirePermission('agent:run') }, async (request, reply) => {
    const runId = parseId(request.params.id, reply);
    if (!runId) return;
    const run = await database.query('SELECT status FROM agent_runs WHERE id = $1 AND user_id = $2', [runId, request.user.sub]);
    if (!run.rowCount) return reply.code(404).send({ code: 404, status: false, message: '运行记录不存在' });
    if (!['queued', 'running'].includes(run.rows[0].status)) return ok({ id: runId, cancelled: false, status: run.rows[0].status });
    const active = activeRuns.get(runId);
    active?.controller.abort(new Error('用户取消执行'));
    await database.query("UPDATE agent_runs SET status = 'cancelled', error_code = 'RUN_CANCELLED', error_message = '用户取消执行', completed_at = now() WHERE id = $1 AND status IN ('queued', 'running')", [runId]);
    await audit(database, request.user.sub, 'agent.run.cancel', 'run', runId);
    return ok({ id: runId, cancelled: true, status: 'cancelled' });
  });
}
