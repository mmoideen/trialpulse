/**
 * Browser build shim for the Node `node:crypto` module.
 *
 * `@trialpulse/shared`'s barrel export (`index.ts`) re-exports `hash.ts`,
 * which imports `createHash` from `node:crypto` for server-side / ingestion
 * content hashing. The Teams tab never calls those hash helpers, but Rollup
 * still needs `createHash` to exist as a binding when it links that module,
 * because ES module binding resolution happens before dead-code elimination
 * removes the unused import. This shim exists purely to satisfy that
 * binding at build time; it must never actually execute in the browser.
 *
 * `packages/shared` is a frozen contract owned by another workstream, so the
 * fix lives here rather than there.
 */
export function createHash(): never {
  throw new Error(
    '@trialpulse/shared hash utilities are server-only and must never run in the Teams tab browser bundle.',
  );
}
