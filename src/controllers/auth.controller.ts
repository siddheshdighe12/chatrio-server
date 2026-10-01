import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/prisma.js';

const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  displayName: z.string().min(1, 'Display name is required').max(50),
});

const loginSchema = z.object({
  identifier: z.string().min(1, 'Email or username is required'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export async function registerHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = registerSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message || 'Validation error' });
  }

  const { username, email, password, displayName } = result.data;
  const normalizedUsername = username.toLowerCase();
  const normalizedEmail = email.toLowerCase();

  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ username: normalizedUsername }, { email: normalizedEmail }],
    },
  });

  if (existing) {
    if (existing.username === normalizedUsername) {
      return reply.status(409).send({ error: 'Username is already taken' });
    }
    return reply.status(409).send({ error: 'Email is already in use' });
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const avatarUrl = null;

  const user = await prisma.user.create({
    data: {
      username: normalizedUsername,
      email: normalizedEmail,
      password: hashedPassword,
      displayName,
      avatarUrl,
      isOnline: true,
      lastSeenAt: new Date(),
    },
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
      createdAt: true,
    },
  });

  const accessToken = request.server.jwt.sign(
    { id: user.id, email: user.email, username: user.username },
    { expiresIn: '7d' }
  );

  const refreshToken = uuidv4();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 days

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt,
    },
  });

  return reply.status(201).send({
    user,
    accessToken,
    refreshToken,
  });
}

export async function loginHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = loginSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message || 'Validation error' });
  }

  const { identifier, password } = result.data;
  const normalized = identifier.toLowerCase().trim();

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: normalized }, { username: normalized }],
    },
  });

  if (!user) {
    return reply.status(401).send({ error: 'Invalid email/username or password' });
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    return reply.status(401).send({ error: 'Invalid email/username or password' });
  }

  // Update presence
  await prisma.user.update({
    where: { id: user.id },
    data: { isOnline: true, lastSeenAt: new Date() },
  });

  const accessToken = request.server.jwt.sign(
    { id: user.id, email: user.email, username: user.username },
    { expiresIn: '7d' }
  );

  const refreshToken = uuidv4();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt,
    },
  });

  return reply.send({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      isOnline: true,
      showReadReceipts: user.showReadReceipts,
      showTypingStatus: user.showTypingStatus,
    },
    accessToken,
    refreshToken,
  });
}

export async function refreshHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = refreshSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({ error: result.error.errors[0]?.message || 'Validation error' });
  }

  const { refreshToken } = result.data;

  const storedToken = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });

  if (!storedToken || storedToken.revokedAt || storedToken.expiresAt < new Date()) {
    return reply.status(401).send({ error: 'Refresh token expired or revoked' });
  }

  const newAccessToken = request.server.jwt.sign(
    {
      id: storedToken.user.id,
      email: storedToken.user.email,
      username: storedToken.user.username,
    },
    { expiresIn: '7d' }
  );

  return reply.send({ accessToken: newAccessToken });
}

export async function logoutHandler(request: FastifyRequest, reply: FastifyReply) {
  const userId = request.currentUser?.id;
  if (!userId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = (request.body as { refreshToken?: string }) || {};
  if (body.refreshToken) {
    await prisma.refreshToken.updateMany({
      where: { token: body.refreshToken, userId },
      data: { revokedAt: new Date() },
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { isOnline: false, lastSeenAt: new Date() },
  });

  return reply.send({ ok: true });
}

export async function getMeHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.currentUser) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  return reply.send({ user: request.currentUser });
}
