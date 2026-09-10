-- 将已启动过展示环境的默认身份和 Agent 文案同步为个人项目品牌。
-- 不删除历史会话；旧对话内容保留，后续新回答不再使用旧项目名称。
UPDATE users
SET email = 'demo@agent-workbench.local', display_name = '个人演示账号', updated_at = now()
WHERE email = 'demo@yagent.local'
  AND NOT EXISTS (SELECT 1 FROM users WHERE email = 'demo@agent-workbench.local');

UPDATE agents
SET name = '个人 Agent 工作台',
    description = '可观察、可评测的个人 Agent 工作台',
    system_prompt = '你是“个人 Agent 工作台”的智能助手。使用中文，基于已经执行的证据回答。',
    updated_at = now()
WHERE slug = 'agent-workbench';
