import { createHash, createDecipheriv } from 'node:crypto';
import { listMcpTools } from './mcpClient.js';

function key(secret) { return createHash('sha256').update(secret).digest(); }
function decrypt(value, secret) {
  if (!value?.ciphertext) return value || {};
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(value.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

function agentToolName(serverId, toolName) {
  return `mcp_${serverId.replace(/-/g, '').slice(0, 12)}_${String(toolName).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;
}

export async function getDynamicMcpTools({ database, userId, secret, runStore }) {
  const result = await database.query(`
    SELECT id, name, transport, config FROM mcp_servers
    WHERE enabled = true AND (owner_id IS NULL OR owner_id = $1) ORDER BY created_at ASC
  `, [userId]);
  const all = [];
  for (const row of result.rows) {
    const server = { ...row, config: decrypt(row.config, secret) };
    try {
      let tools = await runStore?.getCachedMcpTools(server.id);
      if (!tools) {
        tools = await listMcpTools(server);
        await runStore?.cacheMcpTools(server.id, tools);
      }
      await database.query("UPDATE mcp_servers SET status = 'connected', updated_at = now() WHERE id = $1", [server.id]);
      all.push(...tools.map((tool) => ({
        name: agentToolName(server.id, tool.name), toolName: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || { type: 'object', properties: {} }, serverName: server.name, server,
      })));
    } catch (error) {
      await database.query("UPDATE mcp_servers SET status = 'error', updated_at = now() WHERE id = $1", [server.id]);
    }
  }
  return all;
}

export { agentToolName };
