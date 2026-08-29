/**
 * Cross-language chunk parity: `local/corpus.ts` vs. the REAL production
 * Python ingestion pipeline.
 *
 * Mirror image of `ingestion/tests/test_hash_parity.py`, which shells out
 * from Python to Node to check `hash.ts` parity against `hashing.py`. This
 * shells out from Node to Python (`ingestion/.venv/bin/python`) via
 * `fixtures/py_chunk_runner.py`, which runs the actual production chunker
 * (`trialpulse_ingest.chunking` + `.pipeline` + `.tombstones`) over
 * `data/synthetic/` -- not a hand-copied reimplementation of it -- and
 * asserts the two implementations produce an IDENTICAL chunk set: same
 * count, same chunk_id set, same content_hash set, same heading_path set,
 * same page numbers, and same source_urls.
 *
 * This is the regression test for the defect this file's sibling
 * (`corpus.ts`) fixes: two independent chunkers over the same corpus that
 * agreed on nothing (0 chunk_ids in common, 0 content_hashes in common, 65
 * vs. 45 total chunks). If this test ever goes red again, every eval
 * golden, RBAC test, and version-compare citation is once again being
 * exercised against chunks production can never emit.
 *
 * Gracefully (but LOUDLY) skips if `ingestion/.venv` has not been set up --
 * a fresh clone that hasn't run the Python setup steps in
 * `ingestion/README.md` should not fail `npm test -w @trialpulse/orchestrator`
 * on that account, but the skip must be impossible to miss in CI output.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Chunk } from '@trialpulse/shared';
import { loadCorpusChunks, resolveCorpusDir } from './corpus';

const REPO_ROOT = join(resolveCorpusDir(), '..', '..');
const INGESTION_DIR = join(REPO_ROOT, 'ingestion');
const RUNNER_SCRIPT = join(__dirname, 'fixtures', 'py_chunk_runner.py');

function findPythonExecutable(): string | null {
  // `ingestion/.venv/bin/python` is the path the task brief calls out
  // explicitly; `Scripts/python.exe` covers a venv created on Windows.
  const candidates = [
    join(INGESTION_DIR, '.venv', 'bin', 'python'),
    join(INGESTION_DIR, '.venv', 'bin', 'python3'),
    join(INGESTION_DIR, '.venv', 'Scripts', 'python.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const PYTHON_EXECUTABLE = findPythonExecutable();

if (!PYTHON_EXECUTABLE) {
  // Deliberately loud: `console.warn` (not silent skip metadata buried in a
  // JSON reporter) plus a banner that is impossible to miss scrolling past
  // in a terminal.
  // eslint-disable-next-line no-console
  console.warn(
    `\n${'='.repeat(78)}\n` +
      'SKIPPING chunk-parity.test.ts: ingestion/.venv not found.\n' +
      'This test is the ONLY thing verifying that local/corpus.ts (used by\n' +
      'seeding, the dev server, and the eval harness) produces the SAME\n' +
      'chunks as the real production Python ingestion pipeline. Set up the\n' +
      'Python environment (see ingestion/README.md), then re-run\n' +
      '`npm test -w @trialpulse/orchestrator`.\n' +
      `${'='.repeat(78)}\n`,
  );
}

/** Chunk shape written by `fixtures/py_chunk_runner.py` (embedding omitted -- irrelevant to chunk-shape parity). */
interface ParityChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  document_classification: string;
  document_version: string;
  content: string;
  content_hash: string;
  heading_path: string;
  page_number: number;
  source_url: string;
  site_code: string | null;
  previous_version_hash: string | null;
}

