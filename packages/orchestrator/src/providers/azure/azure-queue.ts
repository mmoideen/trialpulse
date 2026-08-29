/**
 * Azure Storage Queue-backed `QueueProvider`, talking to the Queue Service
 * REST API directly over `fetch` (Node 20+ has a built-in `fetch`) rather
 * than pulling in `@azure/storage-queue`: Azure Storage's REST surface for
 * "post a message" is a single authenticated POST, and avoiding the extra
 * SDK keeps this package's dependency footprint aligned with what
 * `package.json` already declares. Authentication is Azure AD (managed
 * identity) via `DefaultAzureCredential` -- Azure Storage accepts Bearer
 * tokens on the Queue service the same way Azure AI Search and Cosmos do.
 *
 * `drain()` always returns `[]`: this is a real queue, not a test double,
 * and there is no "peek and remove everything" Storage Queue operation that
 * would be safe to call from application code (the closest primitive,
 * repeated get+delete, would race with the actual consumer function and
 * risk data loss). The frozen `QueueProvider` contract documents this
 * exact behaviour; the in-memory provider is what tests use to assert on
 * enqueued messages.
 */
import type { TrialPulseConfig } from '../../config';
import type { QueueProvider } from '../types';
import { getManagedIdentityCredential } from './credential';
import { isLikelyTransientAzureError, withRetry } from './retry';

const STORAGE_SCOPE = 'https://storage.azure.com/.default';
const QUEUE_SERVICE_API_VERSION = '2021-08-06';

function toQueueMessageXml(base64Body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><QueueMessage><MessageText>${base64Body}</MessageText></QueueMessage>`;
}

class AzureQueueProvider implements QueueProvider {
  constructor(private readonly config: TrialPulseConfig) {}

  async enqueue(queueName: string, message: unknown): Promise<void> {
    const credential = getManagedIdentityCredential();
    const token = await credential.getToken(STORAGE_SCOPE);
    if (!token) {
      throw new Error('Failed to acquire a managed identity token for Azure Storage Queue.');
    }

    const body = toQueueMessageXml(Buffer.from(JSON.stringify(message), 'utf8').toString('base64'));
    const url = `${this.config.storage.queueAccountUrl.replace(/\/+$/, '')}/${queueName}/messages?api-version=${QUEUE_SERVICE_API_VERSION}`;

    await withRetry(
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token.token}`,
            'x-ms-version': QUEUE_SERVICE_API_VERSION,
            'Content-Type': 'application/xml',
          },
          body,
        });
        if (!response.ok) {
          const statusCode = response.status;
          throw Object.assign(new Error(`Azure Storage Queue enqueue failed: HTTP ${statusCode}`), { statusCode });
        }
      },
      { isRetryable: isLikelyTransientAzureError },
    );
  }

  drain(_queueName: string): Promise<unknown[]> {
    return Promise.resolve([]);
  }
}

export function createAzureQueueProvider(config: TrialPulseConfig): QueueProvider {
  return new AzureQueueProvider(config);
}
