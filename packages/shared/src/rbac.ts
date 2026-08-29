/**
 * Role-based access control policy.
 *
 * Per PRD decision 1, RBAC is enforced *inside* the Azure AI Search query via
 * an OData $filter, never as an application-side post-filter. Post-filtering
 * leaks information through result counts and ranking positions.
 *
 * The filter is assembled exclusively from the constants in this file. No
 * caller-controlled string ever reaches the filter expression.
 */
import {
  DOCUMENT_CLASSIFICATIONS,
  type DocumentClassification,
  type Role,
  ROLES,
} from './types';

export interface RedactionPolicy {
  /** Strip patient identifiers and per-patient narrative from safety reports. */
  safetyAggregateOnly: boolean;
  /** Mask site names/codes unless the site is assigned to the caller. */
  maskUnassignedSites: boolean;
  /** Suppress verbatim document text; answer with summary + metrics only. */
  summaryOnly: boolean;
  /**
   * Structurally bound every chunk's content to a short, sentence-level
   * excerpt *before* it reaches the prompt (see `redactChunksForRole` in
   * `pipeline/redaction.ts`). `summaryOnly` alone is only a generation-time
   * instruction the model could ignore or fail to honour; this is the
   * deterministic backstop that makes "full document text redacted" (PRD
   * 3.1, ADR 0002) actually true rather than a prompt-only promise.
   */
  boundedExtractOnly: boolean;
  /** Prefix every answer with an admin-access watermark. */
  adminWatermark: boolean;
}

export interface RolePolicy {
  role: Role;
  /** Classifications the role may retrieve. Empty array is never valid. */
  allowedClassifications: readonly DocumentClassification[];
  /** True when the role may retrieve every classification (no $filter needed). */
  unrestricted: boolean;
  redaction: RedactionPolicy;
  /** Maximum chunks fed to the generator for this role. */
  maxChunks: number;
  description: string;
}

const NO_REDACTION: RedactionPolicy = {
  safetyAggregateOnly: false,
  maskUnassignedSites: false,
  summaryOnly: false,
  boundedExtractOnly: false,
  adminWatermark: false,
};

const ALL: readonly DocumentClassification[] = DOCUMENT_CLASSIFICATIONS;

/**
 * Recursively freeze an object graph. `Object.freeze` is shallow: without
 * this, `ROLE_POLICIES.site_monitor.redaction.maskUnassignedSites = false`
 * or `ROLE_POLICIES.medical_affairs.allowedClassifications.push(...)` would
 * both silently succeed in non-strict code and permanently corrupt the
 * frozen-looking policy table for the lifetime of the process.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value as object)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const ROLE_POLICIES: Readonly<Record<Role, RolePolicy>> = deepFreeze({
  regulatory_affairs: {
    role: 'regulatory_affairs',
    allowedClassifications: ALL,
    unrestricted: true,
    redaction: { ...NO_REDACTION },
    maxChunks: 8,
    description: 'Full corpus access, no redaction.',
  },
  clinical_operations: {
    role: 'clinical_operations',
    allowedClassifications: ALL.filter((c) => c !== 'competitive_intelligence'),
    unrestricted: false,
    redaction: { ...NO_REDACTION },
    maxChunks: 8,
    description: 'All classifications except competitive intelligence.',
  },
  medical_affairs: {
    role: 'medical_affairs',
    allowedClassifications: [
      'investigator_brochure',
      'safety_report',
      'competitive_intelligence',
    ],
    unrestricted: false,
    redaction: { ...NO_REDACTION, safetyAggregateOnly: true },
    maxChunks: 8,
    description:
      'Investigator brochures, safety reports and competitive intelligence; safety data aggregated.',
  },
  site_monitor: {
    role: 'site_monitor',
    allowedClassifications: ['site_communication'],
    unrestricted: false,
    redaction: { ...NO_REDACTION, maskUnassignedSites: true },
    maxChunks: 6,
    description: 'Site communications only; unassigned site identifiers masked.',
  },
  executive: {
    role: 'executive',
    allowedClassifications: ALL,
    unrestricted: true,
    // D3: `summaryOnly` alone was a generation-time instruction over
    // completely unredacted chunk text -- a model could ignore it, and it
    // contradicted PRD 3.1 ("Full document text redacted; only summaries
    // and metrics shown") and ADR 0002 ("no verbatim document text"), which
    // in turn used that false premise to justify ranking `executive` as
    // more restrictive than `medical_affairs`/`clinical_operations`. Real,
    // deterministic redaction now backs the same claim: safety PII is
    // stripped exactly as it is for `medical_affairs`, and every chunk is
    // structurally bounded to a short excerpt before the prompt is built
    // (see `boundedExtractOnly` in `pipeline/redaction.ts`).
    redaction: { ...NO_REDACTION, safetyAggregateOnly: true, summaryOnly: true, boundedExtractOnly: true },
    maxChunks: 10,
    description: 'Full corpus for synthesis, but answers are summary-only and never verbatim.',
  },
  it_admin: {
    role: 'it_admin',
    allowedClassifications: ALL,
    unrestricted: true,
    redaction: { ...NO_REDACTION, adminWatermark: true },
    maxChunks: 8,
    description: 'Full corpus for support purposes; answers watermarked.',
  },
});

/** The role assigned when the JWT carries no recognised app role. */
export const DEFAULT_ROLE: Role = 'site_monitor';

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function getRolePolicy(role: Role): RolePolicy {
  return ROLE_POLICIES[role];
}

