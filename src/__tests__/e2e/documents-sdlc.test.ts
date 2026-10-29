/** Built CLI and real Git. A test process never impersonates the required human confirmation. */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
const ROOT = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(ROOT, 'dist/index.js');
const CHECK = path.join(ROOT, 'skill-data/sdlc/scripts/check.mjs');
const REVIEW = path.join(ROOT, 'skill-data/sdlc/scripts/review.mjs');
let repo: string;
beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sdlc-e2e-')));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'CLI Test'); git('config', 'user.email', 'cli@example.invalid');
  fs.mkdirSync(path.join(repo, 'intent/ws/task'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'intent/ws/task/intent.md'), '---\ntype: Intent\nsources: []\n---\n# Tested intent\n');
  git('add', '.'); git('commit', '-qm', 'intent');
});
afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function run(file: string, args: string[], cwd = repo) { return spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' }, timeout: 60000 }); }
const task = ['--workspace', 'ws', '--task', 'task'];

it('serves the SDLC skill, validates committed documents and keeps required reviews pending for a person', () => {
  const skill = run(CLI, ['skill', 'get', 'sdlc']);
  expect(skill.status, skill.stderr).toBe(0);
  expect(skill.stdout).toContain('Task SDLC');
  expect(run(CHECK, ['--workspace', '../outside', '--task', 'task', '--locate']).status).toBe(1);
  const checked = run(CHECK, [...task, '--stage', 'intent']);
  expect(checked.status, checked.stderr).toBe(0);
  expect(JSON.parse(checked.stdout).artifacts[0]).toMatchObject({ path: 'intent/ws/task/intent.md', commit: git('rev-parse', 'HEAD') });
  const asked = run(REVIEW, [...task, '--stage', 'intent', '--request']);
  expect(asked.status, asked.stderr).toBe(0);
  const id = JSON.parse(asked.stdout).result.id;
  const refused = run(REVIEW, [...task, '--respond', id]);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toContain('Required human confirmation');
  expect(run(REVIEW, [...task, '--stage', 'intent', '--approved']).status).toBe(1);
  expect(JSON.parse(run(REVIEW, [...task, '--history']).stdout).result[0]).not.toHaveProperty('answer');
  expect(git('status', '--porcelain')).toBe('');
});

it('rejects removed command entrypoints and previews OKF migration without changing source bytes', () => {
  for (const command of ['workflow', 'models', 'score', 'score-sessions', 'dashboard', 'dashboard-report', 'bind-project']) {
    const result = run(CLI, [command]);
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toContain('unknown command');
  }
  const before = '# Preserved lesson\n';
  fs.writeFileSync(path.join(repo, 'legacy.md'), before);
  const preview = run(CHECK, ['--file', 'legacy.md', '--migrate', '--type', 'Learning']);
  expect(preview.status, preview.stderr).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true, before, after: '---\ntype: Learning\n---\n# Preserved lesson\n' });
  expect(fs.readFileSync(path.join(repo, 'legacy.md'), 'utf8')).toBe(before);
});
