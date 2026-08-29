/**
 * Loads the 20-document synthetic corpus into heading-aware `Chunk[]` for
 * the in-memory search index -- using EXACTLY the chunking algorithm the
 * production Python ingestion pipeline uses.
 *
 * This is a deliberate, close-to-line-for-line TypeScript port of
 * `ingestion/trialpulse_ingest/chunking.py` (chunk boundaries, page-marker
 * parsing/stripping, whitespace-word tokenizer, sentence-boundary overlap)
 * plus the chunk-assembly logic in `ingestion/trialpulse_ingest/pipeline.py`
 * (title-prefixed `heading_path`, `chunk_id` derivation, `source_url`
 * construction, `previous_version_hash` backfill via the bare section path).
 * `ingestion/trialpulse_ingest/extraction.py`'s `MarkdownExtractor` (YAML
 * front-matter stripping) is mirrored too, since that is what actually
 * produces the text `chunk_markdown` receives in production.
 *
 * There used to be a stale comment here claiming "the Python ingestion
 * pipeline does not yet have its own chunker... so there is no existing
 * chunking behaviour to mirror exactly". That stopped being true once
 * `chunking.py`/`pipeline.py` were implemented, and the divergence it left
 * behind (a second, independent chunker keyed off `corpus-manifest.json`'s
 * `sections[]`/`facts[]` instead of the markdown) meant every eval golden,
 * RBAC test, and version-compare citation in this repo was exercised
 * against chunks production can never emit. See `chunk-parity.test.ts`,
 * which shells out to the real Python pipeline and asserts the two
 * implementations agree on every chunk.
 *
 * `corpus-manifest.json` is still read here, but ONLY for document-level
 * metadata (`document_id`, `title`, `classification`, `version`,
 * `site_code`, `supersedes`) -- exactly what `pipeline.load_manifest` uses
 * it for. Its `sections[]`/`facts[]` fields are intentionally never read by
 * this module; they exist for the eval harness's golden self-check (see
 * `eval/run-eval.ts` gate 8), not for chunking.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  contentHash,
  sha256,
  type Chunk,
  type DocumentClassification,
} from '@trialpulse/shared';

interface ManifestDocument {
  document_id: string;
  filename: string;
  title: string;
  classification: DocumentClassification;
  version: string;
  effective_date: string;
  site_code: string | null;
  supersedes: string | null;
}

interface CorpusManifest {
  corpus_version: string;
  documents: ManifestDocument[];
}

/**
 * Walk up from `startDir` looking for `data/synthetic/corpus-manifest.json`.
 * Needed because this module's own directory depth relative to the repo
 * root differs between running from TypeScript source (vitest, `src/local/`)
 * and running from compiled output (`dist/src/local/`) -- searching upward
 * is robust to both instead of hardcoding a `../../..` depth that would
 * silently break for one of the two.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'data', 'synthetic', 'corpus-manifest.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate data/synthetic/corpus-manifest.json by walking up from "${startDir}". ` +
      'Is the synthetic corpus present in the repo?',
  );
}

export function resolveCorpusDir(explicit?: string): string {
  if (explicit) return explicit;
  const repoRoot = findRepoRoot(__dirname);
  return join(repoRoot, 'data', 'synthetic');
}

function loadManifest(corpusDir: string): CorpusManifest {
  const manifestPath = join(corpusDir, 'corpus-manifest.json');
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as CorpusManifest;
}

// ---------------------------------------------------------------------------
// Text extraction -- mirrors `MarkdownExtractor.extract` in extraction.py:
// strip the YAML front-matter block, return everything after it verbatim
// (including the synthetic-data banner, which chunking.py treats as
// pre-heading content).
// ---------------------------------------------------------------------------
const FRONT_MATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n/;

function extractMarkdownText(raw: string): string {
  return raw.replace(FRONT_MATTER_RE, '');
}

// ---------------------------------------------------------------------------
// Chunking -- mirrors chunking.py exactly.
//
// Ambiguity resolved identically to chunking.py's own docstring: the PRD
// does not specify a tokenizer, and a real BPE tokenizer would need network
// access on first use, so one token is approximated as one
// whitespace-delimited word. This is used consistently for both
// CHUNK_TARGET_TOKENS sizing and CHUNK_OVERLAP_TOKENS overlap, so relative
// chunk boundaries match chunking.py's even though absolute counts would
// differ from a real tokenizer.
// ---------------------------------------------------------------------------
const HEADING_RE = /^(#{2,6})\s+(.+?)\s*$/;
const PAGE_MARKER_RE = /^<!--\s*page:\s*(\d+)\s*-->\s*$/;
// Sentence boundary: end punctuation followed by whitespace and another
// character. Deliberately simple (no abbreviation handling), matching
// chunking.py's _SENTENCE_SPLIT_RE exactly.
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=\S)/;

const DEFAULT_PAGE_NUMBER = 1;

/** A chunk before document metadata, content_hash, and chunk_id are attached. Mirrors chunking.py's `ChunkDraft`. */
export interface ChunkDraft {
  /**
   * Heading hierarchy only, e.g. "1. Study Design" or "A > B > C". Empty
   * string for content that appears before the first `##`-level heading in
   * the document (the synthetic-data banner, in our corpus) -- note a
   * top-level `#` title heading does NOT count as a section boundary here,
   * exactly like chunking.py's `_HEADING_RE` (`#{2,6}`, never `#`).
   */
  sectionPath: string;
  pageNumber: number;
  content: string;
  /** 0-based position of this chunk within the whole document. */
  ordinal: number;
}

