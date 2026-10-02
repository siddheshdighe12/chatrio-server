import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
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
        return reply.status(400).send({
          error: 'No file uploaded',
        });
      }

      if (!env.SUPABASE_SECRET_KEY || !env.SUPABASE_STORAGE_URL) {
        request.log.error(
          {
            hasSupabaseSecretKey: !!env.SUPABASE_SECRET_KEY,
            hasSupabaseStorageUrl: !!env.SUPABASE_STORAGE_URL,
          },
          'Supabase Storage is not fully configured'
        );

        return reply.status(500).send({
          error: 'Supabase Storage is not configured',
        });
      }

      try {
        const fileBuffer = await data.toBuffer();

        const ext = data.filename.includes('.')
          ? `.${data.filename.split('.').pop()}`
          : '';

        const uniqueName = `${uuidv4()}${ext}`;
        const storagePath = `uploads/${uniqueName}`;

        const storageBaseUrl = env.SUPABASE_STORAGE_URL.replace(/\/+$/, '');

        const uploadUrl =
          `${storageBaseUrl}/storage/v1/object/` +
          `${encodeURIComponent(env.SUPABASE_STORAGE_BUCKET)}/` +
          `${storagePath
            .split('/')
            .map((part) => encodeURIComponent(part))
            .join('/')}`;

        request.log.info(
          {
            storagePath,
            bucket: env.SUPABASE_STORAGE_BUCKET,
            mimeType: data.mimetype,
            size: fileBuffer.length,
          },
          'Uploading file to Supabase Storage'
        );

        const storageResponse = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
            'Content-Type': data.mimetype,
            'Cache-Control': '31536000',
          },
          body: fileBuffer,
        });

        const responseText = await storageResponse.text();

        if (!storageResponse.ok) {
          request.log.error(
            {
              status: storageResponse.status,
              statusText: storageResponse.statusText,
              response: responseText,
              uploadUrl,
            },
            'Supabase Storage upload failed'
          );

          return reply.status(500).send({
            error: 'Failed to upload file',
            details: responseText,
          });
        }

        const isImage = data.mimetype.startsWith('image/');
        const fileType = isImage ? 'IMAGE' : 'FILE';

        // Use the direct Storage hostname for the public URL.
        const publicUrl =
          `${storageBaseUrl}/storage/v1/object/public/` +
          `${encodeURIComponent(env.SUPABASE_STORAGE_BUCKET)}/` +
          `${storagePath
            .split('/')
            .map((part) => encodeURIComponent(part))
            .join('/')}`;

        request.log.info(
          {
            storagePath,
            publicUrl,
            status: storageResponse.status,
          },
          'Supabase Storage upload successful'
        );

        return reply.status(201).send({
          url: publicUrl,
          storageKey: storagePath,
          fileName: data.filename,
          mimeType: data.mimetype,
          size: fileBuffer.length,
          type: fileType,
        });
      } catch (error) {
        request.log.error(
          error,
          'Upload failed'
        );

        return reply.status(500).send({
          error: 'Failed to upload file',
        });
      }
    }
  );
}