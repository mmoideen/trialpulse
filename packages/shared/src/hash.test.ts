import { describe, expect, it } from 'vitest';
import { contentHash, embeddingCacheKey, normalizeText, queryHash, sha256 } from './hash';

describe('normalizeText', () => {
  it('collapses line endings, whitespace and case', () => {
    expect(normalizeText('Hello\r\nWorld')).toBe('hello\nworld');
    expect(normalizeText('a \t  b')).toBe('a b');
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeText('  padded  ')).toBe('padded');
  });

  it('treats the Word non-breaking space as a normal space', () => {
    expect(normalizeText('Grade 3')).toBe('grade 3');
  });

  it('trims each line so indentation does not change the hash', () => {
    expect(normalizeText('  line one  \n\t line two ')).toBe('line one\nline two');
  });

  it('is idempotent', () => {
    const messy = ' A  B \r\n\r\n\r\n C ';
    expect(normalizeText(normalizeText(messy))).toBe(normalizeText(messy));
  });
});

describe('contentHash', () => {
  it('is stable across cosmetic differences', () => {
    expect(contentHash('The primary endpoint is overall survival.')).toBe(
      contentHash('  the  primary endpoint is overall survival.  '),
    );
  });

  it('changes when the substance changes', () => {
    expect(contentHash('480 participants')).not.toBe(contentHash('528 participants'));
  });

  it('produces a 64-character hex digest', () => {
    expect(contentHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches a known SHA-256 vector after normalisation', () => {
    // normalizeText('Hello') === 'hello'
    expect(contentHash('Hello')).toBe(sha256('hello'));
  });
});

describe('queryHash and cache keys', () => {
  it('hashes queries that differ only cosmetically to the same value', () => {
    expect(queryHash('What changed in v4.0?')).toBe(queryHash('what   changed in v4.0? '));
  });

  it('scopes the embedding cache key by role so caches cannot cross roles', () => {
    const q = 'summarize safety events';
    expect(embeddingCacheKey(q, 'site_monitor')).not.toBe(
      embeddingCacheKey(q, 'regulatory_affairs'),
    );
    expect(embeddingCacheKey(q, 'executive')).toContain('executive');
  });
});

describe('unicode robustness', () => {
  it('hashes NFC and NFD spellings of the same text identically', () => {
    const nfc = 'café study'.normalize('NFC'); // é as one code point
    const nfd = 'café study'.normalize('NFD'); // e + combining acute
    expect(nfc).not.toBe(nfd); // the inputs really do differ byte-wise
    expect(contentHash(nfc)).toBe(contentHash(nfd));
  });

  it('substitutes lone surrogates instead of relying on the encoder', () => {
    // Python raises UnicodeEncodeError on these where Node silently replaces
    // them; both sides must agree, so normalizeText handles them explicitly.
    const loneHigh = 'protocol \uD800 text';
    const loneLow = 'protocol \uDC00 text';
    expect(() => contentHash(loneHigh)).not.toThrow();
    expect(normalizeText(loneHigh)).toContain('�');
    expect(normalizeText(loneLow)).toContain('�');
    expect(normalizeText(loneHigh)).not.toContain('\uD800');
  });

  it('leaves well-formed surrogate pairs intact', () => {
    const emoji = 'section 📄 marker'; // U+1F4C4, a valid pair
    expect(normalizeText(emoji)).toContain('📄');
  });
});
