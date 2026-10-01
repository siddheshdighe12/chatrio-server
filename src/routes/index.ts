import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.routes.js';
import { userRoutes } from './user.routes.js';
import { conversationRoutes } from './conversation.routes.js';
import { messageRoutes } from './message.routes.js';
import { uploadRoutes } from './upload.routes.js';
import { pushTokenRoutes } from './pushToken.routes.js';

export async function registerRoutes(app: FastifyInstance) {
  // Chatrio API v1 routes
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(conversationRoutes, { prefix: '/conversations' });
  await app.register(messageRoutes, { prefix: '/' });
  await app.register(uploadRoutes, { prefix: '/' });
  await app.register(pushTokenRoutes, { prefix: '/' });

  app.get('/api', async () => {
    return { name: 'Chatrio API', version: '1.0.0', status: 'operational' };
  });
}
