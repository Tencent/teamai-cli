import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

describe('push with a stalled GitLab reviewer lookup', () => {
  it('exits nonzero at the deadline, keeps the pushed branch and never creates an MR', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mr-reviewer-'));
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url?.includes('/users?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[{"id":5,');
        return;
      }
      res.writeHead(500);
      res.end('Unexpected request');
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const home = path.join(sandbox, 'home');
      const seed = path.join(sandbox, 'seed');
      const remote = path.join(sandbox, 'team.git');
      const clone = path.join(sandbox, 'clone');
      fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
      fs.mkdirSync(seed);
      const env = {
        ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
        GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'member', GIT_AUTHOR_EMAIL: 'member@example.invalid',
        GIT_COMMITTER_NAME: 'member', GIT_COMMITTER_EMAIL: 'member@example.invalid',
        GIT_TERMINAL_PROMPT: '0', TEAMAI_NONINTERACTIVE: '1',
        GITLAB_URL: origin, TEAMAI_GITLAB_HOST: `127.0.0.1:${address.port}`,
        GITLAB_API_PREFIX: 'api/v4', GITLAB_TOKEN: 'fixture-token',
      };
      const git = (args: string[], cwd: string): string => execFileSync('git', args, {
        cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
      }).trim();
      const config = { team: 'reviewer-timeout', repo: `${origin}/group/repo`, provider: 'gitlab', reviewers: ['alice'], usageReport: false };
      fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify(config));
      git(['init', '-q', '-b', 'main'], seed);
      git(['add', '.'], seed);
      git(['commit', '-qm', 'fixture'], seed);
      git(['clone', '-q', '--bare', seed, remote], sandbox);
      git(['clone', '-q', remote, clone], sandbox);
      fs.writeFileSync(path.join(clone, 'teamai.yaml'), YAML.stringify({ ...config, team: 'edited-team' }));
      fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
        repo: { localPath: clone, remote, kind: 'git' },
        provider: 'gitlab', username: 'member', scope: 'user', updatePolicy: 'skip',
      }));

      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, 'push', '--all'], {
          cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let killed = false;
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        const timer = setTimeout(() => { killed = true; child.kill(); }, 45_000);
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (killed) reject(new Error(`CLI did not finish: ${output}`));
          else resolve({ code, output });
        });
      });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('Failed to create PR:');
      expect(result.output).toContain('You can create a PR manually.');
      expect(seen).toEqual(['GET /api/v4/users?username=alice']);
      const branches = git(['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/teamai/'], sandbox);
      expect(branches).toContain('refs/heads/teamai/');
      expect(git(['branch', '--show-current'], clone)).toBe('main');
      expect(git(['status', '--porcelain'], clone)).toBe('');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); });
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
