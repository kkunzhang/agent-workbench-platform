import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import { embed } from '../services/modelClient.js';
import { listMcpTools } from '../services/mcpClient.js';
import { runEvalSuite } from '../services/evalSuiteService.js';
import { requirePermission } from './identity.js';

const listQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
const idSchema = z.object({ id: z.string().uuid() });
const knowledgeSearchSchema = z.object({ query: z.string().trim().min(1).max(2_000), limit: z.coerce.number().int().min(1).max(20).default(5) });
const memorySchema = z.object({ content: z.string().trim().min(2).max(4_000), expiresAt: z.string().datetime().optional() });
const knowledgeBaseSchema = z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).default('') });
const documentSchema = z.object({ fileName: z.string().trim().min(1).max(255), content: z.string().trim().min(1).max(500_000), mimeType: z.string().trim().max(120).optional() });
const mcpServerSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9-]{3,64}$/),
  transport: z.enum(['stdio', 'sse', 'streamable-http']),
  config: z.object({ command: z.string().trim().max(300).optional(), args: z.array(z.string().max(300)).max(30).optional(), url: z.string().url().max(1000).optional(), env: z.record(z.string().max(500)).optional() }),
});

function ok(data) { return { code: 200, status: true, data }; }
function parse(schema, value, reply) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  reply.code(422).send({ code: 422, status: false, message: '请求参数不合法', errors: parsed.error.flatten() });
  return null;
}
function parseId(value, reply) { return parse(idSchema, { id: value }, reply)?.id; }
function toVectorLiteral(vector) { return `[${vector.map((item) => Number(item).toFixed(8)).join(',')}]`; }
function splitContent(content, size = 800, overlap = 100) {
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(content.length, start + size);
    chunks.push(content.slice(start, end));
    if (end === content.length) break;
    start = end - overlap;
  }
  return chunks;
}
function encryptionKey(secret) { return createHash('sha256').update(secret).digest(); }
function encryptConfig(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: encrypted.toString('base64url') };
}
function decryptConfig(value, secret) {
  if (!value?.ciphertext || !value?.iv || !value?.tag) return value || {};
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(value.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}
function redactConfig(config) {
  return { hasCommand: Boolean(config?.command), argsCount: Array.isArray(config?.args) ? config.args.length : 0, url: config?.url || null, hasEnvironment: Boolean(config?.env && Object.keys(config.env).length) };
}
async function getOwnedKnowledgeBase(database, id, userId) {
  const result = await database.query('SELECT id, name, description, created_at AS "createdAt", updated_at AS "updatedAt" FROM knowledge_bases WHERE id = $1 AND owner_id = $2', [id, userId]);
  return result.rows[0] || null;
}

export async function registerRuntimeRoutes(app, { database, config }) {
  app.get('/api/v1/traces', { preHandler: requirePermission('trace:read') }, async (request, reply) => {
    const query = parse(listQuerySchema, request.query, reply);
    if (!query) return;
    const offset = (query.page - 1) * query.pageSize;
    const result = await database.query(`
      SELECT id, session_id AS "sessionId", agent_id AS "agentId", input, status, model_provider AS "modelProvider",
        model_name AS "modelName", duration_ms AS "durationMs", created_at AS "createdAt", completed_at AS "completedAt", COUNT(*) OVER() AS total
      FROM agent_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3
    `, [request.user.sub, query.pageSize, offset]);
    return ok({ list: result.rows, total: Number(result.rows[0]?.total || 0), page: query.page, pageSize: query.pageSize });
  });

  app.get('/api/v1/traces/:id', { preHandler: requirePermission('trace:read') }, async (request, reply) => {
    const runId = parseId(request.params.id, reply);
    if (!runId) return;
    const run = await database.query(`
      SELECT id, session_id AS "sessionId", agent_id AS "agentId", input, output, status, plan, model_provider AS "modelProvider",
        model_name AS "modelName", input_tokens AS "inputTokens", output_tokens AS "outputTokens", duration_ms AS "durationMs",
        error_code AS "errorCode", error_message AS "errorMessage", created_at AS "createdAt", completed_at AS "completedAt"
      FROM agent_runs WHERE id = $1 AND user_id = $2
    `, [runId, request.user.sub]);
    if (!run.rowCount) return reply.code(404).send({ code: 404, status: false, message: 'Trace 不存在' });
    const steps = await database.query(`
      SELECT sequence, kind, name, status, input, output, duration_ms AS "durationMs", created_at AS "createdAt"
      FROM agent_run_steps WHERE run_id = $1 ORDER BY sequence
    `, [runId]);
    return ok({ ...run.rows[0], steps: steps.rows });
  });

  app.get('/api/v1/memories', { preHandler: requirePermission('agent:read') }, async (request) => {
    const result = await database.query(`
      SELECT id, content, source, expires_at AS "expiresAt", created_at AS "createdAt"
      FROM user_memories WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 200
    `, [request.user.sub]);
    return ok(result.rows);
  });

  app.post('/api/v1/memories', { preHandler: requirePermission('agent:run') }, async (request, reply) => {
    const input = parse(memorySchema, request.body, reply);
    if (!input) return;
    const vector = await embed(input.content);
    const result = await database.query(`
      INSERT INTO user_memories (user_id, content, embedding, expires_at)
      VALUES ($1, $2, $3::vector, $4)
      RETURNING id, content, source, expires_at AS "expiresAt", created_at AS "createdAt"
    `, [request.user.sub, input.content, vector ? toVectorLiteral(vector) : null, input.expiresAt || null]);
    return reply.code(201).send(ok(result.rows[0]));
  });

  app.delete('/api/v1/memories/:id', { preHandler: requirePermission('agent:run') }, async (request, reply) => {
    const id = parseId(request.params.id, reply);
    if (!id) return;
    await database.query('DELETE FROM user_memories WHERE id = $1 AND user_id = $2', [id, request.user.sub]);
    return ok({ id, deleted: true });
  });

  app.get('/api/v1/knowledge-bases', { preHandler: requirePermission('agent:read') }, async (request) => {
    const result = await database.query(`
      SELECT knowledge_bases.id, knowledge_bases.name, knowledge_bases.description, knowledge_bases.created_at AS "createdAt",
        knowledge_bases.updated_at AS "updatedAt", COUNT(knowledge_documents.id)::int AS "documentCount"
      FROM knowledge_bases LEFT JOIN knowledge_documents ON knowledge_documents.knowledge_base_id = knowledge_bases.id
      WHERE knowledge_bases.owner_id = $1 GROUP BY knowledge_bases.id ORDER BY knowledge_bases.updated_at DESC
    `, [request.user.sub]);
    return ok(result.rows);
  });

  app.post('/api/v1/knowledge-bases', { preHandler: requirePermission('knowledge:manage') }, async (request, reply) => {
    const input = parse(knowledgeBaseSchema, request.body, reply);
    if (!input) return;
    const result = await database.query(`
      INSERT INTO knowledge_bases (owner_id, name, description) VALUES ($1, $2, $3)
      RETURNING id, name, description, created_at AS "createdAt", updated_at AS "updatedAt"
    `, [request.user.sub, input.name, input.description]);
    return reply.code(201).send(ok(result.rows[0]));
  });

  app.get('/api/v1/knowledge-bases/:id/documents', { preHandler: requirePermission('agent:read') }, async (request, reply) => {
    const knowledgeBaseId = parseId(request.params.id, reply);
    if (!knowledgeBaseId) return;
    const knowledgeBase = await getOwnedKnowledgeBase(database, knowledgeBaseId, request.user.sub);
    if (!knowledgeBase) return reply.code(404).send({ code: 404, status: false, message: '知识库不存在' });
    const documents = await database.query(`
      SELECT id, file_name AS "fileName", mime_type AS "mimeType", status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM knowledge_documents WHERE knowledge_base_id = $1 ORDER BY created_at DESC
    `, [knowledgeBase.id]);
    return ok(documents.rows);
  });

  app.post('/api/v1/knowledge-bases/:id/documents/text', { preHandler: requirePermission('knowledge:manage') }, async (request, reply) => {
    const input = parse(documentSchema, request.body, reply);
    if (!input) return;
    const knowledgeBaseId = parseId(request.params.id, reply);
    if (!knowledgeBaseId) return;
    const knowledgeBase = await getOwnedKnowledgeBase(database, knowledgeBaseId, request.user.sub);
    if (!knowledgeBase) return reply.code(404).send({ code: 404, status: false, message: '知识库不存在' });
    const document = await database.query(`
      INSERT INTO knowledge_documents (knowledge_base_id, file_name, mime_type, content, status)
      VALUES ($1, $2, $3, $4, 'processing') RETURNING id
    `, [knowledgeBase.id, input.fileName, input.mimeType || 'text/plain', input.content]);
    const chunks = splitContent(input.content);
    for (let index = 0; index < chunks.length; index += 1) {
      const vector = await embed(chunks[index]);
      await database.query(`
        INSERT INTO knowledge_chunks (document_id, chunk_index, content, embedding, metadata)
        VALUES ($1, $2, $3, $4::vector, $5)
      `, [document.rows[0].id, index, chunks[index], vector ? toVectorLiteral(vector) : null, JSON.stringify({ charLength: chunks[index].length })]);
    }
    const updated = await database.query(`
      UPDATE knowledge_documents SET status = 'ready', updated_at = now() WHERE id = $1
      RETURNING id, file_name AS "fileName", status, created_at AS "createdAt"
    `, [document.rows[0].id]);
    return reply.code(201).send(ok({ ...updated.rows[0], chunkCount: chunks.length }));
  });

  app.get('/api/v1/knowledge-bases/:id/search', { preHandler: requirePermission('agent:read') }, async (request, reply) => {
    const knowledgeBaseId = parseId(request.params.id, reply);
    if (!knowledgeBaseId) return;
    const input = parse(knowledgeSearchSchema, request.query, reply);
    if (!input) return;
    const knowledgeBase = await getOwnedKnowledgeBase(database, knowledgeBaseId, request.user.sub);
    if (!knowledgeBase) return reply.code(404).send({ code: 404, status: false, message: '知识库不存在' });
    const vector = await embed(input.query);
    const vectorLiteral = vector ? toVectorLiteral(vector) : null;
    const result = await database.query(`
      SELECT knowledge_chunks.id, knowledge_chunks.chunk_index AS "chunkIndex", knowledge_chunks.content,
        knowledge_documents.id AS "documentId", knowledge_documents.file_name AS "fileName",
        CASE
          WHEN $2::vector IS NOT NULL AND knowledge_chunks.embedding IS NOT NULL
            THEN 1 - (knowledge_chunks.embedding <=> $2::vector)
          ELSE ts_rank(to_tsvector('simple', knowledge_chunks.content), plainto_tsquery('simple', $3))
        END AS score
      FROM knowledge_chunks
      JOIN knowledge_documents ON knowledge_documents.id = knowledge_chunks.document_id
      WHERE knowledge_documents.knowledge_base_id = $1
      ORDER BY score DESC, knowledge_chunks.chunk_index ASC
      LIMIT $4
    `, [knowledgeBase.id, vectorLiteral, input.query, input.limit]);
    return ok({ query: input.query, retrieval: vector ? 'vector' : 'full-text', chunks: result.rows });
  });

  app.get('/api/v1/mcp/servers', { preHandler: requirePermission('mcp:manage') }, async () => {
    const result = await database.query(`
      SELECT id, name, transport, config, enabled, status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM mcp_servers ORDER BY created_at DESC
    `);
    return ok(result.rows.map((item) => ({ ...item, config: redactConfig(decryptConfig(item.config, config.jwtSecret)) })));
  });

  app.post('/api/v1/mcp/servers', { preHandler: requirePermission('mcp:manage') }, async (request, reply) => {
    const input = parse(mcpServerSchema, request.body, reply);
    if (!input) return;
    if (input.transport === 'stdio' && !input.config.command) return reply.code(422).send({ code: 422, status: false, message: 'stdio MCP Server 必须提供 command' });
    if (input.transport !== 'stdio' && !input.config.url) return reply.code(422).send({ code: 422, status: false, message: 'HTTP MCP Server 必须提供 url' });
    const result = await database.query(`
      INSERT INTO mcp_servers (owner_id, name, transport, config, status) VALUES ($1, $2, $3, $4, 'unknown')
      RETURNING id, name, transport, enabled, status, created_at AS "createdAt"
    `, [request.user.sub, input.name, input.transport, JSON.stringify(encryptConfig(input.config, config.jwtSecret))]);
    return reply.code(201).send(ok(result.rows[0]));
  });

  app.get('/api/v1/mcp/demo/tools', { preHandler: requirePermission('agent:read') }, async () => ok(await listMcpTools()));

  app.get('/api/v1/evaluations/cases', { preHandler: requirePermission('trace:read') }, async () => {
    const result = await database.query('SELECT id, name, input, expected, enabled, created_at AS "createdAt" FROM evaluation_cases ORDER BY name');
    return ok(result.rows);
  });

  app.post('/api/v1/evaluations/runs', { preHandler: requirePermission('trace:read') }, async (request, reply) => {
    const started = await database.query(`INSERT INTO evaluation_runs (initiated_by, status) VALUES ($1, 'running') RETURNING id`, [request.user.sub]);
    const legacyRun = await runEvalSuite();
    const evaluationRunId = started.rows[0].id;
    for (const result of legacyRun.results) {
      const testCase = await database.query('SELECT id FROM evaluation_cases WHERE name = $1', [result.name]);
      await database.query(`
        INSERT INTO evaluation_results (evaluation_run_id, evaluation_case_id, status, actual, duration_ms)
        VALUES ($1, $2, $3, $4, $5)
      `, [evaluationRunId, testCase.rows[0]?.id || null, result.passed ? 'passed' : 'failed', JSON.stringify(result), result.evaluation.durationMs]);
    }
    await database.query(`
      UPDATE evaluation_runs SET status = 'completed', summary = $1, completed_at = now() WHERE id = $2
    `, [JSON.stringify(legacyRun.summary), evaluationRunId]);
    return reply.code(201).send(ok({ id: evaluationRunId, ...legacyRun }));
  });

  app.get('/api/v1/metrics', { preHandler: requirePermission('trace:read') }, async (request) => {
    const metrics = await database.query(`
      SELECT
        COUNT(*)::int AS "runCount",
        COUNT(*) FILTER (WHERE status = 'completed')::int AS "completedRunCount",
        COALESCE(ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int, 0) AS "averageDurationMs",
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0)::int AS "p95DurationMs"
      FROM agent_runs WHERE user_id = $1
    `, [request.user.sub]);
    return ok(metrics.rows[0]);
  });
}
