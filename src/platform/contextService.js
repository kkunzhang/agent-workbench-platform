import { embed } from '../services/modelClient.js';

export function toVectorLiteral(vector) {
  return `[${vector.map((item) => Number(item).toFixed(8)).join(',')}]`;
}

export async function retrieveKnowledge(database, userId, query) {
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

export async function retrieveMemories(database, userId, query) {
  const vector = await embed(query);
  const result = await database.query(`
    SELECT content, source, created_at AS "createdAt",
      CASE WHEN $2::vector IS NOT NULL AND embedding IS NOT NULL
        THEN 1 - (embedding <=> $2::vector)
        ELSE ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', $3))
      END AS score
    FROM user_memories
    WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())
    ORDER BY score DESC, created_at DESC
    LIMIT 3
  `, [userId, vector ? toVectorLiteral(vector) : null, query]);
  return result.rows.filter((item) => Number(item.score) > 0);
}

export async function persistMemory(database, userId, content) {
  const vector = await embed(content);
  await database.query(
    'INSERT INTO user_memories (user_id, content, embedding) VALUES ($1, $2, $3::vector)',
    [userId, content, vector ? toVectorLiteral(vector) : null],
  );
}
