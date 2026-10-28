import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], homeDir: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'TeamAI CI',
      GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI',
      GIT_COMMITTER_EMAIL: 'ci@teamai.test',
    },
  });
}

/**
 * `manifest/members.yaml` assigns roles as team data (#1186): the member's own
 * `primaryRole` stops deciding, `roles set` refuses, and a member the file does
 * not list receives shared resources only instead of an unfiltered sync.
 */
describe('assigned roles (#1186)', () => {
  let sandbox: string;
  let homeDir: string;
  let remoteRepo: string;

  function writeSkill(namespace: string | null, name: string): void {
    const skillDir = namespace === null
      ? path.join(remoteRepo, 'skills', name)
      : path.join(remoteRepo, 'skills', namespace, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`);
  }

  /** A project checkout of the team repo whose config names `username`. */
  function project(name: string, username: string, localRole?: string): string {
    const projectRoot = path.join(sandbox, name);
    const localRepo = path.join(projectRoot, '.teamai', 'team-repo');
    // Built fresh so a retry of the test starts from the same state.
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });
    git(['clone', '-q', remoteRepo, localRepo], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remoteRepo}`,
      `username: ${username}`,
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      ...(localRole ? [`primaryRole: ${localRole}`] : []),
      '',
    ].join('\n'));
    return projectRoot;
  }

  function deliveredSkills(projectRoot: string): string[] {
    const skillsDir = path.join(projectRoot, '.claude', 'skills');
    return fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : [];
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-assigned-roles-e2e-'));
    homeDir = path.join(sandbox, 'home');
    remoteRepo = path.join(sandbox, 'remote');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(remoteRepo, 'manifest'), { recursive: true });

    fs.writeFileSync(path.join(remoteRepo, 'teamai.yaml'), [
      'team: assigned-roles-e2e',
      `repo: ${remoteRepo}`,
      'provider: tgit',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '    rules: .claude/rules',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: backend',
      '    resources:',
      '      knowledge: [backend]',
      '      skills: [backend]',
      '  - id: frontend',
      '    resources:',
      '      knowledge: [frontend]',
      '      skills: [frontend]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'members.yaml'), [
      'version: 1',
      'members:',
      '  alice: [frontend]',
      'default: []',
      '',
    ].join('\n'));
    writeSkill('backend', 'backend-only');
    writeSkill('frontend', 'frontend-only');

    git(['init', '-q', '-b', 'main'], remoteRepo);
    git(['add', '-A'], remoteRepo);
    git(['commit', '-q', '-m', 'fixture'], remoteRepo);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers the assigned role, not the one the member set locally, and refuses roles set', async () => {
    // The config says backend; the team assigned frontend.
    const projectRoot = project('alice-project', 'alice', 'backend');

    const list = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(list.code, list.output).toBe(0);
    expect(JSON.parse(list.output)).toMatchObject({
      roles: ['frontend'],
      primaryRole: 'frontend',
      source: 'assigned',
      assignmentFile: 'manifest/members.yaml',
    });

    const set = await runCLI(['roles', 'set', 'backend'], homeDir, projectRoot);
    expect(set.code).toBe(1);
    expect(set.output).toContain('manifest/members.yaml');

    const pull = await runCLI(['pull', '--force'], homeDir, projectRoot);
    expect(pull.code, pull.output).toBe(0);
    // `teamai` is the CLI's own discovery skill, delivered to every member.
    expect(deliveredSkills(projectRoot)).toEqual(['frontend-only', 'teamai']);

    // The refused `roles set` left the config file alone, and so did the pull.
    const config = fs.readFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), 'utf8');
    expect(config).toContain('primaryRole: backend');
  });

  // The assignment lives in the repo the pull itself refreshes: resolved before
  // that, it would deliver the previous roles and record the new revision as
  // synced, so no later pull would fix it without --force.
  it('delivers a reassignment on the pull that fetches it', async () => {
    const projectRoot = project('bob-project', 'bob');
    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'members.yaml'), [
      'version: 1',
      'members:',
      '  alice: [frontend]',
      '  bob: [frontend]',
      'default: []',
      '',
    ].join('\n'));
    git(['commit', '-qam', 'assign bob to frontend'], remoteRepo);
    const first = await runCLI(['pull', '--force'], homeDir, projectRoot);
    expect(first.code, first.output).toBe(0);
    expect(deliveredSkills(projectRoot)).toEqual(['frontend-only', 'teamai']);

    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'members.yaml'), [
      'version: 1',
      'members:',
      '  alice: [frontend]',
      '  bob: [backend]',
      'default: []',
      '',
    ].join('\n'));
    git(['commit', '-qam', 'reassign bob to backend'], remoteRepo);

    // A plain pull, as a session start runs it: one pull, no --force.
    const second = await runCLI(['pull'], homeDir, projectRoot);
    expect(second.code, second.output).toBe(0);
    expect(deliveredSkills(projectRoot), second.output).toEqual(['backend-only', 'teamai']);
    const list = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(JSON.parse(list.output)).toMatchObject({ roles: ['backend'] });
  });

  it('delivers no role namespace to a member the file does not list', async () => {
    const projectRoot = project('carol-project', 'carol');

    const list = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(JSON.parse(list.output)).toMatchObject({ roles: [], primaryRole: null, source: 'default' });

    const pull = await runCLI(['pull', '--force'], homeDir, projectRoot);
    expect(pull.code, pull.output).toBe(0);
    // Without the assignments file this role-less member would receive every
    // namespace — both of these skills. `default: []` closes that.
    expect(deliveredSkills(projectRoot)).toEqual(['teamai']);
  });

  // The file is read from origin/<default>, so the clone's copy is not a way
  // around the assignment: only what the forge merged counts.
  it('ignores an edit to, or deletion of, the clone\'s members.yaml', async () => {
    const projectRoot = project('alice-clone-edit', 'alice');
    const cloneCopy = path.join(projectRoot, '.teamai', 'team-repo', 'manifest', 'members.yaml');

    fs.writeFileSync(cloneCopy, 'version: 1\nmembers:\n  alice: [backend]\ndefault: []\n');
    const edited = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(JSON.parse(edited.output)).toMatchObject({ roles: ['frontend'], source: 'assigned' });

    fs.rmSync(cloneCopy);
    const deleted = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(JSON.parse(deleted.output)).toMatchObject({ roles: ['frontend'], source: 'assigned' });
    const set = await runCLI(['roles', 'set', 'backend'], homeDir, projectRoot);
    expect(set.code, set.output).toBe(1);
  });

  // Pinned to a tag, the checkout does not move when main reassigns, so the
  // revision alone would say "Already synced" and leave the new skills undelivered.
  it('delivers a reassignment to a workspace pinned to a tag, whose revision did not change', async () => {
    git(['tag', 'pin-1186'], remoteRepo);
    const projectRoot = project('dave-project', 'dave');
    const pin = await runCLI(['pull', '--team-ref', 'pin-1186'], homeDir, projectRoot);
    expect(pin.code, pin.output).toBe(0);
    expect(deliveredSkills(projectRoot)).toEqual(['teamai']);

    const members = fs.readFileSync(path.join(remoteRepo, 'manifest', 'members.yaml'), 'utf8');
    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'members.yaml'), members.replace('default: []', '  dave: [backend]\ndefault: []'));
    git(['commit', '-qam', 'assign dave to backend'], remoteRepo);

    const second = await runCLI(['pull'], homeDir, projectRoot);
    expect(second.code, second.output).toBe(0);
    expect(second.output).not.toContain('Already synced');
    expect(deliveredSkills(projectRoot)).toEqual(['backend-only', 'teamai']);
    const list = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(JSON.parse(list.output)).toMatchObject({ roles: ['backend'], source: 'assigned' });
  });

  // The file appearing is a change too: a role-less member goes from every
  // namespace to the shared root, with no role list changing and no revision
  // moving in a pinned checkout.
  it('withdraws role namespaces from a pinned workspace when members.yaml appears on main', async () => {
    const membersFile = path.join(remoteRepo, 'manifest', 'members.yaml');
    const members = fs.readFileSync(membersFile, 'utf8');
    git(['rm', '-q', 'manifest/members.yaml'], remoteRepo);
    git(['commit', '-qm', 'no assignments'], remoteRepo);
    git(['tag', 'pin-1186-open'], remoteRepo);
    const projectRoot = project('erin-project', 'erin');
    const pin = await runCLI(['pull', '--team-ref', 'pin-1186-open'], homeDir, projectRoot);
    expect(pin.code, pin.output).toBe(0);
    expect(deliveredSkills(projectRoot)).toEqual(['backend-only', 'frontend-only', 'teamai']);

    fs.writeFileSync(membersFile, members);
    git(['add', 'manifest/members.yaml'], remoteRepo);
    git(['commit', '-qm', 'assignments back'], remoteRepo);

    const second = await runCLI(['pull'], homeDir, projectRoot);
    expect(second.code, second.output).toBe(0);
    expect(second.output).not.toContain('Already synced');
    expect(deliveredSkills(projectRoot), second.output).toEqual(['teamai']);
    const list = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(JSON.parse(list.output)).toMatchObject({ roles: [], source: 'default' });
  });
});

