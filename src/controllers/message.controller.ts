import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { MessageStatus, MessageType } from '../types/database.js';
import { notifyConversationRecipients } from '../services/pushNotification.service.js';
import { normalizeMediaUrl, normalizeAttachment } from '../utils/media.js';

// Regex that matches http(s):// URLs (used for link extraction)
const URL_REGEX = /https?:\/\/[^\s]+/gi;

const sendMessageSchema = z.object({
  type: z.enum([MessageType.TEXT, MessageType.IMAGE, MessageType.FILE]).default(MessageType.TEXT),
  content: z.string().max(4000).optional(),
  replyToId: z.string().uuid().optional(),
  attachments: z
    .array(
      z.object({
        type: z.string(),
        fileName: z.string(),
        mimeType: z.string(),
        size: z.number(),
        storageKey: z.string().default(''),
        url: z.string().url(),
        width: z.number().optional(),
        height: z.number().optional(),
      })
    )
    .optional(),
});

const editMessageSchema = z.object({
  content: z.string().min(1, 'Content is required').max(4000),
});

const reactSchema = z.object({
  emoji: z.string().min(1).max(8),
});

export async function listMessagesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { conversationId } = request.params as { conversationId: string };
  const { limit = '50', before } = request.query as { limit?: string; before?: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  // Membership check
  const member = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: { conversationId, userId: currentUserId },
    },
  });

  if (!member || !member.isActive) {
    return reply.status(403).send({ error: 'You are not a member of this conversation' });
  }

  const takeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

  const whereClause: any = {
    conversationId,
  };

  if (before) {
    whereClause.createdAt = {
      lt: new Date(before),
    };
  }

  const messages = await prisma.message.findMany({
    where: whereClause,
    take: takeLimit,
    orderBy: { createdAt: 'desc' },
    include: {
      sender: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
      attachments: true,
      reactions: {
        include: {
          user: {
            select: { id: true, displayName: true },
          },
        },
      },
      replyTo: {
        select: {
          id: true,
          type: true,
          content: true,
          isDeleted: true,
          sender: {
            select: { id: true, displayName: true },
          },
        },
      },
      readBy: {
        select: { userId: true, readAt: true },
      },
    },
  });

  // Return in chronological order with normalized URLs
  const normalized = messages.map((m) => ({
    ...m,
    sender: m.sender
      ? { ...m.sender, avatarUrl: normalizeMediaUrl(m.sender.avatarUrl, request) }
      : m.sender,
    attachments: m.attachments?.map((a) => normalizeAttachment(a, request)),
    replyTo: m.replyTo
      ? {
          ...m.replyTo,
          sender: m.replyTo.sender
            ? {
                ...m.replyTo.sender,
                avatarUrl: (m.replyTo.sender as any).avatarUrl
                  ? normalizeMediaUrl((m.replyTo.sender as any).avatarUrl, request)
                  : undefined,
              }
            : m.replyTo.sender,
        }
      : m.replyTo,
  }));

  return reply.send(normalized.reverse());
}

export async function sendMessageHandler(request: FastifyRequest, reply: FastifyReply) {
  const { conversationId } = request.params as { conversationId: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const result = sendMessageSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message });
  }

  const { type, content, replyToId, attachments } = result.data;

  // Membership check
  const member = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: { conversationId, userId: currentUserId },
    },
  });

  if (!member || !member.isActive) {
    return reply.status(403).send({ error: 'You are not an active member of this conversation' });
  }

  const now = new Date();

  // Create message with attachments
  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId: currentUserId,
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
              storageKey: att.storageKey || '',
              url: att.url,
              width: att.width,
              height: att.height,
            })),
          }
        : undefined,
    },
    include: {
      sender: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
      attachments: true,
      reactions: true,
      replyTo: {
        select: {
          id: true,
          type: true,
          content: true,
          sender: {
            select: { id: true, displayName: true },
          },
        },
      },
      readBy: true,
    },
  });

  // Update conversation updatedAt
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: now },
  });

  // Send push notifications (REST path — no active-viewer socket context available,
  // so we use an empty map; users viewing via socket would have received the
  // real-time message:new event already and typically don't use the REST fallback)
  const senderDisplay = (message.sender as any)?.displayName ?? 'Someone';
  notifyConversationRecipients({
    conversationId,
    senderId: currentUserId,
    senderName: senderDisplay,
    messagePreview:
      type === 'IMAGE' ? '\u{1F4F7} Image'
      : type === 'FILE' ? '\u{1F4CE} File'
      : (content ?? ''),
    messageId: message.id,
    activeConversations: new Map(),
  }).catch((err) => console.error('[Push] REST send error:', err));

  const normalized = {
    ...message,
    sender: message.sender
      ? { ...message.sender, avatarUrl: normalizeMediaUrl(message.sender.avatarUrl, request) }
      : message.sender,
    attachments: message.attachments?.map((a) => normalizeAttachment(a, request)),
  };

  return reply.status(201).send(normalized);
}

