import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/services/agentService.js';

test('已取消的 Agent Run 不会开始执行', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(async () => {
    for await (const _event of runAgent({
      store: {},
      account: 'test-user',
      question: '计算 1 + 1',
      sessionId: 'test-session',
      signal: controller.signal,
    })) {
      // 已取消时不应产出事件。
    }
  }, /执行已取消/);
});
