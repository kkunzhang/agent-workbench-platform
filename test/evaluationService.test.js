import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRun, summarizeEvaluations } from '../src/services/evaluationService.js';

test('评测记录工具、步骤和延迟检查', () => {
  const evaluation = evaluateRun({
    question: '计算 1 + 1',
    answer: '2',
    toolCalls: [{ status: 'complete' }],
    durationMs: 12,
    trace: { spans: [{ kind: 'tool' }] },
  });
  assert.equal(evaluation.score, 1);
  assert.equal(evaluation.durationMs, 12);
  assert.equal(summarizeEvaluations([{ evaluation }]).passRate, 1);
});
