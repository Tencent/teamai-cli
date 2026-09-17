import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { learningsRoots, listLearningFiles } from '../utils/learnings-roots.js';
import type { LocalConfig } from '../types.js';

let home: string;
const realHome = process.env.HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-learnings-roots-'));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function gitConfig(overrides: Partial<LocalConfig> = {}): LocalConfig {
  return {
    repo: {
      localPath: path.join(home, '.teamai', 'team-repo'),
      remote: 'https://example.com/team.git',
      kind: 'git',
    },
    username: 'alice',
    scope: 'user',
    additionalRoles: [],
    ...overrides,
  };
}

describe('learningsRoots', () => {
  it('writes into the learnings branch worktree, beside the clone', () => {
    const roots = learningsRoots(gitConfig());

    expect(roots.write).toBe(path.join(home, '.teamai', 'learnings-wt', 'learnings'));
    expect(roots.read[0]).toBe(roots.write);
  });

  it('always keeps the clone among the read roots, so an inherited corpus stays readable', () => {
    const roots = learningsRoots(gitConfig());

    expect(roots.read).toContain(path.join(home, '.teamai', 'team-repo', 'learnings'));
  });

  it('adds the machine-local cache as a read root in user scope', () => {
    const roots = learningsRoots(gitConfig({ scope: 'user' }));

    expect(roots.read).toContain(path.join(home, '.teamai', 'learnings'));
  });

  it('leaves the machine-local cache out in project scope, because it is shared by every project', () => {
    const roots = learningsRoots(gitConfig({ scope: 'project', projectRoot: path.join(home, 'work') }));

    expect(roots.read).not.toContain(path.join(home, '.teamai', 'learnings'));
  });

  it('keeps the worktree inside .teamai in single-repo mode', () => {
    const business = path.join(home, 'product');
    const roots = learningsRoots(gitConfig({
      repo: {
        localPath: path.join(business, '.teamai'),
        remote: 'https://example.com/product.git',
        kind: 'self',
        businessRepoRoot: business,
      },
      scope: 'project',
      projectRoot: business,
    }));

    expect(roots.write).toBe(path.join(business, '.teamai', 'learnings-wt', 'learnings'));
    // The corpus written before the switch stays readable, in place.
    expect(roots.read).toContain(path.join(business, '.teamai', 'learnings'));
  });

  it('writes into the knowledge dir for an HTTP backend, which has no branch', () => {
    const roots = learningsRoots(gitConfig({
      repo: {
        localPath: path.join(home, '.teamai', 'team-repo'),
        remote: 'https://example.com/api',
        kind: 'http',
      },
      scope: 'project',
      projectRoot: path.join(home, 'work'),
    }));

    expect(roots.write).toBe(path.join(home, '.teamai', 'team-repo', 'learnings'));
    expect(roots.read[0]).toBe(roots.write);
  });

  it('never repeats a root', () => {
    const roots = learningsRoots(gitConfig());

    expect(new Set(roots.read).size).toBe(roots.read.length);
  });
});

describe('listLearningFiles', () => {
  it('lists the flat markdown of every root and reports where each file lives', async () => {
    const recent = path.join(home, 'wt', 'learnings');
    const inherited = path.join(home, 'clone', 'learnings');
    fs.mkdirSync(recent, { recursive: true });
    fs.mkdirSync(inherited, { recursive: true });
    fs.writeFileSync(path.join(recent, 'new.md'), 'new');
    fs.writeFileSync(path.join(inherited, 'old.md'), 'old');

    const files = await listLearningFiles([recent, inherited]);

    expect(files.map((f) => f.file).sort()).toEqual(['new.md', 'old.md']);
    expect(files.find((f) => f.file === 'old.md')?.root).toBe(inherited);
  });

  it('keeps the first root when the same file is in two of them', async () => {
    const recent = path.join(home, 'wt', 'learnings');
    const inherited = path.join(home, 'clone', 'learnings');
    fs.mkdirSync(recent, { recursive: true });
    fs.mkdirSync(inherited, { recursive: true });
    fs.writeFileSync(path.join(recent, 'same.md'), 'current');
    fs.writeFileSync(path.join(inherited, 'same.md'), 'superseded');

    const files = await listLearningFiles([recent, inherited]);

    expect(files).toHaveLength(1);
    expect(files[0]?.absPath).toBe(path.join(recent, 'same.md'));
  });

  it('ignores a root that does not exist', async () => {
    const present = path.join(home, 'wt', 'learnings');
    fs.mkdirSync(present, { recursive: true });
    fs.writeFileSync(path.join(present, 'a.md'), 'a');

    const files = await listLearningFiles([path.join(home, 'nope'), present]);

    expect(files.map((f) => f.file)).toEqual(['a.md']);
  });
});
