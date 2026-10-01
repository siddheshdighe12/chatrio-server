import { Server as SocketIOServer, Socket } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { MessageStatus, MessageType } from '../types/database.js';
import { notifyConversationRecipients } from '../services/pushNotification.service.js';

interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      email: string;
      username: string;
      displayName: string;
    };
  };
}

// In-memory mapping of userId -> Set of active socket IDs
const userSockets = new Map<string, Set<string>>();

// In-memory tracking of which conversation each user is actively viewing
// userId -> Set<conversationId>
const activeConversations = new Map<string, Set<string>>();

// Exported singleton so other modules (e.g. upload routes) can broadcast
let ioInstance: SocketIOServer | null = null;

export function getIO(): SocketIOServer | null {
  return ioInstance;
}

export function isUserOnline(userId: string): boolean {
  return (userSockets.get(userId)?.size ?? 0) > 0;
}

/**
 * Broadcast an event to all conversation rooms the given user belongs to.
 * Used for real-time avatar / profile updates.
 */
export async function broadcastToUserConversations(
  userId: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!ioInstance) return;
  try {
    const memberships = await prisma.conversationMember.findMany({
      where: { userId, isActive: true },
      select: { conversationId: true },
    });
    for (const m of memberships) {
      ioInstance.to(`conversation:${m.conversationId}`).emit(event, payload);
    }
  } catch (err) {
    console.error('broadcastToUserConversations error:', err);
  }
}

/** Broadcast presence to all conversation rooms + globally */
async function broadcastPresence(userId: string, isOnline: boolean, lastSeenAt?: Date) {
  if (!ioInstance) return;
  const payload: Record<string, unknown> = { userId, isOnline };
  if (lastSeenAt) payload.lastSeenAt = lastSeenAt.toISOString();

  try {
    const memberships = await prisma.conversationMember.findMany({
      where: { userId, isActive: true },
      select: { conversationId: true },
    });
    for (const m of memberships) {
      ioInstance.to(`conversation:${m.conversationId}`).emit('user:presence', payload);
    }
    // Also broadcast globally for anyone interested
    ioInstance.emit('user:presence', payload);
  } catch (err) {
    console.error('broadcastPresence error:', err);
  }
}

/** Full message include for socket responses */
const MESSAGE_INCLUDE = {
  sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
  attachments: true,
  reactions: { include: { user: { select: { id: true, displayName: true } } } },
  replyTo: {
    select: {
      id: true, type: true, content: true, isDeleted: true,
      sender: { select: { id: true, displayName: true } },
    },
  },
  readBy: true,
} as const;

