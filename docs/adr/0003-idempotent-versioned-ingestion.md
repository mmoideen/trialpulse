# 0003. Content-hashed, idempotent, version-aware ingestion with tombstoning

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** PRD decision 2, workflow 3.3.1, feature 3.2.2

## Context

Documents arrive from SharePoint through two paths that are both unreliable in
different ways:

- **Change webhooks** fire quickly but can be missed entirely, delivered out of
  order, or delivered more than once for a single edit. SharePoint's change
  notification is an invitation to look, not a description of what changed.
- **A daily scheduled sync** catches everything the webhooks missed, at the cost
  of re-presenting every document in the library.

Both paths therefore hand the pipeline the same document repeatedly. A naive
pipeline responds by re-chunking, re-embedding and re-indexing, which produces
three failures at once: duplicate chunks in the index (so a single fact is cited
three times, or crowds out other facts from the top-k), a linear increase in
embedding spend on content that has not changed, and an index whose contents
depend on the order events happened to arrive in.

Clinical documents also version. A protocol goes from v3.0 to v4.0 and the old
version does not become worthless - regulatory affairs will ask what changed
(feature 3.2.2), and a monitor mid-way through reading v3.0 should not have it
vanish underneath them. Deleting superseded chunks the instant a new version
lands is both a feature regression and a jarring user experience.

## Decision

**Every chunk is keyed by the SHA-256 of its normalised text.**
`contentHash(text)` normalises before hashing: CRLF to LF, non-breaking spaces
from Word exports to ordinary spaces, runs of whitespace collapsed, blank-line
runs collapsed, lines trimmed, lowercased. Cosmetic churn - a document re-saved
in a newer version of Word, a paragraph reflowed - therefore produces the same
hash and the chunk is skipped.

If the hash is already in the index, the chunk is skipped. This makes ingestion
idempotent: replaying the same document N times converges to the same index
state as ingesting it once, which means a duplicated webhook, a retried queue
message and the daily sync all cost nothing but a hash lookup.

**The normalisation is implemented twice and tested for parity.** The
TypeScript version lives in `packages/shared/src/hash.ts`; the Python version in
`ingestion/trialpulse_ingest/hashing.py`. Two implementations of a hash function
is exactly the kind of duplication that rots, so
`ingestion/tests/test_hash_parity.py` asserts they agree. If they diverge, every
document re-ingests on the next sync and the duplicate-chunk problem returns
silently. The test is the only thing standing between us and that.

**Chunk ids are deterministic, not random.** A chunk id is derived from the
document id, the heading path and the chunk ordinal, so the same section of the
same document always lands on the same id. A UUID per chunk would make the
"skip if the hash exists" check useless for updates: the second ingestion would
write a fresh id, and the index would grow rather than converge.

**Superseded chunks are tombstoned, not deleted.** When a new document version
produces new hashes, the prior version's chunks are marked tombstoned with a
purge date 30 days out (`TOMBSTONE_RETENTION_DAYS`). They stay searchable during
that window. `previous_version_hash` links a chunk to the same heading path in
the prior version, which is what makes the version-comparison feature a lookup
rather than a full-document diff.

## Consequences

**Good**

- Re-ingestion is free and safe. The daily sync can run over the whole corpus
  without a cost or correctness penalty, which turns the PRD's "24-hour delay is
  a risk" (open question 3) into a bounded, cheap safety net rather than
  something to be avoided.
- Embedding spend tracks *changed* content, not *seen* content. At 1M chunks and
  a 5%-per-month change rate this is the difference between roughly $3 and
  roughly $67 of embedding cost per month (see `docs/cost-model.md`).
- A partial failure mid-document leaves the index in a state that the next run
  repairs, because the already-written chunks are skipped and only the missing
  ones are computed. There is no "resume from offset" bookkeeping.
- Version comparison has the data it needs without a second store.

**Bad, or at least costly**

- Normalisation is lossy in a way that can bite. Lowercasing means a document
  whose only change was capitalisation - `mg` to `MG`, or a defined term being
  capitalised for the first time - produces the same hash and is not
  re-indexed. For clinical documents, case changes in dosing units are the
  plausible worst case. We accept this because the alternative (hashing raw
  bytes) makes every whitespace change a re-embed, and because the retrieved
  text a user sees comes from the *stored* chunk content, which is updated when
  anything else in the chunk changes.
- Tombstoned chunks remain retrievable for 30 days, so a query can legitimately
  cite superseded content. Citations carry `document_version`, and the UI shows
  it, but this is a real trap for a user who does not read carefully. Reducing
  the window trades that against the "document vanished mid-read" problem.
- Deterministic chunk ids mean chunk boundaries are part of the contract.
  Changing the chunking algorithm - `CHUNK_TARGET_TOKENS`, heading handling -
  re-ids the entire corpus and forces a full re-embed. That is a deliberate,
  scheduled operation, documented in the reindex procedure in
  `docs/runbook.md`, not something to change casually.
- The index now stores both live and tombstoned chunks, so storage and vector
  quota must be sized for roughly 30 days of churn on top of the live corpus.
