import type { CallerIdentity, ScoredChunk } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_WATERMARK_TEXT,
  applyAdminWatermark,
  buildPromptDirectives,
  buildRedactionNotice,
  findSiteCode,
  maskUnassignedSiteCodes,
  redactChunksForRole,
  stripPatientIdentifiers,
  SUMMARY_ONLY_MARKER,
  truncateToBoundedExtract,
} from './redaction';

function chunk(overrides: Partial<ScoredChunk>): ScoredChunk {
  return {
    chunk_id: 'c1',
    document_id: 'd1',
    document_title: 'Some Document',
    document_classification: 'safety_report',
    document_version: '1.0',
    content: 'content',
    content_hash: 'hash',
    heading_path: 'heading',
    page_number: 1,
    source_url: 'https://example.com/doc',
    ingested_at: '2026-01-01T00:00:00Z',
    site_code: null,
    previous_version_hash: null,
    similarity_score: 0.9,
    ...overrides,
  };
}

function identity(overrides: Partial<CallerIdentity>): CallerIdentity {
  return {
    user_principal_name: 'user@meridiantx.com',
    object_id: 'oid',
    tenant_id: 'tid',
    name: 'User',
    role: 'medical_affairs',
    role_fallback_applied: false,
    assigned_sites: [],
    ...overrides,
  };
}

describe('stripPatientIdentifiers', () => {
  it('redacts a participant id, age/sex combination, from real corpus text', () => {
    const source =
      'Participant 014-0032, a 61-year-old male, experienced Grade 4 infusion-related reaction on Cycle 1 Day 1.';
    const { text, changed } = stripPatientIdentifiers(source);
    expect(changed).toBe(true);
    expect(text).not.toContain('014-0032');
    expect(text).not.toContain('61-year-old');
    expect(text).toBe(
      'Participant [PARTICIPANT ID REDACTED], a [AGE/SEX REDACTED], experienced Grade 4 infusion-related reaction on Cycle 1 Day 1.',
    );
  });

  it('redacts a participant id and initials, from real corpus text', () => {
    const source = 'Participant 027-0011, initials J.M., experienced Grade 3 hypertension requiring dose interruption.';
    const { text, changed } = stripPatientIdentifiers(source);
    expect(changed).toBe(true);
    expect(text).not.toContain('027-0011');
    expect(text).not.toContain('J.M.');
    expect(text).toContain('[PARTICIPANT ID REDACTED]');
    expect(text).toContain('[INITIALS REDACTED]');
  });

  it('redacts a participant id and date of birth, from real corpus text', () => {
    const source = 'Participant 003-0007, date of birth 14 March 1958, experienced a Grade 4 pneumonitis SUSAR.';
    const { text, changed } = stripPatientIdentifiers(source);
    expect(changed).toBe(true);
    expect(text).not.toContain('003-0007');
    expect(text).not.toContain('1958');
    expect(text).toContain('[DATE OF BIRTH REDACTED]');
  });

  it('leaves aggregate SOC counts untouched', () => {
    const source =
      'Skin and subcutaneous tissue disorders were reported in 218 events during Q2 2026. ' +
      'Gastrointestinal disorders were reported in 141 events during Q2 2026.';
    const { text, changed } = stripPatientIdentifiers(source);
    expect(changed).toBe(false);
    expect(text).toBe(source);
  });

  it('leaves serious adverse event aggregate counts untouched', () => {
    const source =
      'There were 34 serious adverse events reported in Q2 2026. ' +
      'Six serious adverse events were assessed as related to revarafusp alfa.';
    const { text, changed } = stripPatientIdentifiers(source);
    expect(changed).toBe(false);
    expect(text).toBe(source);
  });
});

