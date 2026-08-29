import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH } from './constants';
import {
  documentIdSchema,
  feedbackRequestSchema,
  queryRequestSchema,
  reindexRequestSchema,
  sharePointNotificationSchema,
  usageQuerySchema,
} from './schemas';

describe('queryRequestSchema', () => {
  it('accepts a well-formed query', () => {
    const parsed = queryRequestSchema.parse({ query: '  What is the primary endpoint?  ' });
    expect(parsed.query).toBe('What is the primary endpoint?');
  });

  it('rejects an over-length query at the PRD cap', () => {
    expect(queryRequestSchema.safeParse({ query: 'a'.repeat(MAX_QUERY_LENGTH) }).success).toBe(true);
    expect(queryRequestSchema.safeParse({ query: 'a'.repeat(MAX_QUERY_LENGTH + 1) }).success).toBe(
      false,
    );
  });

  it('rejects empty and whitespace-only queries', () => {
    expect(queryRequestSchema.safeParse({ query: '' }).success).toBe(false);
    expect(queryRequestSchema.safeParse({ query: '   ' }).success).toBe(false);
  });

  it('rejects unknown keys so callers cannot smuggle fields', () => {
    const result = queryRequestSchema.safeParse({
      query: 'valid question',
      role: 'regulatory_affairs',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid conversation id', () => {
    expect(
      queryRequestSchema.safeParse({ query: 'valid question', conversation_id: 'abc' }).success,
    ).toBe(false);
  });
});

describe('reindexRequestSchema', () => {
  it('requires at least one selector', () => {
    expect(reindexRequestSchema.safeParse({}).success).toBe(false);
    expect(reindexRequestSchema.safeParse({ full: true }).success).toBe(true);
    expect(reindexRequestSchema.safeParse({ document_ids: ['sp-prot-0001'] }).success).toBe(true);
    expect(reindexRequestSchema.safeParse({ classification: 'protocol' }).success).toBe(true);
  });

  it('rejects an unknown classification', () => {
    expect(reindexRequestSchema.safeParse({ classification: 'site_level' }).success).toBe(false);
  });

  it('caps the document id batch', () => {
    const ids = Array.from({ length: 501 }, (_, i) => `doc-${i}`);
    expect(reindexRequestSchema.safeParse({ document_ids: ids }).success).toBe(false);
  });
});

describe('usageQuerySchema', () => {
  it('validates ISO dates and known roles', () => {
    expect(usageQuerySchema.safeParse({ from: '2026-08-01', to: '2026-08-28' }).success).toBe(true);
    expect(usageQuerySchema.safeParse({ from: '08/01/2026' }).success).toBe(false);
    expect(usageQuerySchema.safeParse({ role: 'nope' }).success).toBe(false);
  });
});

describe('feedbackRequestSchema', () => {
  it('accepts up and down only', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(feedbackRequestSchema.safeParse({ turn_id: id, feedback: 'up' }).success).toBe(true);
    expect(feedbackRequestSchema.safeParse({ turn_id: id, feedback: 'meh' }).success).toBe(false);
  });
});

describe('documentIdSchema', () => {
  it('rejects path traversal and injection characters', () => {
    expect(documentIdSchema.safeParse('sp-prot-0001').success).toBe(true);
    expect(documentIdSchema.safeParse('../../etc/passwd').success).toBe(false);
    expect(documentIdSchema.safeParse("x' or '1'='1").success).toBe(false);
    expect(documentIdSchema.safeParse('').success).toBe(false);
  });
});

describe('sharePointNotificationSchema', () => {
  it('parses a notification batch', () => {
    const parsed = sharePointNotificationSchema.parse({
      value: [{ subscriptionId: 'sub-1', clientState: 'secret', resource: 'drives/1/root' }],
    });
    expect(parsed.value).toHaveLength(1);
  });

  it('caps the batch size', () => {
    const value = Array.from({ length: 101 }, (_, i) => ({
      subscriptionId: `s${i}`,
      resource: 'r',
    }));
    expect(sharePointNotificationSchema.safeParse({ value }).success).toBe(false);
  });
});
