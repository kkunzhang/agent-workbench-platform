CREATE TABLE IF NOT EXISTS ai_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('ollama', 'openai-compatible')),
  model_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, model_key)
);

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  model_id UUID REFERENCES ai_models(id) ON DELETE SET NULL,
  tool_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_steps INTEGER NOT NULL DEFAULT 4 CHECK (max_steps BETWEEN 1 AND 20),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  title TEXT NOT NULL DEFAULT '新对话',
  pinned BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  plain_text TEXT NOT NULL DEFAULT '',
  contents JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating TEXT NOT NULL CHECK (rating IN ('like', 'dislike')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS session_favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS agent_quota_usage (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  run_count INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, agent_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_updated ON agent_sessions(user_id, updated_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_plain_text ON messages USING gin (to_tsvector('simple', plain_text));

INSERT INTO ai_models (provider, model_key, display_name, capabilities)
VALUES ('ollama', 'qwen3.5:0.8b', '本地 Qwen 3.5 0.8B', '["chat", "embedding"]')
ON CONFLICT (provider, model_key) DO NOTHING;

INSERT INTO agents (slug, name, description, system_prompt, model_id, tool_policy, max_steps)
SELECT
  'agent-workbench',
  'Agent 工程工作台',
  '可观察、可评测的办公 Agent',
  '你是 Agent 工程工作台助手。使用中文，基于已经执行的证据回答。',
  ai_models.id,
  '{"allow": ["calculate", "knowledge_search", "memory_search", "mcp_echo", "mcp_add"], "requireConfirmation": []}'::jsonb,
  4
FROM ai_models
WHERE ai_models.provider = 'ollama' AND ai_models.model_key = 'qwen3.5:0.8b'
ON CONFLICT (slug) DO NOTHING;
