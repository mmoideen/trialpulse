/**
 * DEV-ONLY auth provider.
 *
 * Imported exclusively from `resolveAuthProvider()` in `auth.ts`, behind a
 * static `import.meta.env.DEV` check, so it never reaches a production
 * bundle. The runtime guard below is defence in depth in case this module is
 * ever imported some other way.
 *
 * It sends a dev-identity header pair that the local orchestrator dev server
 * trusts in place of a real Teams SSO bearer token, so the tab can be run
 * with `npm run dev` against `http://localhost` without sideloading into
 * Teams.
 */
import { isRole, type Role } from '@trialpulse/shared';
import type { AuthProvider, CallerUiIdentity } from './auth';

const FALLBACK_DEV_ROLE: Role = 'regulatory_affairs';
const FALLBACK_DEV_UPN = 'dev.user@meridiantx.com';

function resolveDevRole(): Role {
  const configured = import.meta.env.VITE_DEV_ROLE;
  return configured && isRole(configured) ? configured : FALLBACK_DEV_ROLE;
}

class DevAuthProvider implements AuthProvider {
  constructor() {
    if (!import.meta.env.DEV) {
      throw new Error('DevAuthProvider must never be constructed outside development.');
    }
  }

  async getToken(): Promise<string> {
    return 'dev-mode-token';
  }

  getExtraHeaders(): Record<string, string> {
    // D12: the orchestrator's development auth mode only ever reads a
    // single `x-dev-identity` JSON header (see `src/auth/jwt.ts`'s
    // `parseDevIdentity`) -- it does not, and per that module's own
    // reasoning should not, additionally trust two separate, looser
    // `X-TrialPulse-Dev-*` headers just because a client happens to send
    // them. This used to send those two headers, which the server never
    // read at all, so the tab's dev flow 401ed against a real local
    // orchestrator. Fixed on the tab side, matching the server's actual,
    // narrower contract.
    return {
      'x-dev-identity': JSON.stringify({
        upn: import.meta.env.VITE_DEV_UPN ?? FALLBACK_DEV_UPN,
        role: resolveDevRole(),
        sites: [],
      }),
    };
  }

  invalidate(): void {
    /* no-op: the dev token never expires */
  }

  async getIdentity(): Promise<CallerUiIdentity> {
    return {
      role: resolveDevRole(),
      roleFallbackApplied: false,
      userPrincipalName: import.meta.env.VITE_DEV_UPN ?? FALLBACK_DEV_UPN,
      displayName: 'Dev User',
    };
  }
}

export const devAuthProvider: AuthProvider = new DevAuthProvider();
