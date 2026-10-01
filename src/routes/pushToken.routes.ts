import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authenticate } from '../middleware/auth.middleware.js';

const registerSchema = z.object({
  token: z.string().min(1).refine(
    (t) => t.startsWith('ExponentPushToken[') || t.startsWith('ExpoPushToken['),
    { message: 'Must be a valid Expo push token' }
  ),
  deviceId: z.string().min(1, 'deviceId is required'),
  platform: z.enum(['android', 'ios']).default('android'),
});

export async function pushTokenRoutes(app: FastifyInstance) {
  // Register / upsert an Expo push token for the authenticated user
  app.post(
    '/push-tokens',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.currentUser?.id;
      if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

      const result = registerSchema.safeParse(request.body);
      if (!result.success) {
        return reply.status(400).send({ error: result.error.errors[0]?.message });
      }

      const { token, deviceId, platform } = result.data;

      await prisma.pushToken.upsert({
        where: { userId_deviceId: { userId, deviceId } },
        update: { token, platform, updatedAt: new Date() },
        create: { userId, token, deviceId, platform },
      });

      return reply.status(200).send({ ok: true });
    }
  );

  // Remove push token on logout or when permission is revoked
  app.delete(
    '/push-tokens/:deviceId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.currentUser?.id;
      if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

      const { deviceId } = request.params as { deviceId: string };

      await prisma.pushToken.deleteMany({
        where: { userId, deviceId },
      });

      return reply.send({ ok: true });
    }
  );
}
