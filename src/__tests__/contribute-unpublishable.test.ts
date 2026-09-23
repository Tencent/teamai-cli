import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

let tmp: string;
const realHome = process.env.HOME;

function config() {
  return {
    // Not a dedicated team-repo clone root, so the learnings worktree cannot be
    // created at all: the publish fails before it can write anything.
    repo: { localPath: path.join(tmp, 'not-a-clone'), remote: 'r', kind: 'git' as const },
    username: 'alice',
    scope: 'user' as const,
    additionalRoles: [],
  };
}

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(async () => ({ localConfig: config() })),
  detectProjectConfig: vi.fn(async () => null),
  loadLocalConfigForScope: vi.fn(async () => null),
  loadTeamConfig: vi.fn(async () => null),
}));

const { contribute } = await import('../contribute.js');

/**
 * Whatever goes wrong with git, a contribution the member has already made has
 * to stay findable on their own machine. Before learnings moved to their own
 * branch the note was written into the clone, so it was always indexed; it must
 * not become invisible when the branch worktree is what cannot be created.
 */
describe('contributing when the learnings branch cannot be written at all', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-unpublishable-'));
    process.env.HOME = path.join(tmp, 'home');
    fs.mkdirSync(path.join(tmp, 'not-a-clone'), { recursive: true });
    fs.mkdirSync(process.env.HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps the note recallable on this machine', async () => {
    const note = path.join(tmp, 'note.md');
    fs.writeFileSync(note, '---\ntitle: unpublishable\n---\ngateway timeout budget\n');

    await contribute({ scope: 'user', title: 'unpublishable', file: note });

    const index = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, '.teamai', 'search-index.json'), 'utf8'),
    );
    const names = index.entries.map((e: { filename: string }) => e.filename);
    expect(names.some((n: string) => n.startsWith('unpublishable-'))).toBe(true);
  });
});
