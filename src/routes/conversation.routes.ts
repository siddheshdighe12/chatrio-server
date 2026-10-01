import type { FastifyInstance } from 'fastify';
import {
  listConversationsHandler,
  getOrCreateDirectHandler,
  createGroupHandler,
  getConversationHandler,
  updateGroupHandler,
  pinConversationHandler,
  muteConversationHandler,
  archiveConversationHandler,
  markUnreadHandler,
  deleteConversationHandler,
  clearConversationHandler,
  addMembersHandler,
  removeMemberHandler,
  updateMemberRoleHandler,
  leaveGroupHandler,
} from '../controllers/conversation.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export async function conversationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', listConversationsHandler);
  app.post('/direct', getOrCreateDirectHandler);
  app.post('/group', createGroupHandler);
  app.get('/:id', getConversationHandler);
  app.patch('/:id', updateGroupHandler);
  app.patch('/:id/pin', pinConversationHandler);
  app.patch('/:id/mute', muteConversationHandler);
  app.patch('/:id/archive', archiveConversationHandler);
  app.post('/:id/unread', markUnreadHandler);
  app.delete('/:id', deleteConversationHandler);
  app.post('/:id/clear', clearConversationHandler);
  // Group member management
  app.post('/:id/members', addMembersHandler);
  app.delete('/:id/members/:userId', removeMemberHandler);
  app.patch('/:id/members/:userId', updateMemberRoleHandler);
  app.post('/:id/leave', leaveGroupHandler);
}
