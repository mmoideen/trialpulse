#!/usr/bin/env node
/**
 * `npm run seed` -- seeds the in-memory index from `data/synthetic/` and
 * prints the resulting chunk count, total and per classification, so a
 * developer (or CI) can eyeball that the corpus loaded as expected without
 * starting the full server.
 */
import { DOCUMENT_CLASSIFICATIONS } from '@trialpulse/shared';
import { createLocalHarness } from './harness';

async function main(): Promise<void> {
  const harness = await createLocalHarness();
  const total = await harness.chunkCount();

  // eslint-disable-next-line no-console -- this script's entire job is to print to stdout.
  console.log(`Seeded ${total} chunks from data/synthetic/.\n`);

  for (const classification of DOCUMENT_CLASSIFICATIONS) {
    const docs = await harness.search.listDocuments(`document_classification eq '${classification}'`);
    const chunkCount = docs.reduce((sum, d) => sum + d.chunk_count, 0);
    // eslint-disable-next-line no-console
    console.log(`  ${classification.padEnd(28)} ${docs.length} document(s), ${chunkCount} chunk(s)`);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Seeding failed:', err);
  process.exitCode = 1;
});
