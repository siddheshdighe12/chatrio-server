/**
 * Call Service — Chatrio
 *
 * Responsibilities:
 *  - Generate short-lived, room-scoped LiveKit access tokens
 *  - Validate and execute call-state transitions
 *  - Schedule ring timeout (45 s → MISSED)
 *  - Send incoming-call push notifications
 *
 * LiveKit credentials are read exclusively from env vars.
 * The API secret is never returned to any client.
 */

import { AccessToken, VideoGrant } from 'livekit-server-sdk';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { CallStatus, CallType } from '../types/database.js';
import { sendPushNotifications, type PushMessage } from './pushNotification.service.js';

// ── Token TTL: 4 hours ───────────────────────────────────────────────────────
const TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 h
const RING_TIMEOUT_MS   = 45_000;      // 45 s

// In-memory ring timeout handles: callId → NodeJS.Timeout
const ringTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// ─────────────────────────────────────────────────────────────────────────────
// LiveKit availability guard
// ─────────────────────────────────────────────────────────────────────────────

export function isLiveKitConfigured(): boolean {
  return !!(env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_URL);
}

// ─────────────────────────────────────────────────────────────────────────────
// Token generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a short-lived LiveKit room token for one authenticated participant.
 *
 * @param userId      The Chatrio user ID — becomes the LiveKit participant identity
 * @param displayName The user's display name shown in LiveKit sessions
 * @param roomName    The LiveKit room name (= call.id UUID)
 * @param canPublish  Whether this participant may publish tracks
 */
export async function generateLiveKitToken(
  userId: string,
  displayName: string,
  roomName: string,
  canPublish = true,
): Promise<{ token: string; serverUrl: string }> {
  if (!isLiveKitConfigured()) {
    throw Object.assign(
      new Error('LiveKit is not configured on the server. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL.'),
      { statusCode: 503 },
    );
  }

  const at = new AccessToken(env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!, {
    identity: userId,
    name: displayName,
    ttl: TOKEN_TTL_SECONDS,
  });

  const grant: VideoGrant = {
    roomJoin: true,
    room: roomName,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
  };

  at.addGrant(grant);

  const token = await at.toJwt();

  return { token, serverUrl: env.LIVEKIT_URL! };
}

// ─────────────────────────────────────────────────────────────────────────────
// Participant authorization helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that:
 *  1. The conversation exists and is of type DIRECT.
 *  2. The authenticated user is an active member.
 *  3. The recipient is the other active member.
 *
 * Returns { callerId, recipientId } on success.
 */
export async function authorizeDirectCall(
  conversationId: string,
  authenticatedUserId: string,
): Promise<{ callerId: string; recipientId: string }> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      members: {
        where: { isActive: true },
        select: { userId: true },
      },
    },
  });

  if (!conversation) {
    throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
  }

  if (conversation.type !== 'DIRECT') {
    throw Object.assign(new Error('Calls are only supported in direct conversations'), { statusCode: 400 });
  }

  const memberIds = conversation.members.map((m) => m.userId);

  if (!memberIds.includes(authenticatedUserId)) {
    throw Object.assign(new Error('Not a member of this conversation'), { statusCode: 403 });
  }

  const recipientId = memberIds.find((id) => id !== authenticatedUserId);
  if (!recipientId) {
    throw Object.assign(new Error('Recipient not found in conversation'), { statusCode: 400 });
  }

  return { callerId: authenticatedUserId, recipientId };
}

/**
 * Resolve a call record and verify the requesting user is a participant.
 * Throws 404 if call not found, 403 if not a participant.
 */
export async function getCallForParticipant(callId: string, userId: string) {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: {
      caller:    { select: { id: true, displayName: true, avatarUrl: true } },
      recipient: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });

  if (!call) {
    throw Object.assign(new Error('Call not found'), { statusCode: 404 });
  }

  if (call.callerId !== userId && call.recipientId !== userId) {
    throw Object.assign(new Error('Not a participant in this call'), { statusCode: 403 });
  }

  return call;
}

// ─────────────────────────────────────────────────────────────────────────────
// State-transition validation
// ─────────────────────────────────────────────────────────────────────────────

/** Allowed server-enforced call-state transitions */
const ALLOWED_TRANSITIONS: Partial<Record<CallStatus, CallStatus[]>> = {
  [CallStatus.RINGING]: [
    CallStatus.ACTIVE,
    CallStatus.DECLINED,
    CallStatus.CANCELLED,
    CallStatus.MISSED,
    CallStatus.FAILED,
  ],
  [CallStatus.ACTIVE]: [CallStatus.ENDED, CallStatus.FAILED],
};

