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

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, HOME: home, USERPROFILE: home } });
}

beforeEach(() => {
  if (!fs.existsSync(cli)) throw new Error('Run npm run build before this test.');
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-feedback-readonly-')));
  home = path.join(sandbox, 'home');
  project = path.join(sandbox, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  git(project, ['init', '-q']);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe.each(['user', 'project'] as const)('feedback reads team votes in %s scope', (scope) => {
  it.each(['local-upvote', 'no-upvotes', 'missing', 'team-upvote'] as const)(
    'leaves the reports file unchanged for %s', (scenario) => {
      const dataHome = scope === 'user'
        ? path.join(home, '.teamai')
        : path.join(home, '.teamai', 'projects', projectSlug(project));
      const repo = path.join(dataHome, 'team-repo');
      fs.mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q']);
      git(repo, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.test', 'commit', '--allow-empty', '-qm', 'Initial']);
      const reports = path.join(dataHome, 'reports-wt');
      git(repo, ['worktree', 'add', '-qb', 'teamai-reports', reports]);
      writeYaml(path.join(dataHome, 'config.yaml'), {
        repo: { localPath: repo, remote: 'https://example.test/team.git' },
        username: 'tester', scope, additionalRoles: [],
        ...(scope === 'project' ? { projectRoot: project } : {}),
      });
      const entry = { recalled_count: 1, upvoted_count: 2, last_recalled_at: '2026-10-01T00:00:00Z' };
      const localFile = path.join(dataHome, scope === 'user' ? 'user-votes' : 'votes', 'tester.yaml');
      writeYaml(localFile, {
        version: 2, votes: scenario === 'local-upvote' ? { doc: entry } : {}, deltas: {},
      });
      const teamFile = path.join(reports, 'votes', 'tester.yaml');
      writeYaml(teamFile, scenario === 'team-upvote'
        ? { version: 2, votes: { doc: entry }, deltas: {} }
        : { votes: { doc: { at: '2026-10-01T00:00:00Z' } } });
      const teamBefore = fs.readFileSync(teamFile, 'utf8');
      const localBefore = fs.readFileSync(localFile, 'utf8');
      const docId = scenario === 'missing' ? 'absent' : 'doc';

      const result = spawnSync(process.execPath, [cli, 'recall', 'feedback', '--negative', docId], {
        cwd: scope === 'project' ? project : sandbox,
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
        encoding: 'utf8', timeout: 10_000,
      });
      if (result.error) throw result.error;
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(0);
      expect(fs.readFileSync(teamFile, 'utf8')).toBe(teamBefore);
      if (scenario === 'local-upvote' || scenario === 'team-upvote') {
        expect(output).toContain('Negative signal recorded for: doc');
        const local = YAML.parse(fs.readFileSync(localFile, 'utf8')) as UserVotesV2;
        expect(local.votes.doc.upvoted_count).toBe(1);
        expect(local.deltas.doc.upvoted_delta).toBe(-1);
      } else {
        expect(output).toContain(scenario === 'missing'
          ? 'Document not found in votes: absent' : 'No upvotes to decrement for: doc');
        expect(fs.readFileSync(localFile, 'utf8')).toBe(localBefore);
      }
    },
  );
});
