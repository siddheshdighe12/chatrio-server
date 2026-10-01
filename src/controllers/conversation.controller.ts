import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { ConversationType, MemberRole, MessageType } from '../types/database.js';
import { isUserOnline } from '../sockets/index.js';
import { normalizeMediaUrl } from '../utils/media.js';

const directConvSchema = z.object({
  targetUserId: z.string().uuid(),
});

const createGroupSchema = z.object({
  name: z.string().min(1, 'Group name is required').max(60),
  description: z.string().max(250).optional(),
  avatarUrl: z.string().url().optional(),
  memberIds: z.array(z.string().uuid()).min(1, 'Select at least 1 member'),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(250).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

// Helper to format conversation response consistently
async function formatConversation(conv: any, currentUserId: string, request?: FastifyRequest) {
  const myMembership = conv.members.find((m: any) => m.userId === currentUserId);

  const lastMessage = conv.messages?.[0] || null;

  const unreadCount = await prisma.message.count({
    where: {
      conversationId: conv.id,
      senderId: { not: currentUserId },
      isDeleted: false,
      deletedForUserIds: { not: { contains: currentUserId } },
      readBy: { none: { userId: currentUserId } },
    },
  });

  let otherMember = null;
  if (conv.type === ConversationType.DIRECT) {
    const found = conv.members.find((m: any) => m.userId !== currentUserId)?.user || null;
    if (found) {
      otherMember = { ...found, isOnline: isUserOnline(found.id) };
    }
  }

  return {
    id: conv.id,
    type: conv.type,
    name: conv.type === ConversationType.GROUP ? conv.name : otherMember?.displayName || 'Chat',
    avatarUrl: normalizeMediaUrl(
      conv.type === ConversationType.GROUP ? conv.avatarUrl : otherMember?.avatarUrl,
      request
    ),
    description: conv.description,
    updatedAt: conv.updatedAt,
    otherUser: otherMember
      ? {
          ...otherMember,
          avatarUrl: normalizeMediaUrl(otherMember.avatarUrl, request),
        }
      : null,
    members: conv.members.map((m: any) => ({
      id: m.id,
      role: m.role,
      user: {
        ...m.user,
        avatarUrl: normalizeMediaUrl(m.user?.avatarUrl, request),
        isOnline: isUserOnline(m.user.id),
      },
    })),
    lastMessage: lastMessage
      ? {
          id: lastMessage.id,
          type: lastMessage.type,
          content: lastMessage.content,
          senderId: lastMessage.senderId,
          senderName: lastMessage.sender?.displayName || null,
          status: lastMessage.status,
          createdAt: lastMessage.createdAt,
          attachmentsCount: lastMessage.attachments?.length || 0,
        }
      : null,
    unreadCount,
    isPinned: myMembership?.isPinned || false,
    isMuted: myMembership?.isMuted || false,
    isArchived: myMembership?.isArchived || false,
    myRole: myMembership?.role || MemberRole.MEMBER,
  };
}

export async function listConversationsHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const conversations = await prisma.conversation.findMany({
    where: {
      members: {
        some: {
          userId: currentUserId,
          isActive: true,
        },
      },
    },
    include: {
      members: {
        where: { isActive: true },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              isOnline: true,
              lastSeenAt: true,
            },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          sender: {
            select: { id: true, username: true, displayName: true },
          },
          attachments: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const formatted = await Promise.all(conversations.map((conv) => formatConversation(conv, currentUserId, request)));

  // Pinned first, then by updatedAt
  formatted.sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return reply.send(formatted);
}

export async function getOrCreateDirectHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const result = directConvSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message });
  }

  const { targetUserId } = result.data;
  if (targetUserId === currentUserId) {
    return reply.status(400).send({ error: 'Cannot create a direct conversation with yourself' });
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, displayName: true, avatarUrl: true, isOnline: true, lastSeenAt: true },
  });

  if (!targetUser) {
    return reply.status(404).send({ error: 'User not found' });
  }

  const targetWithPresence = { ...targetUser, isOnline: isUserOnline(targetUser.id) };

  // Look for existing active conversation
  const existing = await prisma.conversation.findFirst({
    where: {
      type: ConversationType.DIRECT,
      AND: [
        { members: { some: { userId: currentUserId, isActive: true } } },
        { members: { some: { userId: targetUserId, isActive: true } } },
      ],
    },
    include: {
      members: {
        where: { isActive: true },
        include: {
          user: {
            select: {
              id: true, username: true, displayName: true, avatarUrl: true, isOnline: true, lastSeenAt: true,
            },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { sender: { select: { id: true, username: true, displayName: true } }, attachments: true },
      },
    },
  });

  if (existing) {
    return reply.send(await formatConversation(existing, currentUserId));
  }

  // Create new direct conversation
  const newConv = await prisma.conversation.create({
    data: {
      type: ConversationType.DIRECT,
      members: {
        create: [
          { userId: currentUserId, role: MemberRole.MEMBER },
          { userId: targetUserId, role: MemberRole.MEMBER },
        ],
      },
    },
    include: {
      members: {
        include: {
          user: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, isOnline: true, lastSeenAt: true },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { sender: { select: { id: true, username: true, displayName: true } }, attachments: true },
      },
    },
  });

  return reply.status(201).send(await formatConversation(newConv, currentUserId));
}

export async function createGroupHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const result = createGroupSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message });
  }

  const { name, description, avatarUrl, memberIds } = result.data;

  const uniqueMemberIds = [...new Set([...memberIds, currentUserId])];

  const group = await prisma.conversation.create({
    data: {
      type: ConversationType.GROUP,
      name,
      description,
      avatarUrl,
      members: {
        create: uniqueMemberIds.map((uid) => ({
          userId: uid,
          role: uid === currentUserId ? MemberRole.OWNER : MemberRole.MEMBER,
        })),
      },
    },
    include: {
      members: {
        where: { isActive: true },
        include: {
          user: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, isOnline: true, lastSeenAt: true },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { sender: { select: { id: true, username: true, displayName: true } }, attachments: true },
      },
    },
  });

  // Create SYSTEM message
  await prisma.message.create({
    data: {
      conversationId: group.id,
      senderId: null,
      type: MessageType.SYSTEM,
      content: `${request.currentUser?.displayName || 'User'} created the group`,
      metadata: JSON.stringify({ event: 'GROUP_CREATED', actorId: currentUserId }),
    },
  });

  return reply.status(201).send(await formatConversation(group, currentUserId));
}

