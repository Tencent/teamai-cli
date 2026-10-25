import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptStore, isRunAttempt } from '../scorers/attempts.js';
import type { LocalConfig } from '../types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scope(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-attempts-'));
  dirs.push(root);
  return { repo: { localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
}

describe('AttemptStore', () => {
  it('reads an attempt file written before attempts named their source as a workflow attempt', async () => {
    const config = scope();
    const dir = path.join(config.dataHome ?? '', 'scores', 'attempts', 's0000000000000');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a00000000.json'), JSON.stringify({
      status: 'leased', attempt: 'a00000000', entry: 's0000000000000', scorer: 'review', rubric: { sourceHash: 'h' },
      subject: { runId: 'r', step: 's', pass: 1 }, driver: { kind: 'local', machine: 'm', workspace: '/w' },
      judge: { tool: 'claude', by: 'scorer', isolation: 'verified', access: 'read' }, leasedAt: '2026-10-25T00:00:00.000Z', expiresAt: '2026-10-25T00:30:00.000Z',
    }));

    const read = await AttemptStore.get(config, 's0000000000000', 'a00000000');
    expect(read).toMatchObject({ subject: { runId: 'r', step: 's', pass: 1 } });
    expect(read && isRunAttempt(read)).toBe(true);
  });
});
