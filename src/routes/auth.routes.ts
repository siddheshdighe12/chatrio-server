import type { FastifyInstance } from 'fastify';
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  getMeHandler,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', registerHandler);
  app.post('/login', loginHandler);
  app.post('/refresh', refreshHandler);

  // Authenticated endpoints
  app.post('/logout', { preHandler: [authenticate] }, logoutHandler);
  app.get('/me', { preHandler: [authenticate] }, getMeHandler);
}