export async function getConversationHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: {
      members: {
        where: { isActive: true },
        include: {
          user: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, bio: true, isOnline: true, lastSeenAt: true },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { sender: { select: { id: true, username: true, displayName: true } }, attachments: true },
      },
    },
  });

  if (!conv) return reply.status(404).send({ error: 'Conversation not found' });

  const isMember = conv.members.some((m) => m.userId === currentUserId);
  if (!isMember) return reply.status(403).send({ error: 'You are not a member of this conversation' });

  return reply.send(await formatConversation(conv, currentUserId));
}

export async function updateGroupHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });

  if (!membership || (membership.role !== MemberRole.OWNER && membership.role !== MemberRole.ADMIN)) {
    return reply.status(403).send({ error: 'Only group owners or admins can update group settings' });
  }

  const result = updateGroupSchema.safeParse(request.body);
  if (!result.success) return reply.status(400).send({ error: result.error.errors[0]?.message });

  const updated = await prisma.conversation.update({
    where: { id },
    data: result.data,
  });

  return reply.send(updated);
}

export async function pinConversationHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!member) return reply.status(403).send({ error: 'Not a member' });

  const updated = await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
    data: { isPinned: !member.isPinned },
  });

  return reply.send({ isPinned: updated.isPinned });
}

export async function muteConversationHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!member) return reply.status(403).send({ error: 'Not a member' });

  const updated = await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
    data: { isMuted: !member.isMuted },
  });

  return reply.send({ isMuted: updated.isMuted });
}

export async function archiveConversationHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!member) return reply.status(403).send({ error: 'Not a member' });

  const updated = await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
    data: { isArchived: !member.isArchived },
  });

  return reply.send({ isArchived: updated.isArchived });
}

export async function markUnreadHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  // Mark last message as unread by removing read receipt for current user
  const lastMsg = await prisma.message.findFirst({
    where: { conversationId: id, senderId: { not: currentUserId }, isDeleted: false },
    orderBy: { createdAt: 'desc' },
  });

  if (lastMsg) {
    await prisma.messageRead.deleteMany({
      where: { messageId: lastMsg.id, userId: currentUserId },
    });
  }

  return reply.send({ ok: true });
}

export async function deleteConversationHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!member) return reply.status(403).send({ error: 'Not a member' });

  // Soft-delete: mark member as inactive
  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
    data: { isActive: false, leftAt: new Date() },
  });

  return reply.send({ ok: true });
}