export async function editMessageHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const result = editMessageSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message });
  }

  const existing = await prisma.message.findUnique({ where: { id } });
  if (!existing) return reply.status(404).send({ error: 'Message not found' });

  if (existing.senderId !== currentUserId) {
    return reply.status(403).send({ error: 'You can only edit your own messages' });
  }

  if (existing.isDeleted) {
    return reply.status(400).send({ error: 'Cannot edit a deleted message' });
  }

  const updated = await prisma.message.update({
    where: { id },
    data: {
      content: result.data.content,
      isEdited: true,
      editedAt: new Date(),
    },
    include: {
      sender: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
      attachments: true,
      reactions: true,
      replyTo: true,
      readBy: true,
    },
  });

  return reply.send(updated);
}

export async function deleteMessageHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const existing = await prisma.message.findUnique({ where: { id } });
  if (!existing) return reply.status(404).send({ error: 'Message not found' });

  if (existing.senderId !== currentUserId) {
    return reply.status(403).send({ error: 'You can only delete your own messages' });
  }

  const updated = await prisma.message.update({
    where: { id },
    data: {
      isDeleted: true,
      deletedAt: new Date(),
      type: MessageType.DELETED,
      content: 'This message was deleted',
    },
    include: {
      sender: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
      attachments: true,
      reactions: true,
      replyTo: true,
      readBy: true,
    },
  });

  return reply.send(updated);
}

export async function reactMessageHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const result = reactSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message });
  }

  const { emoji } = result.data;

  // Check if message exists and user is member of conversation
  const message = await prisma.message.findUnique({
    where: { id },
    include: { conversation: { include: { members: true } } },
  });

  if (!message) return reply.status(404).send({ error: 'Message not found' });

  const isMember = message.conversation.members.some(
    (m) => m.userId === currentUserId && m.isActive
  );
  if (!isMember) {
    return reply.status(403).send({ error: 'You are not a member of this conversation' });
  }

  // Toggle reaction: check if reaction already exists for (messageId, userId)
  const existingReaction = await prisma.messageReaction.findUnique({
    where: {
      messageId_userId: { messageId: id, userId: currentUserId },
    },
  });

  if (existingReaction) {
    if (existingReaction.emoji === emoji) {
      // Remove reaction if same emoji tapped again
      await prisma.messageReaction.delete({
        where: { id: existingReaction.id },
      });
    } else {
      // Update reaction to new emoji
      await prisma.messageReaction.update({
        where: { id: existingReaction.id },
        data: { emoji },
      });
    }
  } else {
    // Add reaction
    await prisma.messageReaction.create({
      data: {
        messageId: id,
        userId: currentUserId,
        emoji,
      },
    });
  }

  // Return refreshed reactions
  const reactions = await prisma.messageReaction.findMany({
    where: { messageId: id },
    include: {
      user: {
        select: { id: true, displayName: true },
      },
    },
  });

  return reply.send({ messageId: id, reactions });
}