/** Whitespace-word approximation of token count. See module docstring. */
function approxTokenCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(SENTENCE_SPLIT_RE)
    .filter((s) => s.length > 0);
}

/**
 * Greedily pack whole sentences into token-bounded chunks with overlap.
 * Mirrors `_pack_sentences_with_overlap` in chunking.py exactly, including
 * how trailing sentences are carried into the next chunk to create the
 * overlap.
 */
function packSentencesWithOverlap(sentences: string[], targetTokens: number, overlapTokens: number): string[] {
  if (sentences.length === 0) return [];

  const chunks: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = approxTokenCount(sentence);
    if (current.length > 0 && currentTokens + sentenceTokens > targetTokens) {
      chunks.push(current);
      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        if (carryTokens >= overlapTokens) break;
        carry.unshift(current[i]!);
        carryTokens += approxTokenCount(current[i]!);
      }
      current = carry;
      currentTokens = carryTokens;
    }
    current.push(sentence);
    currentTokens += sentenceTokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks.map((c) => c.join(' '));
}

/**
 * Split one section's body into one or more chunk texts. A section under
 * CHUNK_TARGET_TOKENS is returned as a single chunk unchanged. Mirrors
 * `_split_section` in chunking.py.
 */
function splitSection(content: string): string[] {
  if (approxTokenCount(content) <= CHUNK_TARGET_TOKENS) {
    return content.trim() ? [content] : [];
  }
  const sentences = splitSentences(content);
  return packSentencesWithOverlap(sentences, CHUNK_TARGET_TOKENS, CHUNK_OVERLAP_TOKENS);
}

/**
 * Chunk normalized-markdown-with-page-markers text into `ChunkDraft`s.
 * `text` is expected to already have YAML front matter stripped (see
 * `extractMarkdownText`). Recognises `##`..`######` headings and
 * `<!-- page: N -->` page markers, which are parsed and NOT included in any
 * chunk's content. Content before the first heading (if any) becomes a
 * section with an empty `sectionPath`. Line-for-line port of
 * `chunk_markdown` in chunking.py.
 */
