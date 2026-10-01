import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';

export interface TokenPayload {
  id: string;
  email: string;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: {
      id: string;
      email: string;
      username: string;
      displayName: string;
      avatarUrl?: string | null;
      bio?: string | null;
      isOnline: boolean;
      showReadReceipts: boolean;
      showTypingStatus: boolean;
    };
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const payload = await request.jwtVerify<TokenPayload>();

    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        isOnline: true,
        showReadReceipts: true,
        showTypingStatus: true,
      },
    });

    if (!user) {
      return reply.status(401).send({ error: 'User not found or revoked' });
    }

    request.currentUser = user;
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized or invalid token' });
  }
}
