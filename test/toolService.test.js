import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTool, parseNumberExpression } from '../src/services/toolService.js';
import { formatImageSearchAnswer, normalizeSearxngResults } from '../src/services/webSearchService.js';

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

test('联网与沙盒只能通过已注册工具进入计划', () => {
  assert.deepEqual(chooseTool('联网搜索 OpenAI Responses API')[0], {
    name: 'web_search', args: { query: 'OpenAI Responses API', limit: 5 },
  });
  assert.deepEqual(chooseTool('联网搜个猫的图片')[0], {
    name: 'image_search', args: { query: '猫的图片', limit: 4 },
  });
  assert.deepEqual(chooseTool('沙盒运行 JavaScript：(19 + 23) * 2')[0], {
    name: 'sandbox_javascript', args: { code: '(19 + 23) * 2', input: {} },
  });
});

test('搜索结果会清理危险 URL，并把图片结果渲染为来源链接与预览', () => {
  const results = normalizeSearxngResults({ results: [
    { title: '有效', img_src: 'https://image.example/cat.png', url: 'https://source.example/cat', engine: 'demo' },
    { title: '无效', img_src: 'javascript:alert(1)', url: 'https://source.example/unsafe' },
  ] }, 'image', 4);
  assert.equal(results.length, 1);
  const answer = formatImageSearchAnswer({ query: '猫', results });
  assert.match(answer, /\[有效\]\(https:\/\/source\.example\/cat\)/);
  assert.match(answer, /!\[有效\]\(https:\/\/image\.example\/cat\.png\)/);
});
