import { createClient } from 'redis';

/**
 * Redis 保存运行中的短期状态：取消标记、最后事件和 MCP 工具清单缓存。
 * PostgreSQL 是最终事实来源，因此 Redis 短暂不可用时不会丢失已落库的 Run。
 */
export function createRunStore({ url, keyPrefix = 'agent-workbench:', logger = console, client } = {}) {
  const redis = client || createClient({ url, socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 2_000) } });
  redis.on?.('error', (error) => logger.warn?.({ err: error }, 'Redis 临时不可用'));
  const key = (name) => `${keyPrefix}${name}`;
  let ready = Boolean(client);

  async function safe(operation, fallback = null) {
    try { return await operation(); } catch (error) { logger.warn?.({ err: error }, 'Redis 操作失败，降级到 PostgreSQL'); return fallback; }
  }

  return {
    async connect() {
      if (ready || redis.isOpen) { ready = true; return true; }
      await safe(() => redis.connect(), null);
      ready = Boolean(redis.isOpen);
      return ready;
    },
    get available() { return ready && redis.isOpen !== false; },
    async begin(run) { return safe(() => redis.set(key(`run:${run.id}`), JSON.stringify(run), { EX: 3_600 })); },
    async event(runId, sequence, event) {
      return safe(async () => {
        const multi = redis.multi();
        multi.set(key(`run:${runId}:last`), JSON.stringify({ sequence, event }), { EX: 3_600 });
        multi.rPush(key(`run:${runId}:events`), JSON.stringify({ sequence, event }));
        multi.expire(key(`run:${runId}:events`), 3_600);
        await multi.exec();
      });
    },
    async finish(runId) { return safe(() => redis.del([key(`run:${runId}`), key(`run:${runId}:cancel`)])); },
    async cancel(runId) { return safe(() => redis.set(key(`run:${runId}:cancel`), '1', { EX: 3_600 })); },
    async isCancelled(runId) { return Boolean(await safe(() => redis.exists(key(`run:${runId}:cancel`)), 0)); },
    async cacheMcpTools(serverId, tools) { return safe(() => redis.set(key(`mcp:${serverId}:tools`), JSON.stringify(tools), { EX: 300 })); },
    async getCachedMcpTools(serverId) {
      const value = await safe(() => redis.get(key(`mcp:${serverId}:tools`)));
      try { return value ? JSON.parse(value) : null; } catch { return null; }
    },
    async close() { if (redis.isOpen) await redis.quit(); },
  };
}
