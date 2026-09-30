/**
 * E2E (#823, item 1): `teamai import --from-mr` publishes the learning it
 * extracts.
 *
 * The learning was written into the `teamai-learnings` worktree, but the only
 * push was `autoPushViaMR` committing `.` in `repo.localPath`, another
 * checkout. That found nothing to commit, so the learning stayed untracked on
 * this machine and never reached the team. It now goes through the same queue
 * and publish as `teamai contribute`.
 *
 * `gh` (the MR) and `claude` (the extraction) are stand-ins on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "pr view") echo '{"title":"Retry flaky upload","body":"Retries S3 uploads.","author":{"login":"dev"},"mergedAt":"2026-09-20T10:00:00Z","commits":[{"oid":"abc123","messageHeadline":"retry upload"}]}' ;;
  "pr diff") printf 'diff --git a/up.ts b/up.ts\\n+retry(3)\\n' ;;
  "pr create") echo "https://github.com/acme/team/pull/99" ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

const FAKE_CLAUDE = `#!/usr/bin/env bash
cat <<'MD'
---
title: Retry flaky S3 uploads
tags: [s3, retry]
---
# Retry flaky S3 uploads

Wrap uploads in retry(3); the bucket throttles bursts.
MD
`;

// contribute's naming, under `learnings/` or one namespace below it:
// <title-slug>-<date>-<random>.md
const LEARNING = /^learnings\/(?:[^/]+\/)?retry-flaky-s3-uploads-\d{4}-\d{2}-\d{2}-[a-z0-9]+\.md$/;

interface RunResult {
  code: number | null;
  output: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

/**
 * A user-scope install in git mode, on a local bare team repo (provider
 * github), that has run `teamai pull`. With `project`, the team declares that
 * project owning the learnings namespace of the same name, and the install
 * has it active.
 */