describe('maskUnassignedSiteCodes', () => {
  it('masks a site code the caller is not assigned to', () => {
    const { text, changed } = maskUnassignedSiteCodes(
      'Site US-027 reported a major protocol deviation on 27 May 2026.',
      ['US-014'],
    );
    expect(changed).toBe(true);
    expect(text).toBe('Site [SITE REDACTED] reported a major protocol deviation on 27 May 2026.');
  });

  it('leaves an assigned site code untouched', () => {
    const { text, changed } = maskUnassignedSiteCodes(
      'An interim monitoring visit was conducted at site US-014 on 18 June 2026.',
      ['US-014'],
    );
    expect(changed).toBe(false);
    expect(text).toBe('An interim monitoring visit was conducted at site US-014 on 18 June 2026.');
  });

  it('masks multiple distinct unassigned site codes', () => {
    const { text, changed } = maskUnassignedSiteCodes('Sites US-027 and EU-003 both reported delays.', ['US-014']);
    expect(changed).toBe(true);
    expect(text).toBe('Sites [SITE REDACTED] and [SITE REDACTED] both reported delays.');
  });

  it('masks a lowercase site code the same as an uppercase one (regex is case-insensitive)', () => {
    const { text, changed } = maskUnassignedSiteCodes('see site-us-027-protocol-deviation-notice.md', ['US-014']);
    expect(changed).toBe(true);
    expect(text).toBe('see site-[SITE REDACTED]-protocol-deviation-notice.md');
  });

  it('does not mask an assigned site code even when it appears lowercase', () => {
    const { text, changed } = maskUnassignedSiteCodes('see site-us-014-monitoring-visit-followup.md', ['US-014']);
    expect(changed).toBe(false);
    expect(text).toBe('see site-us-014-monitoring-visit-followup.md');
  });
});

describe('findSiteCode', () => {
  it('finds and upper-cases a site code embedded in a document title', () => {
    expect(findSiteCode('Site US-027 Protocol Deviation Notice')).toBe('US-027');
  });

  it('finds a lowercase site code embedded in a filename slug', () => {
    expect(findSiteCode('site-us-027-protocol-deviation-notice.md')).toBe('US-027');
  });

  it('returns null when no site code is present (e.g. a cross-site newsletter)', () => {
    expect(findSiteCode('AXIOM Investigator Newsletter June 2026')).toBeNull();
  });
});

describe('truncateToBoundedExtract', () => {
  it('leaves short content (within the sentence and char bounds) unchanged', () => {
    const { text, changed } = truncateToBoundedExtract('Enrollment is 480 participants.');
    expect(changed).toBe(false);
    expect(text).toBe('Enrollment is 480 participants.');
  });

  it('keeps only the first two sentences of a longer passage', () => {
    const source =
      'Enrollment is 480 participants. The primary endpoint is overall survival. ' +
      'Dosing occurs every three weeks. A single interim analysis is planned.';
    const { text, changed } = truncateToBoundedExtract(source);
    expect(changed).toBe(true);
    expect(text).toBe('Enrollment is 480 participants. The primary endpoint is overall survival.');
    expect(text).not.toContain('interim analysis');
  });

  it('hard-cuts a single sentence that exceeds the character bound', () => {
    const longSentence = `This is a very long single sentence that goes on and on. ${'word '.repeat(100)}`.trim();
    const { text, changed } = truncateToBoundedExtract(longSentence);
    expect(changed).toBe(true);
    expect(text.length).toBeLessThanOrEqual(320);
  });

  it('keeps the sentences most relevant to the query, not simply the first two (regression: eval G21)', () => {
    // The fact actually asked about is the chunk's *third* sentence -- a
    // naive "first two sentences" bound would drop it every time,
    // regardless of what was actually asked. This is exactly the ib-0002
    // passage eval/goldens.json's G21 case exercises end-to-end.
    const source =
      'This section presents the reference safety information for revarafusp alfa as of Edition 6. ' +
      'Edition 6 adds Grade 3 or higher hypertension as an identified risk. ' +
      'Edition 6 revises Grade 3 or higher acneiform dermatitis incidence to 13 percent. ' +
      'Investigators should review Section 7 for updated dose modification guidance.';
    const query = 'What is the revised Grade 3 or higher acneiform dermatitis incidence percentage for revarafusp alfa?';
    const { text, changed } = truncateToBoundedExtract(source, query);
    expect(changed).toBe(true);
    expect(text).toContain('acneiform dermatitis incidence to 13 percent');
  });

  it('skips a long, lower-priority sentence that would blow the character budget rather than hard-cutting it ahead of a short, higher-priority one (regression: eval G21, real corpus text)', () => {
    // The exact investigator-brochure-edition-6.md passage: the highest-
    // scoring sentence (13 percent) is short and appears *after* a much
    // longer, second-highest-scoring sentence about the hypertension
    // signal mechanism. Reassembling in original order and then hard-
    // cutting at 320 chars used to truncate the short, most-relevant
    // sentence mid-word because the long one was serialised first.
    const source =
      'This section presents the reference safety information for revarafusp alfa as of Edition 6, updated ' +
      'following additional exposure accrued across AXIOM-HN01 and AXIOM-HN02 and summarized in the 2026 ' +
      'Development Safety Update Report. Edition 6 adds Grade 3 or higher hypertension as an identified risk. ' +
      'This follows signal evaluation that identified a numerically higher rate of hypertension in revarafusp ' +
      'alfa-treated participants relative to background rates in this population, consistent with on-target ' +
      'TGF-beta pathway inhibition, which is mechanistically linked to blood pressure regulation. ' +
      'Edition 6 revises Grade 3 or higher acneiform dermatitis incidence to 13 percent. This reflects the ' +
      'larger, more mature safety database now available compared with Edition 5. Infusion-related reactions ' +
      'remain an identified risk requiring premedication. Extended post-infusion observation, described in the ' +
      'current protocol, further mitigates this risk. Hypomagnesemia remains an expected adverse reaction and ' +
      'continues to be manageable with supplementation. Investigators should review Section 7 for updated dose ' +
      'modification guidance corresponding to these safety updates.';
    const query = 'What is the revised Grade 3 or higher acneiform dermatitis incidence percentage for revarafusp alfa?';
    const { text } = truncateToBoundedExtract(source, query);
    expect(text).toContain('Edition 6 revises Grade 3 or higher acneiform dermatitis incidence to 13 percent.');
    expect(text.length).toBeLessThanOrEqual(320);
  });

  it('falls back to the first N sentences (original order) when the query has no term overlap at all', () => {
    const source =
      'Enrollment is 480 participants. The primary endpoint is overall survival. ' +
      'Dosing occurs every three weeks. A single interim analysis is planned.';
    const { text } = truncateToBoundedExtract(source, 'completely unrelated words with zero overlap');
    expect(text).toBe('Enrollment is 480 participants. The primary endpoint is overall survival.');
  });
});

