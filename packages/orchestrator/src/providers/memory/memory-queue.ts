/**
 * In-memory `QueueProvider` for local dev, unit tests and the eval harness.
 * Unlike the Azure Queue implementation (which always returns `[]` from
 * `drain`, per the contract doc in `providers/types.ts`), this one actually
 * stores and returns enqueued messages so tests can assert on them (e.g. the
 * reindex/webhook handlers enqueue the job they claim to enqueue).
 */
import type { QueueProvider } from '../types';

export class MemoryQueueProvider implements QueueProvider {
  private readonly queues = new Map<string, unknown[]>();

  enqueue(queueName: string, message: unknown): Promise<void> {
    const queue = this.queues.get(queueName);
    if (queue) queue.push(message);
    else this.queues.set(queueName, [message]);
    return Promise.resolve();
  }

  /** Removes and returns every message currently queued under `queueName`. */
  drain(queueName: string): Promise<unknown[]> {
    const queue = this.queues.get(queueName) ?? [];
    this.queues.delete(queueName);
    return Promise.resolve(queue);
  }
}
