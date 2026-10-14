import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const PROJECT_TITLE = 'Java Project Review Workflow';
const USER_TITLE = 'Organization Review Workflow';
const PROJECT_COLLISION_TITLE = 'Project Shared Collision Policy';
const USER_COLLISION_TITLE = 'Organization Shared Collision Policy';
const INHERIT_MSG = 'workspace scope detected, inheriting user-scope resources and knowledge';

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], env: Record<string, string>, cwd: string, clean: string[] = [], input = ''): Promise<RunResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', ...env };
  for (const key of clean) delete childEnv[key];
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, output }));
  });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...GIT_ENV },
  });
}

function learningDoc(title: string): string {
  return `---\ntitle: "${title}"\nauthor: tester\ndate: 2026-08-04\ntags: [review, workflow]\n---\n\nUse an independent reviewer after implementation.\n`;
}

function skillDoc(name: string): string {
  return `---\nname: ${name}\ndescription: review workflow\n---\n\n# ${name}\n\nReview independently.\n`;
}

const TEAM_YAML = [
  'team: e2e-team',
  'repo: https://example.com/e2e.git',
  'provider: tgit',
  'sharing:',
  '  env:',
  '    injectShellProfile: true',
  '  mcp:',
  '    autoApply: true',
  'toolPaths:',
  '  claude:',
  '    skills: .claude/skills',
  '    rules: .claude/rules',
  '    mcpProject: .mcp.json',
].join('\n');

