import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function readText(result) {
  return (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function transportFor(server) {
  const source = server.config || {};
  if (server.transport === 'stdio') return new StdioClientTransport({ command: source.command, args: source.args || [], env: source.env, stderr: 'pipe' });
  if (server.transport === 'sse') return new SSEClientTransport(new URL(source.url));
  if (server.transport === 'streamable-http') return new StreamableHTTPClientTransport(new URL(source.url));
  throw new Error(`不支持的 MCP transport：${server.transport}`);
}

export async function withMcpClient(server, operation) {
  const client = new Client({ name: 'agent-workbench-client', version: '0.3.0' });
  const transport = transportFor(server);
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listMcpTools(server) {
  if (!server) return [];
  return withMcpClient(server, async (client) => (await client.listTools()).tools || []);
}

export async function callMcpTool({ server, toolName, args }) {
  return withMcpClient(server, async (client) => {
    const result = await client.callTool({ name: toolName, arguments: args || {} });
    if (result.isError) throw new Error(readText(result) || `MCP 工具 ${toolName} 执行失败`);
    return readText(result);
  });
}

export async function closeMcpClient() {
  // 动态 MCP 请求作用域内建连与关闭，无全局 demo 子进程。
}
