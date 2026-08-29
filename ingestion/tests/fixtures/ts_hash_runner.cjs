#!/usr/bin/env node
'use strict';

/**
 * Runs the REAL `normalizeText`/`contentHash` from
 * packages/shared/src/hash.ts against a list of input strings, so the
 * Python test suite can assert byte-for-byte parity with the actual
 * TypeScript source (not a hand-copied re-implementation of it).
 *
 * Transpiles hash.ts in-memory with the TypeScript compiler (already a
 * dependency of the repo's root node_modules, so this works whether or not
 * `packages/shared` has been built) and executes the resulting CommonJS
 * module directly -- no build step, no network access.
 *
 * Usage: node ts_hash_runner.cjs <path-to-hash.ts>
 *        (reads a JSON array of strings on stdin, writes a JSON array of
 *        {normalized, hash} objects to stdout)
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

function main() {
  const hashTsPath = process.argv[2];
  if (!hashTsPath) {
    process.stderr.write('usage: ts_hash_runner.cjs <path-to-hash.ts>\n');
    process.exit(2);
  }

  const source = fs.readFileSync(hashTsPath, 'utf8');

  const ts = require('typescript');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: hashTsPath,
  }).outputText;

  // Compile the transpiled output as a real Node module (rather than eval)
  // so `require('node:crypto')` inside hash.ts resolves normally.
  const compiledModule = new Module(hashTsPath, module.parent);
  compiledModule.filename = hashTsPath;
  compiledModule.paths = Module._nodeModulePaths(path.dirname(hashTsPath));
  compiledModule._compile(transpiled, hashTsPath);

  const { contentHash, normalizeText } = compiledModule.exports;

  const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));
  const results = inputs.map((text) => ({
    normalized: normalizeText(text),
    hash: contentHash(text),
  }));

  process.stdout.write(JSON.stringify(results));
}

main();
