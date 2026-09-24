import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const PUSH_AGENTS = ['claude', 'codex', 'codebuddy', 'opencode'] as const;
type PushAgent = (typeof PUSH_AGENTS)[number];

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function runCLI(
  args: string[],
  cwd: string,
  home: string,
  envOverrides: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        ...GIT_ENV,
        HOME: home,
        FORCE_COLOR: '0',
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

interface PushFixture {
  sandbox: string;
  home: string;
  projectRoot: string;
  remote: string;
}

function makePushFixture(
  provider: 'github' | 'gitlab' | 'git',
  repoUrl: string,
  agent: PushAgent,
): PushFixture {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `teamai-push-${provider}-${agent}-e2e-`));
  const home = path.join(sandbox, 'home');
  const projectRoot = path.join(sandbox, 'project');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'team.git');
  const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, `.${agent}`, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'skills', 'backend', 'beta-proof'), { recursive: true });
  fs.writeFileSync(
    path.join(seed, 'teamai.yaml'),
    [
      `team: issue-331-${provider}`,
      `repo: ${repoUrl}`,
      `provider: ${provider}`,
      'reviewers: []',
      'toolPaths:',
      `  ${agent}:`,
      `    skills: .${agent}/skills`,
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(seed, 'skills', 'backend', 'beta-proof', 'SKILL.md'),
    '---\nname: beta-proof\ndescription: original\n---\n\n# Original\n',
  );
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], sandbox);
  git(['clone', '-q', remote, teamRepo], projectRoot);
  fs.writeFileSync(
    path.join(projectRoot, '.teamai', 'config.yaml'),
    [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      `username: issue-331-${provider}`,
      'updatePolicy: auto',
      'primaryRole: backend',
      'additionalRoles: []',
      'scope: project',
      `projectRoot: ${projectRoot}`,
    ].join('\n'),
  );

  return { sandbox, home, projectRoot, remote };
}

async function pullModifyAndPush(
  fixture: PushFixture,
  agent: PushAgent,
  envOverrides: Record<string, string> = {},
  extraPushArgs: string[] = [],
): Promise<RunResult> {
  const pullResult = await runCLI(
    ['pull'],
    fixture.projectRoot,
    fixture.home,
    envOverrides,
  );
  expect(pullResult.code, pullResult.output).toBe(0);
  const skillPath = `.${agent}/skills/beta-proof`;
  const skillFile = path.join(fixture.projectRoot, skillPath, 'SKILL.md');
  expect(fs.existsSync(skillFile), pullResult.output).toBe(true);
  expect(fs.readFileSync(skillFile, 'utf8')).toContain('# Original');

  fs.writeFileSync(
    skillFile,
    '---\nname: beta-proof\ndescription: modified\n---\n\n# Modified locally\n',
  );
  return runCLI(
    ['push', '--skill', skillPath, '--role', 'backend', '--all', ...extraPushArgs],
    fixture.projectRoot,
    fixture.home,
    envOverrides,
  );
}