export async function markReadHandler(request: FastifyRequest, reply: FastifyReply) {
  const { conversationId } = request.params as { conversationId: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  // Find all messages in conversation not sent by current user and not yet read by current user
  const unreadMessages = await prisma.message.findMany({
    where: {
      conversationId,
      senderId: { not: currentUserId },
      isDeleted: false,
      readBy: {
        none: { userId: currentUserId },
      },
    },
    select: { id: true },
  });

  const now = new Date();

  // Create MessageRead records
  await Promise.all(
    unreadMessages.map((msg) =>
      prisma.messageRead.upsert({
        where: {
          messageId_userId: { messageId: msg.id, userId: currentUserId },
        },
        update: { readAt: now },
        create: {
          messageId: msg.id,
          userId: currentUserId,
          readAt: now,
        },
      })
    )
  );

  // Update status of these messages to READ
  if (unreadMessages.length > 0) {
    await prisma.message.updateMany({
      where: {
        id: { in: unreadMessages.map((m) => m.id) },
        status: { not: MessageStatus.READ },
      },
      data: { status: MessageStatus.READ },
    });
  }

  return reply.send({ ok: true, readCount: unreadMessages.length });
}

/**
 * GET /conversations/:conversationId/media
 *
 * Returns:
 *  - images: paginated Attachment rows where type = IMAGE
 *  - files:  paginated Attachment rows where type != IMAGE
 *  - links:  paginated messages that contain a URL in their content
 *
 * Query params:
 *  - tab: 'images' | 'files' | 'links'  (default: 'images')
 *  - limit: number (default 40, max 100)
 *  - cursor: createdAt ISO string (for pagination)
 */
export async function getConversationMediaHandler(request: FastifyRequest, reply: FastifyReply) {
  const { conversationId } = request.params as { conversationId: string };
  const { tab = 'images', limit = '40', cursor } = request.query as {
    tab?: string;
    limit?: string;
    cursor?: string;
  };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  // Membership check
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: currentUserId } },
  });
  if (!member || !member.isActive) {
    return reply.status(403).send({ error: 'You are not a member of this conversation' });
  }

  const takeLimit = Math.min(Math.max(parseInt(limit, 10) || 40, 1), 100);
  const cursorDate = cursor ? new Date(cursor) : undefined;

  if (tab === 'images') {
    // Return image attachments (non-deleted messages only)
    const attachments = await prisma.attachment.findMany({
      where: {
        type: 'IMAGE',
        message: {
          conversationId,
          isDeleted: false,
          ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
        },
      },
      take: takeLimit,
      orderBy: { createdAt: 'desc' },
      include: {
        message: {
          select: {
            id: true,
            createdAt: true,
            sender: { select: { id: true, displayName: true } },
          },
        },
      },
    });
    const nextCursor =
      attachments.length === takeLimit
        ? attachments[attachments.length - 1].message.createdAt.toISOString()
        : null;
    const normalized = attachments.map((a) => normalizeAttachment(a, request));
    return reply.send({ items: normalized, nextCursor });
  }

  if (tab === 'files') {
    // Return non-image attachments
    const attachments = await prisma.attachment.findMany({
      where: {
        type: { not: 'IMAGE' },
        message: {
          conversationId,
          isDeleted: false,
          ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
        },
      },
      take: takeLimit,
      orderBy: { createdAt: 'desc' },
      include: {
        message: {
          select: {
            id: true,
            createdAt: true,
            sender: { select: { id: true, displayName: true } },
          },
        },
      },
    });
    const nextCursor =
      attachments.length === takeLimit
        ? attachments[attachments.length - 1].message.createdAt.toISOString()
        : null;
    const normalized = attachments.map((a) => normalizeAttachment(a, request));
    return reply.send({ items: normalized, nextCursor });
  }

  if (tab === 'links') {
    // Return text messages containing URLs
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        isDeleted: false,
        type: 'TEXT',
        content: { contains: 'http' },
        ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
      },
      take: takeLimit * 2, // fetch extra to filter out false positives
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        content: true,
        createdAt: true,
        sender: { select: { id: true, displayName: true } },
      },
    });

    // Extract URL matches from each message
    type LinkItem = {
      messageId: string;
      url: string;
      content: string;
      createdAt: string;
      sender: { id: string; displayName: string } | null;
    };
    const linkItems: LinkItem[] = [];
    for (const msg of messages) {
      if (!msg.content) continue;
      const matches = msg.content.match(URL_REGEX);
      if (!matches) continue;
      for (const url of matches) {
        linkItems.push({
          messageId: msg.id,
          url,
          content: msg.content,
          createdAt: msg.createdAt.toISOString(),
          sender: msg.sender,
        });
        if (linkItems.length >= takeLimit) break;
      }
      if (linkItems.length >= takeLimit) break;
    }

    const nextCursor =
      messages.length >= takeLimit * 2 && linkItems.length >= takeLimit
        ? linkItems[linkItems.length - 1].createdAt
        : null;
    return reply.send({ items: linkItems, nextCursor });
  }

  return reply.status(400).send({ error: 'Invalid tab. Use: images, files, or links' });
}
