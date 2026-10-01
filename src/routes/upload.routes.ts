import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/auth.middleware.js';
import { env } from '../config/env.js';

export async function uploadRoutes(app: FastifyInstance) {
  app.post(
    '/upload',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      const uploadsDir = path.resolve(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      const ext = path.extname(data.filename) || '';
      const uniqueName = `${uuidv4()}${ext}`;
      const filePath = path.join(uploadsDir, uniqueName);

      // Stream file to disk
      await pipeline(data.file, fs.createWriteStream(filePath));

      const stats = fs.statSync(filePath);
      const isImage = data.mimetype.startsWith('image/');
      const fileType = isImage ? 'IMAGE' : 'FILE';

      // Build file URL accessible over HTTP
      const host = request.headers.host || `localhost:${env.PORT}`;
      const protocol = request.protocol || 'http';
      const fileUrl = `${protocol}://${host}/uploads/${uniqueName}`;

      return reply.status(201).send({
        url: fileUrl,
        fileName: data.filename,
        mimeType: data.mimetype,
        size: stats.size,
        type: fileType,
      });
    }
  );
}
