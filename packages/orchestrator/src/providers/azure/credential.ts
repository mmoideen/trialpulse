/**
 * Shared managed-identity credential for every Azure provider.
 *
 * Per PRD 8.1 ("Secrets managed via Azure Key Vault; no secrets in code or
 * environment variables except Key Vault references") the preferred
 * authentication path everywhere is `DefaultAzureCredential`, which in a
 * deployed Azure Functions app resolves to the Function App's managed
 * identity with no secret material anywhere. An explicit key (itself only
 * ever populated via a Key Vault reference app setting -- see
 * `src/config.ts`) is a fallback for environments where managed identity
 * is not yet wired up (e.g. a very early dev subscription).
 */
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';

let cached: TokenCredential | null = null;

/** One shared `DefaultAzureCredential` for the process lifetime. */
export function getManagedIdentityCredential(): TokenCredential {
  cached ??= new DefaultAzureCredential();
  return cached;
}
