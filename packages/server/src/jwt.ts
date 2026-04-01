/**
 * Agent JWT module — issues, verifies, refreshes, and revokes short-lived JWTs
 * used by dispatched agents to authenticate their callbacks.
 *
 * Algorithm: HS256 with OUIJA_SECRET_KEY (RS256/EdDSA deferred to v1.1 when
 * a proper key-management story exists; HS256 is correct for single-instance v1).
 *
 * Claims:
 *   instanceId, boardId, workspaceId, aud, iss, jti, iat, exp (15 min)
 *
 * Redis denylist: revoked JTIs are stored in Redis with TTL = remaining lifetime.
 * The denylist is checked on every verification to support JWT revocation on cancel.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';

// ---- Constants ----

const ISSUER = 'ouija';
const AUDIENCE = 'ouija-agent-callback';
const TOKEN_LIFETIME_SECS = 15 * 60; // 15 minutes
const REFRESH_THRESHOLD_SECS = 5 * 60; // refresh when < 5 min remaining
const DENYLIST_PREFIX = 'ouija:jwt:deny:';

// ---- Agent JWT claims ----

export interface AgentJWTClaims extends JWTPayload {
  instanceId: string;
  boardId: string;
  workspaceId: string;
  jti: string;
}

// ---- Redis interface (minimal — injected to avoid hard coupling) ----

export interface JWTRedisClient {
  set(key: string, value: string, options: { ex: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

// ---- Module-level Redis client (set once at startup) ----

let _redis: JWTRedisClient | undefined;

export function setJWTRedisClient(client: JWTRedisClient): void {
  _redis = client;
}

// ---- Secret key helper ----

function getSecretKey(): Uint8Array {
  const raw = process.env['OUIJA_SECRET_KEY'];
  if (!raw || raw.length < 32) {
    throw new Error('OUIJA_SECRET_KEY env var is required and must be at least 32 characters');
  }
  return new TextEncoder().encode(raw);
}

// ---- issueAgentJWT ----

export async function issueAgentJWT(
  instanceId: string,
  boardId: string,
  workspaceId: string,
): Promise<string> {
  const jti = randomUUID();
  const secret = getSecretKey();

  const token = await new SignJWT({ instanceId, boardId, workspaceId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(jti)
    .setExpirationTime(`${TOKEN_LIFETIME_SECS}s`)
    .sign(secret);

  return token;
}

// ---- verifyAgentJWT ----

export async function verifyAgentJWT(token: string): Promise<AgentJWTClaims> {
  const secret = getSecretKey();

  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  if (
    typeof payload['instanceId'] !== 'string' ||
    typeof payload['boardId'] !== 'string' ||
    typeof payload['workspaceId'] !== 'string' ||
    typeof payload['jti'] !== 'string'
  ) {
    throw new Error('JWT is missing required claims');
  }

  // Check denylist
  const denied = await isRevoked(payload['jti']);
  if (denied) {
    throw new Error('JWT has been revoked');
  }

  return payload as AgentJWTClaims;
}

// ---- refreshAgentJWT ----

/**
 * Refreshes a JWT if it has less than REFRESH_THRESHOLD_SECS remaining.
 * Returns null if the old token still has sufficient lifetime.
 * Revokes the old JTI on refresh.
 */
export async function refreshAgentJWT(oldToken: string): Promise<string | null> {
  const claims = await verifyAgentJWT(oldToken);

  const expSecs = typeof claims.exp === 'number' ? claims.exp : 0;
  const remainingSecs = expSecs - Math.floor(Date.now() / 1000);

  if (remainingSecs >= REFRESH_THRESHOLD_SECS) {
    return null; // no refresh needed
  }

  // Revoke the old token before issuing new one
  await revokeJWT(claims.jti, remainingSecs > 0 ? remainingSecs : 1);

  return issueAgentJWT(claims.instanceId, claims.boardId, claims.workspaceId);
}

// ---- revokeJWT ----

/**
 * Adds the JTI to the Redis denylist.
 * ttlSecs defaults to TOKEN_LIFETIME_SECS (safe upper bound when remaining life is unknown).
 */
export async function revokeJWT(jti: string, ttlSecs: number = TOKEN_LIFETIME_SECS): Promise<void> {
  if (!_redis) {
    // No Redis available — log warning, degraded revocation
    // In production this should not happen; server startup ensures Redis is set
    return;
  }
  await _redis.set(`${DENYLIST_PREFIX}${jti}`, '1', { ex: Math.ceil(ttlSecs) });
}

// ---- isRevoked ----

export async function isRevoked(jti: string): Promise<boolean> {
  if (!_redis) {
    return false; // No Redis — cannot check denylist (fail open for availability)
  }
  const val = await _redis.get(`${DENYLIST_PREFIX}${jti}`);
  return val !== null;
}

// ---- Remaining seconds helper (exported for agent-callback route) ----

export function getRemainingSeconds(claims: AgentJWTClaims): number {
  const expSecs = typeof claims.exp === 'number' ? claims.exp : 0;
  return expSecs - Math.floor(Date.now() / 1000);
}

export { REFRESH_THRESHOLD_SECS };
