import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  getReportsDir,
  getKnowledgeDir,
  isSelfMode,
  REPORTS_WORKTREE_DIRNAME,
  LocalConfigSchema,
  TeamaiConfigSchema,
  type LocalConfig,
} from '../types.js';
import { buildSelfModeGitignore, migrateSelfModeGitignoreContent } from '../init.js';

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

  it('getKnowledgeDir returns localPath in every mode', () => {
    expect(getKnowledgeDir(makeConfig('self'))).toBe('/repo/.teamai');
    expect(getKnowledgeDir(makeConfig('git', '/home/alice/.teamai/team-repo'))).toBe(
      '/home/alice/.teamai/team-repo',
    );
  });

  it('getReportsDir points at the reports worktree only in self mode', () => {
    expect(getReportsDir(makeConfig('self'))).toBe(
      path.join('/repo/.teamai', REPORTS_WORKTREE_DIRNAME),
    );
    // Non-self modes keep reports alongside knowledge (localPath) — unchanged behavior.
    expect(getReportsDir(makeConfig('git', '/home/alice/.teamai/team-repo'))).toBe(
      '/home/alice/.teamai/team-repo',
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
    for (const entry of ['config.yaml', 'state.json', 'token', 'reports-wt/', 'knowledge-wt/', '.reports-lock', '.bootstrap-lock']) {
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
});

describe('migrateSelfModeGitignoreContent (self-heal old gitignore)', () => {
  it('removes a standalone `env` line and adds env.local', () => {
    const old = ['config.yaml', 'env', 'env.sh', 'members/'].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    expect(changed).toBe(true);
    const lines = content.split('\n').map((l) => l.trim());
    expect(lines).not.toContain('env');
    expect(lines).toContain('env.local');
    // env.local inserted right after env.sh
    expect(content).toContain('env.sh\nenv.local');
  });

  it('does not touch env.sh, env.local, or env/', () => {
    const old = ['env.sh', 'env.local', 'env/'].join('\n');
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
  });

  it('ignores commented lines containing env', () => {
    const old = ['# env is machine-local', 'config.yaml', 'env.local'].join('\n');
    const { changed, content } = migrateSelfModeGitignoreContent(old);
    // No bare `env` line, env.local already present → unchanged.
    expect(changed).toBe(false);
    expect(content).toContain('# env is machine-local');
  });
});
