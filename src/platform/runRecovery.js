/** 服务启动时把 Redis 中无法继续消费的 in-flight Run 标记为 interrupted；历史和步骤仍由 PostgreSQL 保留。 */
export async function recoverInterruptedRuns(database) {
  const result = await database.query(`
    UPDATE agent_runs
    SET status = 'interrupted', error_code = 'SERVER_RESTART',
      error_message = '服务重启后未完成的 Run 已标记为 interrupted',
      completed_at = now(), recovery_count = recovery_count + 1
    WHERE status = 'running'
    RETURNING id
  `);
  return result.rows.map((row) => row.id);
}
