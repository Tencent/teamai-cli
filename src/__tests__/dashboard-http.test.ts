import { describe, expect, it } from 'vitest';
import type http from 'node:http';

import { isLocalHost, isLocalWrite } from '../dashboard/http.js';

const request = (headers: Record<string, string>) => ({ headers } as unknown as http.IncomingMessage);

/** Every request must address the dashboard itself, so a DNS-rebound page cannot read sessions. */
describe('isLocalHost', () => {
  it('accepts the dashboard on localhost and refuses a rebound or missing host', () => {
    expect(isLocalHost(request({ host: 'localhost:3721' }), 3721)).toBe(true);
    expect(isLocalHost(request({ host: '127.0.0.1:3721' }), 3721)).toBe(true);
    expect(isLocalHost(request({ host: 'LOCALHOST:3721' }), 3721)).toBe(true);
    expect(isLocalHost(request({ host: 'evil.example:3721' }), 3721)).toBe(false);
    expect(isLocalHost(request({ host: 'localhost:9999' }), 3721)).toBe(false);
    expect(isLocalHost(request({}), 3721)).toBe(false);
  });
});

/** A write must come from the dashboard page (#1124). */
describe('isLocalWrite', () => {
  const json = { 'content-type': 'application/json', host: 'localhost:3721' };

  it('accepts a JSON request from the dashboard page', () => {
    expect(isLocalWrite(request({ ...json, origin: 'http://localhost:3721' }), 3721)).toBe(true);
    expect(isLocalWrite(request(json), 3721)).toBe(true);
  });

  it('refuses a foreign origin, a rebound host, and a non-JSON body', () => {
    expect(isLocalWrite(request({ ...json, origin: 'https://evil.example' }), 3721)).toBe(false);
    expect(isLocalWrite(request({ ...json, origin: 'null' }), 3721)).toBe(false);
    expect(isLocalWrite(request({ ...json, host: 'evil.example:3721' }), 3721)).toBe(false);
    expect(isLocalWrite(request({ host: 'localhost:3721', 'content-type': 'text/plain' }), 3721)).toBe(false);
  });
});
