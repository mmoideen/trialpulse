import { describe, expect, it } from 'vitest';
import { buildCostHardStopRefusal, buildInjectionRefusal, buildNoAuthorizedDocumentsRefusal, buildNoChunksRefusal } from './refusal';

describe('buildNoChunksRefusal', () => {
  it('matches PRD decision 3\'s exact wording, echoing the topic', () => {
    expect(buildNoChunksRefusal('What is the planned enrollment?')).toBe(
      'I cannot find information about What is the planned enrollment in the documents you are authorized to access.',
    );
  });

  it('falls back to a generic topic phrase for an empty-after-trimming query', () => {
    expect(buildNoChunksRefusal('???')).toBe(
      'I cannot find information about that topic in the documents you are authorized to access.',
    );
  });

  describe('D12: never echoes a clickable markdown link/image (Teams renders card TextBlocks as Markdown)', () => {
    it('strips markdown link syntax, keeping the visible text', () => {
      const malicious = '[Meridian IT: verify your account](https://evil.example)';
      const refusal = buildNoChunksRefusal(malicious);
      expect(refusal).not.toContain('](');
      expect(refusal).not.toContain('https://evil.example');
      expect(refusal).toContain('Meridian IT: verify your account');
    });

    it('strips markdown image syntax the same way', () => {
      const malicious = '![innocuous alt text](https://evil.example/tracker.png)';
      const refusal = buildNoChunksRefusal(malicious);
      expect(refusal).not.toContain('https://evil.example');
      expect(refusal).toContain('innocuous alt text');
    });

    it('defangs a bare (non-bracketed) URL too', () => {
      const refusal = buildNoChunksRefusal('go to https://evil.example/phish now');
      expect(refusal).not.toContain('https://evil.example');
      expect(refusal).toContain('[link removed]');
    });

    it('leaves an ordinary clinical question completely unaffected', () => {
      expect(buildNoChunksRefusal('What IND amendments are pending')).toBe(
        'I cannot find information about What IND amendments are pending in the documents you are authorized to access.',
      );
    });
  });
});

describe('buildNoAuthorizedDocumentsRefusal', () => {
  it('is identical to the no-chunks wording (never hints an RBAC bug occurred)', () => {
    expect(buildNoAuthorizedDocumentsRefusal('safety events')).toBe(buildNoChunksRefusal('safety events'));
  });
});

describe('buildInjectionRefusal', () => {
  it('takes no query input and always returns the identical fixed message', () => {
    expect(buildInjectionRefusal()).toBe(buildInjectionRefusal());
    expect(buildInjectionRefusal()).toMatch(/cannot be processed/i);
  });
});

describe('buildCostHardStopRefusal', () => {
  it('does not echo any query text and explains the cost pause', () => {
    const text = buildCostHardStopRefusal();
    expect(text).toMatch(/cost/i);
    expect(text).toMatch(/administrator/i);
  });
});
