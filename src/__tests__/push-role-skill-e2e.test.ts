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

function makePushFixture(provider: 'github' | 'gitlab', repoUrl: string): PushFixture {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `teamai-push-${provider}-e2e-`));
  const home = path.join(sandbox, 'home');
  const projectRoot = path.join(sandbox, 'project');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'team.git');
  const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'skills', 'backend', 'beta-proof'), { recursive: true });
  fs.writeFileSync(
    path.join(seed, 'teamai.yaml'),
    [
      `team: issue-331-${provider}`,
      `repo: ${repoUrl}`,
      `provider: ${provider}`,
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
  envOverrides: Record<string, string> = {},
): Promise<RunResult> {
  const pullResult = await runCLI(
    ['pull'],
    fixture.projectRoot,
    fixture.home,
    envOverrides,
  );
  expect(pullResult.code, pullResult.output).toBe(0);

  fs.writeFileSync(
    path.join(fixture.projectRoot, '.claude', 'skills', 'beta-proof', 'SKILL.md'),
    '---\nname: beta-proof\ndescription: modified\n---\n\n# Modified locally\n',
  );
  return runCLI(
    ['push', '--skill', '.claude/skills/beta-proof', '--role', 'backend', '--all'],
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
  it('commits, pushes, and creates a GitHub PR', async () => {
    const fixture = makePushFixture('github', 'https://github.com/team/issue-331.git');
    const binDir = path.join(fixture.sandbox, 'bin');
    const ghLog = path.join(fixture.sandbox, 'gh.log');
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, 'gh'),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$TEAMAI_FAKE_GH_LOG"\nprintf "%s\\n" "https://github.com/team/issue-331/pull/331"\n',
      { mode: 0o755 },
    );

    try {
      const result = await pullModifyAndPush(fixture, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        TEAMAI_FAKE_GH_LOG: ghLog,
      });

      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('Pull Request created: https://github.com/team/issue-331/pull/331');
      expect(fs.readFileSync(ghLog, 'utf8')).toContain('pr create -R team/issue-331');

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

  it('commits, pushes, and creates a GitLab MR', async () => {
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
    const fixture = makePushFixture('gitlab', `${gitlabUrl}/team/issue-331.git`);

    try {
      const result = await pullModifyAndPush(fixture, {
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
