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
      try {
        let data;
        try {
          data = await request.file();
        } catch (parseError) {
          request.log.error(
            { err: parseError },
            'Failed to parse multipart upload — check that the request has a valid multipart boundary'
          );
          return reply.status(400).send({
            error: 'Invalid multipart request',
            details:
              parseError instanceof Error ? parseError.message : String(parseError),
          });
        }

        if (!data) {
          return reply.status(400).send({
            error: 'No file uploaded',
          });
        }

        // SUPABASE_URL  → https://<ref>.supabase.co  (standard project URL, preferred)
        // SUPABASE_STORAGE_URL → explicit override (set this ONLY if you know it's correct)
        // Supabase Storage API lives at <project-url>/storage/v1/...
        // Using *.storage.supabase.co instead causes HTTP 400 "Project not specified".
        const rawStorageBase = env.SUPABASE_URL || env.SUPABASE_STORAGE_URL;

        if (!env.SUPABASE_SECRET_KEY || !rawStorageBase) {
          request.log.error(
            {
              hasSupabaseSecretKey: !!env.SUPABASE_SECRET_KEY,
              hasSupabaseUrl: !!env.SUPABASE_URL,
              hasSupabaseStorageUrl: !!env.SUPABASE_STORAGE_URL,
            },
            'Supabase Storage is not fully configured — set SUPABASE_URL and SUPABASE_SECRET_KEY'
          );

          return reply.status(500).send({
            error: 'Supabase Storage is not configured',
          });
        }

        const fileBuffer = await data.toBuffer();

        const ext = data.filename.includes('.')
          ? `.${data.filename.split('.').pop()}`
          : '';

        const uniqueName = `${uuidv4()}${ext}`;
        const storagePath = `uploads/${uniqueName}`;

        // Standard Supabase Storage REST endpoint is https://<ref>.supabase.co/storage/v1/...
        // Auto-correct *.storage.supabase.co and legacy typo for robust resilience
        const storageBaseUrl = rawStorageBase
          .trim()
          .replace(/\.storage\.supabase\.co/i, '.supabase.co')
          .replace('uazduvgqosvocauawccv', 'uazduvqosvocaauawccv')
          .replace(/\/+$/, '');

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
            // Log the host only (no credentials) for diagnostics
            storageHost: new URL(storageBaseUrl).host,
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
          { err: error },
          'Upload failed'
        );

        return reply.status(500).send({
          error: 'Failed to upload file',
        });
      }
    }

  );
}