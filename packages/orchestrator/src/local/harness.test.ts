import { describe, expect, it } from 'vitest';
import { chunkCountsByClassification, createLocalHarness } from './harness';

describe('createLocalHarness', () => {
  it('seeds exactly 65 chunks from the synthetic corpus', async () => {
    const harness = await createLocalHarness();
    expect(await harness.chunkCount()).toBe(65);
  });

  it('seeds the expected per-classification chunk breakdown', async () => {
    // A bare total (see the assertion above) would not have caught the
    // production/local chunker divergence that motivated this test -- two
    // classifications could drift in opposite directions and still sum to
    // 65. Assert the actual breakdown too.
    const harness = await createLocalHarness();
    const counts = await chunkCountsByClassification(harness);
    expect(counts).toEqual({
      protocol: 17,
      investigator_brochure: 7,
      regulatory_submission: 12,
      safety_report: 9,
      site_communication: 11,
      competitive_intelligence: 9,
    });
  });

  it('identityFor builds a CallerIdentity for any role', async () => {
    const harness = await createLocalHarness();
    const identity = harness.identityFor('medical_affairs');
    expect(identity.role).toBe('medical_affairs');
    expect(identity.role_fallback_applied).toBe(false);
  });

  it('identityFor honours overrides', async () => {
    const harness = await createLocalHarness();
    const identity = harness.identityFor('site_monitor', { assigned_sites: ['US-014'] });
    expect(identity.assigned_sites).toEqual(['US-014']);
  });

  it('ask() answers a real question grounded in the seeded corpus', async () => {
    const harness = await createLocalHarness();
    const response = await harness.ask('regulatory_affairs', 'What is the planned enrollment for AXIOM-HN01?');
    expect(response.status).toBe('answered');
    expect(response.citations.length).toBeGreaterThan(0);
  });

  it('ask() passes assignedSites through to the pipeline for site masking', async () => {
    const harness = await createLocalHarness();
    const response = await harness.ask(
      'site_monitor',
      'What protocol deviation was reported at site US-027?',
      { assignedSites: ['US-014'] },
    );
    expect(response.answer).not.toContain('US-027');
  });

  it('ask() passes drillDown through for the executive summary-only notice', async () => {
    const harness = await createLocalHarness();
    const response = await harness.ask('executive', 'What is the planned enrollment for AXIOM-HN01?', {
      drillDown: true,
    });
    expect(response.redaction_notice).toMatch(/drill-down/i);
  });

  it('audit and conversations reflect activity from ask()', async () => {
    const harness = await createLocalHarness();
    await harness.ask('regulatory_affairs', 'What is the planned enrollment for AXIOM-HN01?');
    const records = await harness.audit.query({});
    expect(records.length).toBeGreaterThan(0);
  });

  it('exposes the underlying SearchProvider directly', async () => {
    const harness = await createLocalHarness();
    const count = await harness.search.countChunks();
    expect(count).toBe(65);
  });
});