function runPythonChunker(pythonExecutable: string, outputPath: string): ParityChunk[] {
  const result = spawnSync(pythonExecutable, [RUNNER_SCRIPT, REPO_ROOT, outputPath], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `py_chunk_runner.py exited with status ${String(result.status)}.\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(readFileSync(outputPath, 'utf8')) as ParityChunk[];
}

function firstN<T>(items: readonly T[], n: number): T[] {
  return items.slice(0, n);
}

/** Diff-friendly report of two string sets: what's only on one side, capped so a failure message stays readable. */
function diffSets(label: string, python: ReadonlySet<string>, ts: ReadonlySet<string>, n = 15): string {
  const pythonOnly = [...python].filter((v) => !ts.has(v));
  const tsOnly = [...ts].filter((v) => !python.has(v));
  const lines = [
    `${label}: python has ${python.size}, typescript has ${ts.size} ` +
      `(${pythonOnly.length} only in python, ${tsOnly.length} only in typescript).`,
  ];
  if (pythonOnly.length > 0) {
    lines.push(`  only in python (first ${Math.min(n, pythonOnly.length)}): ${JSON.stringify(firstN(pythonOnly, n))}`);
  }
  if (tsOnly.length > 0) {
    lines.push(`  only in typescript (first ${Math.min(n, tsOnly.length)}): ${JSON.stringify(firstN(tsOnly, n))}`);
  }
  return lines.join('\n');
}

/** Diff-friendly report of a field that should match for every chunk_id present on both sides. */
function diffField<K extends keyof ParityChunk & keyof Chunk>(
  field: K,
  pythonChunks: readonly ParityChunk[],
  tsChunks: readonly Chunk[],
  n = 10,
): string {
  const pythonById = new Map(pythonChunks.map((c) => [c.chunk_id, c]));
  const tsById = new Map(tsChunks.map((c) => [c.chunk_id, c]));
  const mismatches: string[] = [];
  for (const [id, pythonChunk] of pythonById) {
    const tsChunk = tsById.get(id);
    if (!tsChunk) continue; // reported separately by the chunk_id set diff, not here.
    if (pythonChunk[field] !== tsChunk[field]) {
      mismatches.push(`  ${id}\n    python: ${JSON.stringify(pythonChunk[field])}\n    ts:     ${JSON.stringify(tsChunk[field])}`);
    }
  }
  return (
    `${field}: ${mismatches.length} mismatch(es) on chunks present in both implementations ` +
    `(showing first ${Math.min(n, mismatches.length)}):\n${firstN(mismatches, n).join('\n')}`
  );
}

describe.skipIf(!PYTHON_EXECUTABLE)(
  'chunk parity: local/corpus.ts (TypeScript) vs. the real production Python ingestion pipeline',
  () => {
    let tempDir: string;
    let pythonChunks: ParityChunk[];
    let tsChunks: Chunk[];

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'trialpulse-chunk-parity-'));
      const outputPath = join(tempDir, 'python-chunks.json');
      pythonChunks = runPythonChunker(PYTHON_EXECUTABLE!, outputPath);
      tsChunks = loadCorpusChunks();
    });

    afterAll(() => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    });

    it('produces the same number of chunks', () => {
      const pythonIds = new Set(pythonChunks.map((c) => c.chunk_id));
      const tsIds = new Set(tsChunks.map((c) => c.chunk_id));
      expect(tsChunks.length, diffSets('chunk_id', pythonIds, tsIds)).toBe(pythonChunks.length);
    });

    it('produces exactly the same chunk_id set', () => {
      const pythonIds = new Set(pythonChunks.map((c) => c.chunk_id));
      const tsIds = new Set(tsChunks.map((c) => c.chunk_id));
      expect(tsIds, diffSets('chunk_id', pythonIds, tsIds)).toEqual(pythonIds);
    });

    it('produces exactly the same content_hash set', () => {
      const pythonHashes = new Set(pythonChunks.map((c) => c.content_hash));
      const tsHashes = new Set(tsChunks.map((c) => c.content_hash));
      expect(tsHashes, diffSets('content_hash', pythonHashes, tsHashes)).toEqual(pythonHashes);
    });

    it('produces exactly the same heading_path set', () => {
      const pythonHeadings = new Set(pythonChunks.map((c) => c.heading_path));
      const tsHeadings = new Set(tsChunks.map((c) => c.heading_path));
      expect(tsHeadings, diffSets('heading_path', pythonHeadings, tsHeadings)).toEqual(pythonHeadings);
    });

    it('agrees on page_number for every chunk_id present in both', () => {
      const message = diffField('page_number', pythonChunks, tsChunks);
      expect(message, message).toMatch(/^page_number: 0 mismatch/);
    });

    it('agrees on content for every chunk_id present in both (no page markers leaked, no facts fallback drift)', () => {
      const message = diffField('content', pythonChunks, tsChunks);
      expect(message, message).toMatch(/^content: 0 mismatch/);
    });

    it('agrees on source_url for every chunk_id present in both', () => {
      const message = diffField('source_url', pythonChunks, tsChunks);
      expect(message, message).toMatch(/^source_url: 0 mismatch/);
    });

    it('agrees on document_title for every chunk_id present in both', () => {
      const message = diffField('document_title', pythonChunks, tsChunks);
      expect(message, message).toMatch(/^document_title: 0 mismatch/);
    });

    it('agrees on previous_version_hash for every chunk_id present in both', () => {
      const message = diffField('previous_version_hash', pythonChunks, tsChunks);
      expect(message, message).toMatch(/^previous_version_hash: 0 mismatch/);
    });
  },
);