export async function clearConversationHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!member) return reply.status(403).send({ error: 'Not a member' });

  // Mark all messages as deleted for this user using raw update
  const messages = await prisma.message.findMany({
    where: { conversationId: id },
    select: { id: true, deletedForUserIds: true },
  });

  await Promise.all(
    messages.map(async (msg) => {
      let ids: string[] = [];
      try {
        ids = JSON.parse(msg.deletedForUserIds || '[]');
      } catch {}
      if (!ids.includes(currentUserId)) {
        ids.push(currentUserId);
        await prisma.message.update({
          where: { id: msg.id },
          data: { deletedForUserIds: JSON.stringify(ids) },
        });
      }
    })
  );

  return reply.send({ ok: true });
}

// Group Member Management
export async function addMembersHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const body = request.body as { memberIds: string[] };
  if (!body?.memberIds?.length) return reply.status(400).send({ error: 'No member IDs provided' });

  const myMembership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!myMembership || (myMembership.role !== MemberRole.OWNER && myMembership.role !== MemberRole.ADMIN)) {
    return reply.status(403).send({ error: 'Only admins can add members' });
  }

  const addedMembers = [];
  for (const uid of body.memberIds) {
    try {
      const m = await prisma.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: id, userId: uid } },
        update: { isActive: true, leftAt: null },
        create: { conversationId: id, userId: uid, role: MemberRole.MEMBER },
        include: { user: { select: { id: true, displayName: true, username: true, avatarUrl: true } } },
      });
      addedMembers.push(m);
    } catch {}
  }

  // System message
  if (addedMembers.length > 0) {
    await prisma.message.create({
      data: {
        conversationId: id,
        senderId: null,
        type: MessageType.SYSTEM,
        content: `${addedMembers.length} member(s) added to the group`,
        metadata: JSON.stringify({ event: 'MEMBERS_ADDED', actorId: currentUserId }),
      },
    });
  }

  return reply.send({ ok: true, added: addedMembers.length });
}

export async function removeMemberHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id, userId } = request.params as { id: string; userId: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const myMembership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!myMembership || (myMembership.role !== MemberRole.OWNER && myMembership.role !== MemberRole.ADMIN)) {
    return reply.status(403).send({ error: 'Only admins can remove members' });
  }

  // Protect owner
  const targetMembership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId } },
  });
  if (targetMembership?.role === MemberRole.OWNER) {
    return reply.status(403).send({ error: 'Cannot remove the group owner' });
  }

  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId } },
    data: { isActive: false, leftAt: new Date() },
  });

  return reply.send({ ok: true });
}

export async function updateMemberRoleHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id, userId } = request.params as { id: string; userId: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const myMembership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!myMembership || myMembership.role !== MemberRole.OWNER) {
    return reply.status(403).send({ error: 'Only the group owner can change roles' });
  }

  const body = request.body as { role: string };
  if (!['ADMIN', 'MEMBER'].includes(body.role)) {
    return reply.status(400).send({ error: 'Role must be ADMIN or MEMBER' });
  }

  const updated = await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId } },
    data: { role: body.role },
  });

  return reply.send({ ok: true, role: updated.role });
}

export async function leaveGroupHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
  });
  if (!membership) return reply.status(403).send({ error: 'Not a member' });

  if (membership.role === MemberRole.OWNER) {
    // If owner is leaving, promote the next admin or member to owner
    const nextAdmin = await prisma.conversationMember.findFirst({
      where: { conversationId: id, userId: { not: currentUserId }, isActive: true, role: MemberRole.ADMIN },
    });
    const nextMember = nextAdmin || await prisma.conversationMember.findFirst({
      where: { conversationId: id, userId: { not: currentUserId }, isActive: true },
    });
    if (nextMember) {
      await prisma.conversationMember.update({
        where: { id: nextMember.id },
        data: { role: MemberRole.OWNER },
      });
    }
  }

  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: id, userId: currentUserId } },
    data: { isActive: false, leftAt: new Date() },
  });

  await prisma.message.create({
    data: {
      conversationId: id,
      senderId: null,
      type: MessageType.SYSTEM,
      content: `${request.currentUser?.displayName || 'User'} left the group`,
      metadata: JSON.stringify({ event: 'MEMBER_LEFT', actorId: currentUserId }),
    },
  });

  return reply.send({ ok: true });
}