function makeRemote(
  dir: string,
  learningTitle: string,
  skillName: string,
  collisionTitle: string,
  includeEnv = false,
): void {
  fs.mkdirSync(path.join(dir, 'learnings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', skillName), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teamai.yaml'), TEAM_YAML);
  fs.writeFileSync(path.join(dir, 'learnings', `${skillName}.md`), learningDoc(learningTitle));
  fs.writeFileSync(path.join(dir, 'learnings', 'shared-policy.md'), learningDoc(collisionTitle));
  fs.writeFileSync(path.join(dir, 'skills', skillName, 'SKILL.md'), skillDoc(skillName));
  if (includeEnv) {
    fs.mkdirSync(path.join(dir, 'env'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'env', 'env.yaml'),
      'variables:\n  - key: ORG_ONLY_SECRET\n    value: org-old\n',
    );
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'hooks', 'hooks.yaml'),
      'hooks:\n  SessionStart:\n    - command: echo inherited-hook-must-not-run\n',
    );
    fs.writeFileSync(
      path.join(dir, 'mcp.yaml'),
      'servers:\n  inherited-user-server:\n    command: node\n    args: [server.js]\n',
    );
  }
  git(['init', '-q'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}

describe('opt-in user-scope inheritance (e2e)', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;
  let userRemote: string;
  let pullResult: RunResult;

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-inherit-e2e-'));
    homeDir = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'java-project');
    fs.mkdirSync(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });

    userRemote = path.join(sandbox, 'org-remote');
    makeRemote(userRemote, USER_TITLE, 'org-review', USER_COLLISION_TITLE, true);
    const userLocal = path.join(homeDir, '.teamai', 'team-repo');
    git(['clone', '-q', userRemote, userLocal], sandbox);
    fs.writeFileSync(
      path.join(homeDir, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${userLocal}`,
        `  remote: ${userRemote}`,
        'username: ci-user',
        'scope: user',
      ].join('\n'),
    );

    const projectRemote = path.join(sandbox, 'java-remote');
    makeRemote(projectRemote, PROJECT_TITLE, 'java-review', PROJECT_COLLISION_TITLE);
    fs.mkdirSync(path.join(projectRemote, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(projectRemote, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - name: inherited-token',
      '    transport: http',
      '    url: https://api.example.com/mcp',
      '    headers:',
      '      Authorization: "Bearer ${ORG_ONLY_SECRET}"',
      '',
    ].join('\n'));
    git(['add', '-A'], projectRemote);
    git(['commit', '-q', '-m', 'add project MCP server'], projectRemote);
    const projectLocal = path.join(projectRoot, '.teamai', 'team-repo');
    git(['clone', '-q', projectRemote, projectLocal], sandbox);
    fs.writeFileSync(
      path.join(projectRoot, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${projectLocal}`,
        `  remote: ${projectRemote}`,
        'username: ci-project',
        'scope: project',
        `projectRoot: ${projectRoot}`,
        'inheritUserScope: true',
      ].join('\n'),
    );

    pullResult = await runCLI(['pull'], { HOME: homeDir }, projectRoot, ['ORG_ONLY_SECRET']);
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pulls safe resources into both scope-specific locations', () => {
    expect(pullResult.code, pullResult.output).toBe(0);
    expect(pullResult.output).toContain(INHERIT_MSG);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'org-review'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'java-review'))).toBe(true);
  });

  it('does not apply inherited user hooks or MCP configuration', () => {
    expect(fs.existsSync(path.join(homeDir, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.teamai', 'managed-mcp.json'))).toBe(false);
  });

  it('resolves inherited user env for project MCP during pull with a clean process env', () => {
    expect(pullResult.code, pullResult.output).toBe(0);
    const projectMcp = fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8');
    expect(projectMcp).toContain('Bearer org-old');
  });

  // The project's shells load the user env.sh, so the pull that refreshes the
  // user repo rewrites it; the user scope's hooks and MCP stay undelivered.
  it("rewrites the user scope's env.sh from the user repo it refreshed, and nothing else of the user scope's runs", async () => {
    const envSh = path.join(homeDir, '.teamai', 'env.sh');
    expect(fs.readFileSync(envSh, 'utf8')).toContain("export ORG_ONLY_SECRET='org-old'");

    fs.writeFileSync(path.join(userRemote, 'env', 'env.yaml'), 'variables:\n  - key: ORG_ONLY_SECRET\n    value: org-new\n');
    git(['commit', '-q', '-am', 'rotate'], userRemote);
    const result = await runCLI(['pull'], { HOME: homeDir }, projectRoot, ['ORG_ONLY_SECRET']);

    expect(result.code, result.output).toBe(0);
    expect(fs.readFileSync(envSh, 'utf8')).toContain("export ORG_ONLY_SECRET='org-new'");
    expect(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8')).toContain('Bearer org-new');
    expect(fs.existsSync(path.join(homeDir, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.teamai', 'managed-mcp.json'))).toBe(false);
  });

  it('recalls organization and project knowledge together', async () => {
    const result = await runCLI(['recall', 'review workflow'], { HOME: homeDir }, projectRoot);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(PROJECT_TITLE);
    expect(result.output).toContain(USER_TITLE);
    expect(result.output).toContain('[workspace]');
    expect(result.output).toContain('[user]');
  });

  it('lets the project entry shadow the same inherited type and filename', async () => {
    const result = await runCLI(['recall', 'shared collision policy'], { HOME: homeDir }, projectRoot);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(PROJECT_COLLISION_TITLE);
    expect(result.output).not.toContain(USER_COLLISION_TITLE);
  });

  // The directory's scope is the project: its MCP gets the value, with the
  // inherited user variable it already had, and the user scope's tools get nothing.
  it("env set in the project updates the project's MCP with the project's resolution", async () => {
    const projectRemote = path.join(sandbox, 'java-remote');
    fs.mkdirSync(path.join(projectRemote, 'env'), { recursive: true });
    fs.writeFileSync(path.join(projectRemote, 'env', 'secrets.yaml'), 'secrets:\n  - key: PROJECT_TOKEN\n');
    fs.writeFileSync(path.join(projectRemote, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - name: inherited-token',
      '    transport: http',
      '    url: https://api.example.com/mcp',
      '    headers:',
      '      Authorization: "Bearer ${ORG_ONLY_SECRET}"',
      '  - name: project-token',
      '    transport: http',
      '    url: https://project.example.com/mcp',
      '    headers:',
      '      Authorization: "Bearer ${PROJECT_TOKEN}"',
      '',
    ].join('\n'));
    git(['add', '-A'], projectRemote);
    git(['commit', '-q', '-m', 'declare PROJECT_TOKEN'], projectRemote);
    const pulled = await runCLI(['pull'], { HOME: homeDir }, projectRoot, ['ORG_ONLY_SECRET', 'PROJECT_TOKEN']);
    expect(pulled.code, pulled.output).toBe(0);
    expect(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8')).not.toContain('project-token-value');

    const result = await runCLI(
      ['env', 'set', 'PROJECT_TOKEN', '--stdin'], { HOME: homeDir }, projectRoot, ['ORG_ONLY_SECRET', 'PROJECT_TOKEN'], 'project-token-value');

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('MCP servers updated.');
    expect(result.output).not.toContain('project-token-value');
    const projectMcp = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { headers: Record<string, string> }>;
    };
    expect(projectMcp.mcpServers['project-token'].headers.Authorization).toBe('Bearer project-token-value');
    expect(projectMcp.mcpServers['inherited-token'].headers.Authorization).toBe('Bearer org-new');
    const userMcp = path.join(homeDir, '.claude.json');
    if (fs.existsSync(userMcp)) expect(fs.readFileSync(userMcp, 'utf8')).not.toContain('project-token-value');
  });

  it('keeps full user sync pending so a later user pull still applies env', async () => {
    const inheritedState = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.teamai', 'state.json'), 'utf8'),
    ) as { lastPullRev?: string | null; lastInheritedPullRev?: string | null };
    expect(inheritedState.lastInheritedPullRev).toBeTruthy();
    expect(inheritedState.lastPullRev).toBeNull();

    const result = await runCLI(['pull'], { HOME: homeDir }, homeDir);
    expect(result.code, result.output).toBe(0);
    expect(fs.readFileSync(path.join(homeDir, '.teamai', 'env.sh'), 'utf8'))
      .toContain('ORG_ONLY_SECRET');
  });
});
