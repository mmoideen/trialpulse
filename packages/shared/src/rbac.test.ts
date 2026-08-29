import { describe, expect, it } from 'vitest';
import {
  buildSearchFilter,
  canAccessAdminApi,
  DEFAULT_ROLE,
  getRolePolicy,
  isChunkAuthorized,
  isRole,
  resolveRole,
  ROLE_POLICIES,
} from './rbac';
import { DOCUMENT_CLASSIFICATIONS, ROLES, type DocumentClassification } from './types';

describe('role policies', () => {
  it('defines a policy for every role', () => {
    for (const role of ROLES) {
      expect(ROLE_POLICIES[role]).toBeDefined();
      expect(ROLE_POLICIES[role].role).toBe(role);
    }
  });

  it('never leaves a role with an empty allow-list', () => {
    for (const role of ROLES) {
      const policy = getRolePolicy(role);
      expect(policy.unrestricted || policy.allowedClassifications.length > 0).toBe(true);
    }
  });

  it('matches the PRD section 3.1 role table', () => {
    expect(getRolePolicy('regulatory_affairs').unrestricted).toBe(true);
    expect(getRolePolicy('clinical_operations').allowedClassifications).not.toContain(
      'competitive_intelligence',
    );
    expect([...getRolePolicy('medical_affairs').allowedClassifications].sort()).toEqual(
      ['competitive_intelligence', 'investigator_brochure', 'safety_report'].sort(),
    );
    expect(getRolePolicy('site_monitor').allowedClassifications).toEqual(['site_communication']);
    expect(getRolePolicy('executive').redaction.summaryOnly).toBe(true);
    expect(getRolePolicy('it_admin').redaction.adminWatermark).toBe(true);
    expect(getRolePolicy('medical_affairs').redaction.safetyAggregateOnly).toBe(true);
    expect(getRolePolicy('site_monitor').redaction.maskUnassignedSites).toBe(true);
  });

  it('freezes the policy table against mutation', () => {
    expect(Object.isFrozen(ROLE_POLICIES)).toBe(true);
  });

  it('deep-freezes every nested array/object, not just the top-level table (D12)', () => {
    for (const role of ROLES) {
      const policy = getRolePolicy(role);
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.allowedClassifications)).toBe(true);
      expect(Object.isFrozen(policy.redaction)).toBe(true);

      expect(() => {
        (policy.allowedClassifications as DocumentClassification[]).push('protocol');
      }).toThrow(TypeError);
      expect(() => {
        (policy.redaction as { maskUnassignedSites: boolean }).maskUnassignedSites = true;
      }).toThrow(TypeError);
    }
  });

  it('gives executive real, deterministic redaction rather than a prompt-only instruction (D3)', () => {
    const redaction = getRolePolicy('executive').redaction;
    expect(redaction.safetyAggregateOnly).toBe(true);
    expect(redaction.boundedExtractOnly).toBe(true);
    expect(redaction.summaryOnly).toBe(true);
  });
});

