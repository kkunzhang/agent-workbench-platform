export function evaluateRun({ question, answer, toolCalls, durationMs, trace }) {
  const checks = [
    { name: '非空回答', passed: Boolean(answer?.trim()) },
    { name: '工具调用有结果', passed: toolCalls.every((item) => item.status === 'complete') },
    { name: '延迟预算（45 秒）', passed: durationMs <= 45_000 },
    { name: '执行步骤未超预算', passed: !trace || trace.spans.length <= 20 },
    { name: '工具执行可追溯', passed: !toolCalls.length || Boolean(trace?.spans.some((item) => item.kind === 'tool')) },
  ];
  return {
    score: checks.filter((item) => item.passed).length / checks.length,
    checks,
    durationMs,
    createdAt: new Date().toISOString(),
  };
}

export function summarizeEvaluations(evaluations = []) {
  const latest = evaluations.slice(-50);
  const total = latest.length;
  const averageScore = total
    ? latest.reduce((sum, item) => sum + Number(item.evaluation?.score || 0), 0) / total
    : 0;
  const latencyMs = latest.map((item) => item.evaluation?.durationMs).filter(Number.isFinite);
  return {
    total,
    passRate: total ? latest.filter((item) => item.evaluation?.score === 1).length / total : 0,
    averageScore,
    averageLatencyMs: latencyMs.length ? Math.round(latencyMs.reduce((sum, item) => sum + item, 0) / latencyMs.length) : 0,
  };
}