export function assertValidTransition(current: string, next: CallStatus): void {
  const allowed = ALLOWED_TRANSITIONS[current as CallStatus] ?? [];
  if (!allowed.includes(next)) {
    throw Object.assign(
      new Error(`Invalid call-state transition: ${current} → ${next}`),
      { statusCode: 409 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring timeout (45 s)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schedule a 45-second ring timeout.
 * If the call is still RINGING when the timer fires, it transitions to MISSED.
 * `onTimeout(callId)` is invoked so the socket layer can broadcast to participants.
 */
export function scheduleRingTimeout(
  callId: string,
  onTimeout: (callId: string) => void,
): void {
  clearRingTimeout(callId); // cancel any existing handle

  const handle = setTimeout(async () => {
    ringTimeouts.delete(callId);

    try {
      const call = await prisma.call.findUnique({ where: { id: callId } });

      if (!call || call.status !== CallStatus.RINGING) return; // already resolved

      await prisma.call.update({
        where: { id: callId },
        data: { status: CallStatus.MISSED, endedAt: new Date() },
      });

      onTimeout(callId);
    } catch (err) {
      console.error('[Call] Ring timeout handler error:', err);
    }
  }, RING_TIMEOUT_MS);

  ringTimeouts.set(callId, handle);
}

export function clearRingTimeout(callId: string): void {
  const handle = ringTimeouts.get(callId);
  if (handle) {
    clearTimeout(handle);
    ringTimeouts.delete(callId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Incoming-call push notification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a high-priority push notification to all registered devices of the recipient.
 *
 * LIMITATION: This uses Expo's standard push API and produces a notification banner.
 * The user must tap the banner to accept. Native automatic ringing (Android
 * ConnectionService / iOS CallKit) is NOT implemented in this release.
 * A separate 'calls' Android notification channel is used for maximum urgency.
 */
export async function notifyIncomingCall(opts: {
  callId: string;
  recipientId: string;
  callerName: string;
  callType: string;
  conversationId: string;
}): Promise<void> {
  const { callId, recipientId, callerName, callType, conversationId } = opts;

  try {
    const tokens = await prisma.pushToken.findMany({
      where: { userId: recipientId },
      select: { token: true },
    });

    if (tokens.length === 0) return;

    const callTypeLabel = callType === CallType.VIDEO ? 'video call' : 'audio call';

    const messages: PushMessage[] = tokens.map((t) => ({
      to: t.token,
      title: callerName,
      body: `Incoming ${callTypeLabel}`,
      sound: 'default',
      channelId: 'calls',
      data: {
        type: 'incoming_call',
        callId,
        callType,
        conversationId,
        callerName,
      },
    }));

    // Fire-and-forget — don't block the call:initiate response
    sendPushNotifications(messages).catch((err) =>
      console.error('[Call] notifyIncomingCall error:', err)
    );
  } catch (err) {
    console.error('[Call] Failed to dispatch incoming call push notification:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Group Call helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that:
 *  1. The conversation exists and is of type GROUP.
 *  2. The authenticated user is an active member.
 */
export async function authorizeGroupCall(
  conversationId: string,
  authenticatedUserId: string,
) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      members: {
        where: { isActive: true },
        select: { userId: true, role: true },
      },
    },
  });

  if (!conversation) {
    throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
  }

  if (conversation.type !== 'GROUP') {
    throw Object.assign(new Error('Group calls are only supported in group conversations'), { statusCode: 400 });
  }

  const membership = conversation.members.find((m) => m.userId === authenticatedUserId);
  if (!membership) {
    throw Object.assign(new Error('Not a member of this group conversation'), { statusCode: 403 });
  }

  return { conversation, membership };
}

/**
 * Resolve a group call record and verify the requesting user is an active member of the group.
 */
export async function getGroupCallForMember(groupCallId: string, userId: string) {
  const groupCall = await prisma.groupCall.findUnique({
    where: { id: groupCallId },
    include: {
      conversation: {
        include: {
          members: {
            where: { isActive: true },
            select: { userId: true, role: true },
          },
        },
      },
      initiator: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
    },
  });

  if (!groupCall) {
    throw Object.assign(new Error('Group call not found'), { statusCode: 404 });
  }

  const isMember = groupCall.conversation.members.some((m) => m.userId === userId);
  if (!isMember) {
    throw Object.assign(new Error('Not an authorized member of this group call'), { statusCode: 403 });
  }

  return groupCall;
}

/**
 * Send incoming group-call push notifications to all other active group members.
 */
export async function notifyIncomingGroupCall(opts: {
  groupCallId: string;
  conversationId: string;
  groupName: string;
  initiatorName: string;
  callType: string;
  excludeUserId: string;
}): Promise<void> {
  const { groupCallId, conversationId, groupName, initiatorName, callType, excludeUserId } = opts;

  try {
    const members = await prisma.conversationMember.findMany({
      where: {
        conversationId,
        isActive: true,
        userId: { not: excludeUserId },
      },
      select: { userId: true },
    });

    const userIds = members.map((m) => m.userId);
    if (userIds.length === 0) return;

    const tokens = await prisma.pushToken.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    });

    if (tokens.length === 0) return;

    const callTypeLabel = callType === CallType.VIDEO ? 'group video call' : 'group audio call';

    const messages: PushMessage[] = tokens.map((t) => ({
      to: t.token,
      title: groupName || 'Group Call',
      body: `${initiatorName} started a ${callTypeLabel}`,
      sound: 'default',
      channelId: 'calls',
      data: {
        type: 'incoming_group_call',
        groupCallId,
        callType,
        conversationId,
        groupName,
        initiatorName,
      },
    }));

    sendPushNotifications(messages).catch((err) =>
      console.error('[Call] notifyIncomingGroupCall error:', err)
    );
  } catch (err) {
    console.error('[Call] Failed to dispatch group call push notifications:', err);
  }
}
