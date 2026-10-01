import type { FastifyInstance } from 'fastify';
import {
  listMessagesHandler,
  sendMessageHandler,
  editMessageHandler,
  deleteMessageHandler,
  reactMessageHandler,
  markReadHandler,
  getConversationMediaHandler,
} from '../controllers/message.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export async function messageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Conversation messages
  app.get('/conversations/:conversationId/messages', listMessagesHandler);
  app.post('/conversations/:conversationId/messages', sendMessageHandler);
  app.post('/conversations/:conversationId/read', markReadHandler);

  // Media / Files / Links gallery
  app.get('/conversations/:conversationId/media', getConversationMediaHandler);

  // Single message operations
  app.patch('/messages/:id', editMessageHandler);
  app.delete('/messages/:id', deleteMessageHandler);
  app.post('/messages/:id/reactions', reactMessageHandler);
}
