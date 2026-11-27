import { describe, expect, it } from 'vitest';
import { daemon, behave, start, ready, useRuntimeSuite } from '../testing/suite.js';

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  it.each([
    ['an option it does not take', { url: 'ws://127.0.0.1:1/ws', imgae: 'x' }, {}, { code: 'bad_option', key: 'imgae' }],
    ['a mode for a tool it does not run', { url: 'ws://127.0.0.1:1/ws', mode: { cursor: 'agent' } }, {}, { code: 'bad_option', key: 'mode' }],
    ['no daemon at the url', { url: 'ws://127.0.0.1:1/ws' }, {}, { code: 'daemon_unreachable' }],
    ['a daemon older than the client', undefined, { version: '0.13.2' }, { code: 'daemon_version', message: expect.stringContaining('runs version 0.13.2') }],
    ['a daemon without agent receipts', undefined, { missing: ['agentRequestReceipts'] }, { code: 'daemon_version', message: expect.stringContaining('lacks agentRequestReceipts') }],
  ])('fails init on %s', async (_, options, behaviour, error) => {
    behave(behaviour);

    expect(await ready(start(), { options: options ?? { url: daemon.url } })).toEqual({ type: 'init', ok: false, error: expect.objectContaining(error) });
  });
});