function scenario(opts: { project?: string } = {}) {
  const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue823-e2e-')));
  const home = path.join(sandbox, 'home');
  const bin = path.join(sandbox, 'bin');
  const remote = path.join(sandbox, 'team.git');

  const run = (args: string[]): Promise<RunResult> => new Promise((resolve) => {
    const { CLAUDE_SESSION_ID: _s, GITHUB_TOKEN: _t, GH_TOKEN: _g, ...env } = process.env;
    const child = spawn('node', [CLI, ...args], {
      cwd: home,
      env: {
        ...env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', NO_COLOR: '1',
        PATH: `${bin}${path.delimiter}${env.PATH ?? ''}`, TEAMAI_CONTRIBUTE_HINT_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });

  const setup = async () => {
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude')); // the enabled agent's root, so pull has somewhere to deliver
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: issue-823\nrepo: https://github.com/acme/team\nprovider: github\n');
    if (opts.project) {
      fs.mkdirSync(path.join(seed, 'manifest'));
      fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
        'version: 1',
        'projects:',
        `  - id: ${opts.project}`,
        `    name: ${opts.project}`,
        '    resources:',
        `      learnings: [${opts.project}]`,
        '',
      ].join('\n'));
    }
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, path.join(home, '.teamai', 'team-repo')], sandbox);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${path.join(home, '.teamai', 'team-repo')}`,
      `  remote: ${remote}`,
      '  kind: git',
      'username: ci-823',
      'updatePolicy: auto',
      'scope: user',
      'enabledAgents: [claude]',
      ...(opts.project ? [`projects: [${opts.project}]`] : []),
      '',
    ].join('\n'));
    await run(['pull']);
  };

  /** The learnings on the team's `teamai-learnings` branch. */
  const published = (): string[] => {
    try {
      return git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], remote).split('\n').filter((f) => LEARNING.test(f));
    } catch {
      return []; // no branch: nothing was published
    }
  };
  const queued = (): string[] => {
    const queue = path.join(home, '.teamai', 'pending-learnings');
    return fs.existsSync(queue) ? fs.readdirSync(queue) : [];
  };
  const untracked = (): string => {
    const worktree = path.join(home, '.teamai', 'learnings-wt');
    return fs.existsSync(path.join(worktree, '.git')) ? git(['status', '--porcelain'], worktree) : '';
  };
  const cleanup = () => fs.rmSync(sandbox, { recursive: true, force: true });
  return { home, remote, run, setup, published, queued, untracked, cleanup };
}

const importMr = ['import', '--from-mr', 'https://github.com/acme/app/pull/7', '--all'];

describe('import --from-mr publishes its learning (#823)', () => {
  describe('with the team repo reachable', () => {
    const s = scenario();
    let imported: RunResult = { code: null, output: '' };
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
      imported = await s.run(importMr);
    }, 120_000);
    afterAll(() => s.cleanup());

    it('pushes the learning to the team\'s teamai-learnings branch', () => {
      expect(imported.code, imported.output).toBe(0);
      expect(s.published(), imported.output).toHaveLength(1);
      expect(imported.output).toContain('Push changes via MR [SKIPPED: No teamwiki changes to push]');
    });

    it('leaves nothing unpublished behind on this machine', () => {
      expect(s.untracked(), imported.output).toBe('');
      expect(s.queued(), imported.output).toEqual([]);
    });

    it('points recall at the published copy, not the queue it left', () => {
      const index = JSON.parse(fs.readFileSync(path.join(s.home, '.teamai', 'search-index.json'), 'utf8')) as unknown;
      const paths = JSON.stringify(index).match(/"[^"]*retry-flaky-s3-uploads-[^"]*\.md"/g) ?? [];
      expect(paths.length, imported.output).toBeGreaterThan(0);
      expect(paths.filter((p) => p.includes('pending-learnings'))).toEqual([]);
    });

    it('keeps a second learning with the same title and day as its own file', async () => {
      const again = await s.run(importMr);
      expect(again.code, again.output).toBe(0);
      expect(s.published(), again.output).toHaveLength(2);
    });

    it('publishes it at the shared root when no project is active', () => {
      expect(s.published().map((f) => path.posix.dirname(f))).toEqual(['learnings', 'learnings']);
    });
  });

  describe('with one active project that owns a learnings namespace', () => {
    const s = scenario({ project: 'alpha' });
    let imported: RunResult = { code: null, output: '' };
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
      imported = await s.run(importMr);
    }, 120_000);
    afterAll(() => s.cleanup());

    it('publishes the learning in that namespace, as contribute does', () => {
      expect(imported.code, imported.output).toBe(0);
      expect(s.published().map((f) => path.posix.dirname(f)), imported.output).toEqual(['learnings/alpha']);
      expect(imported.output).not.toContain('Learning saved locally');
    });
  });

  describe('with another contribution stuck in the queue', () => {
    const s = scenario();
    let imported: RunResult = { code: null, output: '' };
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
      // An entry nobody can read stays queued on every run.
      const queue = path.join(s.home, '.teamai', 'pending-learnings');
      fs.mkdirSync(queue, { recursive: true });
      fs.writeFileSync(path.join(queue, 'stuck.md'), '# stuck\n', { mode: 0o000 });
      imported = await s.run(importMr);
    }, 120_000);
    afterAll(() => s.cleanup());

    it('publishes this learning and does not say it stayed local', () => {
      expect(s.published(), imported.output).toHaveLength(1);
      expect(imported.output).not.toContain('Learning saved locally');
    });
  });

  describe('when publishing fails', () => {
    const s = scenario();
    let imported: RunResult = { code: null, output: '' };
    let pulled: RunResult = { code: null, output: '' };
    const state = { queuedAfterImport: [] as string[], publishedAfterImport: [] as string[] };
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
      // The team repo is unreachable during the import.
      fs.renameSync(s.remote, `${s.remote}.away`);
      imported = await s.run(importMr);
      fs.renameSync(`${s.remote}.away`, s.remote);
      state.queuedAfterImport = s.queued();
      state.publishedAfterImport = s.published();
      pulled = await s.run(['pull']);
    }, 120_000);
    afterAll(() => s.cleanup());

    it('keeps the learning queued and says the next pull publishes it', () => {
      expect(imported.code, imported.output).toBe(0);
      expect(imported.output).toContain('Learning saved locally');
      expect(imported.output).toContain('the next `teamai pull` publishes it');
      expect(state.publishedAfterImport).toEqual([]);
      expect(state.queuedAfterImport.filter((f) => /^retry-flaky-s3-uploads-.*\.md$/.test(f)), imported.output).toHaveLength(1);
    });

    it('publishes it on the next pull', () => {
      expect(s.published(), pulled.output).toHaveLength(1);
      expect(s.queued(), pulled.output).toEqual([]);
    });
  });

  describe('when a learnings checkout teamai refuses is in the way', () => {
    const s = scenario();
    let imported: RunResult = { code: null, output: '' };
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
      // A checkout whose repository is gone: every pull refuses it too.
      const checkout = path.join(s.home, '.teamai', 'learnings-wt');
      fs.mkdirSync(path.join(checkout, 'learnings'), { recursive: true });
      fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${path.join(s.home, '..', 'gone', '.git', 'worktrees', 'learnings-wt')}\n`);
      imported = await s.run(importMr);
    }, 120_000);
    afterAll(() => s.cleanup());

    it('keeps the learning queued and says no pull publishes it until that checkout is dealt with', () => {
      expect(imported.code, imported.output).toBe(0);
      expect(imported.output).toContain('Learning saved locally');
      expect(imported.output).toContain('no `teamai pull` can publish it until that checkout is dealt with: do what the refusal says');
      expect(imported.output).not.toContain('the next `teamai pull` publishes it');
      expect(s.queued().filter((f) => /^retry-flaky-s3-uploads-.*\.md$/.test(f)), imported.output).toHaveLength(1);
      expect(s.published()).toEqual([]);
    });
  });

  describe('on a read-only HTTP source', () => {
    const s = scenario();
    let imported: RunResult = { code: null, output: '' };
    beforeAll(async () => {
      if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
      await s.setup();
      // The same install, switched to an HTTP source, which has no learnings branch.
      const config = path.join(s.home, '.teamai', 'config.yaml');
      fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('  kind: git\n', '  kind: http\n'));
      imported = await s.run(importMr);
    }, 120_000);
    afterAll(() => s.cleanup());

    it('refuses, as contribute does, instead of queueing a learning nothing can publish', () => {
      expect(imported.output).toContain('read-only HTTP source');
      expect(s.queued(), imported.output).toEqual([]);
    });

    it('still previews with --dry-run, which publishes nothing', async () => {
      const preview = await s.run([...importMr, '--dry-run']);
      expect(preview.output).not.toContain('read-only HTTP source');
      expect(preview.output).toContain('Learning draft generated: Retry flaky S3 uploads');
    });
  });
});
