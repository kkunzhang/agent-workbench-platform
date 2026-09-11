import fs from 'node:fs/promises';
import { artifactPath, verifyArtifactLink } from '../services/presentationService.js';

export async function registerArtifactRoutes(app) {
  app.get('/api/v1/artifacts/:id/download', async (request, reply) => {
    const { id } = request.params;
    const { expires, signature } = request.query || {};
    if (!verifyArtifactLink(id, expires, signature)) return reply.code(403).send({ code: 403, status: false, message: '下载链接无效或已过期' });
    try {
      const file = await fs.readFile(artifactPath(id));
      reply.header('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      reply.header('content-disposition', `attachment; filename="presentation-${id.slice(0, 8)}.pptx"`);
      reply.header('cache-control', 'private, max-age=300');
      return reply.send(file);
    } catch (error) {
      if (error.code === 'ENOENT') return reply.code(404).send({ code: 404, status: false, message: '文件不存在或已被清理' });
      throw error;
    }
  });
}
