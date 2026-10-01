import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { env } from './config/env.js';
import { registerRoutes } from './routes/index.js';

export async function buildApp() {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true },
            },
          }
        : true,
  });

  // ──────────────────────────────────────────────
  // Plugins
  // ──────────────────────────────────────────────

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 500,
    timeWindow: '1 minute',
  });

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB
    },
  });

  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
  });

  // Serve uploads statically
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
  });

  // ──────────────────────────────────────────────
  // Health check
  // ──────────────────────────────────────────────

  app.get('/health', async () => {
    return { ok: true, timestamp: new Date().toISOString(), version: '1.0.0' };
  });

  // ──────────────────────────────────────────────
  // Routes
  // ──────────────────────────────────────────────

  await registerRoutes(app);

  return app;
}
