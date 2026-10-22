import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectSlug } from '../../utils/partition.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const REMOTE_URL = 'https://127.0.0.1:9/team/registration.git';

describe('init member registration failures (#1267)', () => {
  it.each(['failed', 'busy'] as const)('keeps local setup and reports %s before the member callback', (status) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-registration-')));
    const home = path.join(root, 'home');
    const repo = path.join(root, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(repo);
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Registration Test', GIT_AUTHOR_EMAIL: 'registration@teamai.test',
      GIT_COMMITTER_NAME: 'Registration Test', GIT_COMMITTER_EMAIL: 'registration@teamai.test',
    };
    delete env.GIT_CONFIG_GLOBAL;
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    const git = (args: string[]): void => {
      const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
      if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
    };
    try {
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.name', 'registration-test']);
      git(['config', 'user.email', 'registration@teamai.test']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# registration fixture\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'fixture']);
      git(['remote', 'add', 'origin', REMOTE_URL]);

      const partition = path.join(home, '.teamai', 'projects', projectSlug(repo));
      const lock = path.join(partition, '.reports-lock');
      if (status === 'busy') {
        fs.mkdirSync(partition, { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'fixture' }));
      } else {
        // The reports branch's first commit fails before the member callback.
        git(['config', 'commit.gpgsign', 'true']);
        git(['config', 'gpg.program', path.join(root, 'missing-signer')]);
      }

      const result = spawnSync(process.execPath, [CLI, 'init', '.', '--provider', 'git', '--agent', 'claude', '--force'], {
        cwd: repo, env, encoding: 'utf8', input: '', timeout: 45_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.error).toBeUndefined();
      expect(result.status, output).toBe(0);
      expect(output).toContain('teamai initialized (single-repo mode)!');
      expect(fs.existsSync(path.join(partition, 'config.yaml'))).toBe(true);
      expect(YAML.parse(fs.readFileSync(path.join(partition, 'config.yaml'), 'utf8')).repo.kind).toBe('self');
      expect(output).toContain('same `teamai init` command');
      expect(output).not.toContain('Member registered on the teamai-reports branch');
      expect(output).not.toContain('no write access?');
      if (status === 'busy') {
        expect(output).toContain('another write holds the teamai-reports branch');
        expect(fs.existsSync(lock)).toBe(true);
      } else {
        expect(output).toContain('Member registration could not be pushed:');
        expect(output).toContain('missing-signer');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
