-- Redis 保存短暂的执行事件和取消标记；PostgreSQL 保存可恢复的最终状态。
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'));

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS retry_of UUID REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_agent_runs_retry_of ON agent_runs(retry_of);
