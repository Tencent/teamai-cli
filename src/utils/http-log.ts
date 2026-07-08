/**
 * Debug logging for backend HTTP requests (local-agent report/sync/ack).
 *
 * Logs the full request (method / url / headers / body), the response body,
 * and the status code to log.debug — which persists to ~/.teamai/debug.log
 * regardless of verbose mode, so a failed backend call is diagnosable after
 * the fact. Sensitive headers (Authorization, X-API-Token) are redacted so
 * tokens never land in the log file. Request/response bodies are logged
 * verbatim — the current backend payloads carry no secrets (credentials live
 * only in headers); add body redaction here if that ever changes.
 */

import { log } from './logger.js';

/** Header names whose values must be masked before logging. */
const SENSITIVE_HEADER_RE = /^(authorization|x-api-token|x-api-key|cookie)$/i;

/** Mask a sensitive header value, preserving an auth scheme prefix if present. */
function redactValue(value: string): string {
  const scheme = value.match(/^(Bearer|Basic|Token)\s+/i);
  return scheme ? `${scheme[1]} ***` : '***';
}

/** Return a copy of headers with sensitive values replaced by "***". */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_RE.test(key) ? redactValue(value) : value;
  }
  return out;
}

/** Truncate an over-long body string so the log file stays readable. */
function previewBody(body: unknown, maxLen = 4096): string {
  if (body === undefined || body === null) return '(empty)';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > maxLen ? `${text.slice(0, maxLen)}… (${text.length} bytes total)` : text;
}

/** Log an outgoing backend request (headers redacted). */
export function logHttpRequest(
  tag: string,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): void {
  log.debug(`${tag} → ${method} ${url}`);
  log.debug(`${tag}   headers: ${JSON.stringify(redactHeaders(headers))}`);
  if (body !== undefined) {
    log.debug(`${tag}   body: ${previewBody(body)}`);
  }
}

/** Log a backend response — the status code plus the response body. */
export function logHttpResponse(
  tag: string,
  method: string,
  url: string,
  status: number,
  statusText: string,
  body: unknown,
): void {
  const level = status >= 400 ? 'ERROR' : 'OK';
  log.debug(`${tag} ← ${status} ${statusText} [${level}] ${method} ${url}`);
  log.debug(`${tag}   response: ${previewBody(body)}`);
}
