/**
 * Teams SSO authentication.
 *
 * Production always goes through `TeamsSsoAuthProvider`, which wraps
 * `@microsoft/teams-js`'s `app.initialize()` / `authentication.getAuthToken()`
 * silent SSO flow, caches the resulting token, and exposes `invalidate()` so
 * the API client can force a single refresh after a 401.
 *
 * A `DevAuthProvider` exists purely so the tab is runnable standalone
 * (`npm run dev`) against the local orchestrator server without a Teams
 * sideload. It is never imported unless `import.meta.env.DEV` is true --
 * see `resolveAuthProvider` below for how that is enforced structurally
 * rather than just by a runtime `if`.
 *
 * Nothing in this module ever logs a token.
 */
import { app, authentication } from '@microsoft/teams-js';
import type { Role } from '@trialpulse/shared';
import { decodeIdentity } from './decode-token';

export interface CallerUiIdentity {
  role: Role;
  roleFallbackApplied: boolean;
  userPrincipalName: string | null;
  displayName: string | null;
}

export interface AuthProvider {
  /** Resolve a bearer token. Pass `forceRefresh: true` to bypass any cache. */
  getToken(forceRefresh?: boolean): Promise<string>;
  /** Extra headers merged into every request. Only the dev provider uses this. */
  getExtraHeaders?(): Record<string, string>;
  /** Drop any cached token, forcing the next getToken() to fetch a fresh one. */
  invalidate(): void;
  /** UI-only identity (role, name) derived from the current token. Never authoritative. */
  getIdentity(): Promise<CallerUiIdentity>;
}

class TeamsSsoAuthProvider implements AuthProvider {
  private cachedToken: string | null = null;
  private inflight: Promise<string> | null = null;
  private initPromise: Promise<void> | null = null;

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = app.initialize().catch((err: unknown) => {
        // Allow a retry on the next call rather than sticking in a failed state.
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (this.cachedToken && !forceRefresh) {
      return this.cachedToken;
    }
    if (this.inflight && !forceRefresh) {
      return this.inflight;
    }
    this.inflight = this.fetchToken();
    try {
      const token = await this.inflight;
      this.cachedToken = token;
      return token;
    } finally {
      this.inflight = null;
    }
  }

  private async fetchToken(): Promise<string> {
    await this.ensureInitialized();
    // `silent: true`: Teams SSO refreshes the underlying AAD session
    // transparently; we never want an interactive popup mid-conversation.
    return authentication.getAuthToken({ silent: true });
  }

  invalidate(): void {
    this.cachedToken = null;
  }

  async getIdentity(): Promise<CallerUiIdentity> {
    const token = await this.getToken();
    return decodeIdentity(token);
  }
}

export const teamsAuthProvider: AuthProvider = new TeamsSsoAuthProvider();

/**
 * Resolves the auth provider for this session.
 *
 * The dev provider is loaded through a dynamic `import()` guarded by a
 * compile-time-constant `import.meta.env.DEV` check. Vite statically
 * replaces `import.meta.env.DEV` with the literal `false` in production
 * builds, which lets Rollup prove the branch (and the dynamic import it
 * guards) is dead code and drop it entirely. The dev provider's module is
 * therefore structurally absent from the production bundle -- not merely
 * unreachable -- so there is no code path in a shipped build that can ever
 * construct it.
 */
export async function resolveAuthProvider(): Promise<AuthProvider> {
  if (import.meta.env.DEV) {
    const { devAuthProvider } = await import('./dev-auth-provider');
    return devAuthProvider;
  }
  return teamsAuthProvider;
}
