/**
 * Document Version Comparison (PRD feature 3.2.2).
 *
 * "What changed between protocol version 3.0 and 4.0?" is handled specially:
 * instead of a single semantic search, we resolve the two document versions
 * being asked about, pull every chunk for each, align them by the BARE
 * section path, and build a structured diff.
 *
 * Production `heading_path` (see `ingestion/trialpulse_ingest/pipeline.py`)
 * is stored as `"<document_title> > <section path>"`. Because a new document
 * version necessarily has a different title (e.g. "...v3.0" vs "...v4.0"),
 * aligning two versions' chunks by the FULL `heading_path` never matches
 * anything -- every section of the old version looks "removed" and every
 * section of the new version looks "added", even when only a handful of
 * sections actually changed. `sectionPathOf` below strips the title prefix
 * before matching, mirroring `tombstones.section_path_of` in the Python
 * pipeline precisely (see that function's docstring for why exact-prefix
 * removal, not fuzzy matching, is safe here).
 *
 * The diff is turned into synthetic `ScoredChunk`-shaped context entries
 * (see `toSyntheticChunks`) so the rest of the pipeline -- redaction,
 * prompt-building, generation, citation validation, audit -- can treat a
 * version-compare turn exactly like an ordinary retrieval turn.
 */
import { contentHash, type DocumentClassification, type DocumentStatus, type ScoredChunk } from '@trialpulse/shared';

export interface VersionCompareIntent {
  fromVersion: string;
  toVersion: string;
}

// Matches "what changed between version 3.0 and 4.0", "compare version 3.0
// to version 4.0", "difference between versions 3.0 and 4.0", etc. Anchored
// on the word "version(s)" per the PRD's Feature 3.2.2 example phrasing.
const VERSION_COMPARE_RE =
  /(?:chang(?:e[ds]?|ing)|differ(?:ence|ent|s)?|compar(?:e|ison|ing))\b[^.?!]{0,60}\bversions?\s+(\d+(?:\.\d+)*)\s*(?:and|to|vs\.?|versus|->|→)\s*(?:version\s*)?(\d+(?:\.\d+)*)/i;

/** Detect a "what changed between version X and Y" style query. Returns null when the query is not one. */
export function detectVersionCompareIntent(query: string): VersionCompareIntent | null {
  const match = query.match(VERSION_COMPARE_RE);
  if (!match?.[1] || !match[2]) return null;
  return { fromVersion: match[1], toVersion: match[2] };
}

/**
 * Strip a trailing version-like token from a document title so two versions
 * of "the same document" can be recognised, e.g.
 * "AXIOM-HN01 Protocol v3.0" / "AXIOM-HN01 Protocol v4.0" -> both
 * "AXIOM-HN01 Protocol"; "Investigator Brochure Edition 5" / "... Edition 6"
 * -> both "Investigator Brochure".
 */
function stripVersionSuffix(title: string): string {
  return title.replace(/\s+(?:v|version|ed\.?|edition)?\.?\s*\d+(?:\.\d+)*\s*$/i, '').trim();
}

export interface VersionPair {
  from: DocumentStatus;
  to: DocumentStatus;
}

/**
 * Find the two documents (within the caller's already-RBAC-filtered document
 * list) that represent `fromVersion` and `toVersion` of the same document
 * lineage, grouped by their title with the version suffix stripped.
 */
export function findVersionPair(
  documents: readonly DocumentStatus[],
  intent: VersionCompareIntent,
): VersionPair | null {
  const groups = new Map<string, DocumentStatus[]>();
  for (const doc of documents) {
    const key = stripVersionSuffix(doc.document_title).toLowerCase();
    const group = groups.get(key);
    if (group) group.push(doc);
    else groups.set(key, [doc]);
  }
  for (const group of groups.values()) {
    const from = group.find((d) => d.document_version === intent.fromVersion);
    const to = group.find((d) => d.document_version === intent.toVersion);
    if (from && to) return { from, to };
  }
  return null;
}

