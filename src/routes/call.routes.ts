import type { FastifyInstance } from 'fastify';
import {
  initiateCallHandler,
  getCallTokenHandler,
  acceptCallHandler,
  declineCallHandler,
  cancelCallHandler,
  endCallHandler,
  getCallHistoryHandler,
  initiateGroupCallHandler,
  joinGroupCallHandler,
  leaveGroupCallHandler,
  endGroupCallHandler,
  getActiveGroupCallHandler,
} from '../controllers/call.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export async function callRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ── One-to-one calls ────────────────────────────────────────────────────────
  // POST /calls/initiate — start a new call
  app.post('/initiate', initiateCallHandler);

  // POST /calls/:callId/token — get LiveKit credentials for an authorized participant
  app.post('/:callId/token', getCallTokenHandler);

  // POST /calls/:callId/accept — recipient accepts
  app.post('/:callId/accept', acceptCallHandler);

  // POST /calls/:callId/decline — recipient declines
  app.post('/:callId/decline', declineCallHandler);

  // POST /calls/:callId/cancel — caller cancels outgoing call
  app.post('/:callId/cancel', cancelCallHandler);

  // POST /calls/:callId/end — either participant ends active call
  app.post('/:callId/end', endCallHandler);

  // GET /calls/history/:id — get call history for a conversation
  app.get('/history/:id', getCallHistoryHandler);

  // ── Group calls ─────────────────────────────────────────────────────────────
  // POST /calls/group/initiate — start or join active group call
  app.post('/group/initiate', initiateGroupCallHandler);

  // POST /calls/group/:groupCallId/join — join existing group call
  app.post('/group/:groupCallId/join', joinGroupCallHandler);

  // POST /calls/group/:groupCallId/leave — participant leaves group call
  app.post('/group/:groupCallId/leave', leaveGroupCallHandler);

  // POST /calls/group/:groupCallId/end — initiator/admin ends group call for all
  app.post('/group/:groupCallId/end', endGroupCallHandler);

  // GET /calls/group/active/:conversationId — get active group call for a conversation
  app.get('/group/active/:conversationId', getActiveGroupCallHandler);
}
