import { config } from '../config.js';

function compact(value, maxLength = 1800) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function startTrace({ account, sessionId, question, plan }) {
  return {
    id: crypto.randomUUID(),
    account,
    sessionId,
    question: compact(question, 400),
    plan,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    spans: [],
  };
}

export function addSpan(trace, span) {
  const startedAt = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    kind: span.kind,
    name: span.name,
    status: span.status || 'ok',
    input: compact(span.input),
    output: compact(span.output),
    startedAt,
    endedAt: startedAt,
    durationMs: Number(span.durationMs || 0),
    attributes: span.attributes || {},
  };
  trace.spans.push(record);
  return record;
}

export async function finishTrace(store, trace, { status = 'completed', answer = '', evaluation } = {}) {
  trace.status = status;
  trace.endedAt = new Date().toISOString();
  trace.durationMs = Date.parse(trace.endedAt) - Date.parse(trace.startedAt);
  trace.answer = compact(answer, 1200);
  trace.evaluation = evaluation || null;
  await store.load();
  store.state.traces ||= [];
  store.state.traces.unshift(trace);
  store.state.traces = store.state.traces.slice(0, config.traceRetention);
  await store.save();
  return trace;
}

export async function listTraces(store, { limit = 30, sessionId } = {}) {
  await store.load();
  const traces = store.state.traces || [];
  return traces
    .filter((item) => !sessionId || item.sessionId === sessionId)
    .slice(0, Math.min(Number(limit) || 30, 100));
}
