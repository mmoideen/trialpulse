import { describe, expect, it } from 'vitest';
import { routeModel } from './model-router';

describe('routeModel', () => {
  it('routes a short, low-stakes query to mini', () => {
    expect(
      routeModel({ role: 'clinical_operations', query: 'When is the next site visit?', downgradeActive: false }),
    ).toBe('mini');
  });

  it('routes a query containing a high-reasoning keyword to full, regardless of length', () => {
    expect(
      routeModel({ role: 'clinical_operations', query: 'Any safety updates?', downgradeActive: false }),
    ).toBe('full');
  });

  it('is case-insensitive when matching high-reasoning keywords', () => {
    expect(
      routeModel({ role: 'clinical_operations', query: 'What REGULATORY filings are pending?', downgradeActive: false }),
    ).toBe('full');
  });

  it('always routes executives to full, even for a trivial short query', () => {
    expect(routeModel({ role: 'executive', query: 'status?', downgradeActive: false })).toBe('full');
  });

  it('routes a long query (>= token threshold) to full even without a keyword', () => {
    const longQuery = 'word '.repeat(120).trim(); // ~150 tokens at 4 chars/token approximation
    expect(routeModel({ role: 'clinical_operations', query: longQuery, downgradeActive: false })).toBe('full');
  });

  it('forces mini for a non-executive query when the cost downgrade is active, even for a long query', () => {
    const longQuery = 'word '.repeat(120).trim();
    expect(routeModel({ role: 'clinical_operations', query: longQuery, downgradeActive: true })).toBe('mini');
  });

  it('forces mini for a non-executive query when downgrade is active, even with a keyword', () => {
    expect(
      routeModel({ role: 'medical_affairs', query: 'safety summary please', downgradeActive: true }),
    ).toBe('mini');
  });

  it('D5(b): the hard cost cap downgrades executive queries too -- no role is exempt from the daily cap', () => {
    expect(routeModel({ role: 'executive', query: 'status?', downgradeActive: true })).toBe('mini');
  });

  it('D5(b): the cap overrides the executive-full-model rule even for a keyword-bearing query', () => {
    expect(routeModel({ role: 'executive', query: 'What is the safety status?', downgradeActive: true })).toBe('mini');
  });

  it('routes a short query with no keyword for every non-executive role to mini', () => {
    for (const role of ['regulatory_affairs', 'clinical_operations', 'medical_affairs', 'site_monitor', 'it_admin'] as const) {
      expect(routeModel({ role, query: 'Where is the newsletter?', downgradeActive: false })).toBe('mini');
    }
  });

  describe('D5(c): keyword matching is word-boundary, not substring', () => {
    it('does not fire on "ind" as a substring of an unrelated word', () => {
      for (const query of ['find enrollment', 'kind of slow', 'what is the index', 'binding constraint', 'individual patient', 'indication for use', 'closing window', 'remind me later']) {
        expect(routeModel({ role: 'clinical_operations', query, downgradeActive: false }), query).toBe('mini');
      }
    });

    it('does not fire on "nda" as a substring of an unrelated word', () => {
      for (const query of ['agenda for the meeting', 'the calendar invite']) {
        expect(routeModel({ role: 'clinical_operations', query, downgradeActive: false }), query).toBe('mini');
      }
    });

    it('still fires on "ind" as a genuine standalone word or IND reference', () => {
      expect(routeModel({ role: 'clinical_operations', query: 'the IND submission is due', downgradeActive: false })).toBe('full');
      expect(routeModel({ role: 'clinical_operations', query: 'IND-145678 amendment status', downgradeActive: false })).toBe('full');
    });

    it('still fires on every other genuine keyword', () => {
      expect(routeModel({ role: 'clinical_operations', query: 'SAE reported yesterday', downgradeActive: false })).toBe('full');
      expect(routeModel({ role: 'clinical_operations', query: 'NDA filing timeline', downgradeActive: false })).toBe('full');
      expect(routeModel({ role: 'clinical_operations', query: 'FDA meeting request', downgradeActive: false })).toBe('full');
    });
  });
});