/**
 * A member with no role of their own holds the `hai` role the team declares, in
 * user and workspace scope alike. A team that stops assigning roles hands role
 * selection back, and that fallback applies from the pull that fetches the
 * deletion.
 */
describe('hai fallback (#1392)', () => {
  const sandboxes: string[] = [];

  afterAll(() => {
    for (const sandbox of sandboxes) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** A team repo declaring `hai`, `frontend` and `backend`, and a role-less member `frank` in `scope`. */
  function setUp(scope: 'user' | 'workspace', members: string | null) {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `teamai-hai-fallback-${scope}-e2e-`));
    sandboxes.push(sandbox);
    const homeDir = path.join(sandbox, 'home');
    const remote = path.join(sandbox, 'remote');
    const root = scope === 'user' ? homeDir : path.join(sandbox, 'project');
    const localRepo = path.join(root, '.teamai', 'team-repo');
    const configFile = path.join(root, '.teamai', 'config.yaml');
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    fs.mkdirSync(homeDir, { recursive: true });

    write(path.join(remote, 'teamai.yaml'), [
      'team: hai-fallback-e2e',
      `repo: ${remote}`,
      'provider: tgit',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '',
    ].join('\n'));
    write(path.join(remote, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: hai',
      '    resources: { knowledge: [hai], skills: [hai] }',
      '  - id: frontend',
      '    resources: { knowledge: [frontend], skills: [frontend] }',
      '  - id: backend',
      '    resources: { knowledge: [backend], skills: [backend] }',
      '',
    ].join('\n'));
    if (members !== null) write(path.join(remote, 'manifest', 'members.yaml'), members);
    for (const namespace of ['hai', 'frontend', 'backend']) {
      write(
        path.join(remote, 'skills', namespace, `${namespace}-only`, 'SKILL.md'),
        `---\nname: ${namespace}-only\ndescription: ${namespace}-only fixture\n---\n\n# ${namespace}-only\n`,
      );
    }
    git(['init', '-q', '-b', 'main'], remote);
    git(['add', '-A'], remote);
    git(['commit', '-qm', 'fixture'], remote);

    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    git(['clone', '-q', remote, localRepo], sandbox);
    write(configFile, [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remote}`,
      'username: frank',
      'updatePolicy: auto',
      ...(scope === 'user' ? ['scope: user'] : ['scope: project', `projectRoot: ${root}`]),
      '',
    ].join('\n'));
    return {
      remote,
      configFile,
      run: (args: string[]) => runCLI(args, homeDir, root),
      delivered: (): string[] => fs.readdirSync(path.join(root, '.claude', 'skills')).sort(),
    };
  }

  // Detection resolves `hai` in memory: its many readers include metadata
  // lookups and dry runs, which must not write the config.
  it('delivers the hai role to a role-less workspace member without writing it', async () => {
    const { run, delivered, configFile } = setUp('workspace', null);
    const before = fs.readFileSync(configFile, 'utf8');

    const pull = await run(['pull', '--force']);
    expect(pull.code, pull.output).toBe(0);
    expect(delivered(), pull.output).toEqual(['hai-only', 'teamai']);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    const list = await run(['roles', 'list', '--json']);
    expect(JSON.parse(list.output)).toMatchObject({ roles: ['hai'], source: 'local' });
  });

  it.each(['user', 'workspace'] as const)('delivers the hai role, not every namespace, on the pull that drops members.yaml (%s)', async (scope) => {
    const { run, delivered, remote } = setUp(scope, 'version: 1\nmembers:\n  frank: [frontend]\ndefault: []\n');

    const first = await run(['pull', '--force']);
    expect(first.code, first.output).toBe(0);
    expect(delivered()).toEqual(['frontend-only', 'teamai']);

    git(['rm', '-q', 'manifest/members.yaml'], remote);
    git(['commit', '-qm', 'stop assigning roles'], remote);

    const second = await run(['pull']);
    expect(second.code, second.output).toBe(0);
    expect(delivered(), second.output).toEqual(['hai-only', 'teamai']);

    const third = await run(['pull']);
    expect(third.code, third.output).toBe(0);
    expect(delivered(), third.output).toEqual(['hai-only', 'teamai']);
    const list = await run(['roles', 'list', '--json']);
    expect(JSON.parse(list.output)).toMatchObject({ roles: ['hai'], source: 'local' });
  });
});

/**
 * `init` builds its config in memory and hands it to the hook, MCP and env
 * reconciliation before any load can overlay it (#1186). Without the
 * assignment, that config is role-less, and a role-less config matches every
 * role-scoped entry — so init would install the hooks the manifest restricts.
 */
describe('assigned roles at init (#1186)', () => {
  let sandbox: string;
  let homeDir: string;

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('applies only the assigned role\'s hooks, and writes no role to the config', async () => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-assigned-init-e2e-'));
    homeDir = path.join(sandbox, 'home');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'remote.git');
    // The git provider wants a URL; `insteadOf` maps it to the bare repo here.
    const url = 'https://git.example.com/team/assigned-init.git';
    const project = path.join(sandbox, 'project');
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.mkdirSync(seed, { recursive: true });
    fs.mkdirSync(project, { recursive: true });

    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    // The `git` provider reads the member's name from git config; alice is the
    // member manifest/members.yaml lists.
    execFileSync('git', ['config', '--global', 'user.name', 'alice'], { env: { ...process.env, HOME: homeDir }, stdio: 'pipe' });
    execFileSync('git', ['config', '--global', 'user.email', 'alice@teamai.test'], { env: { ...process.env, HOME: homeDir }, stdio: 'pipe' });

    write(path.join(seed, 'teamai.yaml'), [
      'team: assigned-init-e2e',
      `repo: ${url}`,
      'provider: git',
      'usageReport: false',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '',
    ].join('\n'));
    write(path.join(seed, 'manifest/roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: frontend',
      '    resources: { knowledge: [], skills: [frontend], hooks: [frontend] }',
      '  - id: backend',
      '    resources: { knowledge: [], skills: [backend], hooks: [backend] }',
      '',
    ].join('\n'));
    write(path.join(seed, 'manifest/members.yaml'), 'version: 1\nmembers:\n  alice: [frontend]\ndefault: []\n');
    write(path.join(seed, 'hooks/frontend/hooks.yaml'), 'hooks:\n  - id: fe-stop\n    event: Stop\n    command: echo frontend-hook\n    description: Frontend\n');
    write(path.join(seed, 'hooks/backend/hooks.yaml'), 'hooks:\n  - id: be-stop\n    event: Stop\n    command: echo backend-hook\n    description: Backend\n');
    write(path.join(seed, 'skills/frontend/frontend-only/SKILL.md'), '# frontend-only\n');
    write(path.join(seed, 'skills/backend/backend-only/SKILL.md'), '# backend-only\n');

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-qm', 'fixture'], seed);
    // -b main: the bare repo's HEAD decides what init clones, and a HEAD on
    // another branch reads as an empty team repo.
    git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
    execFileSync('git', ['config', '--global', `url.${remote}.insteadOf`, url], { env: { ...process.env, HOME: homeDir }, stdio: 'pipe' });
    git(['remote', 'add', 'origin', remote], seed);
    git(['push', '-q', 'origin', 'main'], seed);
    git(['init', '-q', '-b', 'main'], project);

    const init = await runCLI(
      ['init', url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'],
      homeDir,
      project,
    );
    expect(init.code, init.output).toBe(0);
    // No role prompt: the team assigned them, and init says which.
    expect(init.output).toContain('Roles assigned to alice in manifest/members.yaml: frontend');
    // The hooks init applies are the assigned role's alone. A role-less config
    // matches every role-scoped hook, so without the assignment both land here.
    expect(init.output).toContain('fe-stop');
    expect(init.output).not.toContain('be-stop');

    // Nothing of the assignment is written: the config keeps no role at all.
    const saved = fs.readFileSync(path.join(homeDir, '.teamai', 'projects', fs.readdirSync(path.join(homeDir, '.teamai', 'projects'))[0], 'config.yaml'), 'utf8');
    expect(saved).not.toContain('primaryRole');

    const pull = await runCLI(['pull', '--force'], homeDir, project);
    expect(pull.code, pull.output).toBe(0);
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'frontend-only', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'backend-only'))).toBe(false);
  });
});