export function setupSockets(app: FastifyInstance): SocketIOServer {
  const io = new SocketIOServer(app.server, {
    cors: {
      origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
      credentials: true,
    },
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  // Store singleton reference for external broadcast helpers
  ioInstance = io;

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const authHeader =
        (socket.handshake.auth.token as string) ||
        (socket.handshake.headers.authorization as string);

      if (!authHeader) {
        return next(new Error('Authentication error: Token required'));
      }

      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      const decoded = app.jwt.verify<{ id: string; email: string; username: string }>(token);

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, email: true, username: true, displayName: true },
      });

      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }

      socket.data.user = user;
      next();
    } catch (err) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', async (rawSocket) => {
    const socket = rawSocket as AuthenticatedSocket;
    const user = socket.data.user;
    const userId = user.id;

    // Register active socket
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    const userSocketSet = userSockets.get(userId)!;
    const wasOffline = userSocketSet.size === 0;
    userSocketSet.add(socket.id);

    // Join personal room
    socket.join(`user:${userId}`);

    // Join all conversation rooms for this user
    try {
      const memberships = await prisma.conversationMember.findMany({
        where: { userId, isActive: true },
        select: { conversationId: true },
      });

      for (const m of memberships) {
        socket.join(`conversation:${m.conversationId}`);
      }

      // If user just came online, update DB and broadcast presence
      if (wasOffline) {
        await prisma.user.update({
          where: { id: userId },
          data: { isOnline: true, lastSeenAt: new Date() },
        });
        await broadcastPresence(userId, true);
      }
    } catch (err) {
      console.error('Error joining user to rooms:', err);
    }

    // Send currently connected online user IDs to the connecting socket
    const onlineUserIds: string[] = [];
    for (const [uid, sockets] of userSockets.entries()) {
      if (sockets.size > 0) {
        onlineUserIds.push(uid);
      }
    }
    socket.emit('presence:initial', { onlineUserIds });

    // ── Events ─────────────────────────────────────────────────────────────

    // Join new conversation room dynamically (e.g., when newly created)
    socket.on('conversation:join', (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
    });

    // Track which conversation the user is actively viewing (suppresses push notifications)
    socket.on('conversation:viewing', (conversationId: string) => {
      if (!activeConversations.has(userId)) {
        activeConversations.set(userId, new Set());
      }
      activeConversations.get(userId)!.add(conversationId);
    });

    // User left the conversation screen (re-enables push notifications)
    socket.on('conversation:leave_viewing', (conversationId: string) => {
      activeConversations.get(userId)?.delete(conversationId);
    });

    // Typing start — does NOT affect presence
    socket.on('typing:start', ({ conversationId }: { conversationId: string }) => {
      socket.to(`conversation:${conversationId}`).emit('user:typing', {
        conversationId,
        userId,
        displayName: user.displayName,
      });
    });

    // Typing stop — does NOT affect presence
    socket.on('typing:stop', ({ conversationId }: { conversationId: string }) => {
      socket.to(`conversation:${conversationId}`).emit('user:stop_typing', {
        conversationId,
        userId,
      });
    });

    // Send Message — does NOT affect presence
    socket.on(
      'message:send',
      async (
        data: {
          conversationId: string;
          type?: string;
          content?: string;
          replyToId?: string;
          attachments?: Array<{
            type: string;
            fileName: string;
            mimeType: string;
            size: number;
            url: string;
            width?: number;
            height?: number;
          }>;
        },
        callback?: (res: { ok: boolean; message?: any; error?: string }) => void
      ) => {
        try {
          const { conversationId, type = MessageType.TEXT, content, replyToId, attachments } = data;

          // Verify membership
          const member = await prisma.conversationMember.findUnique({
            where: { conversationId_userId: { conversationId, userId } },
          });

          if (!member || !member.isActive) {
            callback?.({ ok: false, error: 'Not a member of this conversation' });
            return;
          }

          const now = new Date();

          const message = await prisma.message.create({
            data: {
              conversationId,
              senderId: userId,
              type,
              content: content || null,
              replyToId: replyToId || null,
              status: MessageStatus.SENT,
              createdAt: now,
              attachments: attachments && attachments.length > 0
                ? {
                    create: attachments.map((att) => ({
                      type: att.type,
                      fileName: att.fileName,
                      mimeType: att.mimeType,
                      size: att.size,
                      storageKey: '',
                      url: att.url,
                      width: att.width,
                      height: att.height,
                    })),
                  }
                : undefined,
            },
            include: MESSAGE_INCLUDE,
          });

          // Update conversation updatedAt
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: now },
          });

          // Stop typing for this user when message is sent
          socket.to(`conversation:${conversationId}`).emit('user:stop_typing', { conversationId, userId });

          // Broadcast to everyone in conversation (including sender for sync)
          io.to(`conversation:${conversationId}`).emit('message:new', message);

          // Send push notifications to recipients who are not actively viewing this conversation
          notifyConversationRecipients({
            conversationId,
            senderId: userId,
            senderName: user.displayName,
            messagePreview:
              message.type === 'IMAGE' ? '📷 Image'
              : message.type === 'FILE' ? '📎 File'
              : (message.content ?? ''),
            messageId: message.id,
            activeConversations,
          });

          callback?.({ ok: true, message });
        } catch (err: any) {
          console.error('Socket message:send error:', err);
          callback?.({ ok: false, error: err.message || 'Failed to send message' });
        }
      }
    );

    // Edit Message
    socket.on(
      'message:edit',
      async ({ messageId, content }: { messageId: string; content: string }, callback) => {
        try {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (!msg || msg.senderId !== userId || msg.isDeleted) {
            callback?.({ ok: false, error: 'Cannot edit message' });
            return;
          }

          const updated = await prisma.message.update({
            where: { id: messageId },
            data: { content, isEdited: true, editedAt: new Date() },
            include: MESSAGE_INCLUDE,
          });

          io.to(`conversation:${msg.conversationId}`).emit('message:updated', updated);
          callback?.({ ok: true, message: updated });
        } catch (err: any) {
          callback?.({ ok: false, error: err.message });
        }
      }
    );

    // Delete Message for Everyone
    socket.on(
      'message:delete',
      async ({ messageId }: { messageId: string }, callback) => {
        try {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (!msg || msg.senderId !== userId) {
            callback?.({ ok: false, error: 'Cannot delete message' });
            return;
          }

          const updated = await prisma.message.update({
            where: { id: messageId },
            data: {
              isDeleted: true,
              deletedAt: new Date(),
              type: MessageType.DELETED,
              content: 'This message was deleted',
            },
            include: MESSAGE_INCLUDE,
          });

          io.to(`conversation:${msg.conversationId}`).emit('message:deleted', updated);
          callback?.({ ok: true, message: updated });
        } catch (err: any) {
          callback?.({ ok: false, error: err.message });
        }
      }
    );

    // Delete Message for Me Only
    socket.on(
      'message:delete_for_me',
      async ({ messageId }: { messageId: string }, callback) => {
        try {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (!msg) {
            callback?.({ ok: false, error: 'Message not found' });
            return;
          }

          let ids: string[] = [];
          try { ids = JSON.parse(msg.deletedForUserIds || '[]'); } catch {}
          if (!ids.includes(userId)) ids.push(userId);

          await prisma.message.update({
            where: { id: messageId },
            data: { deletedForUserIds: JSON.stringify(ids) },
          });

          // Only notify the sender's socket, not the whole room
          socket.emit('message:deleted_for_me', { messageId, conversationId: msg.conversationId });
          callback?.({ ok: true });
        } catch (err: any) {
          callback?.({ ok: false, error: err.message });
        }
      }
    );

    // React to message
    socket.on(
      'message:react',
      async ({ messageId, emoji }: { messageId: string; emoji: string }, callback) => {
        try {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (!msg) {
            callback?.({ ok: false, error: 'Message not found' });
            return;
          }

          const existing = await prisma.messageReaction.findUnique({
            where: { messageId_userId: { messageId, userId } },
          });

          if (existing) {
            if (existing.emoji === emoji) {
              await prisma.messageReaction.delete({ where: { id: existing.id } });
            } else {
              await prisma.messageReaction.update({
                where: { id: existing.id },
                data: { emoji },
              });
            }
          } else {
            await prisma.messageReaction.create({
              data: { messageId, userId, emoji },
            });
          }

          const reactions = await prisma.messageReaction.findMany({
            where: { messageId },
            include: { user: { select: { id: true, displayName: true } } },
          });

          io.to(`conversation:${msg.conversationId}`).emit('message:reaction_updated', {
            messageId,
            conversationId: msg.conversationId,
            reactions,
          });

          callback?.({ ok: true, reactions });
        } catch (err: any) {
          callback?.({ ok: false, error: err.message });
        }
      }
    );

    // Read messages
    socket.on(
      'message:read',
      async ({ conversationId }: { conversationId: string }, callback) => {
        try {
          const unread = await prisma.message.findMany({
            where: {
              conversationId,
              senderId: { not: userId },
              isDeleted: false,
              readBy: { none: { userId } },
            },
            select: { id: true },
          });

          const now = new Date();

          if (unread.length > 0) {
            await Promise.all(
              unread.map((m) =>
                prisma.messageRead.upsert({
                  where: { messageId_userId: { messageId: m.id, userId } },
                  update: { readAt: now },
                  create: { messageId: m.id, userId, readAt: now },
                })
              )
            );

            await prisma.message.updateMany({
              where: { id: { in: unread.map((m) => m.id) } },
              data: { status: MessageStatus.READ },
            });

            io.to(`conversation:${conversationId}`).emit('message:read_receipt', {
              conversationId,
              userId,
              readMessageIds: unread.map((m) => m.id),
              readAt: now,
            });
          }

          callback?.({ ok: true, count: unread.length });
        } catch (err: any) {
          callback?.({ ok: false, error: err.message });
        }
      }
    );

    // Disconnect handler — only triggers offline after ALL sockets disconnect
    socket.on('disconnect', async () => {
      userSocketSet.delete(socket.id);

      if (userSocketSet.size === 0) {
        userSockets.delete(userId);
        // Clear active conversation tracking when all sockets disconnect
        activeConversations.delete(userId);
        const lastSeenAt = new Date();

        try {
          await prisma.user.update({
            where: { id: userId },
            data: { isOnline: false, lastSeenAt },
          });

          await broadcastPresence(userId, false, lastSeenAt);
        } catch (err) {
          console.error('Error updating user presence on disconnect:', err);
        }
      }
    });
  });

  return io;
}