export type SectionDiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface SectionDiff {
  /** The BARE section path (title prefix stripped, see `sectionPathOf`) -- stable across a document's versions. */
  heading_path: string;
  status: SectionDiffStatus;
  from_page: number | null;
  to_page: number | null;
  from_content: string | null;
  to_content: string | null;
  /**
   * Ids of the real indexed chunks this diff was computed from. A citation
   * must always dereference to a chunk that actually exists in the index, so
   * the synthetic diff chunk borrows one of these rather than minting an id
   * of its own -- see `buildSyntheticChunk`.
   */
  from_chunk_id: string | null;
  to_chunk_id: string | null;
}

/**
 * Recover the bare section path from a stored chunk's heading_path. Mirror
 * of `tombstones.section_path_of` in the Python pipeline (and of the
 * identically-named helper in `local/corpus.ts`, which cannot be imported
 * from here without pulling dev/eval-only local-corpus machinery into the
 * production query pipeline): strip the exact `"<document_title> > "`
 * prefix -- not fuzzy matching, since `document_title` is recorded on the
 * chunk itself -- and treat a heading_path equal to the bare document_title
 * (the pre-heading banner chunk) as the empty section path.
 */
function sectionPathOf(chunk: Pick<ScoredChunk, 'document_title' | 'heading_path'>): string {
  const prefix = `${chunk.document_title} > `;
  if (chunk.heading_path.startsWith(prefix)) return chunk.heading_path.slice(prefix.length);
  if (chunk.heading_path === chunk.document_title) return '';
  return chunk.heading_path;
}

/** Align chunks from two document versions by the bare section path (see `sectionPathOf`) and classify each section's change. */
export function diffSections(fromChunks: readonly ScoredChunk[], toChunks: readonly ScoredChunk[]): SectionDiff[] {
  const fromByHeading = new Map(fromChunks.map((c) => [sectionPathOf(c), c]));
  const toByHeading = new Map(toChunks.map((c) => [sectionPathOf(c), c]));
  const allHeadings = new Set<string>([...fromByHeading.keys(), ...toByHeading.keys()]);

  const diffs: SectionDiff[] = [];
  for (const heading of allHeadings) {
    const from = fromByHeading.get(heading);
    const to = toByHeading.get(heading);
    if (from && !to) {
      diffs.push({
        heading_path: heading,
        status: 'removed',
        from_page: from.page_number,
        to_page: null,
        from_content: from.content,
        to_content: null,
        from_chunk_id: from.chunk_id,
        to_chunk_id: null,
      });
    } else if (!from && to) {
      diffs.push({
        heading_path: heading,
        status: 'added',
        from_page: null,
        to_page: to.page_number,
        from_content: null,
        to_content: to.content,
        from_chunk_id: null,
        to_chunk_id: to.chunk_id,
      });
    } else if (from && to) {
      const status = contentHash(from.content) === contentHash(to.content) ? 'unchanged' : 'changed';
      diffs.push({
        heading_path: heading,
        status,
        from_page: from.page_number,
        to_page: to.page_number,
        from_content: from.content,
        to_content: to.content,
        from_chunk_id: from.chunk_id,
        to_chunk_id: to.chunk_id,
      });
    }
  }

  diffs.sort((a, b) => {
    const pageA = a.from_page ?? a.to_page ?? Number.MAX_SAFE_INTEGER;
    const pageB = b.from_page ?? b.to_page ?? Number.MAX_SAFE_INTEGER;
    return pageA - pageB || a.heading_path.localeCompare(b.heading_path);
  });
  return diffs;
}

