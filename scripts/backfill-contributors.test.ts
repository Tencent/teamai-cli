import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('backfills each skill from its own Git history', ({ onTestFinished }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contributors-'));
  onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q');
  for (const [skill, author] of [['release [ab]', 'Robin'], ['release a', 'Sam']]) {
    const folder = path.join(repo, 'skills', skill);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), skill);
    git('add', '-A');
    git('-c', `user.name=${author}`, '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Add skill');
  }

  const script = fileURLToPath(new URL('./backfill-contributors.ts', import.meta.url));
  const loader = new URL('./typescript-loader.mjs', import.meta.url);
  execFileSync(process.execPath, ['--no-warnings', '--loader', loader.href, script, repo]);
  expect(fs.readFileSync(path.join(repo, 'skills', 'release [ab]', 'CONTRIBUTORS'), 'utf8')).toBe('Robin\n');
  expect(fs.readFileSync(path.join(repo, 'skills', 'release a', 'CONTRIBUTORS'), 'utf8')).toBe('Sam\n');
});
