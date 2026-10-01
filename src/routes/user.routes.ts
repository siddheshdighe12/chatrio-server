import type { FastifyInstance } from 'fastify';
import {
  searchUsersHandler,
  getUserProfileHandler,
  updateProfileHandler,
  uploadAvatarHandler,
  deleteAvatarHandler,
  blockUserHandler,
  unblockUserHandler,
  listBlockedUsersHandler,
  reportUserHandler,
} from '../controllers/user.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/search', searchUsersHandler);
  app.get('/blocked', listBlockedUsersHandler);
  app.get('/:id', getUserProfileHandler);
  app.patch('/profile', updateProfileHandler);
  app.post('/avatar', uploadAvatarHandler);
  app.delete('/avatar', deleteAvatarHandler);
  app.post('/:id/block', blockUserHandler);
  app.delete('/:id/block', unblockUserHandler);
  app.post('/:id/report', reportUserHandler);
}
