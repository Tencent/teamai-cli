import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import matter from 'gray-matter';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;
let home: string;
let project: string;
let origin: string;
let clone: string;
let configPath: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = sandbox): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env, encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(value));
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ns-maintenance-e2e-'));
  home = path.join(sandbox, 'home');
  project = path.join(sandbox, 'project');
  origin = path.join(sandbox, 'origin.git');
  clone = path.join(project, '.teamai', 'team-repo');
  configPath = path.join(project, '.teamai', 'config.yaml');
  const seed = path.join(sandbox, 'seed');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(seed);
  fs.mkdirSync(project);
  env = {
    ...process.env,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'member', GIT_AUTHOR_EMAIL: 'member@example.invalid',
    GIT_COMMITTER_NAME: 'member', GIT_COMMITTER_EMAIL: 'member@example.invalid',
    GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0',
  };
  writeYaml(path.join(seed, 'teamai.yaml'), {
    team: 'namespace-fixture', repo: origin, provider: 'git', usageReport: false,
  });
  writeYaml(path.join(seed, 'manifest', 'projects.yaml'), {
    version: 1,
    projects: [
      { id: 'infra', resources: { learnings: ['k8s'] } },
    ],
  });
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '.'], seed);
  git(['commit', '-qm', 'fixture'], seed);
  git(['clone', '-q', '--bare', seed, origin]);
  git(['clone', '-q', origin, clone]);
  writeYaml(configPath, {
    repo: { localPath: clone, remote: origin, kind: 'git' },
    username: 'member', scope: 'project', projectRoot: project,
    updatePolicy: 'skip', additionalRoles: [], projects: ['infra'], enabledAgents: ['claude'],
  });
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe('digest and maintenance with namespaced learnings (#1395)', () => {
  it('lists namespaced learnings in digest and recall promote --dry-run', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 1. Root learning
    const learningsDir = path.join(clone, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.writeFileSync(
      path.join(learningsDir, `teamai-${today}-pod-timeouts.md`),
      matter.stringify('Fix pod timeouts', { title: 'Pod Startup Timeouts', date: thirtyDaysAgo }),
    );

    // 2. Namespaced k8s learning
    const k8sDir = path.join(learningsDir, 'k8s');
    fs.mkdirSync(k8sDir, { recursive: true });
    fs.writeFileSync(
      path.join(k8sDir, `teamai-${today}-helm-values.md`),
      matter.stringify('Helm values config procedure', { title: 'Helm Values Config', date: thirtyDaysAgo }),
    );

    // 3. Write votes for both in reports worktree / votes
    const reportsSeed = path.join(sandbox, 'reports-seed');
    fs.mkdirSync(reportsSeed);
    git(['init', '-q', '-b', 'teamai-reports'], reportsSeed);
    const votesDir = path.join(reportsSeed, 'votes');
    fs.mkdirSync(votesDir, { recursive: true });
    const statsDir = path.join(reportsSeed, 'stats');
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(path.join(statsDir, 'member.yaml'), 'username: member\nskills: {}\n');

    const recentDate = new Date().toISOString();
    const k8sId = path.join('k8s', `teamai-${today}-helm-values`);
    const rootId = `teamai-${today}-pod-timeouts`;
    for (const u of ['alice', 'bob', 'carol']) {
      writeYaml(path.join(votesDir, `${u}.yaml`), {
        version: 2,
        votes: {
          [rootId]: { recalled_count: 5, upvoted_count: 5, last_recalled_at: recentDate, last_upvoted_at: recentDate },
          [k8sId]: { recalled_count: 5, upvoted_count: 5, last_recalled_at: recentDate, last_upvoted_at: recentDate },
        },
        deltas: {},
      });
    }
    git(['add', '.'], reportsSeed);
    git(['commit', '-qm', 'votes and stats'], reportsSeed);
    git(['push', '-q', origin, 'teamai-reports'], reportsSeed);

    // Run teamai digest
    const digestResult = run(['digest']);
    expect(digestResult.code).toBe(0);
    expect(digestResult.output).toContain('Pod Startup Timeouts');
    expect(digestResult.output).toContain('Helm Values Config');
    expect(digestResult.output).toContain('2 learnings');

    // Run teamai recall promote --dry-run
    const promoteResult = run(['recall', 'promote', '--dry-run']);
    expect(promoteResult.code).toBe(0);
    expect(promoteResult.output).toContain(rootId);
    expect(promoteResult.output).toContain(k8sId);
    expect(promoteResult.output).toContain('2 learning(s) eligible for promotion');
  });

  it('includes child-selected namespaces in digest when workspace has no projects of its own', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Workspace has empty projects
    writeYaml(configPath, {
      repo: { localPath: clone, remote: origin, kind: 'git' },
      username: 'member', scope: 'project', projectRoot: project,
      updatePolicy: 'skip', additionalRoles: [], projects: [], enabledAgents: ['claude'],
    });

    // Child repo under project selecting infra
    const childDir = path.join(project, 'child-svc');
    fs.mkdirSync(childDir, { recursive: true });
    git(['init', '-q'], childDir);
    writeYaml(path.join(childDir, '.teamai', 'config.yaml'), {
      repo: { localPath: clone, remote: origin, kind: 'git' },
      username: 'member', scope: 'project', projectRoot: childDir,
      updatePolicy: 'skip', additionalRoles: [], projects: ['infra'], enabledAgents: ['claude'],
    });

    // 1. Root learning
    const learningsDir = path.join(clone, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
    fs.writeFileSync(
      path.join(learningsDir, `teamai-${today}-pod-timeouts.md`),
      matter.stringify('Fix pod timeouts', { title: 'Pod Startup Timeouts', date: thirtyDaysAgo }),
    );

    // 2. Namespaced k8s learning
    const k8sDir = path.join(learningsDir, 'k8s');
    fs.mkdirSync(k8sDir, { recursive: true });
    fs.writeFileSync(
      path.join(k8sDir, `teamai-${today}-helm-values.md`),
      matter.stringify('Helm values config procedure', { title: 'Helm Values Config', date: thirtyDaysAgo }),
    );

    // Stats
    const reportsSeed = path.join(sandbox, 'reports-seed');
    fs.mkdirSync(reportsSeed);
    git(['init', '-q', '-b', 'teamai-reports'], reportsSeed);
    const statsDir = path.join(reportsSeed, 'stats');
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(path.join(statsDir, 'member.yaml'), 'username: member\nskills: {}\n');
    git(['add', '.'], reportsSeed);
    git(['commit', '-qm', 'stats'], reportsSeed);
    git(['push', '-q', origin, 'teamai-reports'], reportsSeed);

    // Run teamai digest
    const digestResult = run(['digest']);
    expect(digestResult.code).toBe(0);
    expect(digestResult.output).toContain('Pod Startup Timeouts');
    expect(digestResult.output).toContain('Helm Values Config');
    expect(digestResult.output).toContain('2 learnings');
  });
});
