/**
 * JWT helper for the agent worker process.
 *
 * The worker runs as a separate process from the Fastify server and shares the
 * same OUIJA_SECRET_KEY. This module duplicates the minimal JWT issuance logic
 * from @ouija-dev/server/jwt rather than importing from that package (which would
 * pull in Fastify and other server-only deps).
 *
 * Algorithm, claims, and constants must stay in sync with packages/server/src/jwt.ts.
 */

import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';

const ISSUER = 'ouija';
const AUDIENCE = 'ouija-agent-callback';
const TOKEN_LIFETIME_SECS = 15 * 60; // 15 minutes — matches server/jwt.ts

function getSecretKey(): Uint8Array {
  const raw = process.env['OUIJA_SECRET_KEY'];
  if (!raw || raw.length < 32) {
    throw new Error('OUIJA_SECRET_KEY is required and must be at least 32 characters');
  }
  return new TextEncoder().encode(raw);
}

export async function issueAgentJWT(
  instanceId: string,
  boardId: string,
  workspaceId: string,
): Promise<string> {
  const jti = randomUUID();
  const secret = getSecretKey();

  return new SignJWT({ instanceId, boardId, workspaceId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(jti)
    .setExpirationTime(`${TOKEN_LIFETIME_SECS}s`)
    .sign(secret);
}
