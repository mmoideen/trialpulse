/**
 * In-memory `DocumentMetadataStore` for local dev, unit tests and the eval
 * harness. Backs the Browse tab's per-document ingestion status.
 */
import type { DocumentClassification, DocumentStatus } from '@trialpulse/shared';
import type { DocumentMetadataStore } from '../types';

export class MemoryDocumentMetadataStore implements DocumentMetadataStore {
  private readonly byId = new Map<string, DocumentStatus>();

  upsert(status: DocumentStatus): Promise<void> {
    this.byId.set(status.document_id, status);
    return Promise.resolve();
  }

  list(classifications: readonly DocumentClassification[] | null): Promise<DocumentStatus[]> {
    const all = [...this.byId.values()];
    const filtered = classifications === null ? all : all.filter((d) => classifications.includes(d.document_classification));
    filtered.sort((a, b) => a.document_title.localeCompare(b.document_title));
    return Promise.resolve(filtered);
  }

  get(documentId: string): Promise<DocumentStatus | null> {
    return Promise.resolve(this.byId.get(documentId) ?? null);
  }
}
