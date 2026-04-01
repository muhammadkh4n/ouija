/**
 * Auth middleware for the Ouija server.
 *
 * Two auth modes (spec §5.1):
 *
 * 1. Cookie session (dashboard):
 *    - HttpOnly + Secure + SameSite=Strict cookie named "ouija_session"
 *    - Contains a signed HS256 JWT with user claims
 *    - Verified via jose, checked for expiry
 *
 * 2. Bearer API key (external API / programmatic access):
 *    - Authorization: Bearer ouija_<key>
 *    - Key stored as SHA-256 hash in DB (v1: checked against env var for simplicity)
 *    - Prefix "ouija_" for GitHub secret scanning detection
 *
 * Decorates request.user with session info.
 * `requireAuth` preHandler rejects unauthenticated requests with 401.
 *
 * Note: For v1, the admin API key is stored in OUIJA_API_KEY env var.
 * A proper key management system with DB storage is deferred to Phase 2.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { jwtVerify } from 'jose';
import { ApiError } from '@ouija/types';

// ---- Session user shape ----

export interface SessionUser {
  userId: string;
  role: 'admin';
  sessionType: 'cookie' | 'api_key';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

// ---- Secret key helper ----

function getSecretKey(): Uint8Array {
  const raw = process.env['OUIJA_SECRET_KEY'];
  if (!raw || raw.length < 32) {
    throw new Error('OUIJA_SECRET_KEY env var is required (min 32 chars)');
  }
  return new TextEncoder().encode(raw);
}

// ---- Cookie session verification ----

async function verifySessionCookie(cookieValue: string): Promise<SessionUser | null> {
  try {
    const secret = getSecretKey();
    const { payload } = await jwtVerify(cookieValue, secret, {
      issuer: 'ouija',
      audience: 'ouija-dashboard',
    });
    if (typeof payload['userId'] !== 'string') return null;
    return {
      userId: payload['userId'] as string,
      role: 'admin',
      sessionType: 'cookie',
    };
  } catch {
    return null;
  }
}

// ---- Bearer API key verification ----

function verifyApiKey(raw: string): SessionUser | null {
  // Key must start with "ouija_"
  if (!raw.startsWith('ouija_')) return null;

  const expectedKey = process.env['OUIJA_API_KEY'];
  if (!expectedKey) return null;

  // Compare SHA-256 hashes to prevent timing attacks
  const inputHash = createHash('sha256').update(raw).digest('hex');
  const expectedHash = createHash('sha256').update(expectedKey).digest('hex');

  if (inputHash !== expectedHash) return null;

  return {
    userId: 'api',
    role: 'admin',
    sessionType: 'api_key',
  };
}

// ---- Auth hook (populates request.user, non-blocking) ----

async function authHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // 1. Try cookie session first
  const sessionCookie = (request.cookies as Record<string, string | undefined>)['ouija_session'];
  if (sessionCookie) {
    const user = await verifySessionCookie(sessionCookie);
    if (user) {
      request.user = user;
      return;
    }
  }

  // 2. Try Bearer token
  const authHeader = request.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const user = verifyApiKey(token);
    if (user) {
      request.user = user;
      return;
    }
  }

  // No valid auth found — request.user remains undefined
}

// ---- requireAuth preHandler ----

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Run auth hook first if user not already populated
  if (!request.user) {
    await authHook(request, reply);
  }

  if (!request.user) {
    throw new ApiError('UNAUTHORIZED', 'Authentication required.', 401, false);
  }
}

// ---- Register auth as a global onRequest hook ----

export function registerAuthMiddleware(app: FastifyInstance): void {
  // Runs on every request — populates request.user if valid auth present.
  // Does NOT reject unauthenticated requests; that's requireAuth's job.
  app.addHook('onRequest', authHook);
}
