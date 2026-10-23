/**
 * E2E: in single-repo mode push compares the member's `.teamai/` with a fresh
 * checkout of the default branch. A checkout behind that branch holds the
 * older version of every team file a teammate changed since, and push must
 * neither offer it as the member's edit nor push it over the teammate's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../../utils/partition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
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

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

describe('single-repo push from a checkout behind the default branch', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let teammate: string;
  let remote: string;

  const README = '# Shared guide\n';
  const ENV = 'variables:\n  - key: API_BASE\n    value: https://old.example.com\n';
  const TEAMMATE_README = `${README}\nA teammate's fix.\n`;
  const TEAMMATE_ENV = 'variables:\n  - key: API_BASE\n    value: https://new.example.com\n';
  const active = (file: string) => path.join(projectRoot, ...file.split('/'));

  beforeEach(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-self-behind-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    teammate = path.join(sandbox, 'teammate');
    remote = path.join(sandbox, 'origin.git');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.teamai', 'docs'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.teamai', 'env'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'teamai.yaml'), [
      'team: self-behind-e2e',
      'repo: https://git.example.com/team/project.git',
      'provider: git',
      'mode: self',
      'usageReport: false',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectRoot, '.teamai', '.gitignore'), 'config.yaml\nstate.json\n');
    fs.writeFileSync(active('.teamai/docs/README.md'), README);
    fs.writeFileSync(active('.teamai/env/env.yaml'), ENV);
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);
    git(['clone', '-q', '--bare', projectRoot, remote], sandbox);
    git(['remote', 'add', 'origin', remote], projectRoot);
    git(['fetch', '-q', 'origin'], projectRoot);
    git(['clone', '-q', remote, teammate], sandbox);

    const partition = path.join(home, '.teamai', 'projects', projectSlug(projectRoot));
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'anchor'), `${projectRoot}\n`);
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      '  kind: self',
      `  localPath: ${path.join(projectRoot, '.teamai')}`,
      `  remote: ${remote}`,
      `  businessRepoRoot: ${projectRoot}`,
      'username: ci-self-behind',
      'updatePolicy: skip',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** A teammate lands these files on the default branch; the member does not merge it. */
  const teammateLandsOnMain = (files: Record<string, string>): void => {
    git(['pull', '-q', 'origin', 'main'], teammate);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(teammate, file)), { recursive: true });
      fs.writeFileSync(path.join(teammate, file), content);
    }
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', 'teammate fixes'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
  };
  const pushBranches = (): string[] =>
    git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], remote).split('\n').filter(Boolean);
  /** The team merges the member's only push branch; the member takes it with git and `teamai pull`. */
  const mergePushAndPull = async (): Promise<void> => {
    const [branch] = pushBranches();
    git(['pull', '-q', 'origin', 'main'], teammate);
    git(['fetch', '-q', 'origin', branch], teammate);
    git(['merge', '-q', '--no-ff', '-m', `merge ${branch}`, 'FETCH_HEAD'], teammate);
    git(['push', '-q', 'origin', 'main', `:${branch}`], teammate);
    git(['pull', '-q', '--ff-only', 'origin', 'main'], projectRoot);
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
  };

  it('pushes only the member\'s new file and keeps what a teammate changed on the default branch', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    teammateLandsOnMain({ '.teamai/docs/README.md': TEAMMATE_README, '.teamai/env/env.yaml': TEAMMATE_ENV });
    fs.writeFileSync(active('.teamai/docs/handbook.md'), '# Handbook\n');

    const push = await runCLI(['push', '--all'], projectRoot, home);

    // A generic git host takes the branch but no pull request, which exits 1.
    expect(push.code, push.output).toBe(1);
    expect(push.output).toContain('Pushed branch');
    expect(push.output).not.toContain('README.md (modified)');
    expect(push.output).not.toContain('env.yaml (modified)');
    expect(push.output).toContain('.teamai/docs/README.md');
    expect(push.output).toContain('git pull');
    const branches = pushBranches();
    expect(branches).toHaveLength(1);
    expect(git(['diff', '--name-only', 'main', branches[0]], remote).split('\n')).toEqual(['.teamai/docs/handbook.md']);
    expect(git(['show', `${branches[0]}:.teamai/docs/README.md`], remote)).toBe(TEAMMATE_README.trim());
    expect(fs.readFileSync(active('.teamai/docs/README.md'), 'utf8')).toBe(README);
  });

  it('refuses with exit 2, pushing nothing, when the member and a teammate both changed a team file', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    teammateLandsOnMain({ '.teamai/docs/README.md': TEAMMATE_README });
    fs.writeFileSync(active('.teamai/docs/README.md'), `${README}\nThe member's edit.\n`);
    fs.writeFileSync(active('.teamai/docs/handbook.md'), '# Handbook\n');

    const push = await runCLI(['push', '--all'], projectRoot, home);

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain('.teamai/docs/README.md');
    expect(push.output).toContain('git pull');
    expect(pushBranches()).toEqual([]);
    expect(git(['show', 'main:.teamai/docs/README.md'], remote)).toBe(TEAMMATE_README.trim());
  });

  it.each(['SKILL.md', 'references/guide.md', 'references/deleted.md', 'different files'])('refuses a stale skill push that would overwrite upstream changes: %s', async (changed) => {
    const skill = '.teamai/skills/demo';
    const body = '---\nname: demo\ndescription: Demo\n---\nBase skill.\n';
    fs.mkdirSync(active(`${skill}/references`), { recursive: true });
    fs.writeFileSync(active(`${skill}/SKILL.md`), body);
    fs.writeFileSync(active(`${skill}/references/guide.md`), 'Base reference.\n');
    fs.writeFileSync(active(`${skill}/references/deleted.md`), 'Base deletion candidate.\n');
    git(['add', '.teamai/skills'], projectRoot);
    git(['commit', '-q', '-m', 'seed skill'], projectRoot);
    git(['push', '-q', 'origin', 'main'], projectRoot);
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const file = changed === 'different files' ? 'references/guide.md' : changed;
    const upstream = file === 'SKILL.md' ? `${body}Teammate fix.\n` : 'Teammate reference fix.\n';
    teammateLandsOnMain({ [`${skill}/${file}`]: upstream });
    if (changed === 'references/deleted.md') fs.unlinkSync(active(`${skill}/${file}`));
    else if (changed === 'different files') fs.appendFileSync(active(`${skill}/SKILL.md`), 'Author edit.\n');
    else fs.appendFileSync(active(`${skill}/${file}`), 'Author edit.\n');

    const push = await runCLI(['push', '--all'], projectRoot, home);
    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain('.teamai/skills/demo');
    expect(push.output).toContain('git pull');
    expect(pushBranches()).toEqual([]);
    expect(git(['show', `main:${skill}/${file}`], remote)).toBe(upstream.trim());
  });

  it('allows a skill edit after its copy already includes the changed upstream file', async () => {
    const skill = '.teamai/skills/demo';
    const body = '---\nname: demo\ndescription: Demo\n---\nBase skill.\n';
    fs.mkdirSync(active(`${skill}/references`), { recursive: true });
    fs.writeFileSync(active(`${skill}/SKILL.md`), body);
    fs.writeFileSync(active(`${skill}/references/guide.md`), 'Base reference.\n');
    git(['add', '.teamai/skills'], projectRoot);
    git(['commit', '-q', '-m', 'seed skill'], projectRoot);
    git(['push', '-q', 'origin', 'main'], projectRoot);
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    teammateLandsOnMain({ [`${skill}/references/guide.md`]: 'Teammate fix.\n' });
    fs.writeFileSync(active(`${skill}/references/guide.md`), 'Teammate fix.\n');
    fs.appendFileSync(active(`${skill}/SKILL.md`), 'Author edit.\n');

    const push = await runCLI(['push', '--all'], projectRoot, home);
    expect(push.code, push.output).toBe(1); // Generic git provider prints a branch, without opening a PR.
    expect(push.output).toContain('Pushed branch');
    const [branch] = pushBranches();
    expect(git(['show', `${branch}:${skill}/references/guide.md`], remote)).toBe('Teammate fix.');
    expect(git(['show', `${branch}:${skill}/SKILL.md`], remote)).toContain('Author edit.');
  });

  it('pushes a selected skill when a file it leaves out changed both here and on the default branch', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    teammateLandsOnMain({ '.teamai/env/env.yaml': TEAMMATE_ENV });
    fs.writeFileSync(active('.teamai/env/env.yaml'), 'variables:\n  - key: API_BASE\n    value: https://mine.example.com\n');
    const skill = active('.teamai/skills/new-skill');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: new-skill\ndescription: A new skill\n---\n\nBody.\n');

    const push = await runCLI(['push', '--skill', skill], projectRoot, home);

    expect(push.code, push.output).toBe(1);
    expect(push.output).toContain('Pushed branch');
    const branches = pushBranches();
    expect(branches).toHaveLength(1);
    const pushed = git(['diff', '--name-only', 'main', branches[0]], remote).split('\n');
    expect(pushed).toContain('.teamai/skills/new-skill/SKILL.md');
    expect(pushed.filter((file) => !file.startsWith('.teamai/skills/new-skill/'))).toEqual([]);
  });

  it('refuses with exit 2 when this checkout lacks the history to tell who changed a team file', async () => {
    git(['checkout', '-q', '-b', 'feature'], projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'business.txt'), 'feature work\n');
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'feature work'], projectRoot);
    git(['push', '-q', 'origin', 'feature'], projectRoot);
    teammateLandsOnMain({ '.teamai/docs/README.md': TEAMMATE_README });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    git(['clone', '-q', '--depth=1', '--branch', 'feature', '--no-single-branch', `file://${remote}`, projectRoot], sandbox);
    fs.writeFileSync(active('.teamai/docs/handbook.md'), '# Handbook\n');

    const push = await runCLI(['push', '--all'], projectRoot, home);

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain('.teamai/docs/README.md');
    expect(push.output).toContain('git fetch --unshallow origin');
    expect(pushBranches()).toEqual([]);

    git(['fetch', '-q', '--unshallow', 'origin'], projectRoot);
    const retry = await runCLI(['push', '--all'], projectRoot, home);

    expect(retry.code, retry.output).toBe(1);
    const branches = pushBranches();
    expect(branches).toHaveLength(1);
    expect(git(['diff', '--name-only', 'main', branches[0]], remote).split('\n')).toEqual(['.teamai/docs/handbook.md']);
  });

  it('refuses with exit 2, without suggesting an unshallow fetch, when a full checkout shares no history with the default branch', async () => {
    git(['checkout', '-q', '--orphan', 'rewritten'], teammate);
    fs.writeFileSync(path.join(teammate, '.teamai', 'docs', 'README.md'), TEAMMATE_README);
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', 'rewritten history'], teammate);
    git(['push', '-q', '--force', 'origin', 'rewritten:main'], teammate);
    fs.writeFileSync(active('.teamai/docs/handbook.md'), '# Handbook\n');

    const push = await runCLI(['push', '--all'], projectRoot, home);

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain('.teamai/docs/README.md');
    expect(push.output).toContain('shares no history with origin/main');
    expect(push.output).not.toContain('--unshallow');
    expect(pushBranches()).toEqual([]);
  });

  it('refuses with exit 2 when a teammate changed the namespaced file a root rule is pushed to', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const RULE = '# Ops rule\n';
    fs.mkdirSync(active('.teamai/rules'), { recursive: true });
    fs.writeFileSync(active('.teamai/rules/ops-rule.md'), RULE);
    const placed = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);
    expect(placed.output).toContain('Pushed branch');
    await mergePushAndPull();
    expect(fs.readFileSync(active('.teamai/rules/ops/ops-rule.md'), 'utf8')).toBe(RULE);

    teammateLandsOnMain({ '.teamai/rules/ops/ops-rule.md': `${RULE}\nA teammate's line.\n` });
    fs.writeFileSync(active('.teamai/rules/ops-rule.md'), `${RULE}\nThe member's line.\n`);

    const push = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain('.teamai/rules/ops-rule.md');
    expect(pushBranches()).toEqual([]);
    expect(git(['show', 'main:.teamai/rules/ops/ops-rule.md'], remote)).toContain('A teammate\'s line.');
  });

  it('pushes an edit made on a tool copy that push already brought up to the default branch', async () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(active('.claude'), { recursive: true });
    const RULE = '# Foo rule\n';
    teammateLandsOnMain({ '.teamai/rules/foo.md': RULE });
    git(['pull', '-q', '--ff-only', 'origin', 'main'], projectRoot);
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    teammateLandsOnMain({ '.teamai/rules/foo.md': `${RULE}\nTeammate line.\n` });
    expect((await runCLI(['push', '--all', '--dry-run'], projectRoot, home)).code).toBe(0);
    expect(fs.readFileSync(active('.claude/rules/foo.md'), 'utf8')).toContain('Teammate line.');
    fs.appendFileSync(active('.claude/rules/foo.md'), '\nMember line.\n');

    const push = await runCLI(['push', '--all'], projectRoot, home);

    expect(push.code, push.output).toBe(1);
    const branches = pushBranches();
    expect(branches).toHaveLength(1);
    const pushed = git(['show', `${branches[0]}:.teamai/rules/foo.md`], remote);
    expect(pushed).toContain('Teammate line.');
    expect(pushed).toContain('Member line.');
  });

  it('refuses with exit 2 when the agent file a format change removes changed on the default branch', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const AGENT = '---\nname: sample\ndescription: A sample agent\n---\n\nSample instructions.\n';
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), AGENT);
    const placed = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);
    expect(placed.output).toContain('Pushed branch');
    await mergePushAndPull();
    expect(fs.readFileSync(active('.teamai/agents/ops/sample.md'), 'utf8')).toBe(AGENT);

    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': `${AGENT}\nTeammate safety instructions.\n` });
    fs.rmSync(active('.teamai/agents/sample.md'));
    fs.writeFileSync(
      active('.teamai/agents/sample.yaml'),
      'name: sample\ndescription: A sample agent\ninstructions: Member replacement instructions.\n',
    );

    const push = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain(
      '.teamai/agents/sample.yaml (pushed to .teamai/agents/ops/sample.yaml) would delete .teamai/agents/ops/sample.md, '
        + 'which changed on origin/main since this checkout branched from it.',
    );
    expect(push.output).toContain('carry that change into .teamai/agents/sample.yaml');
    expect(pushBranches()).toEqual([]);
    expect(git(['show', 'main:.teamai/agents/ops/sample.md'], remote)).toContain('Teammate safety instructions.');
  });
});
