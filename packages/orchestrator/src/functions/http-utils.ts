/**
 * Shared HTTP plumbing for every function handler: auth extraction, error
 * mapping and JSON responses.
 *
 * Handlers never leak a stack trace or an internal identifier (config
 * values, provider error messages, SQL/OData fragments) to the client --
 * `mapErrorToResponse` converts every error into a small, safe, traced
 * response and the original error is only ever logged server-side.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sha256 } from '@trialpulse/shared';
import type { CallerIdentity } from '@trialpulse/shared';
import { authenticateRequest, type AuthenticateOptions, type HeaderLike } from '../auth/jwt';
import { AuthError } from '../auth/errors';
import type { TrialPulseConfig } from '../config';
import { InvalidQueryError } from '../pipeline/query-pipeline';
import type { Logger } from '../providers/types';

export interface HttpResult {
  status: number;
  jsonBody?: unknown;
  /** Set instead of jsonBody for non-JSON responses (e.g. the SharePoint validation handshake). */
  textBody?: string;
}

export function jsonResult(status: number, jsonBody: unknown): HttpResult {
  return { status, jsonBody };
}

export function textResult(status: number, textBody: string): HttpResult {
  return { status, textBody };
}

/** A handler-thrown error that maps to a specific, safe HTTP status and message. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'error',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Authenticate the caller, mapping AuthError to the right status. Never falls through silently. */
export async function requireIdentity(
  headers: HeaderLike,
  config: TrialPulseConfig,
  options?: AuthenticateOptions,
): Promise<CallerIdentity> {
  return authenticateRequest(headers, config, options);
}

/**
 * Convert any thrown error into a safe HTTP response, logging the real
 * detail server-side under `traceId` for correlation. This is the only
 * place allowed to look at `err.message` from an arbitrary internal error --
 * everywhere else gets the generic message below.
 */
export function mapErrorToResponse(err: unknown, traceId: string, logger: Logger): HttpResult {
  if (err instanceof AuthError) {
    logger.log('warn', 'request authentication/authorization failed', { trace_id: traceId, code: err.code });
    return jsonResult(err.status, { error: err.status === 401 ? 'unauthorized' : 'forbidden', trace_id: traceId });
  }
  if (err instanceof InvalidQueryError) {
    logger.log('info', 'request failed validation', { trace_id: traceId, issues: err.issues });
    return jsonResult(400, { error: 'invalid_request', issues: err.issues, trace_id: traceId });
  }
  if (err instanceof HttpError) {
    logger.log('warn', 'request handler raised HttpError', { trace_id: traceId, code: err.code, status: err.status });
    return jsonResult(err.status, { error: err.code, trace_id: traceId });
  }
  logger.log('error', 'unhandled error in request handler', { trace_id: traceId, error: String(err) });
  return jsonResult(500, { error: 'internal_error', trace_id: traceId });
}

export function newTraceId(): string {
  return randomUUID();
}

/**
 * Constant-time string comparison, safe for comparing two strings of
 * different lengths (SharePoint's `clientState` and our configured secret
 * will always be the same length in a legitimate request, but a forged
 * request's length is exactly the kind of thing a naive `===` leaks via
 * early-exit timing). Both sides are hashed to a fixed-length digest first
 * so `timingSafeEqual`'s equal-length precondition is always satisfied.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = Buffer.from(sha256(a), 'hex');
  const digestB = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(digestA, digestB);
}