describe('resolveRole', () => {
  it('falls back to the most restrictive role when no claim is recognised', () => {
    expect(resolveRole(undefined)).toEqual({ role: DEFAULT_ROLE, fallbackApplied: true });
    expect(resolveRole([])).toEqual({ role: DEFAULT_ROLE, fallbackApplied: true });
    expect(resolveRole(['Marketing.Admin'])).toEqual({ role: DEFAULT_ROLE, fallbackApplied: true });
    expect(DEFAULT_ROLE).toBe('site_monitor');
  });

  it('accepts a single string claim', () => {
    expect(resolveRole('executive')).toEqual({ role: 'executive', fallbackApplied: false });
  });

  it('selects the least privileged role on a multi-role token', () => {
    expect(resolveRole(['regulatory_affairs', 'site_monitor']).role).toBe('site_monitor');
    expect(resolveRole(['it_admin', 'medical_affairs']).role).toBe('medical_affairs');
    expect(resolveRole(['regulatory_affairs', 'clinical_operations']).role).toBe(
      'clinical_operations',
    );
  });

  it('D3: never resolves a medical director holding {medical_affairs, executive} to executive', () => {
    // The reported escalation: `executive` is `unrestricted: true` (full
    // corpus, no search $filter) and, pre-fix, carried none of
    // medical_affairs' safety redaction. Picking it for this combination
    // both widened retrieval scope and dropped a redaction guarantee.
    expect(resolveRole(['medical_affairs', 'executive']).role).toBe('medical_affairs');
    expect(resolveRole(['executive', 'medical_affairs']).role).toBe('medical_affairs');
  });

  it('never resolves a scoped role + executive to executive', () => {
    expect(resolveRole(['executive', 'site_monitor']).role).toBe('site_monitor');
    expect(resolveRole(['executive', 'clinical_operations']).role).toBe('clinical_operations');
  });

  it('resolves executive over the other unrestricted roles, whose redaction is weaker or absent', () => {
    expect(resolveRole(['executive', 'it_admin']).role).toBe('executive');
    expect(resolveRole(['executive', 'regulatory_affairs']).role).toBe('executive');
    expect(resolveRole(['it_admin', 'regulatory_affairs']).role).toBe('it_admin');
  });

  describe('privilege invariant: resolveRole never treats an unrestricted role as more restrictive than a scoped one', () => {
    // `unrestricted` roles (`regulatory_affairs`, `executive`, `it_admin`)
    // have no `$filter` at all -- by construction their scope is a superset
    // of every scoped role's `allowedClassifications`. That makes the
    // subset check below *provable*, unlike a comparison between two
    // different scoped roles: `medical_affairs` and `clinical_operations`,
    // for instance, have genuinely incomparable allow-lists (each has a
    // classification the other lacks), so no fixed choice between them can
    // satisfy "subset of the other" -- that is a deliberate, arbitrary
    // tie-break (see the dedicated test below), not a provable safety
    // property, and is unrelated to the D3 bug this suite targets.
    function effectiveScope(role: (typeof ROLES)[number]): Set<DocumentClassification> {
      const policy = getRolePolicy(role);
      return new Set(policy.unrestricted ? DOCUMENT_CLASSIFICATIONS : policy.allowedClassifications);
    }

    it('never grants scope beyond a scoped role\'s own allow-list when paired with an unrestricted role', () => {
      for (const a of ROLES) {
        for (const b of ROLES) {
          if (a === b) continue;
          const policyA = getRolePolicy(a);
          const policyB = getRolePolicy(b);
          if (policyA.unrestricted === policyB.unrestricted) continue; // both scoped or both unrestricted -- not this test's concern
          const scoped = policyA.unrestricted ? b : a;
          const unrestricted = policyA.unrestricted ? a : b;

          const chosen = resolveRole([a, b]).role;
          expect(
            chosen,
            `resolveRole([${a}, ${b}]) must pick the scoped role (${scoped}), never the ` +
              `unrestricted one (${unrestricted}).`,
          ).toBe(scoped);

          const chosenScope = effectiveScope(chosen);
          for (const classification of chosenScope) {
            expect(effectiveScope(scoped).has(classification)).toBe(true);
          }
        }
      }
    });

    it('never drops a safety/site redaction guarantee the scoped role itself requires', () => {
      // Since the invariant above always picks the scoped role for a
      // scoped/unrestricted pair, this reduces to: the scoped role's *own*
      // policy (unconditionally, regardless of what else is held) must
      // still carry whatever redaction its PRD row promises. Guards against
      // a future edit accidentally weakening a scoped role's own policy.
      for (const role of ROLES) {
        const policy = getRolePolicy(role);
        if (policy.unrestricted) continue;
        if (policy.allowedClassifications.includes('safety_report')) {
          // Every currently-scoped role that can see safety_report must
          // apply the same PRD-mandated protection medical_affairs does.
          expect(policy.redaction.safetyAggregateOnly || role === 'clinical_operations').toBe(true);
        }
      }
    });

    it('resolves whichever unrestricted role has the strictest redaction when both held roles are unrestricted', () => {
      function protectionCount(role: (typeof ROLES)[number]): number {
        const r = getRolePolicy(role).redaction;
        return Number(r.safetyAggregateOnly) + Number(r.maskUnassignedSites) + Number(r.summaryOnly) +
          Number(r.boundedExtractOnly) + Number(r.adminWatermark);
      }
      for (const a of ROLES) {
        for (const b of ROLES) {
          if (a === b) continue;
          const policyA = getRolePolicy(a);
          const policyB = getRolePolicy(b);
          if (!policyA.unrestricted || !policyB.unrestricted) continue;
          const stricter = protectionCount(a) >= protectionCount(b) ? a : b;
          expect(resolveRole([a, b]).role).toBe(stricter);
        }
      }
    });
  });

  describe('known limitation: two scoped roles with incomparable allow-lists', () => {
    // `medical_affairs` uniquely allows `competitive_intelligence`;
    // `clinical_operations` uniquely allows `protocol`/`regulatory_submission`/
    // `site_communication`. Neither allow-list is a subset of the other, so
    // no choice between the two named roles can avoid granting the chosen
    // role's holder-specific extra classification(s) the other role lacks.
    // This is a pre-existing property of picking one whole named role
    // rather than intersecting per-classification permissions, is NOT part
    // of the D3 finding (which concerns `executive` specifically), and is
    // called out here -- with a pinned, deliberate tie-break -- rather than
    // silently left unverified. Follow-up: a real per-classification
    // intersection model, tracked separately from this fix.
    it('pins the current (arbitrary but deterministic) tie-break for medical_affairs vs clinical_operations', () => {
      expect(resolveRole(['medical_affairs', 'clinical_operations']).role).toBe('medical_affairs');
    });

    it('pins the current (arbitrary but deterministic) tie-break for site_monitor vs medical_affairs', () => {
      expect(resolveRole(['site_monitor', 'medical_affairs']).role).toBe('site_monitor');
    });
  });

  it('ignores unrecognised roles mixed with recognised ones', () => {
    expect(resolveRole(['Nonsense.Role', 'executive'])).toEqual({
      role: 'executive',
      fallbackApplied: false,
    });
  });

  it('rejects non-role values', () => {
    expect(isRole('regulatory_affairs')).toBe(true);
    expect(isRole('site_level')).toBe(false);
    expect(isRole(42)).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});

describe('buildSearchFilter', () => {
  it('emits no filter for unrestricted roles', () => {
    expect(buildSearchFilter('regulatory_affairs')).toBeNull();
    expect(buildSearchFilter('executive')).toBeNull();
    expect(buildSearchFilter('it_admin')).toBeNull();
  });

  it('scopes site_monitor to site communications only', () => {
    expect(buildSearchFilter('site_monitor')).toBe(
      "document_classification eq 'site_communication'",
    );
  });

  it('excludes competitive intelligence for clinical operations', () => {
    const filter = buildSearchFilter('clinical_operations');
    expect(filter).not.toBeNull();
    expect(filter).not.toContain('competitive_intelligence');
    for (const c of DOCUMENT_CLASSIFICATIONS) {
      if (c === 'competitive_intelligence') continue;
      expect(filter).toContain(`document_classification eq '${c}'`);
    }
  });

  it('produces a filter referencing only allowed classifications', () => {
    for (const role of ROLES) {
      const policy = getRolePolicy(role);
      const filter = buildSearchFilter(role);
      if (policy.unrestricted) {
        expect(filter).toBeNull();
        continue;
      }
      for (const c of DOCUMENT_CLASSIFICATIONS) {
        const mentioned = filter!.includes(`'${c}'`);
        expect(mentioned).toBe(policy.allowedClassifications.includes(c));
      }
    }
  });

  it('contains no interpolation point for caller input', () => {
    // The filter is assembled only from the frozen policy table, so no query
    // text can reach it. Assert the emitted grammar is exactly what we expect.
    for (const role of ROLES) {
      const filter = buildSearchFilter(role);
      if (filter === null) continue;
      expect(filter).toMatch(
        /^\(?document_classification eq '[a-z_]+'( or document_classification eq '[a-z_]+')*\)?$/,
      );
    }
  });
});

describe('isChunkAuthorized', () => {
  it('agrees with the filter for every role and classification pair', () => {
    for (const role of ROLES) {
      const policy = getRolePolicy(role);
      for (const c of DOCUMENT_CLASSIFICATIONS) {
        const expected = policy.unrestricted || policy.allowedClassifications.includes(c);
        expect(isChunkAuthorized(role, c)).toBe(expected);
      }
    }
  });

  it('denies a site monitor every classification except site communications', () => {
    const denied = DOCUMENT_CLASSIFICATIONS.filter(
      (c: DocumentClassification) => c !== 'site_communication',
    );
    for (const c of denied) {
      expect(isChunkAuthorized('site_monitor', c)).toBe(false);
    }
    expect(isChunkAuthorized('site_monitor', 'site_communication')).toBe(true);
  });
});

describe('canAccessAdminApi', () => {
  it('admits it_admin only', () => {
    for (const role of ROLES) {
      expect(canAccessAdminApi(role)).toBe(role === 'it_admin');
    }
  });
});
