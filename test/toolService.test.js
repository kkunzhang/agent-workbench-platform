import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTool, parseNumberExpression } from '../src/services/toolService.js';

test('受限计算器支持优先级、括号和一元负号', () => {
  assert.equal(parseNumberExpression('(23 + 7) * 4'), 120);
  assert.equal(parseNumberExpression('-2 * (3 + 4)'), -14);
  assert.throws(() => parseNumberExpression('1 / 0'), /除以 0/);
  assert.throws(() => parseNumberExpression('process.exit()'), /只允许/);
});

test('规划候选工具会同时保留检索与 MCP 证据能力', () => {
  const calls = chooseTool('用 MCP 计算 19 和 23，并说明 Harness 的评测方案');
  assert.ok(calls.some((item) => item.name === 'mcp_add'));
  assert.ok(calls.some((item) => item.name === 'knowledge_search'));
});
