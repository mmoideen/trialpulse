/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ORCHESTRATOR_BASE_URL?: string;
  /** Dev-only: role header sent by DevAuthProvider. Never read in production. */
  readonly VITE_DEV_ROLE?: string;
  /** Dev-only: user principal name header sent by DevAuthProvider. */
  readonly VITE_DEV_UPN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