/**
 * Resolve the effective role from the JWT `roles` claim.
 *
 * When a caller holds several app roles we deliberately pick the *least*
 * privileged one. Escalating on a multi-role token would let an over-provisioned
 * account silently gain access it was never reviewed for.
 */
export function resolveRole(claimRoles: unknown): {
  role: Role;
  fallbackApplied: boolean;
} {
  const list = Array.isArray(claimRoles)
    ? claimRoles
    : typeof claimRoles === 'string'
      ? [claimRoles]
      : [];
  const recognised = list.filter(isRole);
  if (recognised.length === 0) {
    return { role: DEFAULT_ROLE, fallbackApplied: true };
  }
  // Ascending privilege order; index 0 is the most restrictive.
  //
  // D3: this must rank roles by *effective retrieval scope*
  // (`allowedClassifications` / `unrestricted`), not by how the role's
  // answers happen to be shaped. `executive` is `unrestricted: true` --
  // the same raw retrieval scope as `it_admin`/`regulatory_affairs` -- so it
  // belongs alongside them at the least-restrictive end, never ahead of a
  // role with a real, narrow allow-list. Putting it ahead of
  // `medical_affairs` (as a previous version of this list did) let a
  // multi-role holder of {medical_affairs, executive} resolve to
  // `executive`: `buildSearchFilter('executive')` returns `null` (no
  // filter), widening retrieval to `protocol`/`regulatory_submission`/
  // `site_communication` chunks `medical_affairs` alone could never see,
  // while also (pre-fix) dropping the `safetyAggregateOnly` PII stripping
  // `medical_affairs` guarantees. See the "privilege invariant" tests in
  // rbac.test.ts for the property this ordering must maintain for every
  // pair of roles.
  //
  // Within the three roles that share the same unrestricted scope, ties are
  // broken by redaction strictness (most protections first): `executive`'s
  // policy now genuinely restricts the answer shape and safety content;
  // `it_admin`'s only "restriction" is an answer watermark, not a content
  // restriction; `regulatory_affairs` has none at all.
  const privilegeOrder: Role[] = [
    'site_monitor',
    'medical_affairs',
    'clinical_operations',
    'executive',
    'it_admin',
    'regulatory_affairs',
  ];
  let chosen = recognised[0] as Role;
  let chosenRank = privilegeOrder.indexOf(chosen);
  for (const candidate of recognised) {
    const rank = privilegeOrder.indexOf(candidate);
    if (rank < chosenRank) {
      chosen = candidate;
      chosenRank = rank;
    }
  }
  return { role: chosen, fallbackApplied: false };
}

/** Escape a literal for safe inclusion in an OData string. */
function odataLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the OData `$filter` for a role.
 *
 * Returns `null` for unrestricted roles, meaning no filter clause is sent.
 * Every value in the expression originates from ROLE_POLICIES, so the output
 * is not influenced by user input.
 */
export function buildSearchFilter(role: Role): string | null {
  const policy = getRolePolicy(role);
  if (policy.unrestricted) return null;
  const allowed = policy.allowedClassifications;
  if (allowed.length === 0) {
    // Defensive: an empty allow-list must match nothing, never everything.
    return 'document_classification eq null and document_classification ne null';
  }
  const clauses = allowed.map(
    (c) => `document_classification eq ${odataLiteral(c)}`,
  );
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' or ')})`;
}

/**
 * Independent authorisation check used as defence in depth after retrieval.
 * The search filter should already guarantee this; a violation here means a
 * filter bug and must be treated as an incident.
 */
export function isChunkAuthorized(
  role: Role,
  classification: DocumentClassification,
): boolean {
  const policy = getRolePolicy(role);
  if (policy.unrestricted) return true;
  return policy.allowedClassifications.includes(classification);
}

/** Roles permitted to call the /api/admin/* endpoints. */
export function canAccessAdminApi(role: Role): boolean {
  return role === 'it_admin';
}
