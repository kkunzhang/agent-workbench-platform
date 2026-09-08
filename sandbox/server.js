import http from 'node:http';
import vm from 'node:vm';

const port = 8790;
const token = process.env.SANDBOX_RUNNER_TOKEN;
const maxCodeBytes = Number(process.env.SANDBOX_MAX_CODE_BYTES || 6000);
const maxInputBytes = Number(process.env.SANDBOX_MAX_INPUT_BYTES || 65536);
const executionTimeoutMs = Number(process.env.SANDBOX_EXECUTION_TIMEOUT_MS || 1000);

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function safeValue(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  if (Buffer.byteLength(encoded) > maxInputBytes) throw new Error('输出不能超过 64KB');
  return JSON.parse(encoded);
}

function execute({ code, input }) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('code 必须是非空 JavaScript');
  if (Buffer.byteLength(code) > maxCodeBytes) throw new Error(`代码不能超过 ${maxCodeBytes} 字节`);
  if (Buffer.byteLength(JSON.stringify(input ?? {})) > maxInputBytes) throw new Error('input 不能超过 64KB');
  const sandbox = Object.create(null);
  Object.assign(sandbox, {
    input: safeValue(input ?? {}),
    Math, JSON, Array, Object, String, Number, Boolean, RegExp,
    parseInt, parseFloat, isFinite,
  });
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const value = new vm.Script(`'use strict';\n(${code})`, { filename: 'user-expression.js' }).runInContext(context, { timeout: executionTimeoutMs, breakOnSigint: true });
  return safeValue(value);
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true, isolation: 'container+vm', network: 'disabled' });
  if (request.method !== 'POST' || request.url !== '/run') return json(response, 404, { message: 'not found' });
  if (!token || request.headers['x-sandbox-token'] !== token) return json(response, 401, { message: 'unauthorized' });
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxCodeBytes + maxInputBytes + 2048) request.destroy();
  });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw || '{}');
      if (body.language !== 'javascript') throw new Error('当前仅支持 javascript');
      const startedAt = Date.now();
      const result = execute(body);
      json(response, 200, { ok: true, result, durationMs: Date.now() - startedAt });
    } catch (error) {
      json(response, 422, { ok: false, message: error.message });
    }
  });
});

server.listen(port, '0.0.0.0');
