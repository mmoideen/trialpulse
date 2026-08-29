import { describe, expect, it } from 'vitest';
import { devAuthProvider } from './dev-auth-provider';

describe('devAuthProvider', () => {
  it('D12: sends a single x-dev-identity JSON header, matching the orchestrator\'s parseDevIdentity contract exactly', () => {
    const headers = devAuthProvider.getExtraHeaders?.() ?? {};
    expect(Object.keys(headers)).toEqual(['x-dev-identity']);

    const parsed = JSON.parse(headers['x-dev-identity']!) as { upn: string; role: string; sites: string[] };
    expect(typeof parsed.upn).toBe('string');
    expect(parsed.upn.length).toBeGreaterThan(0);
    expect(typeof parsed.role).toBe('string');
    expect(parsed.sites).toEqual([]);
  });

  it('never sends the old, server-ignored X-TrialPulse-Dev-* headers', () => {
    const headers = devAuthProvider.getExtraHeaders?.() ?? {};
    expect(headers['X-TrialPulse-Dev-Role']).toBeUndefined();
    expect(headers['X-TrialPulse-Dev-User']).toBeUndefined();
  });

  it('getToken() resolves to a non-empty placeholder token (never a real one)', async () => {
    await expect(devAuthProvider.getToken()).resolves.toBe('dev-mode-token');
  });

  it('getIdentity() reflects the same role as the x-dev-identity header', async () => {
    const headers = devAuthProvider.getExtraHeaders?.() ?? {};
    const parsed = JSON.parse(headers['x-dev-identity']!) as { role: string };
    const identity = await devAuthProvider.getIdentity();
    expect(identity.role).toBe(parsed.role);
  });
});
