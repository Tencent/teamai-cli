import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
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

it.each([false, true])('recovers from a failed publication record replacement (existing: %s)', async (existing) => {
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-session-publish-'));
  const config: LocalConfig = {
    repo: { localPath: path.join(dataHome, 'team'), remote: '' },
    scope: 'user', username: 'tester', additionalRoles: [], dataHome,
  };
  const ref = { platform: 'claude-code', sessionId: 'session-a' };
  const before = '2026-11-25T10:00:00.000Z';
  const after = '2026-11-26T10:00:00.000Z';
  const records = path.join(dataHome, 'sessions', 'published');
  const failure = Object.assign(new Error('publication replacement failed'), { code: 'EIO' });

  try {
    if (existing) await SessionPublish.recordArchived(config, ref, before);
    const files = existing ? await fs.readdir(records) : [];
    const original = existing ? await fs.readFile(path.join(records, files[0]), 'utf8') : undefined;
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure);

    await expect(SessionPublish.recordArchived(config, ref, after)).rejects.toBe(failure);

    expect(await SessionPublish.archivedAt(config, ref)).toBe(existing ? Date.parse(before) : undefined);
    expect(await fs.readdir(records)).toEqual(files);
    if (existing) expect(await fs.readFile(path.join(records, files[0]), 'utf8')).toBe(original);

    await SessionPublish.recordArchived(config, ref, after);

    expect(await SessionPublish.archivedAt(config, ref)).toBe(Date.parse(after));
    expect(await fs.readdir(records)).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(dataHome, { recursive: true, force: true });
  }
});