function describeDiff(diff: SectionDiff, fromVersion: string, toVersion: string): string {
  switch (diff.status) {
    case 'added':
      return (
        `Section "${diff.heading_path}" was added in version ${toVersion} (page ${diff.to_page ?? 'n/a'}). ` +
        `Version ${toVersion} text: ${diff.to_content ?? ''}`
      );
    case 'removed':
      return (
        `Section "${diff.heading_path}" was present in version ${fromVersion} (page ${diff.from_page ?? 'n/a'}) ` +
        `but was removed in version ${toVersion}. Version ${fromVersion} text: ${diff.from_content ?? ''}`
      );
    case 'changed':
      return (
        `Section "${diff.heading_path}" changed between version ${fromVersion} (page ${diff.from_page ?? 'n/a'}) ` +
        `and version ${toVersion} (page ${diff.to_page ?? 'n/a'}).\n` +
        `Version ${fromVersion} said: ${diff.from_content ?? ''}\n` +
        `Version ${toVersion} says: ${diff.to_content ?? ''}`
      );
    case 'unchanged':
      return `Section "${diff.heading_path}" is unchanged between version ${fromVersion} and version ${toVersion}.`;
  }
}

/**
 * `chunkId` MUST be the id of a chunk that exists in the search index. A
 * version-compare answer is still an answer, and every citation it carries has
 * to dereference -- an auditor following a citation back to its source must
 * land on a real indexed chunk, not on an id this function invented. We
 * therefore borrow the id of the chunk the diff text was derived from
 * (preferring the newer version) instead of minting a `diff_*` id that
 * `SearchProvider.getChunk` would resolve to null.
 */
function buildSyntheticChunk(
  content: string,
  headingPath: string,
  page: number,
  pair: VersionPair,
  intent: VersionCompareIntent,
  chunkId: string,
): ScoredChunk {
  const classification = pair.to.document_classification as DocumentClassification;
  return {
    chunk_id: chunkId,
    document_id: pair.to.document_id,
    document_title: pair.to.document_title,
    document_classification: classification,
    document_version: `${intent.fromVersion}→${intent.toVersion}`,
    content,
    content_hash: contentHash(content),
    heading_path: headingPath,
    page_number: page,
    source_url: pair.to.source_url,
    ingested_at: pair.to.last_ingested_at ?? new Date(0).toISOString(),
    site_code: null,
    previous_version_hash: null,
    // Deterministically constructed and therefore trivially "relevant" --
    // never subject to the RELEVANCE_THRESHOLD drop in query-pipeline.ts.
    similarity_score: 1,
  };
}

/**
 * Turn a set of section diffs into synthetic `ScoredChunk`s so the rest of
 * the pipeline can treat a version-compare turn like any other retrieval.
 * `unchanged` sections are omitted unless there is nothing else to show, in
 * which case a single "no differences" chunk is emitted so the turn does not
 * spuriously refuse.
 */
export function toSyntheticChunks(
  diffs: readonly SectionDiff[],
  pair: VersionPair,
  intent: VersionCompareIntent,
): ScoredChunk[] {
  const changed = diffs.filter((d) => d.status !== 'unchanged');

  if (changed.length === 0) {
    // Anchor the "no differences" answer to a real chunk from the compared
    // versions. With no diffs at all there is nothing indexed to cite, so we
    // return nothing and let the pipeline refuse rather than cite a phantom.
    const anchor = diffs[0];
    const anchorId = anchor?.to_chunk_id ?? anchor?.from_chunk_id;
    if (!anchorId) return [];
    const content = `No differences were found between version ${intent.fromVersion} and version ${intent.toVersion}.`;
    return [buildSyntheticChunk(content, 'Version Comparison', 1, pair, intent, anchorId)];
  }

  const chunks: ScoredChunk[] = [];
  for (const [i, diff] of changed.entries()) {
    // Prefer the newer version's chunk: a reader following the citation wants
    // to land on the version they asked "what changed to".
    const chunkId = diff.to_chunk_id ?? diff.from_chunk_id;
    if (!chunkId) continue; // structurally impossible: a diff always has a side.
    chunks.push(
      buildSyntheticChunk(
        describeDiff(diff, intent.fromVersion, intent.toVersion),
        diff.heading_path,
        diff.to_page ?? diff.from_page ?? i + 1,
        pair,
        intent,
        chunkId,
      ),
    );
  }
  return chunks;
}
