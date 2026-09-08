import { executeTool } from './toolService.js';
import { evaluateRun } from './evaluationService.js';

const CASES = [
  { id: 'math', name: '受限计算', call: { name: 'calculate', args: { expression: '(23 + 7) * 4' } }, expected: '120' },
  { id: 'time', name: '时间工具', call: { name: 'get_current_time', args: {} }, expected: null },
  { id: 'knowledge', name: '知识检索', call: { name: 'knowledge_search', args: { query: 'Harness Engineering 如何做评测和 Trace？' } }, expected: 'Harness' },
  { id: 'mcp', name: '真实 MCP 加法调用', call: { name: 'mcp_add', args: { left: 19, right: 23 } }, expected: '42' },
];

export function listEvalCases() {
  return CASES.map(({ call, ...item }) => ({ ...item, tool: call.name }));
}

export async function runEvalSuite() {
  const results = [];
  for (const testCase of CASES) {
    const startedAt = Date.now();
    let toolCall = { ...testCase.call, id: crypto.randomUUID(), status: 'running' };
    let answer = '';
    try {
      toolCall.result = await executeTool(toolCall, { recall: async () => [] });
      toolCall.status = 'complete';
      answer = toolCall.result.output;
    } catch (error) {
      toolCall.status = 'error';
      toolCall.error = error.message;
      answer = error.message;
    }
    const expectedPassed = !testCase.expected || answer.includes(testCase.expected);
    const evaluation = evaluateRun({
      question: testCase.name,
      answer,
      toolCalls: [toolCall],
      durationMs: Date.now() - startedAt,
      trace: { spans: [{ kind: 'tool' }] },
    });
    results.push({
      id: testCase.id,
      name: testCase.name,
      expected: testCase.expected,
      actual: answer,
      passed: expectedPassed && evaluation.score === 1,
      evaluation,
    });
  }
  const run = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.passed).length,
      passRate: results.filter((item) => item.passed).length / results.length,
    },
  };
  return run;
}
