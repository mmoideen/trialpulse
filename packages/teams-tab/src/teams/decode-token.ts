/**
 * Best-effort, client-side read of the caller's role claim from a JWT.
 *
 * This is NOT a security boundary -- the signature is never verified here,
 * and it must never be treated as authoritative. Its only job is to drive UI
 * affordances (e.g. which Browse classifications to request, which badge to
 * show) using the exact same `resolveRole` privilege-resolution logic the
 * orchestrator applies server-side, so the two can never disagree about what
 * a given `roles` claim means. The orchestrator independently re-derives and
 * enforces the role on every request from the verified token.
 */
import { resolveRole, type Role } from '@trialpulse/shared';

interface DecodedJwtPayload {
  roles?: unknown;
  upn?: string;
  preferred_username?: string;
  name?: string;
}

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(paddingNeeded);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeJwtPayload(token: string): DecodedJwtPayload {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return {};
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as DecodedJwtPayload;
  } catch {
    return {};
  }
}

export interface DecodedIdentity {
  role: Role;
  roleFallbackApplied: boolean;
  userPrincipalName: string | null;
  displayName: string | null;
}

export function decodeIdentity(token: string): DecodedIdentity {
  const payload = decodeJwtPayload(token);
  const { role, fallbackApplied } = resolveRole(payload.roles);
  return {
    role,
    roleFallbackApplied: fallbackApplied,
    userPrincipalName: payload.upn ?? payload.preferred_username ?? null,
    displayName: payload.name ?? null,
  };
}
