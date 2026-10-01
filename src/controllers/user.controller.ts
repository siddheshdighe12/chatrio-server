import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { broadcastToUserConversations, isUserOnline } from '../sockets/index.js';

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  bio: z.string().max(250).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  showReadReceipts: z.boolean().optional(),
  showTypingStatus: z.boolean().optional(),
});

export async function searchUsersHandler(request: FastifyRequest, reply: FastifyReply) {
  const { q } = request.query as { q?: string };
  const currentUserId = request.currentUser?.id;

  if (!q || q.trim().length === 0) {
    // Return recommended/recent users (excluding current user)
    const users = await prisma.user.findMany({
      where: {
        id: { not: currentUserId },
      },
      take: 20,
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        isOnline: true,
        lastSeenAt: true,
      },
      orderBy: { displayName: 'asc' },
    });
    return reply.send(
      users.map((u) => ({
        ...u,
        isOnline: isUserOnline(u.id),
      }))
    );
  }

  const query = q.trim().toLowerCase();

  const users = await prisma.user.findMany({
    where: {
      id: { not: currentUserId },
      OR: [
        { username: { contains: query } },
        { displayName: { contains: query } },
      ],
    },
    take: 20,
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      isOnline: true,
      lastSeenAt: true,
    },
    orderBy: { displayName: 'asc' },
  });

  return reply.send(
    users.map((u) => ({
      ...u,
      isOnline: isUserOnline(u.id),
    }))
  );
}

export async function getUserProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      isOnline: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });

  if (!user) {
    return reply.status(404).send({ error: 'User not found' });
  }

  return reply.send({
    ...user,
    isOnline: isUserOnline(user.id),
  });
}

export async function updateProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const result = updateProfileSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message || 'Validation error' });
  }

  const updated = await prisma.user.update({
    where: { id: currentUserId },
    data: result.data,
    select: {
      id: true,
      username: true,
      email: true,
      displayName: true,
      bio: true,
      avatarUrl: true,
      isOnline: true,
      showReadReceipts: true,
      showTypingStatus: true,
    },
  });

  if (result.data.displayName || result.data.avatarUrl !== undefined) {
    await broadcastToUserConversations(currentUserId, 'user:profile_updated', {
      userId: currentUserId,
      avatarUrl: updated.avatarUrl,
      displayName: updated.displayName,
    });
  }

  return reply.send(updated);
}

export async function uploadAvatarHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const data = await request.file();
  if (!data) {
    return reply.status(400).send({ error: 'No file uploaded' });
  }

  if (!data.mimetype.startsWith('image/')) {
    return reply.status(400).send({ error: 'Only image files are allowed' });
  }

  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const ext = path.extname(data.filename) || '.jpg';
  const uniqueName = `avatar_${uuidv4()}${ext}`;
  const filePath = path.join(uploadsDir, uniqueName);

  await pipeline(data.file, fs.createWriteStream(filePath));

  const host = request.headers.host || `localhost:${env.PORT}`;
  const protocol = request.protocol || 'http';
  const avatarUrl = `${protocol}://${host}/uploads/${uniqueName}`;

  // Update DB
  const updated = await prisma.user.update({
    where: { id: currentUserId },
    data: { avatarUrl },
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    },
  });

  // Broadcast to all conversation rooms so other clients update immediately
  await broadcastToUserConversations(currentUserId, 'user:profile_updated', {
    userId: currentUserId,
    avatarUrl,
    displayName: updated.displayName,
  });

  return reply.send({ avatarUrl });
}

export async function deleteAvatarHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const updated = await prisma.user.update({
    where: { id: currentUserId },
    data: { avatarUrl: null },
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    },
  });

  await broadcastToUserConversations(currentUserId, 'user:profile_updated', {
    userId: currentUserId,
    avatarUrl: null,
    displayName: updated.displayName,
  });

  return reply.send({ ok: true, avatarUrl: null });
}

export async function blockUserHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });
  const { id } = request.params as { id: string };
  if (id === currentUserId) return reply.status(400).send({ error: 'Cannot block yourself' });

  try {
    await prisma.blockedUser.create({
      data: { userId: currentUserId, blockedId: id },
    });
  } catch {
    // Already blocked — ignore duplicate
  }
  return reply.send({ ok: true });
}

export async function unblockUserHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });
  const { id } = request.params as { id: string };

  await prisma.blockedUser.deleteMany({
    where: { userId: currentUserId, blockedId: id },
  });
  return reply.send({ ok: true });
}

export async function listBlockedUsersHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });

  const blocked = await prisma.blockedUser.findMany({
    where: { userId: currentUserId },
    include: {
      blocked: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  return reply.send(blocked.map((b) => b.blocked));
}

export async function reportUserHandler(request: FastifyRequest, reply: FastifyReply) {
  const currentUserId = request.currentUser?.id;
  if (!currentUserId) return reply.status(401).send({ error: 'Unauthorized' });
  const { id } = request.params as { id: string };
  const body = request.body as { reason: string; targetType?: string };

  if (!body?.reason?.trim()) return reply.status(400).send({ error: 'Reason is required' });

  await prisma.report.create({
    data: {
      reporterId: currentUserId,
      targetId: id,
      targetType: body.targetType || 'USER',
      reason: body.reason.trim(),
    },
  });
  return reply.send({ ok: true });
}
