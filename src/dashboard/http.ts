/**
 * Request helpers for the dashboard's write routes. The server answers every
 * origin for reads (CORS *), so a write has to prove it comes from the
 * dashboard page itself, and its body is read with a size limit.
 */
import type http from 'node:http';
import { z } from 'zod';

import { type JsonValue, JsonObjectSchema } from '../types.js';

/** A request the dashboard answers with a client error, not a 500. */
export class HttpError extends Error {
  constructor(readonly status: 400 | 403 | 409, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

/** A write route's request body: a JSON object, whose fields the route parses. */
const JsonBodySchema = JsonObjectSchema;

export type JsonBody = z.infer<typeof JsonBodySchema>;

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
export async function readJsonBody(req: http.IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const read of req) {
    // SAFETY: no encoding is set on the request stream, so its async iterator yields Buffer chunks.
    const chunk = read as Buffer;
    size += chunk.length;

    if (size > MAX_JSON_BODY_BYTES) throw new HttpError(400, 'Request body too large.');
    chunks.push(chunk);
  }

  let json: JsonValue;

  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }

  const body = JsonBodySchema.safeParse(json);

  if (!body.success) throw new HttpError(400, 'Request body must be a JSON object.');

  return body.data;
}
