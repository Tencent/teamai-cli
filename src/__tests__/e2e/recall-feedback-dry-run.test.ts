import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectSlug } from '../../utils/partition.js';
import type { UserVotesV2 } from '../../types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'index.js');
let sandbox: string;
let home: string;
let project: string;

function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(value));
}

function setupScope(scope: 'user' | 'project'): { config: string; votes: string } {
  const dataHome = scope === 'user'
    ? path.join(home, '.teamai')
    : path.join(home, '.teamai', 'projects', projectSlug(project));
  const repo = path.join(dataHome, 'team-repo');
  const config = path.join(dataHome, 'config.yaml');
  const votes = path.join(dataHome, scope === 'user' ? 'user-votes' : 'votes', 'tester.yaml');
  writeYaml(config, {
    repo: { localPath: repo, remote: 'https://example.test/feedback.git' },
    username: 'tester', scope, additionalRoles: [],
    ...(scope === 'project' ? { projectRoot: project } : {}),
  });
  // A real load migrates this legacy role selection; a preview must not.
  writeYaml(path.join(repo, 'manifest', 'roles.yaml'), {
    version: 1, roles: [{ id: 'hai', resources: { skills: [], knowledge: [] } }],
  });
  writeYaml(votes, {
    version: 2,
    votes: { doc123: { recalled_count: 3, upvoted_count: 2 } },
    deltas: {},
  });
  return { config, votes };
}

function run(args: string[], cwd = sandbox) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, output: result.stdout + result.stderr };
}

/** Include directory creation, but not the CLI's ordinary diagnostic log. */
function snapshot(dir = sandbox): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (file === path.join(home, '.teamai', 'debug.log')) continue;
    const relative = path.relative(sandbox, file);
    if (entry.isDirectory()) {
      entries[relative] = '<directory>';
      Object.assign(entries, snapshot(file));
    } else {
      entries[relative] = fs.readFileSync(file).toString('base64');
    }
  }
  return entries;
}

beforeEach(() => {
  if (!fs.existsSync(cli)) throw new Error('Run npm run build before this test.');
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-feedback-preview-')));
  home = path.join(sandbox, 'home');
  project = path.join(sandbox, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q', project], { stdio: 'pipe' });
});

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe.each(['user', 'project'] as const)('recall feedback --dry-run in %s scope', (scope) => {
  it.each([
    ['positive', 'before'], ['positive', 'after'],
    ['negative', 'before'], ['negative', 'after'],
  ])('previews %s feedback with the flag %s the command without writes', (polarity, position) => {
    setupScope('user');
    if (scope === 'project') setupScope('project');
    const before = snapshot();
    const args = ['recall', 'feedback', `--${polarity}`, 'doc123'];
    if (position === 'before') args.unshift('--dry-run');
    else args.push('--dry-run');

    const result = run(args, scope === 'project' ? project : sandbox);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`[dry-run] Would submit ${polarity} feedback for: doc123`);
    expect(snapshot()).toEqual(before);
  });

  it('still records real feedback in the selected scope', () => {
    const user = setupScope('user');
    const selected = scope === 'project' ? setupScope('project') : user;
    const userBefore = fs.readFileSync(user.votes, 'utf8');
    const cwd = scope === 'project' ? project : sandbox;
    for (const [polarity, count] of [['positive', 3], ['negative', 2]] as const) {
      const result = run(['recall', 'feedback', `--${polarity}`, 'doc123'], cwd);
      expect(result.code, result.output).toBe(0);
      expect(result.output).not.toContain('[dry-run]');
      const votes = YAML.parse(fs.readFileSync(selected.votes, 'utf8')) as UserVotesV2;
      expect(votes.votes.doc123.upvoted_count).toBe(count);
      expect(votes.deltas.doc123.upvoted_delta).toBe(count - 2);
    }
    if (scope === 'project') expect(fs.readFileSync(user.votes, 'utf8')).toBe(userBefore);
  });
});

describe('feedback preview storage and validation', () => {
  it.each(['positive', 'negative'])('does not migrate old votes or create missing votes for %s feedback', (polarity) => {
    const { votes } = setupScope('user');
    writeYaml(votes, { votes: { doc123: { at: '2026-10-01T00:00:00Z' } } });
    for (const existing of [true, false]) {
      if (!existing) fs.rmSync(path.dirname(votes), { recursive: true });
      const before = snapshot();
      const result = run(['recall', 'feedback', `--${polarity}`, 'doc123', '--dry-run']);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(`[dry-run] Would submit ${polarity} feedback for: doc123`);
      expect(snapshot()).toEqual(before);
    }
  });

  it('refuses an unreadable project config instead of using the user scope', () => {
    setupScope('user');
    const { config } = setupScope('project');
    fs.writeFileSync(config, 'repo: [unclosed\n');
    const before = snapshot();
    const result = run(['recall', 'feedback', '--positive', 'doc123', '--dry-run'], project);
    expect(result.code).toBe(1);
    expect(result.output).toContain('No feedback recorded:');
    expect(result.output).toContain(config);
    expect(result.output).not.toContain('Would submit');
    expect(snapshot()).toEqual(before);
  });
});
