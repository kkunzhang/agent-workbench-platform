-- 旧 Vue 聊天界面的收藏接口仍使用 /api/v3/robot/collection。
-- 这些表只保存收藏关系和可追溯的消息引用，正文依旧存放在 messages。
CREATE TABLE IF NOT EXISTS legacy_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'dialog',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_collection_messages (
  collection_id UUID NOT NULL REFERENCES legacy_collections(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_legacy_collections_user_created ON legacy_collections(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_collections_session ON legacy_collections(session_id);
