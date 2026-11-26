import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SessionPublish } from '../session-flow/session-publish.js';
import type { LocalConfig } from '../types.js';

it('records concurrent publications of the same session', async () => {
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-session-publish-'));
  const config: LocalConfig = {
    repo: { localPath: path.join(dataHome, 'team'), remote: '' },
    scope: 'user', username: 'tester', additionalRoles: [], dataHome,
  };
  const ref = { platform: 'claude-code', sessionId: 'session-a' };
  const publishedAt = '2026-11-25T10:00:00.000Z';

  try {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => SessionPublish.recordArchived(config, ref, publishedAt)));

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(await SessionPublish.archivedAt(config, ref)).toBe(Date.parse(publishedAt));
  } finally {
    await fs.rm(dataHome, { recursive: true, force: true });
  }
});
