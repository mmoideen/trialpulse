// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * TrialPulse ESLint 9 flat config.
 *
 * Scope: packages/shared, packages/orchestrator, packages/teams-tab and eval
 * (the four npm workspaces). `infra/`, `ingestion/`, `teams/`, `docs/` and
 * `data/` are out of scope: the first is Bicep, the second is Python (linted
 * by ruff, see .github/workflows/ci.yml), and the rest are not TypeScript.
 *
 * Type-aware rules (`no-floating-promises`, `no-misused-promises`) only run
 * against each workspace's non-test source files, using `projectService` so
 * every workspace's own tsconfig.json is picked up automatically. Test files
 * (`*.test.ts(x)`) are deliberately excluded from the type-aware tier: every
 * workspace tsconfig under packages/shared, packages/orchestrator and eval
 * excludes `*.test.ts` from its `include`, so there is no tsconfig program
 * that actually contains them and asking typescript-eslint to type-check them
 * would fail with a "not found in project" parser error. They still get the
 * full syntax-only ruleset below.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'infra/**',
      'ingestion/**',
      'teams/**',
      'docs/**',
      'data/**',
      'eval/results/**',
      'eval/goldens.json',
      '.github/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Downgraded from the default error: `any` is used deliberately in a
      // handful of places (provider adapters, test doubles) and a hard error
      // here would require editing source owned by other workstreams.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // The `// eslint-disable-next-line no-console` in
      // packages/orchestrator/src/config.ts predates this config; enabling
      // the rule (as a warning, not an error) is what makes that directive
      // suppress something real instead of nothing at all.
      'no-console': 'warn',
      // packages/shared/src/hash.ts deliberately matches a literal U+00A0
      // (non-breaking space) inside a regex, to normalize it to a plain
      // space when documents are copy-pasted from Word/PDF sources (see
      // that file's surrounding comments). `skipRegExps` is this rule's
      // documented escape hatch for exactly that pattern -- without it,
      // every intentional non-ASCII-whitespace regex literal in the repo
      // would need a per-line disable comment instead of one config line.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
      // packages/orchestrator/src/config.ts declares `interface CacheConfig
      // {}` as a deliberate, documented placeholder (see that file's module
      // doc: the cache provider currently needs no config at all, and the
      // empty interface is the extension point for when it does). Fixing the
      // rule's own complaint -- `type CacheConfig = Record<string, never>`
      // or a `// eslint-disable-next-line` -- means editing orchestrator
      // source, which is out of scope here; downgraded to a warning and
      // reported as a follow-up instead of left un-enforced everywhere.
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
  // Type-aware tier: non-test source files only, one block per workspace so
  // `projectService` resolves each workspace's own tsconfig.json.
  {
    files: ['packages/shared/src/**/*.ts', 'packages/orchestrator/src/**/*.ts', 'eval/*.ts'],
    ignores: ['**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['packages/teams-tab/src/**/*.{ts,tsx}', 'packages/teams-tab/vite.config.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // Real findings here: five React event handlers of the shape
      // `onClick={async () => { ... }}` (CitedAnswerCard.tsx,
      // ConversationTurnItem.tsx x2, main.tsx, AskTab.tsx), which is exactly
      // what this rule exists to catch -- React treats the handler's return
      // value as void, so a rejected promise inside one of those handlers is
      // silently swallowed instead of surfacing anywhere. Fixing them means
      // editing packages/teams-tab/src, which is out of scope for this
      // workstream; downgraded to a warning here and reported as a required
      // follow-up with exact locations rather than left un-enforced.
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