describe('role-scoped skill push e2e (issue #331)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let remote: string;
  let teamRepo: string;
  let pushResult: RunResult;

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-role-e2e-'));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team.git');
    teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'skills', 'backend', 'beta-proof'), { recursive: true });
    fs.writeFileSync(
      path.join(seed, 'teamai.yaml'),
      [
        'team: issue-331',
        'repo: https://git.example.test/team/issue-331.git',
        'provider: git',
        'reviewers: []',
        'toolPaths:',
        '  claude:',
        '    skills: .claude/skills',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(seed, 'skills', 'backend', 'beta-proof', 'SKILL.md'),
      '---\nname: beta-proof\ndescription: original\n---\n\n# Original\n',
    );
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    fs.mkdirSync(projectRoot, { recursive: true });
    git(['clone', '-q', remote, teamRepo], projectRoot);
    fs.writeFileSync(
      path.join(projectRoot, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${teamRepo}`,
        `  remote: ${remote}`,
        'username: issue-331-user',
        'updatePolicy: auto',
        'primaryRole: backend',
        'additionalRoles: []',
        'scope: project',
        `projectRoot: ${projectRoot}`,
      ].join('\n'),
    );

    const pullResult = await runCLI(['pull'], projectRoot, home);
    expect(pullResult.code, pullResult.output).toBe(0);

    fs.writeFileSync(
      path.join(projectRoot, '.claude', 'skills', 'beta-proof', 'SKILL.md'),
      '---\nname: beta-proof\ndescription: modified\n---\n\n# Modified locally\n',
    );

    pushResult = await runCLI(
      ['push', '--skill', '.claude/skills/beta-proof', '--role', 'backend', '--all'],
      projectRoot,
      home,
    );
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('commits and pushes the modified skill and contributor metadata', () => {
    expect(pushResult.output).not.toContain('No changes to push');
    expect(pushResult.output).toContain('Pushed branch teamai/push/issue-331-user/');

    const branch = git(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/issue-331-user/'],
      remote,
    );
    expect(branch).toMatch(/^teamai\/push\/issue-331-user\//);
    expect(git(['show', `${branch}:skills/backend/beta-proof/SKILL.md`], remote))
      .toContain('# Modified locally');
    expect(git(['show', `${branch}:skills/backend/beta-proof/CONTRIBUTORS`], remote))
      .toBe('issue-331-user');
  });

  it('returns the generic Git unsupported-PR failure', () => {
    expect(pushResult.code, pushResult.output).not.toBe(0);
    expect(pushResult.output)
      .toContain('Automatic pull/merge request creation is not supported for generic Git hosts.');
  });
});

describe('role-scoped skill provider PR creation e2e (issue #331)', () => {
  it.each(PUSH_AGENTS)('explains a saved generic provider when anonymous probing identifies GitLab for %s', async (agent) => {
    const requests: http.IncomingMessage[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request);
      response.writeHead(200, {
        'content-type': 'text/html',
        'x-gitlab-meta': JSON.stringify({ correlation_id: 'probe-test', version: '1' }),
      });
      response.end('GitLab sign in');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const fixture = makePushFixture('git', `${baseUrl}/team/issue-331.git`, agent);
    try {
      const result = await pullModifyAndPush(fixture, agent, {
        GITLAB_URL: '', TEAMAI_GITLAB_HOST: '', GITLAB_TOKEN: 'must-not-be-sent',
      });
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('Pushed branch teamai/push/issue-331-git/');
      expect(result.output).toContain('Detected GitLab, but teamai.yaml has provider: git.');
      expect(result.output).toContain('Change it to provider: gitlab');
      expect(result.output).toContain(`set GITLAB_URL to ${baseUrl}`);
      expect(result.output).not.toContain('must-not-be-sent');
      expect(requests.map((request) => request.url)).toEqual(['/users/sign_in?auto_sign_in=false']);
      expect(requests[0].headers['private-token']).toBeUndefined();
      const config = fs.readFileSync(path.join(fixture.projectRoot, '.teamai', 'team-repo', 'teamai.yaml'), 'utf8');
      expect(config).toMatch(/provider: git\r?\n/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(PUSH_AGENTS)('commits, pushes, and creates a GitHub PR for %s', async (agent) => {
    const fixture = makePushFixture('github', 'https://github.com/team/issue-331.git', agent);
    const binDir = path.join(fixture.sandbox, 'bin');
    const ghLog = path.join(fixture.sandbox, 'gh.log');
    fs.mkdirSync(binDir);
    const ghName = process.platform === 'win32' ? 'gh.cmd' : 'gh';
    const ghScript = process.platform === 'win32'
      ? '@echo off\r\n> "%TEAMAI_FAKE_GH_LOG%" echo %*\r\necho https://github.com/team/issue-331/pull/331\r\n'
      : '#!/bin/sh\nprintf "%s\\n" "$*" > "$TEAMAI_FAKE_GH_LOG"\nprintf "%s\\n" "https://github.com/team/issue-331/pull/331"\n';
    fs.writeFileSync(path.join(binDir, ghName), ghScript, { mode: 0o755 });

    try {
      const pathWithoutInstalledGh = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((entry) => !/github\s*cli/i.test(entry))
        .join(path.delimiter);
      const result = await pullModifyAndPush(fixture, agent, {
        PATH: [binDir, pathWithoutInstalledGh].join(path.delimiter),
        TEAMAI_FAKE_GH_LOG: ghLog,
      });

      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('Pull Request created: https://github.com/team/issue-331/pull/331');
      expect(fs.readFileSync(ghLog, 'utf8'))
        .toMatch(/"?pr"?\s+"?create"?\s+"?-R"?\s+"?team\/issue-331"?/);

      const branch = git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/issue-331-github/'],
        fixture.remote,
      );
      expect(branch).toMatch(/^teamai\/push\/issue-331-github\//);
      expect(git(['show', `${branch}:skills/backend/beta-proof/SKILL.md`], fixture.remote))
        .toContain('# Modified locally');
      expect(git(['show', `${branch}:skills/backend/beta-proof/CONTRIBUTORS`], fixture.remote))
        .toBe('issue-331-github');
    } finally {
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(PUSH_AGENTS)('commits, pushes, and creates a GitLab MR for %s', async (agent) => {
    const requestPaths: string[] = [];
    let requestBody = '';
    const server = http.createServer((request, response) => {
      requestPaths.push(request.url ?? '');
      request.on('data', (chunk: Buffer) => { requestBody += chunk.toString(); });
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          iid: 331,
          web_url: 'https://gitlab.example.test/team/issue-331/-/merge_requests/331',
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Failed to start the fake GitLab API server.');
    }
    const gitlabUrl = `http://127.0.0.1:${address.port}`;
    const fixture = makePushFixture('gitlab', `${gitlabUrl}/team/issue-331.git`, agent);

    try {
      const result = await pullModifyAndPush(fixture, agent, {
        GITLAB_URL: gitlabUrl,
        GITLAB_TOKEN: 'test-token',
      });

      expect(result.code, result.output).toBe(0);
      expect(result.output)
        .toContain('Pull Request created: https://gitlab.example.test/team/issue-331/-/merge_requests/331');
      expect(requestPaths).toEqual(['/api/v4/projects/team%2Fissue-331/merge_requests']);
      expect(JSON.parse(requestBody)).toMatchObject({
        source_branch: expect.stringMatching(/^teamai\/push\/issue-331-gitlab\//),
        target_branch: 'main',
      });

      const branch = git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/issue-331-gitlab/'],
        fixture.remote,
      );
      expect(branch).toMatch(/^teamai\/push\/issue-331-gitlab\//);
      expect(git(['show', `${branch}:skills/backend/beta-proof/SKILL.md`], fixture.remote))
        .toContain('# Modified locally');
      expect(git(['show', `${branch}:skills/backend/beta-proof/CONTRIBUTORS`], fixture.remote))
        .toBe('issue-331-gitlab');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('push branch and dirty-clone e2e (issue #663)', () => {
  it('uses --branch for a real resource push', async () => {
    const fixture = makePushFixture('git', 'https://git.example.test/team/issue-663.git', 'claude');
    try {
      const result = await pullModifyAndPush(
        fixture,
        'claude',
        {},
        ['--branch', 'feature/explicit-resource'],
      );
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('Pushed branch feature/explicit-resource');
      expect(git(['show', 'feature/explicit-resource:skills/backend/beta-proof/SKILL.md'], fixture.remote))
        .toContain('# Modified locally');
    } finally {
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it('uses --branch for a teamai.yaml-only push', async () => {
    const fixture = makePushFixture('git', 'https://git.example.test/team/issue-663-config.git', 'claude');
    try {
      const pulled = await runCLI(['pull'], fixture.projectRoot, fixture.home);
      expect(pulled.code, pulled.output).toBe(0);
      const yamlPath = path.join(fixture.projectRoot, '.teamai', 'team-repo', 'teamai.yaml');
      fs.appendFileSync(yamlPath, '\npublicSkills: []\n');

      const result = await runCLI(
        ['push', '--all', '--branch', 'feature/explicit-config'],
        fixture.projectRoot,
        fixture.home,
      );
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('Pushed branch feature/explicit-config');
      expect(git(['show', 'feature/explicit-config:teamai.yaml'], fixture.remote))
        .toContain('publicSkills: []');
    } finally {
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it('updates an existing open-PR branch instead of creating another branch', async () => {
    const fixture = makePushFixture('git', 'https://git.example.test/team/issue-663-existing.git', 'claude');
    try {
      const first = await pullModifyAndPush(fixture, 'claude');
      expect(first.output).toContain('Pushed branch teamai/push/issue-331-git/');
      const branch = git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/issue-331-git/'],
        fixture.remote,
      );
      expect(branch).toMatch(/^teamai\/push\/issue-331-git\//);

      const statePath = path.join(fixture.projectRoot, '.teamai', 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        pendingPushes: Array<{ branch: string; prUrl: string | null }>;
      };
      const pending = state.pendingPushes.find((entry) => entry.branch === branch);
      expect(pending).toBeDefined();
      if (!pending) return;
      pending.prUrl = 'https://github.com/team/issue-663-existing/pull/663';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

      fs.writeFileSync(
        path.join(fixture.projectRoot, '.claude', 'skills', 'beta-proof', 'SKILL.md'),
        '---\nname: beta-proof\ndescription: modified again\n---\n\n# Modified again\n',
      );
      const second = await runCLI(
        ['push', '--skill', '.claude/skills/beta-proof', '--role', 'backend', '--all'],
        fixture.projectRoot,
        fixture.home,
      );
      expect(second.code, second.output).toBe(0);
      expect(second.output)
        .toContain('Existing PR updated: https://github.com/team/issue-663-existing/pull/663');
      expect(git(['show', `${branch}:skills/backend/beta-proof/SKILL.md`], fixture.remote))
        .toContain('# Modified again');
      expect(git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/issue-331-git/'],
        fixture.remote,
      )).toBe(branch);
    } finally {
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it('routes config changes to the explicit new branch when an existing PR is also updated', async () => {
    const fixture = makePushFixture('git', 'https://git.example.test/team/issue-663-mixed.git', 'claude');
    try {
      const teamRepo = path.join(fixture.projectRoot, '.teamai', 'team-repo');
      git(['config', 'core.autocrlf', 'false'], teamRepo);
      git(['checkout', '--', '.'], teamRepo);
      const first = await pullModifyAndPush(fixture, 'claude');
      expect(first.output).toContain('Pushed branch teamai/push/issue-331-git/');
      const existingBranch = git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/issue-331-git/'],
        fixture.remote,
      );
      expect(existingBranch).toMatch(/^teamai\/push\/issue-331-git\//);

      const statePath = path.join(fixture.projectRoot, '.teamai', 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        pendingPushes: Array<{ branch: string; prUrl: string | null }>;
      };
      const pending = state.pendingPushes.find((entry) => entry.branch === existingBranch);
      expect(pending).toBeDefined();
      if (!pending) return;
      pending.prUrl = 'https://github.com/team/issue-663-mixed/pull/663';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

      fs.writeFileSync(
        path.join(fixture.projectRoot, '.claude', 'skills', 'beta-proof', 'SKILL.md'),
        '---\nname: beta-proof\ndescription: modified again\n---\n\n# Modified again\n',
      );
      const newSkillDir = path.join(fixture.projectRoot, '.claude', 'skills', 'gamma-proof');
      fs.mkdirSync(newSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(newSkillDir, 'SKILL.md'),
        '---\nname: gamma-proof\ndescription: new\n---\n\n# New skill\n',
      );
      fs.appendFileSync(path.join(teamRepo, 'teamai.yaml'), '\npublicSkills: []\n');

      const second = await runCLI(
        ['push', '--all', '--branch', 'feature/explicit-mixed'],
        fixture.projectRoot,
        fixture.home,
      );
      expect(second.code, second.output).not.toBe(0);
      expect(second.output)
        .toContain('Existing PR updated: https://github.com/team/issue-663-mixed/pull/663');
      expect(second.output).toContain('Pushed branch feature/explicit-mixed');
      expect(git(['show', `${existingBranch}:teamai.yaml`], fixture.remote))
        .not.toContain('publicSkills: []');
      expect(git(['show', 'feature/explicit-mixed:teamai.yaml'], fixture.remote))
        .toContain('publicSkills: []');
      expect(git(['show', 'feature/explicit-mixed:skills/backend/gamma-proof/SKILL.md'], fixture.remote))
        .toContain('# New skill');
    } finally {
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a mode-only teamai.yaml change before reset --hard', async () => {
    const fixture = makePushFixture('git', 'https://git.example.test/team/issue-663-dirty.git', 'claude');
    try {
      const teamRepo = path.join(fixture.projectRoot, '.teamai', 'team-repo');
      git(['config', 'core.autocrlf', 'false'], teamRepo);
      git(['checkout', '--', 'teamai.yaml'], teamRepo);
      const pulled = await runCLI(['pull'], fixture.projectRoot, fixture.home);
      expect(pulled.code, pulled.output).toBe(0);
      git(['config', 'core.fileMode', 'true'], teamRepo);
      git(['update-index', '--chmod=+x', 'teamai.yaml'], teamRepo);
      expect(git(['status', '--short'], teamRepo)).toContain('teamai.yaml');

      const result = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('Cannot push: the team repo has uncommitted changes');
      expect(result.output).toContain('teamai.yaml');
      expect(git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'],
        fixture.remote,
      )).toBe('');
    } finally {
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a content-and-mode teamai.yaml change before reset --hard', async () => {
    const fixture = makePushFixture('git', 'https://git.example.test/team/issue-663-dirty-content.git', 'claude');
    try {
      const teamRepo = path.join(fixture.projectRoot, '.teamai', 'team-repo');
      git(['config', 'core.autocrlf', 'false'], teamRepo);
      git(['checkout', '--', 'teamai.yaml'], teamRepo);
      const pulled = await runCLI(['pull'], fixture.projectRoot, fixture.home);
      expect(pulled.code, pulled.output).toBe(0);
      fs.appendFileSync(path.join(teamRepo, 'teamai.yaml'), '\npublicSkills: []\n');
      git(['config', 'core.fileMode', 'true'], teamRepo);
      git(['update-index', '--chmod=+x', 'teamai.yaml'], teamRepo);
      expect(git(['status', '--short'], teamRepo)).toContain('teamai.yaml');

      const result = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('Cannot push: the team repo has uncommitted changes');
      expect(result.output).toContain('teamai.yaml');
      expect(git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'],
        fixture.remote,
      )).toBe('');
    } finally {
      fs.rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});
