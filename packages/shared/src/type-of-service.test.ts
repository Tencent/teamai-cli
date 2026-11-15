import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ignoreTypeOfServiceRefusal } from './type-of-service.js';

let server: http.Server;
let url: string;
const native = net.Socket.prototype.setTypeOfService;

beforeEach(async () => {
  server = http.createServer((_request, response) => { response.end('ok'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  url = `http://127.0.0.1:${address !== null && typeof address === 'object' ? address.port : 0}/`;
});

afterEach(async () => {
  net.Socket.prototype.setTypeOfService = native;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Node's fetch sets the type of service as each socket connects, and a socket the peer reset first refuses it with
// EINVAL, about once in 2000 requests on macOS, which ended the process. Every socket refuses here, so one fetch shows
// it. Node before 24 sets no type of service, so there is nothing to refuse.
it.skipIf(native === undefined)('carries a fetch whose socket refuses its type of service, with nothing thrown past it', async () => {
  net.Socket.prototype.setTypeOfService = function refuse(): net.Socket {
    throw Object.assign(new Error('setsockopt EINVAL'), { code: 'EINVAL' });
  };
  ignoreTypeOfServiceRefusal();

  const response = await fetch(url, { method: 'POST', body: '{}' });

  expect(await response.text()).toBe('ok');
});
