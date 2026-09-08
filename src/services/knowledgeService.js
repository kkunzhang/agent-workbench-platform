const DOCUMENTS = [
  {
    id: 'agent-loop',
    title: 'Agent Loop 设计原则',
    tags: ['agent', 'loop', 'planning', '工具'],
    content: 'Agent Loop 应包含目标拆解、工具选择、工具执行、结果观察、停止条件和最终回答。生产实现必须设置最大步骤数、超时与可观测执行轨迹。',
  },
  {
    id: 'mcp-boundary',
    title: 'MCP 与 Tool 的边界',
    tags: ['mcp', 'tool', '协议'],
    content: 'Tool 是 Agent 可调用的能力定义；MCP 是把外部能力标准化暴露给客户端的协议。Skill 是可复用的任务方法，不直接执行副作用。',
  },
  {
    id: 'harness',
    title: 'Harness Engineering 检查项',
    tags: ['harness', '评测', 'trace', '权限'],
    content: 'Harness 应覆盖输入校验、工具权限、预算、超时、重试、幂等、执行轨迹、离线评测和失败归因。它把模型的不确定性关进可验证的工程边界。',
  },
  {
    id: 'multi-agent',
    title: '多 Agent 适用场景',
    tags: ['multi-agent', 'subagent', '成本'],
    content: '多 Agent 适合独立研究、并行审阅和角色制衡；不应代替简单任务的单 Agent。需要显式控制上下文传递、并发、预算和汇总质量。',
  },
];

function score(query, document) {
  const lower = String(query).toLowerCase();
  return [document.title, document.content, ...document.tags]
    .reduce((total, text) => total + (lower.includes(String(text).toLowerCase()) ? 2 : 0), 0);
}

export function listKnowledge() {
  return DOCUMENTS.map(({ content, ...document }) => ({ ...document, preview: content.slice(0, 90) }));
}

export function searchKnowledge(query, limit = 3) {
  return DOCUMENTS
    .map((document) => ({ ...document, score: score(query, document) }))
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
