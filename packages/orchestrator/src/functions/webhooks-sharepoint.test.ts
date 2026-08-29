import { describe, expect, it } from 'vitest';
import { handleSharePointWebhook } from './webhooks-sharepoint';
import { buildTestDeps } from './test-support';

const VALID_CLIENT_STATE = 'super-secret-client-state'; // matches SHAREPOINT_WEBHOOK_CLIENT_STATE in test-support.ts

describe('POST /api/webhooks/sharepoint', () => {
  it('echoes the validationtoken as-is with a 200 during the handshake', async () => {
    const { deps } = buildTestDeps();
    const result = await handleSharePointWebhook(deps, { validationtoken: 'abc123' }, undefined);
    expect(result.status).toBe(200);
    expect(result.textBody).toBe('abc123');
  });

  it('D12/F5: no longer enqueues onto any queue -- this app is not the SharePoint subscription owner (see module doc)', async () => {
    const { deps } = buildTestDeps();
    const result = await handleSharePointWebhook(deps, {}, {
      value: [{ subscriptionId: 'sub-1', clientState: VALID_CLIENT_STATE, resource: 'sites/x/drives/y/root' }],
    });
    expect(result.status).toBe(202);
    // Every queue this handler used to reference (or could plausibly still
    // reference) must remain empty -- both the old, non-provisioned name
    // and the real, provisioned one.
    expect(await deps.queue.drain('sharepoint-reingest-jobs')).toHaveLength(0);
    expect(await deps.queue.drain(deps.config.ingestQueueName)).toHaveLength(0);
  });

  describe('D12: the response never discloses whether clientState validation passed (constant response, not a status/body oracle)', () => {
    it('a valid clientState returns { received: true }', async () => {
      const { deps } = buildTestDeps();
      const result = await handleSharePointWebhook(deps, {}, {
        value: [{ subscriptionId: 'sub-1', clientState: VALID_CLIENT_STATE, resource: 'sites/x/drives/y/root' }],
      });
      expect(result.status).toBe(202);
      expect(result.jsonBody).toEqual({ received: true });
    });

    it('a mismatched clientState returns the identical 202 and { received: true } -- never a distinguishable body', async () => {
      const { deps } = buildTestDeps();
      const result = await handleSharePointWebhook(deps, {}, {
        value: [{ subscriptionId: 'sub-1', clientState: 'wrong-secret', resource: 'sites/x/drives/y/root' }],
      });
      expect(result.status).toBe(202);
      expect(result.jsonBody).toEqual({ received: true });
    });

    it('a malformed payload returns the identical 202 and { received: true }, never an error status', async () => {
      const { deps } = buildTestDeps();
      const result = await handleSharePointWebhook(deps, {}, { not: 'the expected shape' });
      expect(result.status).toBe(202);
      expect(result.jsonBody).toEqual({ received: true });
    });

    it('a batch mixing valid and invalid entries still returns the same constant response', async () => {
      const { deps } = buildTestDeps();
      const result = await handleSharePointWebhook(deps, {}, {
        value: [
          { subscriptionId: 'sub-1', clientState: VALID_CLIENT_STATE, resource: 'sites/x/drives/y/root' },
          { subscriptionId: 'sub-2', clientState: 'wrong-secret', resource: 'sites/x/drives/z/root' },
        ],
      });
      expect(result.status).toBe(202);
      expect(result.jsonBody).toEqual({ received: true });
    });
  });

  it('D12: never surfaces an unhandled internal error as a non-2xx status (would make SharePoint delete the subscription)', async () => {
    const { deps } = buildTestDeps();
    // A body that passes JSON parsing but is nowhere near the expected
    // shape, deep enough to exercise the catch path defensively; the
    // handler must still ack with 202 rather than ever bubbling a 500.
    const result = await handleSharePointWebhook(deps, {}, null);
    expect(result.status).toBe(202);
    expect(result.jsonBody).toEqual({ received: true });
  });
});
