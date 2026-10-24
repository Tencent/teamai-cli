import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

describe('incremental index through pull (real CLI)', () => {
  it('reuses sources on the unchanged-revision path and refreshes an edited doc', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-incremental-cli-'));
    const home = path.join(dir, 'home');
    const seed = path.join(dir, 'seed');
    const repo = path.join(home, '.teamai', 'team-repo');
    const remote = path.join(dir, 'team.git');
    const env = { ...process.env, HOME: home, USERPROFILE: home,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
      TEAMAI_TEST_NO_DETACH: '1', FORCE_COLOR: '0' };
    const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
    const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
    try {
      await fs.mkdir(path.join(seed, 'docs'), { recursive: true });
      await fs.mkdir(path.join(seed, 'learnings'), { recursive: true });
      await fs.writeFile(path.join(seed, 'learnings', 'stable.md'), '# Stable learning\n\nUnchanged knowledge.\n');
      await fs.mkdir(path.dirname(repo), { recursive: true });
      await fs.writeFile(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'incremental', repo: remote, provider: 'git', usageReport: false }));
      await fs.writeFile(path.join(seed, 'docs', 'alpha.md'), 'Alpha original.');
      git(['init', '-qb', 'main'], seed);
      git(['add', '.'], seed); git(['commit', '-qm', 'fixture'], seed);
      git(['clone', '-q', '--bare', seed, remote], dir);
      git(['clone', '-q', remote, repo], dir);
      await fs.writeFile(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
        repo: { localPath: repo, remote }, username: 'fixture', scope: 'user',
        enabledAgents: [], codexTrustEnabled: false, usageReportEnabled: false, updatePolicy: 'auto',
      }));
      run(['pull']);
      const indexFile = path.join(home, '.teamai', 'search-index.json');
      const first = JSON.parse(await fs.readFile(indexFile, 'utf8'));
      expect(first.entries.find((e: { filename: string }) => e.filename === 'alpha.md').tokens).toContain('original');
      await fs.writeFile(path.join(home, '.teamai', 'debug.log'), '');
      const probe = path.join(dir, 'read-probe.mjs');
      const reads = path.join(dir, 'index-reads.jsonl');
      await fs.writeFile(probe, `import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = promises.readFile;
promises.readFile = function(file, ...args) {
 if (String(file).includes('/learnings/') && new Error().stack.includes('entryFromMdFile')) fs.appendFileSync(${JSON.stringify(reads)}, JSON.stringify(String(file)) + '\\n');
 return original.call(this, file, ...args);
};
syncBuiltinESMExports();
`);
      for (let attempt = 0; attempt < 3; attempt++) {
        execFileSync(process.execPath, ['--import', probe, cli, 'pull'], { cwd: home, env, encoding: 'utf8', timeout: 30000 });
      }
      expect(await fs.readFile(reads, 'utf8').catch(() => '')).toBe('');
      expect(await fs.readFile(path.join(home, '.teamai', 'debug.log'), 'utf8')).toMatch(/Search index files: \d+ reused, 0 rebuilt, 0 dropped/);

      await fs.writeFile(path.join(seed, 'docs', 'alpha.md'), 'Alpha revised.');
      await fs.writeFile(path.join(seed, 'learnings', 'stable.md'), '# Stable learning\n\nRevised knowledge.\n');
      git(['add', '.'], seed); git(['commit', '-qm', 'edit'], seed); git(['push', '-q', remote, 'main'], seed);
      execFileSync(process.execPath, ['--import', probe, cli, 'pull'], { cwd: home, env, encoding: 'utf8', timeout: 30000 });
      expect((await fs.readFile(reads, 'utf8')).trim().length).toBeGreaterThan(0);
      const after = JSON.parse(await fs.readFile(indexFile, 'utf8'));
      expect(after.entries.find((e: { filename: string }) => e.filename === 'alpha.md').tokens).toContain('revised');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
