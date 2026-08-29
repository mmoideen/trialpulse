import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DOCUMENT_CLASSIFICATIONS, ROLES, ROLE_POLICIES } from '@trialpulse/shared';
import { BrowseTab } from './BrowseTab';
import type { ApiClient } from '../teams/api-client';
import { makeDocumentStatus } from '../test/fixtures';
import { classificationLabel } from '../utils/labels';

const ALL_DOCS = DOCUMENT_CLASSIFICATIONS.map((classification) =>
  makeDocumentStatus({
    document_id: `doc-${classification}`,
    document_title: `${classification} title`,
    document_classification: classification,
  }),
);

function fakeApiClient(): ApiClient {
  return {
    listDocuments: async () => ALL_DOCS,
  } as unknown as ApiClient;
}

describe('BrowseTab', () => {
  it.each(ROLES)('never renders a classification outside the allow-list for role "%s"', async (role) => {
    render(<BrowseTab apiClient={fakeApiClient()} role={role} />);

    await waitFor(() => expect(screen.queryByText(/loading documents/i)).not.toBeInTheDocument());

    const allowed = new Set(ROLE_POLICIES[role].allowedClassifications);
    for (const classification of DOCUMENT_CLASSIFICATIONS) {
      const docTitle = screen.queryByText(`${classification} title`);
      const sectionHeading = screen.queryByRole('heading', { name: classificationLabel(classification) });
      if (allowed.has(classification)) {
        expect(docTitle).toBeInTheDocument();
        expect(sectionHeading).toBeInTheDocument();
      } else {
        // Absent entirely, not merely styled as hidden/disabled.
        expect(docTitle).not.toBeInTheDocument();
        expect(sectionHeading).not.toBeInTheDocument();
      }
    }
  });

  it('shows a per-classification empty state when the search box matches nothing', async () => {
    render(<BrowseTab apiClient={fakeApiClient()} role="regulatory_affairs" />);
    await waitFor(() => expect(screen.queryByText(/loading documents/i)).not.toBeInTheDocument());

    const search = screen.getByLabelText(/filter documents/i);
    search.dispatchEvent(new Event('focus'));
    await import('@testing-library/user-event').then(({ default: userEvent }) =>
      userEvent.setup().type(search, 'no-such-document-xyz'),
    );

    await waitFor(() => {
      const messages = screen.getAllByText(/no .* match "no-such-document-xyz"/i);
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  it('shows an error state when the document list fails to load', async () => {
    const failing = { listDocuments: async () => Promise.reject(new Error('network down')) } as unknown as ApiClient;
    render(<BrowseTab apiClient={failing} role="site_monitor" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't load documents/i);
  });
});
