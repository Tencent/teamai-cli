import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import {
  getReportsDir,
  getKnowledgeDir,
  isSelfMode,
  usesBranchWorktree,
  REPORTS_WORKTREE_DIRNAME,
  LocalConfigSchema,
  TeamaiConfigSchema,
  type LocalConfig,
} from '../types.js';
import { buildProjectScopeGitignore, buildSelfModeGitignore, migrateSelfModeGitignore, migrateSelfModeGitignoreContent } from '../init.js';

/** The names of `names` that `gitignore`, as `.teamai/.gitignore`, makes git ignore. */
function ignoredBy(gitignore: string, names: string[]): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitignore-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.mkdirSync(path.join(dir, '.teamai'));
    fs.writeFileSync(path.join(dir, '.teamai', '.gitignore'), gitignore);
    return names.filter((name) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', `.teamai/${name}`], { cwd: dir });
        return true;
      } catch {
        return false;
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The files a usage write leaves beside `usage.jsonl` while it runs or when it gives up on the lock (#788). */
const USAGE_SIDE_FILES = ['usage.jsonl.lock', 'usage.jsonl.123.0123456789ab.tmp', 'usage.pending-0f8e2c1a-1b2c-4d5e-8f90-123456789abc.jsonl'];
/** The temp copy an interrupted config save leaves beside config.yaml (writeFileAtomic, #831). */
const CONFIG_SAVE_TEMP = 'config.yaml.123.0123456789ab.tmp';

function makeConfig(kind: 'git' | 'http' | 'self', localPath = '/repo/.teamai'): LocalConfig {
  return {
    repo: {
      localPath,
      remote: 'https://github.com/acme/app.git',
      kind,
      ...(kind === 'self' ? { businessRepoRoot: '/repo' } : {}),
    },
    username: 'alice',
    scope: 'project',
    projectRoot: '/repo',
    additionalRoles: [],
  };
}

describe('single-repo mode path helpers', () => {
  it('isSelfMode is true only for kind: self', () => {
    expect(isSelfMode(makeConfig('self'))).toBe(true);
    expect(isSelfMode(makeConfig('git'))).toBe(false);
    expect(isSelfMode(makeConfig('http'))).toBe(false);
  });

  it('usesBranchWorktree is true for every non-HTTP kind, including omitted kind', () => {
    expect(usesBranchWorktree(makeConfig('self'))).toBe(true);
    expect(usesBranchWorktree(makeConfig('git'))).toBe(true);
    expect(usesBranchWorktree(makeConfig('http'))).toBe(false);
    expect(usesBranchWorktree({ repo: {} })).toBe(true);
  });

  it('getKnowledgeDir returns localPath in every mode', () => {
    expect(getKnowledgeDir(makeConfig('self'))).toBe('/repo/.teamai');
    expect(getKnowledgeDir(makeConfig('git', '/home/alice/.teamai/team-repo'))).toBe(
      '/home/alice/.teamai/team-repo',
    );
  });

  it('getReportsDir points at the reports worktree for self and git, clone/localPath for http', () => {
    expect(getReportsDir(makeConfig('self'))).toBe(
      path.join('/repo/.teamai', REPORTS_WORKTREE_DIRNAME),
    );
    // Independent git clone: sibling of the clone, not nested inside it.
    expect(getReportsDir(makeConfig('git', '/home/alice/.teamai/team-repo'))).toBe(
      path.join('/home/alice/.teamai', REPORTS_WORKTREE_DIRNAME),
    );
    expect(getReportsDir(makeConfig('http', '/home/alice/.teamai/team-repo'))).toBe(
      '/home/alice/.teamai/team-repo',
    );
  });
});

describe('LocalConfigSchema: kind self + businessRepoRoot', () => {
  it('accepts kind: self with businessRepoRoot', () => {
    const parsed = LocalConfigSchema.parse({
      repo: {
        localPath: '/repo/.teamai',
        remote: 'https://github.com/acme/app.git',
        kind: 'self',
        businessRepoRoot: '/repo',
      },
      username: 'alice',
      scope: 'project',
      projectRoot: '/repo',
    });
    expect(parsed.repo.kind).toBe('self');
    expect(parsed.repo.businessRepoRoot).toBe('/repo');
  });

  it('still accepts legacy git/http configs without the new fields', () => {
    const parsed = LocalConfigSchema.parse({
      repo: { localPath: '/x/team-repo', remote: 'r' },
      username: 'bob',
    });
    expect(parsed.repo.kind).toBeUndefined();
    expect(parsed.repo.businessRepoRoot).toBeUndefined();
  });
});

describe('TeamaiConfigSchema: mode marker', () => {
  it('accepts mode: self (the clone-time self-heal marker)', () => {
    const parsed = TeamaiConfigSchema.parse({
      team: 'app',
      repo: 'https://github.com/acme/app.git',
      mode: 'self',
    });
    expect(parsed.mode).toBe('self');
  });

  it('leaves mode undefined for standalone team repos', () => {
    const parsed = TeamaiConfigSchema.parse({
      team: 'app',
      repo: 'https://github.com/acme/app.git',
    });
    expect(parsed.mode).toBeUndefined();
  });
});

describe('buildSelfModeGitignore', () => {
  const gi = buildSelfModeGitignore();

  it('ignores machine-local state and worktrees', () => {
    for (const entry of ['config.yaml', 'state.json', 'token', 'teamai.lock', 'reports-wt/', 'knowledge-wt/', '.reports-lock', '.bootstrap-lock']) {
      expect(gi).toContain(entry);
    }
  });

  it('ignores report data (it lives on the orphan branch, not main)', () => {
    for (const entry of ['members/', 'sessions/', 'votes/', 'stats/', 'pending-review.jsonl']) {
      expect(gi).toContain(`\n${entry}`);
    }
  });

  it('does NOT ignore knowledge (skills/rules/docs/learnings/env stay on main)', () => {
    // These must not appear as ignore lines (they are committed to main).
    // env is intentionally committed in single-repo mode (unlike standalone mode's
    // per-machine env), so `teamai push` can carry team env vars — it must NOT be
    // an ignore line. env.sh (generated locally) stays ignored, checked below.
    const lines = gi.split('\n').map((l) => l.trim());
    expect(lines).not.toContain('skills/');
    expect(lines).not.toContain('rules/');
    expect(lines).not.toContain('docs/');
    expect(lines).not.toContain('learnings/');
    expect(lines).not.toContain('env');
    expect(lines).not.toContain('env/');
  });

  it('still ignores the locally-generated env.sh (only env.yaml is shared)', () => {
    expect(gi.split('\n').map((l) => l.trim())).toContain('env.sh');
  });

  it('ignores the usage lock, its rewrite temp and pending files, so a usage write leaves git status clean', () => {
    expect(ignoredBy(gi, USAGE_SIDE_FILES)).toEqual(USAGE_SIDE_FILES);
  });

  it('ignores the temp copy an interrupted config save leaves (#823)', () => {
    expect(ignoredBy(gi, [CONFIG_SAVE_TEMP])).toEqual([CONFIG_SAVE_TEMP]);
  });

  it('ignores the learnings worktree, its lock and the queue, so contributing leaves git status clean', () => {
    const lines = gi.split('\n').map((l) => l.trim());
    expect(lines).toContain('learnings-wt/');
    expect(lines).toContain('.learnings-lock');
    expect(lines).toContain('pending-learnings/');
  });
});

describe('buildProjectScopeGitignore', () => {
  it('ignores the local config and the temp copy an interrupted config save leaves (#823)', () => {
    const names = ['config.yaml', CONFIG_SAVE_TEMP, 'state.json', 'token'];
    expect(ignoredBy(buildProjectScopeGitignore(), names)).toEqual(names);
  });
});

describe('migrateSelfModeGitignore', () => {
  it('leaves the .gitignore whole when the disk fills while it is healed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-self-heal-'));
    const gitignorePath = path.join(root, '.teamai', '.gitignore');
    const old = ['config.yaml', 'token', 'teamai.lock', 'env.local', 'usage.jsonl'].join('\n');
    fs.mkdirSync(path.dirname(gitignorePath));
    fs.writeFileSync(gitignorePath, old);
    // The disk fills after the first bytes, wherever the healed file is written.
    const spy = vi.spyOn(fse, 'writeFile').mockImplementation(async (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
      fs.writeFileSync(String(file), String(data).slice(0, 10));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    try {
      await migrateSelfModeGitignore({ ...makeConfig('self', path.join(root, '.teamai')), projectRoot: root });
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(old);
    expect(fs.readdirSync(path.dirname(gitignorePath))).toEqual(['.gitignore']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('migrateSelfModeGitignoreContent (self-heal old gitignore)', () => {
  it('removes a standalone `env` line and adds machine-local entries', () => {
    const old = ['config.yaml', 'env', 'env.sh', 'members/'].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    expect(changed).toBe(true);
    const lines = content.split('\n').map((l) => l.trim());
    expect(lines).not.toContain('env');
    expect(lines).toContain('env.local');
    expect(lines).toContain('teamai.lock');
    // env.local inserted right after env.sh
    expect(content).toContain('env.sh\nenv.local');
  });

  it('does not touch env.sh, env.local, or env/', () => {
    const old = [
      'env.sh', 'env.local', 'teamai.lock',
      'learnings-wt/', '.learnings-lock', 'pending-learnings/', 'env/',
      'usage.jsonl.*', 'usage.pending-*.jsonl', 'config.yaml.*.tmp',
    ].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    expect(changed).toBe(false); // nothing to remove, env.local already present
    const lines = content.split('\n').map((l) => l.trim());
    expect(lines).toContain('env.sh');
    expect(lines).toContain('env.local');
    expect(lines).toContain('env/');
  });

  it('is a no-op on a current gitignore (already migrated)', () => {
    const current = buildSelfModeGitignore();
    const { changed, content } = migrateSelfModeGitignoreContent(current);
    expect(changed).toBe(false);
    expect(content).toBe(current);
  });

  it('adds env.local even when there is no env.sh to anchor to', () => {
    const old = ['config.yaml', 'env', 'token'].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    expect(changed).toBe(true);
    const lines = content.split('\n').map((l) => l.trim());
    expect(lines).not.toContain('env');
    expect(lines).toContain('env.local');
    expect(lines).toContain('teamai.lock');
  });

  it('ignores commented lines containing env', () => {
    const old = [
      '# env is machine-local', 'config.yaml', 'env.local', 'teamai.lock',
      'learnings-wt/', '.learnings-lock', 'pending-learnings/',
      'usage.jsonl.*', 'usage.pending-*.jsonl', 'config.yaml.*.tmp',
    ].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    // No bare `env` line, env.local already present → unchanged.
    expect(changed).toBe(false);
    expect(content).toContain('# env is machine-local');
  });

  it('adds teamai.lock next to token in older gitignore files', () => {
    const old = ['config.yaml', 'token', 'env.local'].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    expect(changed).toBe(true);
    expect(content).toContain('token\nteamai.lock');
  });

  it('adds the usage lock, rewrite temp and pending patterns to a file that ignores only usage.jsonl', () => {
    const old = ['config.yaml', 'token', 'teamai.lock', 'env.local', 'usage.jsonl', 'known-skills.json'].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    expect(changed).toBe(true);
    expect(ignoredBy(content, USAGE_SIDE_FILES)).toEqual(USAGE_SIDE_FILES);
    expect(content).toContain('usage.jsonl\nusage.jsonl.*\nusage.pending-*.jsonl\nknown-skills.json');
  });

  it('adds the temp copy an interrupted config save leaves, after config.yaml (#823)', () => {
    const old = ['config.yaml', 'state.json', 'token', 'teamai.lock', 'env.local'].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    expect(changed).toBe(true);
    expect(content).toContain('config.yaml\nconfig.yaml.*.tmp\nstate.json');
    expect(ignoredBy(content, [CONFIG_SAVE_TEMP])).toEqual([CONFIG_SAVE_TEMP]);
  });

  it('adds the learnings worktree, its lock and the queue', () => {
    const old = ['config.yaml', 'token', 'teamai.lock', 'env.local', 'reports-wt/', 'knowledge-wt/'].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    expect(changed).toBe(true);
    const lines = content.split('\n').map((l) => l.trim());
    expect(lines).toContain('learnings-wt/');
    expect(lines).toContain('.learnings-lock');
    expect(lines).toContain('pending-learnings/');
  });
});
