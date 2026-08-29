import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { pages } from '@microsoft/teams-js';
import { App } from './App';
import { createApiClient } from './teams/api-client';
import { resolveAuthProvider } from './teams/auth';
import { initThemeSync } from './teams/theme';
import './styles/tokens.css';

async function bootstrap() {
  initThemeSync();

  const authProvider = await resolveAuthProvider();
  const identity = await authProvider.getIdentity();
  const apiClient = createApiClient(authProvider, {
    baseUrl: import.meta.env.VITE_ORCHESTRATOR_BASE_URL ?? '',
  });

  // D1: `source_url` is `string | null` on `Citation` -- `null` when the
  // redaction pipeline suppressed it (see `packages/shared/src/types.ts`).
  // `?? window.location.href` below already handles that case safely: a
  // restricted citation's link is never shared, only ever the app's own
  // URL as a fallback.
  async function handleShare(answer: string, citations: { source_url: string | null }[]) {
    const link = citations[0]?.source_url;
    try {
      await pages.shareDeepLink({
        subPageId: 'ask',
        subPageLabel: 'TrialPulse answer',
        subPageWebUrl: link ?? window.location.href,
      });
    } catch {
      // Outside a Teams host (e.g. local dev) shareDeepLink is unavailable;
      // sharing is a convenience action, never a hard requirement.
    }
  }

  const root = createRoot(document.getElementById('root')!);
  root.render(
    <StrictMode>
      <App apiClient={apiClient} identity={identity} onShare={(answer, citations) => {
          void handleShare(answer, citations);
        }}
      />
    </StrictMode>,
  );
}

void bootstrap();
