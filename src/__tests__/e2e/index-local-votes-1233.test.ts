import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'dist/index.js');
let sandbox: string;

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
}

function machineEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'alice',
    GIT_AUTHOR_EMAIL: 'alice@example.invalid',
    GIT_COMMITTER_NAME: 'alice',
    GIT_COMMITTER_EMAIL: 'alice@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    FORCE_COLOR: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: 'always',
  };
}

function runCli(home: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const env = machineEnv(home);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out\n${output}`));
    }, 45_000);
    const capture = (data: Buffer) => { output += data.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function localVotes(home: string): Record<string, unknown> {
  const file = path.join(home, '.teamai', 'user-votes', 'alice.yaml');
  return YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  if (sandbox && path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('teamai-1233-')) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('local vote index freshness (#1233)', () => {
  it.each(['enabled', 'disabled', 'rejected', 'unconfirmed'] as const)('updates scores on the first pull with reporting %s', async (reporting) => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-1233-'));
    const origin = path.join(sandbox, 'origin.git');
    const seed = path.join(sandbox, 'seed');
    const home = path.join(sandbox, 'home');
    const env = machineEnv(home);
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'acme', repo: origin, provider: 'git', usageReport: reporting !== 'disabled',
      sharing: { recall: { enabled: true } },
    }));
    const learnings = path.join(seed, 'learnings');
    fs.mkdirSync(learnings, { recursive: true });
    fs.writeFileSync(path.join(learnings, 'retry.md'), '---\ntitle: Retry failed requests\ndate: 2026-10-21\n---\nRetry failed requests with backoff.\n');
    git(['init', '-q', '-b', 'main'], seed, env);
    git(['add', '.'], seed, env); git(['commit', '-q', '-m', 'fixture'], seed, env);
    git(['clone', '-q', '--bare', seed, origin], sandbox, env);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\nname = alice\nemail = alice@example.invalid\n');
    const clone = path.join(home, '.teamai', 'team-repo');
    git(['clone', '-q', origin, clone], sandbox, env);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: clone, remote: origin, kind: 'git' }, username: 'alice', scope: 'user',
      updatePolicy: 'skip', enabledAgents: ['claude'], additionalRoles: [],
    }));
    // A prior recall credited by Stop; manual feedback is then sent via the real CLI.
    const votesDir = path.join(home, '.teamai', 'user-votes');
    fs.mkdirSync(votesDir, { recursive: true });
    fs.writeFileSync(path.join(votesDir, 'alice.yaml'), YAML.stringify({
      version: 2,
      votes: { retry: { recalled_count: 1, upvoted_count: 0, last_recalled_at: new Date().toISOString() } },
      deltas: { retry: { recalled_delta: 1, upvoted_delta: 0 } },
    }));
    if (reporting === 'rejected') {
      const hook = path.join(origin, 'hooks', 'pre-receive');
      fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n'); fs.chmodSync(hook, 0o755);
    }
    const initial = await runCli(home, ['pull'], sandbox);
    expect(initial.code, initial.output).toBe(0);
    const initialIndex = JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'search-index.json'), 'utf8'));
    expect(initialIndex.entries.find((e: { filename: string }) => e.filename === 'retry.md')).toMatchObject({ votes: 0.3 });
    const initialRecall = await runCli(home, ['recall', '--check', 'retry failed requests'], sandbox);
    expect(initialRecall.code, initialRecall.output).toBe(0);
    const initialScore = Number(initialRecall.output.match(/score=([0-9.]+)/)?.[1]);
    expect(Number.isFinite(initialScore)).toBe(true);
    const feedback = await runCli(home, ['recall', 'feedback', '--positive', 'retry'], sandbox);
    expect(feedback.code, feedback.output).toBe(0);
    expect(feedback.output).toContain('Upvoted: retry');
    const votePath = path.join(votesDir, 'alice.yaml');
    if (reporting === 'unconfirmed') {
      // The real push lands, but a live lock prevents local confirmation.
      // The hook only controls the crash/lock boundary; it never edits votes.
      // Extensionless Git hooks also run under an ESM package boundary.
      fs.writeFileSync(path.join(origin, 'hooks', 'package.json'), '{"type":"module"}');
      const hook = path.join(origin, 'hooks', 'post-receive');
      fs.writeFileSync(hook, `#!${process.execPath}
import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(votePath + '.lock')}, ${JSON.stringify(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'acceptance' }))}));
`);
      fs.chmodSync(hook, 0o755);
      const delivered = await runCli(home, ['pull'], sandbox);
      expect(delivered.code, delivered.output).toBe(0);
      expect(localVotes(home).pendingSync).toBeDefined();
      const remote = YAML.parse(git(['show', 'teamai-reports:votes/alice.yaml'], origin, env));
      expect(remote.votes.retry.upvoted_count).toBe(1);
      fs.unlinkSync(hook); fs.unlinkSync(votePath + '.lock');
      const next = await runCli(home, ['recall', 'feedback', '--positive', 'retry'], sandbox);
      expect(next.code, next.output).toBe(0);
      // Confirm that new feedback did not change the historical delivery snapshot.
      const state = localVotes(home) as { pendingSync: { deltas: { retry: { upvoted_delta: number } } } };
      expect(state.pendingSync.deltas.retry.upvoted_delta).toBe(1);
    }
    const expectedVotes = reporting === 'unconfirmed' ? 2.3 : 1.3;
    for (let attempt = 0; attempt < 2; attempt++) {
      const pull = await runCli(home, ['pull'], sandbox);
      expect(pull.code, pull.output).toBe(0);
      const index = JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'search-index.json'), 'utf8'));
      expect(index.entries.find((e: { filename: string }) => e.filename === 'retry.md'), JSON.stringify(index) + '\n' + pull.output).toMatchObject({ votes: expectedVotes });
      const recall = await runCli(home, ['recall', '--check', 'retry failed requests'], sandbox);
      expect(recall.code, recall.output).toBe(0);
      expect(recall.output).toMatch(/^RELEVANT\b/m);
      expect(Number(recall.output.match(/score=([0-9.]+)/)?.[1])).toBeGreaterThan(initialScore);
    }
    if (reporting === 'disabled') {
      const indexPath = path.join(home, '.teamai', 'search-index.json');
      const indexedVotes = () => JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries.find((e: { filename: string }) => e.filename === 'retry.md').votes;
      fs.writeFileSync(votePath + '.lock', JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'acceptance' }));
      try {
        const busy = await runCli(home, ['pull'], sandbox);
        expect(busy.code, busy.output).toBe(0);
        expect(indexedVotes()).toBe(0);
      } finally { fs.unlinkSync(votePath + '.lock'); }
      const recovered = await runCli(home, ['pull'], sandbox);
      expect(recovered.code, recovered.output).toBe(0);
      expect(indexedVotes()).toBe(1.3);
      fs.unlinkSync(indexPath);
      const rebuilt = await runCli(home, ['recall', '--check', 'retry failed requests'], sandbox);
      expect(rebuilt.code, rebuilt.output).toBe(0);
      expect(indexedVotes()).toBe(1.3);
      const note = path.join(sandbox, 'contribution.md');
      fs.writeFileSync(note, '# Contribution\n\nRetry failed requests with exponential backoff.\n');
      fs.unlinkSync(indexPath);
      const contributed = await runCli(home, ['contribute', '--file', note, '--title', 'Backoff', '--scope', 'user'], sandbox);
      expect(contributed.code, contributed.output).toBe(0);
      expect(indexedVotes()).toBe(1.3);
    }
    if (reporting === 'enabled' || reporting === 'unconfirmed') expect(localVotes(home).deltas).toEqual({});
    else expect(localVotes(home).deltas).toEqual({ retry: { recalled_delta: 1, upvoted_delta: 1 } });
  }, 120_000);
});

describe('confirmed votes after narrow-clone pushes (#1233)', () => {
  it.each(['full', 'single', 'shallow'] as const)('keeps delivered votes through contribute and recall rebuilds: %s', async (mode) => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-1233-'));
    const origin = path.join(sandbox, 'origin.git');
    const seed = path.join(sandbox, 'seed');
    const home = path.join(sandbox, 'home');
    const env = machineEnv(home);
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'acme', repo: origin, provider: 'git', usageReport: true,
      sharing: { recall: { enabled: true } },
    }));
    const learnings = path.join(seed, 'learnings');
    fs.mkdirSync(learnings, { recursive: true });
    fs.writeFileSync(path.join(learnings, 'retry.md'), '---\ntitle: Retry failed requests\ndate: 2026-10-21\n---\nRetry failed requests with backoff.\n');
    git(['init', '-q', '-b', 'main'], seed, env);
    git(['add', '.'], seed, env); git(['commit', '-q', '-m', 'fixture'], seed, env);
    git(['clone', '-q', '--bare', seed, origin], sandbox, env);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\nname = alice\nemail = alice@example.invalid\n');
    const clone = path.join(home, '.teamai', 'team-repo');
    git(['clone', '-q', ...(mode === 'single' ? ['--single-branch'] : mode === 'shallow' ? ['--depth=1'] : []), 'file://' + origin, clone], sandbox, env);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: clone, remote: origin, kind: 'git' }, username: 'alice', scope: 'user',
      updatePolicy: 'skip', enabledAgents: ['claude'], additionalRoles: [],
    }));
    // A prior recall credited by Stop; manual feedback is then sent via the real CLI.
    const votesDir = path.join(home, '.teamai', 'user-votes');
    fs.mkdirSync(votesDir, { recursive: true });
    fs.writeFileSync(path.join(votesDir, 'alice.yaml'), YAML.stringify({
      version: 2,
      votes: { retry: { recalled_count: 1, upvoted_count: 0, last_recalled_at: new Date().toISOString() } },
      deltas: { retry: { recalled_delta: 1, upvoted_delta: 0 } },
    }));
    const initial = await runCli(home, ['pull'], sandbox);
    expect(initial.code, initial.output).toBe(0);
    const initialIndex = JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'search-index.json'), 'utf8'));
    expect(initialIndex.entries.find((e: { filename: string }) => e.filename === 'retry.md')).toMatchObject({ votes: 0.3 });
    const feedback = await runCli(home, ['recall', 'feedback', '--positive', 'retry'], sandbox);
    expect(feedback.code, feedback.output).toBe(0);
    const delivered = await runCli(home, ['pull'], sandbox);
    expect(delivered.code, delivered.output).toBe(0);
    const note = path.join(sandbox, 'note.md');
    fs.writeFileSync(note, '# Backoff\nRetry with backoff.\n');
    const contributed = await runCli(home, ['contribute', '--file', note, '--title', 'Backoff', '--scope', 'user'], sandbox);
    expect(contributed.code, contributed.output).toBe(0);
    const indexPath = path.join(home, '.teamai', 'search-index.json');
    const votes = () => JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries.find((e: { filename: string }) => e.filename === 'retry.md').votes;
    const afterContribute = votes();
    const remote = YAML.parse(git(['show', 'teamai-reports:votes/alice.yaml'], origin, env));
    const tracking = git(['rev-parse', 'refs/remotes/origin/teamai-reports'], clone, env);
    const confirmed = git(['rev-parse', 'teamai-reports'], origin, env);
    fs.unlinkSync(indexPath);
    const recall = await runCli(home, ['recall', '--check', 'retry failed requests'], sandbox);
    expect(recall.code, recall.output).toBe(0);
    const afterRecall = votes();
    const deltas = localVotes(home).deltas;
    const pull = await runCli(home, ['pull'], sandbox);
    expect(pull.code, pull.output).toBe(0);
    expect(tracking).toBe(confirmed);
    expect(remote.votes.retry.upvoted_count).toBe(1);
    expect((deltas as Record<string, unknown>).retry).toBeUndefined();
    expect(afterContribute).toBe(1.3);
    expect(afterRecall).toBe(1.3);
    expect(votes()).toBe(1.3);
  }, 120_000);
});
