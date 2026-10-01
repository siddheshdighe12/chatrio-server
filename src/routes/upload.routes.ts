import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
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

      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
        return reply.status(500).send({
          error: 'Supabase Storage is not configured',
        });
      }

      try {
        const supabase = createClient(
          env.SUPABASE_URL,
          env.SUPABASE_SECRET_KEY,
          {
            auth: {
              persistSession: false,
              autoRefreshToken: false,
            },
          }
        );

        const ext = data.filename.includes('.')
          ? `.${data.filename.split('.').pop()}`
          : '';

        const uniqueName = `${uuidv4()}${ext}`;
        const storagePath = `uploads/${uniqueName}`;

        const fileBuffer = await data.toBuffer();

        const { error } = await supabase.storage
          .from(env.SUPABASE_STORAGE_BUCKET)
          .upload(storagePath, fileBuffer, {
            contentType: data.mimetype,
            cacheControl: '31536000',
            upsert: false,
          });

        if (error) {
          request.log.error(error, 'Supabase Storage upload failed');

          return reply.status(500).send({
            error: 'Failed to upload file',
          });
        }

        const { data: publicUrlData } = supabase.storage
          .from(env.SUPABASE_STORAGE_BUCKET)
          .getPublicUrl(storagePath);

        const isImage = data.mimetype.startsWith('image/');
        const fileType = isImage ? 'IMAGE' : 'FILE';

        return reply.status(201).send({
          url: publicUrlData.publicUrl,
          fileName: data.filename,
          mimeType: data.mimetype,
          size: fileBuffer.length,
          type: fileType,
        });
      } catch (error) {
        request.log.error(error, 'Upload failed');

        return reply.status(500).send({
          error: 'Failed to upload file',
        });
      }
    }
  );
}