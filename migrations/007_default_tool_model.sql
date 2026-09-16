-- 默认 Agent 使用本机具备工具调用能力的模型；普通聊天模型仍可在 ai_models 中单独配置。
INSERT INTO ai_models (provider, model_key, display_name, capabilities)
VALUES ('ollama', 'local-qwen35b-tools:latest', '本地 Qwen 35B Tool 模型', '["chat", "tool-calling"]'::jsonb)
ON CONFLICT (provider, model_key) DO UPDATE SET capabilities = EXCLUDED.capabilities, enabled = true;

UPDATE agents
SET model_id = (SELECT id FROM ai_models WHERE provider = 'ollama' AND model_key = 'local-qwen35b-tools:latest'), updated_at = now()
WHERE slug = 'agent-workbench';
