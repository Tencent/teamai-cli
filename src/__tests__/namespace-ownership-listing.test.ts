/**
 * Ownership has to come from the directory listing, not from the skills found in
 * it. A `skills/Frontend/` holding no deliverable SKILL.md still owns the
 * `Frontend` declaration; deriving the list from candidates alone left it out,
 * so the declaration fell through to `skills/frontend/` and delivered a
 * directory nothing had selected.
 *
 * The listing is mocked here because a case-insensitive filesystem cannot hold
 * both spellings at once — the situation this guards is Linux-only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listDirs = vi.fn();

vi.mock('../utils/fs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/fs.js')>()),
  listDirs: (...args: unknown[]) => listDirs(...args),
}));

import { scanRoleAwareSkills } from '../resources/desired.js';
import type { ResourceNamespaces } from '../roles.js';
import type { LocalConfig, ResourceItem } from '../types.js';

const localConfig = { repo: { localPath: '/repo', remote: 'r', kind: 'git' } } as unknown as LocalConfig;
const namespaces = { skills: ['Frontend'] } as unknown as ResourceNamespaces;

function skill(namespace: string, name = 'tdd'): ResourceItem {
  return {
    name,
    type: 'skills',
    namespace,
    sourcePath: `/repo/skills/${namespace}/${name}`,
    relativePath: `skills/${namespace}/${name}`,
  };
}

beforeEach(() => {
  listDirs.mockReset();
});

describe('scanRoleAwareSkills ownership', () => {
  it('does not deliver the folded sibling when the empty exact directory owns the declaration', async () => {
    // `skills/Frontend/` exists with nothing deliverable in it; `skills/frontend/`
    // holds a real skill. Folding must not move the declaration to the sibling.
    listDirs.mockResolvedValue(['Frontend', 'frontend']);

    const result = await scanRoleAwareSkills(localConfig, namespaces, [skill('frontend')]);

    expect(result.kind).toBe('resolved');
    expect(result.kind === 'resolved' && result.items).toEqual([]);
  });

  it('delivers the folded directory when no exact directory exists', async () => {
    listDirs.mockResolvedValue(['frontend']);

    const result = await scanRoleAwareSkills(localConfig, namespaces, [skill('frontend')]);

    expect(result.kind).toBe('resolved');
    expect(result.kind === 'resolved' && result.items.map((item) => item.name)).toEqual(['tdd']);
  });

  it('delivers only the exact directory when both hold the skill', async () => {
    listDirs.mockResolvedValue(['Frontend', 'frontend']);

    const result = await scanRoleAwareSkills(localConfig, namespaces, [
      skill('Frontend'),
      skill('frontend'),
    ]);

    expect(result.kind).toBe('resolved');
    expect(result.kind === 'resolved' && result.items.map((item) => item.namespace)).toEqual(['Frontend']);
  });

  it('still reports a conflict when two different active namespaces hold one name', async () => {
    listDirs.mockResolvedValue(['Frontend', 'backend']);
    const twoActive = { skills: ['Frontend', 'backend'] } as unknown as ResourceNamespaces;

    const result = await scanRoleAwareSkills(localConfig, twoActive, [skill('Frontend'), skill('backend')]);

    expect(result.kind).toBe('conflict');
  });
});
