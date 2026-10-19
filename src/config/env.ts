import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),

  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGINS: z.string().default('http://localhost:8081'),

  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),

  // Dedicated Storage endpoint because Render can resolve
  // the Storage hostname even when the project API hostname
  // is not resolving.
  SUPABASE_STORAGE_URL: z.string().optional(),

  SUPABASE_STORAGE_BUCKET: z.string().default('chatrio-media'),

  // Expo push notifications
  EXPO_ACCESS_TOKEN: z.string().optional(),

  // ── LiveKit (required for voice/video calling) ──────────────────────────
  // Set these in the Render environment before enabling calling features.
  // Server still starts without them; call endpoints return 503 when missing.
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_URL: z.string().optional(), // e.g. wss://your-project.livekit.cloud
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Warn at startup if LiveKit is not configured (non-fatal)
if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
  console.warn(
    '⚠️  LiveKit env vars (LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL) are not set.' +
    ' Voice/video calling will be unavailable until they are configured.'
  );
}