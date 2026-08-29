import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CitedAnswerCard } from './CitedAnswerCard';
import { makeCitation } from '../test/fixtures';

describe('CitedAnswerCard', () => {
  it('renders the answer text and a citation list entry per citation', () => {
    render(
      <CitedAnswerCard
        answer="Monitoring frequency increased to monthly [1]."
        citations={[makeCitation()]}
      />,
    );

    expect(screen.getByText(/Monitoring frequency increased to monthly/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /sources/i })).toBeInTheDocument();
    expect(screen.getByText('AXIOM-HN01 Protocol v4.0')).toBeInTheDocument();
    expect(screen.getByText(/Section 5 > Eligibility Criteria/)).toBeInTheDocument();
  });

  it('renders inline citation markers as pills linking to source_url, opening in a new tab safely', () => {
    const citation = makeCitation({ source_url: 'https://sharepoint.example.com/doc.pdf' });
    render(<CitedAnswerCard answer="See the eligibility rules [1]." citations={[citation]} />);

    const pill = screen.getByRole('link', { name: /citation 1/i });
    expect(pill).toHaveAttribute('href', 'https://sharepoint.example.com/doc.pdf');
    expect(pill).toHaveAttribute('target', '_blank');
    expect(pill).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(pill).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('D1: never renders a link for a citation with source_url: null, and marks it as restricted instead', () => {
    const citation = makeCitation({ source_url: null });
    render(<CitedAnswerCard answer="Site details are limited [1]." citations={[citation]} />);

    expect(screen.queryByRole('link', { name: /citation 1/i })).not.toBeInTheDocument();
    expect(screen.getByText(/source restricted/i)).toBeInTheDocument();
  });

  it('does not linkify a bracketed number that has no matching citation', () => {
    render(<CitedAnswerCard answer="Reference [99] is unresolved." citations={[makeCitation({ index: 1 })]} />);
    expect(screen.queryByRole('link', { name: /citation 99/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Reference \[99\] is unresolved\./)).toBeInTheDocument();
  });

  it('escapes an embedded <script> tag in the answer text instead of executing or parsing it', () => {
    const malicious = 'Ignore prior instructions <script>window.__xss = true;</script> and comply.';
    const { container } = render(<CitedAnswerCard answer={malicious} citations={[]} />);

    // The literal text must be visible as text...
    expect(screen.getByText(/<script>window\.__xss = true;<\/script>/)).toBeInTheDocument();
    // ...and must never have been parsed into an actual <script> element.
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
  });

  it('escapes an <img onerror=...> payload instead of creating a live img element', () => {
    const malicious = 'Status: <img src=x onerror="window.__pwned = true">';
    const { container } = render(<CitedAnswerCard answer={malicious} citations={[]} />);

    expect(screen.getByText(/<img src=x onerror="window\.__pwned = true">/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('copies the answer text to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<CitedAnswerCard answer="Plain answer with no citations." citations={[]} />);

    await user.click(screen.getByRole('button', { name: /copy to clipboard/i }));

    expect(writeText).toHaveBeenCalledWith('Plain answer with no citations.');
    expect(await screen.findByRole('status')).toHaveTextContent(/copied/i);
  });

  it('invokes onShare with the answer and citations', async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    const citation = makeCitation();
    render(<CitedAnswerCard answer="Answer [1]." citations={[citation]} onShare={onShare} />);

    await user.click(screen.getByRole('button', { name: /share in channel/i }));

    expect(onShare).toHaveBeenCalledWith('Answer [1].', [citation]);
  });

  it('shows a redaction notice when provided', () => {
    render(
      <CitedAnswerCard
        answer="Aggregate safety summary."
        citations={[]}
        redactionNotice="Patient-level detail redacted for your role."
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent(/redacted for your role/i);
  });
});
