/**
 * Expo Push Notification Service
 *
 * Sends push notifications via Expo's free push service.
 * Docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */

import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
}

interface ExpoTicket {
  id?: string;
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Sends push notifications in batches of up to 100.
 * Automatically removes invalid/expired tokens from the DB.
 */
export async function sendPushNotifications(messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };

  if (env.EXPO_ACCESS_TOKEN) {
    headers['Authorization'] = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  }

  // Filter out non-Expo tokens (safety guard)
  const valid = messages.filter(
    (m) => m.to.startsWith('ExponentPushToken[') || m.to.startsWith('ExpoPushToken[')
  );
  if (valid.length === 0) {
    console.log('[Push] No valid Expo push tokens among messages');
    return;
  }

  console.log(`[Push] Sending push notifications to ${valid.length} recipient(s)...`);

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        console.error(`[Push] Expo API error ${res.status}:`, await res.text());
        continue;
      }

      const json = (await res.json()) as { data: ExpoTicket[] };
      const tickets = json.data ?? [];
      console.log(`[Push] Expo API response:`, JSON.stringify(tickets));

      // Collect invalid token errors and remove them from DB
      const invalidTokens: string[] = [];
      tickets.forEach((ticket, idx) => {
        if (ticket.status === 'error') {
          const errType = ticket.details?.error;
          if (errType === 'DeviceNotRegistered') {
            invalidTokens.push(batch[idx].to);
          } else {
            console.warn('[Push] Ticket error:', ticket.message, '| token:', batch[idx].to);
          }
        }
      });

      if (invalidTokens.length > 0) {
        await prisma.pushToken.deleteMany({
          where: { token: { in: invalidTokens } },
        });
        console.log(`[Push] Removed ${invalidTokens.length} invalid token(s)`);
      }
    } catch (err) {
      console.error('[Push] Failed to send batch:', err);
    }
  }
}

/**
 * Build and send push notifications to all recipients of a conversation
 * except the sender and users who are currently actively viewing that conversation.
 */
export async function notifyConversationRecipients(opts: {
  conversationId: string;
  senderId: string;
  senderName: string;
  messagePreview: string;
  messageId: string;
  activeConversations: Map<string, Set<string>>;
}): Promise<void> {
  const { conversationId, senderId, senderName, messagePreview, messageId, activeConversations } = opts;

  try {
    // Get all active members excluding the sender
    const members = await prisma.conversationMember.findMany({
      where: {
        conversationId,
        isActive: true,
        userId: { not: senderId },
      },
      select: { userId: true, isMuted: true },
    });

    // Filter out members who are actively viewing this conversation or have muted it
    const eligibleUserIds = members
      .filter((m) => {
        if (m.isMuted) return false;
        const viewingSet = activeConversations.get(m.userId);
        return !(viewingSet?.has(conversationId));
      })
      .map((m) => m.userId);

    console.log(
      `[Push] Conversation ${conversationId}: ${members.length} member(s) found, ${eligibleUserIds.length} eligible for push notification`
    );

    if (eligibleUserIds.length === 0) return;

    // Fetch push tokens for eligible users
    const pushTokenRecords = await prisma.pushToken.findMany({
      where: { userId: { in: eligibleUserIds } },
      select: { token: true, userId: true },
    });

    console.log(`[Push] Found ${pushTokenRecords.length} push token record(s) for eligible users`);

    if (pushTokenRecords.length === 0) return;

    const preview = messagePreview.length > 120
      ? messagePreview.slice(0, 117) + '...'
      : messagePreview;

    const messages: PushMessage[] = pushTokenRecords.map((r) => ({
      to: r.token,
      title: senderName,
      body: preview,
      sound: 'default',
      channelId: 'messages',
      data: {
        conversationId,
        messageId,
        type: 'new_message',
      },
    }));

    sendPushNotifications(messages).catch((err) =>
      console.error('[Push] notifyConversationRecipients error:', err)
    );
  } catch (err) {
    console.error('[Push] Failed to prepare notifications:', err);
  }
}
