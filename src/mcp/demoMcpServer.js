import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'agent-workbench-mcp', version: '0.1.0' });

server.tool('echo', { text: z.string().describe('要回显的文本') }, async ({ text }) => ({
  content: [{ type: 'text', text: `MCP echo: ${text}` }],
}));

server.tool('add', { left: z.number(), right: z.number() }, async ({ left, right }) => ({
  content: [{ type: 'text', text: String(left + right) }],
}));

await server.connect(new StdioServerTransport());