describe('redactChunksForRole', () => {
  it('applies safety_aggregate_only for medical_affairs on safety_report chunks only', () => {
    const chunks = [
      chunk({
        document_classification: 'safety_report',
        content: 'Participant 014-0032, a 61-year-old male, experienced a reaction.',
      }),
      chunk({
        chunk_id: 'c2',
        document_classification: 'investigator_brochure',
        content: 'Participant 014-0032 information should not be redacted here (not a safety_report chunk).',
      }),
    ];
    const result = redactChunksForRole('medical_affairs', identity({ role: 'medical_affairs' }), chunks);
    expect(result.redactionsApplied).toEqual(['safety_aggregate_only']);
    expect(result.chunks[0]?.content).not.toContain('014-0032');
    expect(result.chunks[1]?.content).toContain('014-0032');
  });

  it('applies mask_unassigned_sites for site_monitor', () => {
    const chunks = [
      chunk({
        document_classification: 'site_communication',
        document_title: 'Site US-027 Protocol Deviation Notice',
        content: 'Site US-027 reported a major protocol deviation.',
        site_code: 'US-027',
      }),
    ];
    const result = redactChunksForRole(
      'site_monitor',
      identity({ role: 'site_monitor', assigned_sites: ['US-014'] }),
      chunks,
    );
    expect(result.redactionsApplied).toEqual(['mask_unassigned_sites']);
    expect(result.chunks[0]?.content).not.toContain('US-027');
    expect(result.chunks[0]?.document_title).not.toContain('US-027');
  });

  it('does not mask a site_monitor chunk for the caller\'s own assigned site', () => {
    const chunks = [
      chunk({
        document_classification: 'site_communication',
        document_title: 'Site US-014 Monitoring Visit Follow-up Letter',
        content: 'An interim monitoring visit was conducted at site US-014.',
        site_code: 'US-014',
      }),
    ];
    const result = redactChunksForRole(
      'site_monitor',
      identity({ role: 'site_monitor', assigned_sites: ['US-014'] }),
      chunks,
    );
    expect(result.redactionsApplied).toEqual([]);
    expect(result.chunks[0]?.content).toContain('US-014');
  });

  it('is a no-op for roles with no chunk-level redaction policy', () => {
    const chunks = [chunk({ document_classification: 'protocol', content: 'Enrollment is 480 participants.' })];
    const result = redactChunksForRole('regulatory_affairs', identity({ role: 'regulatory_affairs' }), chunks);
    expect(result.redactionsApplied).toEqual([]);
    expect(result.chunks[0]).toBe(chunks[0]);
  });

  it('D1: suppresses source_url and masks heading_path for a site_monitor chunk outside the assigned sites', () => {
    const chunks = [
      chunk({
        document_classification: 'site_communication',
        document_title: 'Site US-027 Protocol Deviation Notice',
        heading_path: 'Site US-027 Protocol Deviation Notice > Summary',
        content: 'Site US-027 reported a major protocol deviation.',
        source_url: 'https://meridiantx.sharepoint.com/sites/trials/site-us-027-protocol-deviation-notice.md',
        site_code: 'US-027',
      }),
    ];
    const result = redactChunksForRole(
      'site_monitor',
      identity({ role: 'site_monitor', assigned_sites: ['US-014'] }),
      chunks,
    );
    expect(result.redactionsApplied).toEqual(['mask_unassigned_sites']);
    expect(result.chunks[0]?.source_url).toBe('');
    expect(result.chunks[0]?.heading_path).not.toContain('US-027');
  });

  it('D1: never suppresses source_url for the caller\'s own assigned site', () => {
    const chunks = [
      chunk({
        document_classification: 'site_communication',
        document_title: 'Site US-014 Monitoring Visit Follow-up Letter',
        heading_path: 'Site US-014 Monitoring Visit Follow-up Letter > Summary',
        content: 'An interim monitoring visit was conducted at site US-014.',
        source_url: 'https://meridiantx.sharepoint.com/sites/trials/site-us-014-monitoring-visit-followup.md',
        site_code: 'US-014',
      }),
    ];
    const result = redactChunksForRole(
      'site_monitor',
      identity({ role: 'site_monitor', assigned_sites: ['US-014'] }),
      chunks,
    );
    expect(result.redactionsApplied).toEqual([]);
    expect(result.chunks[0]?.source_url).toBe(
      'https://meridiantx.sharepoint.com/sites/trials/site-us-014-monitoring-visit-followup.md',
    );
  });

  it('D1: never suppresses source_url for a chunk with no site_code at all', () => {
    const chunks = [
      chunk({
        document_classification: 'site_communication',
        content: 'A general reminder with no site-specific content.',
        source_url: 'https://meridiantx.sharepoint.com/sites/trials/general-reminder.md',
        site_code: null,
      }),
    ];
    const result = redactChunksForRole(
      'site_monitor',
      identity({ role: 'site_monitor', assigned_sites: ['US-014'] }),
      chunks,
    );
    expect(result.chunks[0]?.source_url).toBe('https://meridiantx.sharepoint.com/sites/trials/general-reminder.md');
  });

  it('D3: applies both safetyAggregateOnly and boundedExtractOnly for executive, deterministically', () => {
    const chunks = [
      chunk({
        document_classification: 'safety_report',
        content:
          'Participant 014-0032, a 61-year-old male, experienced a Grade 4 infusion-related reaction. ' +
          'Six serious adverse events were assessed as related to revarafusp alfa. ' +
          'A dose interruption was implemented per protocol. Recovery was documented within 14 days.',
      }),
    ];
    const result = redactChunksForRole('executive', identity({ role: 'executive' }), chunks);
    expect(result.redactionsApplied).toEqual(expect.arrayContaining(['safety_aggregate_only', 'bounded_extract_only']));
    expect(result.chunks[0]?.content).not.toContain('014-0032');
    expect(result.chunks[0]?.content).not.toContain('61-year-old');
    // Bounded to the first two (already-redacted) sentences -- never the
    // full verbatim document text, structurally, regardless of the prompt
    // instruction.
    expect(result.chunks[0]?.content).not.toContain('Recovery was documented');
  });

  it('D3: threads the query through to boundedExtractOnly so the relevant sentence survives truncation', () => {
    const chunks = [
      chunk({
        document_classification: 'protocol',
        content:
          'This section presents the reference safety information for revarafusp alfa as of Edition 6. ' +
          'Edition 6 adds Grade 3 or higher hypertension as an identified risk. ' +
          'Edition 6 revises Grade 3 or higher acneiform dermatitis incidence to 13 percent. ' +
          'Investigators should review Section 7 for updated dose modification guidance.',
      }),
    ];
    const result = redactChunksForRole(
      'executive',
      identity({ role: 'executive' }),
      chunks,
      'What is the revised Grade 3 or higher acneiform dermatitis incidence percentage for revarafusp alfa?',
    );
    expect(result.chunks[0]?.content).toContain('acneiform dermatitis incidence to 13 percent');
  });

  it('D3: bounds even non-safety content to a short excerpt for executive', () => {
    const chunks = [
      chunk({
        document_classification: 'protocol',
        content:
          'Planned enrollment is 528 participants across 104 sites. The primary endpoint is overall survival. ' +
          'Secondary endpoints include progression-free survival and objective response rate. ' +
          'The study uses a Simon two-stage design for the dose-expansion cohort.',
      }),
    ];
    const result = redactChunksForRole('executive', identity({ role: 'executive' }), chunks);
    expect(result.redactionsApplied).toEqual(['bounded_extract_only']);
    expect(result.chunks[0]?.content).not.toContain('Simon two-stage design');
  });
});

