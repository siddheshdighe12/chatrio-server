import type { FastifyInstance } from 'fastify';
import {
  initiateCallHandler,
  getCallTokenHandler,
  acceptCallHandler,
  declineCallHandler,
  cancelCallHandler,
  endCallHandler,
  getCallHistoryHandler,
} from '../controllers/call.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export async function callRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

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
}