export function chunkMarkdown(text: string): ChunkDraft[] {
  const headingStack: Array<{ level: number; heading: string }> = [];
  let currentPage = DEFAULT_PAGE_NUMBER;
  let sectionPage = DEFAULT_PAGE_NUMBER;
  let sectionLines: string[] = [];
  let ordinal = 0;
  const drafts: ChunkDraft[] = [];

  function flushSection(): void {
    const body = sectionLines.join('\n').trim();
    sectionLines = [];
    if (!body) return;
    const sectionPath = headingStack.map((h) => h.heading).join(' > ');
    for (const chunkText of splitSection(body)) {
      drafts.push({
        sectionPath,
        pageNumber: sectionPage,
        content: chunkText.trim(),
        ordinal,
      });
      ordinal += 1;
    }
  }

  for (const rawLine of text.split('\n')) {
    const headingMatch = HEADING_RE.exec(rawLine);
    const pageMatch = PAGE_MARKER_RE.exec(rawLine.trim());

    if (headingMatch) {
      // A new heading always starts a new section -- never split across it
      // in either direction.
      flushSection();
      const level = headingMatch[1]!.length;
      const headingText = headingMatch[2]!;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, heading: headingText });
      sectionPage = currentPage;
      continue;
    }

    if (pageMatch) {
      currentPage = Number(pageMatch[1]);
      // If the section body is still empty, the marker sets this section's
      // page (the normal case: the generator emits the marker immediately
      // after each heading).
      if (sectionLines.length === 0) {
        sectionPage = currentPage;
      }
      continue;
    }

    sectionLines.push(rawLine);
  }

  flushSection();
  return drafts;
}

// ---------------------------------------------------------------------------
// source_url -- mirrors `build_source_url` in pipeline.py exactly, including
// its `urllib.parse.quote`-compatible percent-encoding.
// ---------------------------------------------------------------------------

/**
 * SharePoint document library names per PRD section 2.2's architecture
 * diagram. Mirrors `CLASSIFICATION_LIBRARY_NAMES` in pipeline.py exactly.
 */
const CLASSIFICATION_LIBRARY_NAMES: Record<string, string> = {
  protocol: 'Protocols',
  investigator_brochure: 'Investigator Brochures',
  regulatory_submission: 'Regulatory Submissions',
  safety_report: 'Safety Reports',
  site_communication: 'Site Communications',
  competitive_intelligence: 'Competitive Intelligence',
};

const SHAREPOINT_SITE_BASE = 'https://meridiantx.sharepoint.com/sites/TrialPulse';

/**
 * Percent-encodes exactly like Python's `urllib.parse.quote(value)` (default
 * `safe='/'`) -- deliberately NOT `encodeURIComponent`, which leaves
 * `! * ' ( ) ~` unescaped where `quote` would escape them. `source_url` is
 * part of the cross-language chunk-parity contract (`chunk-parity.test.ts`),
 * so this has to match byte for byte, not just "look similar".
 */
