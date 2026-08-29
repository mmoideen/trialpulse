import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import type { ApiClient } from './teams/api-client';
import type { CallerUiIdentity } from './teams/auth';

let dashboardModuleLoaded = false;

// PRD section 9: "the initial tab load must be Ask only." This mock lets us
// observe, from outside, whether the Dashboard chunk has actually been
// imported -- the factory below only runs the first time something performs
// `import('./tabs/DashboardTab')`.
vi.mock('./tabs/DashboardTab', () => {
  dashboardModuleLoaded = true;
  return {
    default: () => <div>Dashboard content</div>,
  };
});

function fakeApiClient(): ApiClient {
  return {
    getConversation: vi.fn().mockResolvedValue({ turns: [], continuation: null }),
    listDocuments: vi.fn().mockResolvedValue([]),
  } as unknown as ApiClient;
}

const identity: CallerUiIdentity = {
  role: 'regulatory_affairs',
  roleFallbackApplied: false,
  userPrincipalName: 'user@meridiantx.com',
  displayName: 'Test User',
};

describe('Dashboard tab code-splitting', () => {
  it('never imports the Dashboard module until the Dashboard tab is opened', async () => {
    const user = userEvent.setup();
    render(<App apiClient={fakeApiClient()} identity={identity} />);

    // Ask tab is visible immediately...
    expect(await screen.findByRole('tab', { name: 'Ask', selected: true })).toBeInTheDocument();
    // ...and the Dashboard module has not been touched.
    expect(dashboardModuleLoaded).toBe(false);

    await user.click(screen.getByRole('tab', { name: 'Browse' }));
    expect(dashboardModuleLoaded).toBe(false);

    await user.click(screen.getByRole('tab', { name: 'Dashboard' }));

    await waitFor(() => expect(dashboardModuleLoaded).toBe(true));
    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
  });
});
