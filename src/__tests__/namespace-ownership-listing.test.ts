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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const listDirs = vi.fn();

vi.mock('../utils/fs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/fs.js')>()),
  listDirs: (...args: unknown[]) => listDirs(...args),
}));

import { scanRoleAwareSkills } from '../resources/desired.js';
import { readTeamSkillIndex } from '../resources/skills.js';
import { selectAgentsForDirectory } from '../resources/agents.js';
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

describe('readTeamSkillIndex reads ownership from the listing', () => {
  const SKILL = '---\nname: tdd\ndescription: Test-driven development\n---\n\n# TDD\n';

  async function repoWithLowercaseSkill(): Promise<string> {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-skill-index-own-'));
    const full = path.join(repo, 'skills', 'frontend', 'tdd');
    await fs.mkdir(full, { recursive: true });
    await fs.writeFile(path.join(full, 'SKILL.md'), SKILL, 'utf8');

    return repo;
  }

  /**
   * Regression: the index treated every folded match as owned, so a locally
   * authored `tdd` without a delivery record resolved to the lowercase team copy
   * and overwrote it, instead of being rejected as out of scope — the exact
   * `Frontend/` directory owns the declaration and holds no such skill.
   */
  it('does not index the folded sibling when the exact directory owns the declaration', async () => {
    listDirs.mockResolvedValue(['Frontend', 'frontend']);
    const repo = await repoWithLowercaseSkill();

    const index = await readTeamSkillIndex(repo, ['Frontend']);

    expect(index.teamSkills.get('tdd')).toBeUndefined();
  });

  it('indexes the folded directory when no exact directory exists', async () => {
    listDirs.mockResolvedValue(['frontend']);
    const repo = await repoWithLowercaseSkill();

    const index = await readTeamSkillIndex(repo, ['Frontend']);

    expect(index.teamSkills.get('tdd')?.namespace).toBe('frontend');
  });
});

describe('selectAgentsForDirectory with owned directories', () => {
  function agent(name: string, namespace?: string): ResourceItem {
    return {
      name,
      type: 'agents',
      namespace,
      sourcePath: `/repo/agents/${namespace ? `${namespace}/` : ''}${name}.yaml`,
      relativePath: `agents/${name}.yaml`,
    };
  }

  /**
   * Regression: the folded sibling was treated as an active namespace, so it
   * claimed the name. The exact directory owns the declaration even when it
   * holds a different agent, and the sibling is then nobody's.
   */
  it('does not let a folded sibling claim a name the exact directory owns', () => {
    const owned = new Set(['Frontend']);
    const selected = selectAgentsForDirectory(
      [agent('other', 'Frontend'), agent('reviewer', 'frontend')],
      ['Frontend'],
      undefined,
      owned,
    );

    expect(selected.map((item) => item.name)).toEqual(['other']);
  });

  /**
   * The claiming bug hid the record: a folded reviewer took the name, so the
   * genuinely recorded `backend` copy was never recovered and nothing was
   * delivered for that stem.
   */
  it('recovers a recorded agent when the folded sibling no longer claims it', () => {
    const owned = new Set(['Frontend']);
    const selected = selectAgentsForDirectory(
      [agent('other', 'Frontend'), agent('reviewer', 'frontend'), agent('reviewer', 'backend')],
      ['Frontend'],
      { reviewer: 'agents/backend/reviewer.yaml' },
      owned,
    );

    expect(selected.map((item) => item.namespace)).toContain('backend');
  });

  it('without an owned set still folds, as before', () => {
    const selected = selectAgentsForDirectory(
      [agent('other', 'Frontend'), agent('reviewer', 'frontend')],
      ['Frontend'],
    );

    expect(selected.map((item) => item.name)).toEqual(['other', 'reviewer']);
  });
});
