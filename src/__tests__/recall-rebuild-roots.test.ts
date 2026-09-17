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

vi.mock('../config.js', () => ({
  requireInit: vi.fn(async () => ({ localConfig: config() })),
  detectProjectConfig: vi.fn(async () => null),
  loadLocalConfigForScope: vi.fn(async (scope: string) => (scope === 'user' ? config() : null)),
  loadTeamConfig: vi.fn(async () => null),
  autoDetectInit: vi.fn(async () => ({ localConfig: config() })),
}));

function config() {
  return {
    repo: { localPath: path.join(tmp, '.teamai', 'team-repo'), remote: 'r', kind: 'git' as const },
    username: 'alice',
    scope: 'user' as const,
    additionalRoles: [],
    projects: ['alpha'],
  };
}

const { recall } = await import('../recall.js');

/**
 * A recall that has to rebuild the index must see the same learnings a pull
 * would have indexed: every root, and the active project namespaces. It used to
 * pick one directory and pass no namespaces at all, so half the knowledge base
 * disappeared with no error.
 */
describe('recall rebuilding a missing index', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-roots-'));
    process.env.HOME = tmp;
    const repo = path.join(tmp, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(repo, 'learnings', 'alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'learnings', 'shared-note.md'),
      '---\ntitle: shared note\n---\nretry budget for the gateway',
    );
    fs.writeFileSync(
      path.join(repo, 'learnings', 'alpha', 'project-note.md'),
      '---\ntitle: project note\n---\nretry budget for the gateway',
    );
    fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n',
    );
  });

  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('indexes the active project namespace, not only the shared root', async () => {
    await recall('retry budget', {});

    const index = JSON.parse(fs.readFileSync(path.join(tmp, '.teamai', 'search-index.json'), 'utf8'));
    const names = index.entries.map((e: { filename: string }) => e.filename);
    expect(names).toContain('shared-note.md');
    expect(names).toContain(path.join('alpha', 'project-note.md'));
  });
});
