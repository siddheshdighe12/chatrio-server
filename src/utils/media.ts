import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';

/**
 * Resolves any media/attachment/avatar URL to point to the current active server host.
 * If the URL contains an `/uploads/...` path (even from a previous IP or port),
 * it extracts that path and prepends the current protocol and host from the request headers.
 */
export function normalizeMediaUrl(url: string | null | undefined, request?: FastifyRequest): string {
  if (!url) return '';

  const uploadIndex = url.indexOf('/uploads/');
  if (uploadIndex !== -1) {
    // Only rewrite if the URL is relative (no scheme) or points to the current server host.
    // External absolute URLs (e.g., Supabase CDN) that happen to contain /uploads/ in their
    // path must NOT be rewritten — they are already correct public CDN URLs.
    const isAbsoluteExternal = /^https?:\/\//i.test(url);
    if (!isAbsoluteExternal) {
      const uploadPath = url.substring(uploadIndex);
      const host = request?.headers?.host || `localhost:${env.PORT}`;
      const protocol = request?.protocol || 'http';
      return `${protocol}://${host}${uploadPath}`;
    }
  }

  return url;
}

/**
 * Normalizes an attachment object's URL field.
 */
export function normalizeAttachment<T extends { url: string }>(attachment: T, request?: FastifyRequest): T {
  return {
    ...attachment,
    url: normalizeMediaUrl(attachment.url, request),
  };
}
