/**
 * Typed authentication/authorization error.
 *
 * Callers (the HTTP function handlers, via `http-utils.ts`) map `status` to
 * the actual HTTP response code. We deliberately keep this distinct from a
 * generic `Error` so a handler can never accidentally leak a 500 for what is
 * really a 401/403, and never accidentally leak a stack trace for one either.
 */
export type AuthErrorCode =
  | 'missing_token'
  | 'malformed_token'
  | 'invalid_token'
  | 'tenant_mismatch'
  | 'missing_upn'
  | 'missing_oid'
  | 'invalid_dev_header'
  | 'forbidden_role'
  | 'bot_not_configured'
  | 'invalid_bot_token';

export class AuthError extends Error {
  readonly status: 401 | 403;
  readonly code: AuthErrorCode;

  constructor(status: 401 | 403, message: string, code: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}
