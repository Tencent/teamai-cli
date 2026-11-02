/**
 * Request helpers for the dashboard's write routes. The server answers every
 * origin for reads (CORS *), so a write has to prove it comes from the
 * dashboard page itself, and its body is read with a size limit.
 */
import type http from 'node:http';

/** A request the dashboard answers with a client error, not a 500. */
export class HttpError extends Error {
  constructor(readonly status: 400 | 403 | 409, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * True for a JSON request whose Host, and Origin when sent, are this
 * dashboard on localhost. A JSON body forces a preflight the server never
 * grants, and a foreign Origin or a rebound Host is refused outright.
 */
export function isLocalWrite(req: http.IncomingMessage, port: number): boolean {
  const local = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return false;

  if (!local.has(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;

  if (origin === undefined) return true;

  try {
    const parsed = new URL(origin);

    return parsed.protocol === 'http:' && local.has(parsed.host);
  } catch {
    return false;
  }
}

/** A request's JSON object body. Throws a 400 for anything else. */
export async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;

    if (size > MAX_JSON_BODY_BYTES) throw new HttpError(400, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }

  let body: unknown;

  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be a JSON object.');

  return body as Record<string, unknown>;
}