function pyQuote(value: string): string {
  const unreserved = /[A-Za-z0-9_.\-~/]/;
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += unreserved.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * A plausible SharePoint document URL for a given classification/filename.
 * Mirrors `build_source_url` in pipeline.py: real production ingestion
 * receives the true `webUrl` from Microsoft Graph; this is only used for the
 * local synthetic corpus, which has no real SharePoint site behind it. The
 * same URL (no page anchor) is used for every chunk of a document, exactly
 * like production -- there is no `#page=N` suffix.
 */
export function buildSourceUrl(classification: DocumentClassification, filename: string): string {
  const library = CLASSIFICATION_LIBRARY_NAMES[classification] ?? 'Documents';
  return `${SHAREPOINT_SITE_BASE}/${pyQuote(library)}/${pyQuote(filename)}`;
}

// ---------------------------------------------------------------------------
// chunk_id + heading_path -- mirror hashing.make_chunk_id and pipeline.py's
// heading_path construction exactly.
// ---------------------------------------------------------------------------

function makeChunkId(documentId: string, headingPath: string, ordinal: number, contentHashValue: string): string {
  return sha256(`${documentId}::${headingPath}::${ordinal}::${contentHashValue}`);
}

function headingPathFor(documentTitle: string, sectionPath: string): string {
  return sectionPath ? `${documentTitle} > ${sectionPath}` : documentTitle;
}

/**
 * Recover the bare section path from a stored chunk's heading_path. Mirror
 * of `tombstones.section_path_of` in the Python pipeline, matched precisely:
 * strip the exact `"<document_title> > "` prefix (not fuzzy matching --
 * `document_title` is recorded on the chunk itself), and treat a heading_path
 * equal to the bare document_title (the pre-heading banner chunk) as the
 * empty section path.
 *
 * Needed because `heading_path` bakes in the chunk's OWN document_title, and
 * two versions of "the same document" necessarily have different titles
 * (e.g. "...v3.0" vs "...v4.0") -- so cross-version alignment
 * (`previous_version_hash` backfill here; `diffSections` in
 * `pipeline/version-compare.ts`) must compare on the section path alone.
 */
export function sectionPathOf(chunk: Pick<Chunk, 'document_title' | 'heading_path'>): string {
  const prefix = `${chunk.document_title} > `;
  if (chunk.heading_path.startsWith(prefix)) return chunk.heading_path.slice(prefix.length);
  if (chunk.heading_path === chunk.document_title) return '';
  return chunk.heading_path;
}

export interface LoadCorpusOptions {
  /** Defaults to `<repo root>/data/synthetic`. */
  corpusDir?: string;
  /** Timestamp stamped onto every chunk's `ingested_at`; defaults to a fixed value for determinism. */
  ingestedAt?: string;
}

const DEFAULT_INGESTED_AT = '2026-01-01T00:00:00.000Z';

/**
 * Build every chunk for one document (before `previous_version_hash`
 * backfill). Mirrors the per-document body of
 * `IngestionPipeline.ingest_document` in pipeline.py: extract ->
 * chunk_markdown -> hash -> assemble Chunk.
 */
function chunksForDocument(corpusDir: string, doc: ManifestDocument, ingestedAt: string): Chunk[] {
  const filePath = join(corpusDir, doc.filename);
  if (!existsSync(filePath)) {
    // Production's MarkdownExtractor raises ExtractionError on a missing
    // file; there is no facts[]-based fallback to synthesize content from
    // (that was a stopgap for when the markdown corpus didn't exist yet --
    // it now always does, and mirroring production means chunking from
    // markdown only).
    throw new Error(
      `Cannot chunk document "${doc.document_id}": markdown file not found at "${filePath}". ` +
        'loadCorpusChunks chunks from markdown only, mirroring the production ingestion pipeline.',
    );
  }

  const raw = readFileSync(filePath, 'utf8');
  const text = extractMarkdownText(raw);
  const drafts = chunkMarkdown(text);
  const sourceUrl = buildSourceUrl(doc.classification, doc.filename);

  return drafts.map((draft) => {
    const chunkContentHash = contentHash(draft.content);
    const headingPath = headingPathFor(doc.title, draft.sectionPath);
    return {
      chunk_id: makeChunkId(doc.document_id, headingPath, draft.ordinal, chunkContentHash),
      document_id: doc.document_id,
      document_title: doc.title,
      document_classification: doc.classification,
      document_version: doc.version,
      content: draft.content,
      content_hash: chunkContentHash,
      heading_path: headingPath,
      page_number: draft.pageNumber,
      source_url: sourceUrl,
      ingested_at: ingestedAt,
      site_code: doc.site_code,
      previous_version_hash: null, // backfilled below once every document's chunks exist.
    };
  });
}

/** Load and chunk the full synthetic corpus. Deterministic: same manifest + files always produce the same chunks. */
export function loadCorpusChunks(options: LoadCorpusOptions = {}): Chunk[] {
  const corpusDir = resolveCorpusDir(options.corpusDir);
  const ingestedAt = options.ingestedAt ?? DEFAULT_INGESTED_AT;
  const manifest = loadManifest(corpusDir);

  const chunksByDocument = new Map<string, Chunk[]>();
  for (const doc of manifest.documents) {
    chunksByDocument.set(doc.document_id, chunksForDocument(corpusDir, doc, ingestedAt));
  }

  // Backfill previous_version_hash (PRD decision 2): mirrors
  // tombstones.build_previous_version_hash_map + pipeline.py exactly --
  // align by the BARE section path (title stripped via sectionPathOf), not
  // by heading_path, because a new document version's title necessarily
  // differs from the version it supersedes.
  for (const doc of manifest.documents) {
    if (!doc.supersedes) continue;
    const previousChunks = chunksByDocument.get(doc.supersedes);
    if (!previousChunks) continue;

    const previousHashBySectionPath = new Map<string, string>();
    for (const chunk of previousChunks) {
      previousHashBySectionPath.set(sectionPathOf(chunk), chunk.content_hash);
    }

    const currentChunks = chunksByDocument.get(doc.document_id) ?? [];
    for (const chunk of currentChunks) {
      chunk.previous_version_hash = previousHashBySectionPath.get(sectionPathOf(chunk)) ?? null;
    }
  }

  return [...chunksByDocument.values()].flat();
}