describe('buildPromptDirectives', () => {
  it('includes the summary-only marker for executive', () => {
    const directives = buildPromptDirectives('executive');
    expect(directives.some((d) => d.includes(SUMMARY_ONLY_MARKER))).toBe(true);
  });

  it('is empty for a role without generation-time directives', () => {
    expect(buildPromptDirectives('regulatory_affairs')).toEqual([]);
  });
});

describe('applyAdminWatermark', () => {
  it('prefixes the answer for it_admin', () => {
    const { text, applied } = applyAdminWatermark('it_admin', 'Here is the answer.');
    expect(applied).toBe(true);
    expect(text.startsWith(ADMIN_WATERMARK_TEXT)).toBe(true);
    expect(text).toContain('Here is the answer.');
  });

  it('is a no-op for other roles', () => {
    const { text, applied } = applyAdminWatermark('regulatory_affairs', 'Here is the answer.');
    expect(applied).toBe(false);
    expect(text).toBe('Here is the answer.');
  });
});

describe('buildRedactionNotice', () => {
  it('explains summary-only for executive', () => {
    const notice = buildRedactionNotice('executive', { drillDownRequested: false, redactionsApplied: [] });
    expect(notice).toMatch(/summary/i);
  });

  it('explains the drill-down denial for an executive drill-down request', () => {
    const notice = buildRedactionNotice('executive', { drillDownRequested: true, redactionsApplied: [] });
    expect(notice).toMatch(/drill-down/i);
  });

  it('explains the watermark for it_admin', () => {
    const notice = buildRedactionNotice('it_admin', { drillDownRequested: false, redactionsApplied: [] });
    expect(notice).toMatch(/watermark/i);
  });

  it('explains safety redaction only when it was actually applied', () => {
    expect(
      buildRedactionNotice('medical_affairs', { drillDownRequested: false, redactionsApplied: ['safety_aggregate_only'] }),
    ).toMatch(/patient-level/i);
    expect(buildRedactionNotice('medical_affairs', { drillDownRequested: false, redactionsApplied: [] })).toBeNull();
  });

  it('explains site masking only when it was actually applied', () => {
    expect(
      buildRedactionNotice('site_monitor', { drillDownRequested: false, redactionsApplied: ['mask_unassigned_sites'] }),
    ).toMatch(/site/i);
    expect(buildRedactionNotice('site_monitor', { drillDownRequested: false, redactionsApplied: [] })).toBeNull();
  });

  it('returns null for a role with no redaction policy at all', () => {
    expect(buildRedactionNotice('regulatory_affairs', { drillDownRequested: false, redactionsApplied: [] })).toBeNull();
  });
});
