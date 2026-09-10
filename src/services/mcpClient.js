import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../mcp/demoMcpServer.js', import.meta.url));
let connection = null;

async function getConnection() {
  if (connection) return connection;
  const client = new Client({ name: 'agent-workbench-client', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  await client.connect(transport);
  connection = { client, transport };
  return connection;
}

function readText(result) {
  return (result.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

export async function listMcpTools() {
  const { client } = await getConnection();
  const result = await client.listTools();
  return result.tools || [];
}

export async function callMcpTool(name, args) {
  const { client } = await getConnection();
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(readText(result) || `MCP 工具 ${name} 执行失败`);
  return readText(result);
}

export async function closeMcpClient() {
  if (!connection) return;
  await connection.client.close();
  connection = null;
}
