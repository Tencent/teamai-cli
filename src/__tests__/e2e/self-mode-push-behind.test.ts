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
  const mergePushAndPull = async (updateCheckout = true): Promise<void> => {
    const [branch] = pushBranches();
    git(['pull', '-q', 'origin', 'main'], teammate);
    git(['fetch', '-q', 'origin', branch], teammate);
    git(['merge', '-q', '--no-ff', '-m', `merge ${branch}`, 'FETCH_HEAD'], teammate);
    git(['push', '-q', 'origin', 'main', `:${branch}`], teammate);
    if (updateCheckout) git(['pull', '-q', '--ff-only', 'origin', 'main'], projectRoot);
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

  it.each([false, true])('refuses agent conversion after an upstream edit, checkout synchronized: %s', async (synced) => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const AGENT = '---\nname: sample\ndescription: A sample agent\n---\n\nSample instructions.\n';
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), AGENT);
    const placed = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);
    expect(placed.output).toContain('Pushed branch');
    await mergePushAndPull();
    expect(fs.readFileSync(active('.teamai/agents/ops/sample.md'), 'utf8')).toBe(AGENT);

    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': `${AGENT}\nTeammate safety instructions.\n` });
    if (synced) { git(['fetch', '-q', 'origin'], projectRoot); git(['merge', '-q', '--no-edit', 'origin/main'], projectRoot); }
    fs.rmSync(active('.teamai/agents/sample.md'));
    fs.writeFileSync(
      active('.teamai/agents/sample.yaml'),
      'name: sample\ndescription: A sample agent\ninstructions: Member replacement instructions.\n',
    );

    const push = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain(
      '.teamai/agents/sample.yaml (pushed to .teamai/agents/ops/sample.yaml) would delete .teamai/agents/ops/sample.md, '
        + 'which changed on origin/main since this machine delivered it.',
    );
    const teamVersion = git(['rev-parse', 'main:.teamai/agents/ops/sample.md'], remote);
    expect(push.output).toContain(
      'carry that change into .teamai/agents/sample.yaml, then run '
        + `\`teamai push --carried .teamai/agents/ops/sample.md@${teamVersion}\` with the other options you used.`,
    );
    expect(pushBranches()).toEqual([]);
    expect(git(['show', 'main:.teamai/agents/ops/sample.md'], remote)).toContain('Teammate safety instructions.');
  });

  it('deletes a placed agent a teammate changed only with --carried naming the version the stop printed', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const AGENT = '---\nname: sample\ndescription: A sample agent\n---\n\nSample instructions.\n';
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), AGENT);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();
    fs.rmSync(active('.teamai/agents/sample.md'));
    fs.writeFileSync(
      active('.teamai/agents/sample.yaml'),
      'name: sample\ndescription: A sample agent\ninstructions: Member replacement instructions.\n',
    );
    const push = ['push', '--all', '--role', 'ops'];
    const teamVersion = (): string => git(['rev-parse', 'main:.teamai/agents/ops/sample.md'], remote);
    const carried = (version: string): string => `.teamai/agents/ops/sample.md@${version}`;

    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': `${AGENT}\nTeammate safety instructions.\n` });
    const first = teamVersion();
    for (const args of [[...push, '--dry-run'], push, push]) {
      const stop = await runCLI(args, projectRoot, home);
      expect(stop.code, stop.output).toBe(2);
      expect(stop.output).toContain(`\`teamai push --carried ${carried(first)}\``);
    }
    const unknown = await runCLI([...push, '--carried', `.teamai/agents/ops/other.md@${first}`], projectRoot, home);
    expect(unknown.code, unknown.output).toBe(2);
    expect(unknown.output).toContain(`--carried .teamai/agents/ops/other.md@${first} names no placed agent file this push stops for.`);

    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': `${AGENT}\nTeammate safety instructions.\nTeammate review step.\n` });
    const second = teamVersion();
    const outdated = await runCLI([...push, '--carried', carried(first)], projectRoot, home);
    expect(outdated.code, outdated.output).toBe(2);
    expect(outdated.output).toContain(`\`teamai push --carried ${carried(second)}\``);
    expect(pushBranches()).toEqual([]);

    git(['pull', '-q', '--ff-only', 'origin', 'main'], projectRoot);
    fs.writeFileSync(
      active('.teamai/agents/sample.yaml'),
      'name: sample\ndescription: A sample agent\ninstructions: |\n  Member replacement instructions.\n'
        + '  Teammate safety instructions.\n  Teammate review step.\n',
    );
    const preview = await runCLI([...push, '--carried', carried(second), '--dry-run'], projectRoot, home);
    expect(preview.code, preview.output).toBe(0);
    expect(preview.output).toContain('Dry run — no changes made');
    expect(pushBranches()).toEqual([]);
    const pushed = await runCLI([...push, '--carried', carried(second)], projectRoot, home);

    expect(pushed.output).toContain('Pushed branch');
    const [branch] = pushBranches();
    expect(git(['diff', '--name-status', 'main', branch], remote)).toContain('D\t.teamai/agents/ops/sample.md');
    expect(git(['show', `${branch}:.teamai/agents/ops/sample.yaml`], remote)).toContain('Teammate review step.');
  });

  it('overwrites a placed agent a teammate changed only with --carried naming the version the stop printed', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const AGENT = '---\nname: sample\ndescription: A sample agent\n---\n\nSample instructions.\n';
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), AGENT);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();
    const push = ['push', '--all', '--role', 'ops'];
    const teamVersion = (): string => git(['rev-parse', 'main:.teamai/agents/ops/sample.md'], remote);
    const carried = (version: string): string => `.teamai/agents/ops/sample.md@${version}`;

    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': `${AGENT}Teammate safety instructions.\n` });
    git(['pull', '-q', '--ff-only', 'origin', 'main'], projectRoot);
    fs.writeFileSync(active('.teamai/agents/sample.md'), `${AGENT}Member instructions.\n`);
    const first = teamVersion();
    for (const args of [[...push, '--dry-run'], push, push]) {
      const stop = await runCLI(args, projectRoot, home);
      expect(stop.code, stop.output).toBe(2);
      expect(stop.output).toContain(
        '.teamai/agents/sample.md (pushed to .teamai/agents/ops/sample.md) would overwrite .teamai/agents/ops/sample.md, '
          + 'which changed on origin/main since this machine delivered it.',
      );
      expect(stop.output).toContain(`\`teamai push --carried ${carried(first)}\``);
    }

    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': `${AGENT}Teammate safety instructions.\nTeammate review step.\n` });
    const second = teamVersion();
    const outdated = await runCLI([...push, '--carried', carried(first)], projectRoot, home);
    expect(outdated.code, outdated.output).toBe(2);
    expect(outdated.output).toContain(`\`teamai push --carried ${carried(second)}\``);
    expect(pushBranches()).toEqual([]);

    git(['pull', '-q', '--ff-only', 'origin', 'main'], projectRoot);
    fs.writeFileSync(
      active('.teamai/agents/sample.md'),
      `${AGENT}Teammate safety instructions.\nTeammate review step.\nMember instructions.\n`,
    );
    const preview = await runCLI([...push, '--carried', carried(second), '--dry-run'], projectRoot, home);
    expect(preview.code, preview.output).toBe(0);
    expect(preview.output).toContain('Dry run — no changes made');
    const retry = await runCLI(push, projectRoot, home);
    expect(retry.code, retry.output).toBe(2);
    expect(pushBranches()).toEqual([]);
    const pushed = await runCLI([...push, '--carried', carried(second)], projectRoot, home);

    expect(pushed.output).toContain('Pushed branch');
    const [branch] = pushBranches();
    const sent = git(['show', `${branch}:.teamai/agents/ops/sample.md`], remote);
    expect(sent).toContain('Teammate review step.');
    expect(sent).toContain('Member instructions.');
  });

  it.each(['edit', 'conversion'])('pushes the next %s of a placed agent after this machine\'s own edit landed', async (next) => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const AGENT = '---\nname: sample\ndescription: A sample agent\n---\n\nSample instructions.\n';
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), AGENT);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();
    fs.writeFileSync(active('.teamai/agents/sample.md'), `${AGENT}First member edit.\n`);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();
    if (next === 'edit') {
      fs.writeFileSync(active('.teamai/agents/sample.md'), `${AGENT}First member edit.\nSecond member edit.\n`);
    } else {
      fs.rmSync(active('.teamai/agents/sample.md'));
      fs.writeFileSync(active('.teamai/agents/sample.yaml'), 'name: sample\ndescription: A sample agent\ninstructions: Second member edit.\n');
    }

    const push = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);

    expect(push.output).toContain('Pushed branch');
    const [branch] = pushBranches();
    const destination = `.teamai/agents/ops/sample.${next === 'edit' ? 'md' : 'yaml'}`;
    expect(git(['show', `${branch}:${destination}`], remote)).toContain('Second member edit.');
  });

  it('stops an edit over a teammate\'s change once an older placement record took the blob of a merged edit', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const AGENT = '---\nname: sample\ndescription: A sample agent\n---\n\nSample instructions.\n';
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), AGENT);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();
    const statePath = path.join(home, '.teamai', 'projects', projectSlug(projectRoot), 'state.json');
    const olderState: Record<string, unknown> = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete olderState.placedAgentSources;
    fs.writeFileSync(statePath, JSON.stringify(olderState));
    fs.writeFileSync(active('.teamai/agents/sample.md'), `${AGENT}First member edit.\n`);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();

    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': `${AGENT}First member edit.\nTeammate safety instructions.\n` });
    git(['pull', '-q', '--ff-only', 'origin', 'main'], projectRoot);
    fs.writeFileSync(active('.teamai/agents/sample.md'), `${AGENT}First member edit.\nSecond member edit.\n`);
    const push = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain(
      '.teamai/agents/sample.md (pushed to .teamai/agents/ops/sample.md) would overwrite .teamai/agents/ops/sample.md, '
        + 'which changed on origin/main since this machine delivered it.',
    );
    expect(pushBranches()).toEqual([]);
  });

  it('stops a --carried agent conversion when a teammate added its destination file', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const AGENT = '---\nname: sample\ndescription: A sample agent\n---\n\nSample instructions.\n';
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), AGENT);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();
    teammateLandsOnMain({
      '.teamai/agents/ops/sample.md': `${AGENT}\nTeammate safety instructions.\n`,
      '.teamai/agents/ops/sample.yaml': 'name: sample\ndescription: A sample agent\ninstructions: Team YAML instructions.\n',
    });
    fs.rmSync(active('.teamai/agents/sample.md'));
    fs.writeFileSync(
      active('.teamai/agents/sample.yaml'),
      'name: sample\ndescription: A sample agent\ninstructions: |\n  Member replacement instructions.\n  Teammate safety instructions.\n',
    );
    const teamVersion = git(['rev-parse', 'main:.teamai/agents/ops/sample.md'], remote);

    const push = await runCLI(
      ['push', '--all', '--role', 'ops', '--carried', `.teamai/agents/ops/sample.md@${teamVersion}`], projectRoot, home,
    );

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain(
      '.teamai/agents/sample.yaml (pushed to .teamai/agents/ops/sample.yaml) changed both here and on origin/main',
    );
    expect(pushBranches()).toEqual([]);
  });

  it('rejects --carried for an agent conversion this push leaves out', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    const AGENT = '---\nname: sample\ndescription: A sample agent\n---\n\nSample instructions.\n';
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), AGENT);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();
    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': `${AGENT}\nTeammate safety instructions.\n` });
    fs.rmSync(active('.teamai/agents/sample.md'));
    fs.writeFileSync(active('.teamai/agents/sample.yaml'), 'name: sample\ndescription: A sample agent\ninstructions: Member.\n');
    fs.mkdirSync(active('.teamai/skills/independent'), { recursive: true });
    fs.writeFileSync(active('.teamai/skills/independent/SKILL.md'), '---\nname: independent\ndescription: Independent skill\n---\n# Independent\n');
    const carried = `.teamai/agents/ops/sample.md@${git(['rev-parse', 'main:.teamai/agents/ops/sample.md'], remote)}`;

    const push = await runCLI(
      ['push', '--all', '--skill', '.teamai/skills/independent', '--shared', '--carried', carried], projectRoot, home,
    );

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain(`--carried ${carried} names no placed agent file this push stops for. Nothing was pushed.`);
    expect(pushBranches()).toEqual([]);
  });

  it.each([false, true])('rejects --carried when no resource goes out, teamai.yaml changed: %s', async (configChanged) => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    if (configChanged) fs.appendFileSync(active('.teamai/teamai.yaml'), '\n# pending config change\n');
    const carried = `.teamai/agents/ops/sample.md@${'a'.repeat(40)}`;

    const push = await runCLI(['push', '--all', '--carried', carried], projectRoot, home);

    expect(push.code, push.output).toBe(2);
    expect(push.output).toContain(`--carried ${carried} names no placed agent file this push stops for. Nothing was pushed.`);
    expect(pushBranches()).toEqual([]);
  });

  it('publishes an edited root agent re-added after the placed agent was deleted', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), '---\nname: sample\ndescription: Sample\n---\nOriginal.\n');
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull(false);
    git(['rm', '.teamai/agents/ops/sample.md'], teammate);
    fs.mkdirSync(path.join(teammate, '.teamai/agents'), { recursive: true });
    fs.writeFileSync(path.join(teammate, '.teamai/agents/sample.yaml'), 'name: sample\ndescription: Sample\ninstructions: Re-added.\n');
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', 'replace placed agent with shared root'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    fs.rmSync(active('.teamai/agents/sample.md'));
    git(['fetch', '-q', 'origin'], projectRoot);
    git(['merge', '-q', '--no-edit', 'origin/main'], projectRoot);
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    fs.writeFileSync(active('.teamai/agents/sample.yaml'), 'name: sample\ndescription: Sample\ninstructions: Member edit after re-add.\n');
    const pushed = await runCLI(['push', '--all'], projectRoot, home);
    expect(pushed.output).toContain('Pushed branch');
    const [branch] = pushBranches();
    expect(git(['show', `${branch}:.teamai/agents/sample.yaml`], remote)).toContain('Member edit after re-add.');
  });

  it('does not republish a delivered tool copy after the retired root copy is deleted', async () => {
    const config = path.join(home, '.teamai/projects', projectSlug(projectRoot), 'config.yaml');
    fs.appendFileSync(config, 'additionalRoles: [ops]\n');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(active('.claude'), { recursive: true });
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), '---\nname: sample\ndescription: Sample\n---\nOriginal.\n');
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull();
    fs.unlinkSync(active('.teamai/agents/sample.md'));
    const delivered = await runCLI(['pull', '--force'], projectRoot, home);
    expect(delivered.code, delivered.output).toBe(0);
    expect(fs.existsSync(active('.claude/agents/sample.md')), delivered.output + '\n' + JSON.stringify(fs.readdirSync(active('.claude'), { recursive: true }))).toBe(true);
    git(['rm', '.teamai/agents/ops/sample.md'], teammate);
    git(['commit', '-q', '-m', 'remove placed agent'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    fs.appendFileSync(active('.claude/agents/sample.md'), '\nMember edit in the leftover copy.\n');
    const pushed = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);
    expect(pushed.output).not.toContain('Pushed branch');
    expect(pushBranches()).toEqual([]);
  });

  it('names the recreated namespace source and allows editing it without republishing the retired root copy', async () => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    const original = '---\nname: sample\ndescription: Sample\n---\nOriginal.\n';
    fs.writeFileSync(active('.teamai/agents/sample.md'), original);
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull(false);
    git(['rm', '.teamai/agents/ops/sample.md'], teammate);
    git(['commit', '-q', '-m', 'remove placed agent'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    await runCLI(['push', '--all', '--dry-run'], projectRoot, home);
    teammateLandsOnMain({ '.teamai/agents/ops/sample.md': original + 'Restored by teammate.\n' });
    git(['fetch', '-q', 'origin'], projectRoot);
    git(['merge', '-q', '--no-edit', 'origin/main'], projectRoot);
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    fs.writeFileSync(active('.teamai/agents/sample.md'), original + 'Restored by teammate.\nMember edit after restore.\n');
    const held = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);
    expect(held.output).not.toContain('Pushed branch');
    expect(held.output).toContain('edit the restored .teamai/agents/ops/sample.md source directly');
    fs.writeFileSync(active('.teamai/agents/ops/sample.md'), original + 'Restored by teammate.\nMember edit after restore.\n');
    const pushed = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);
    expect(pushed.output).toContain('Pushed branch');
    const [branch] = pushBranches();
    expect(git(['show', `${branch}:.teamai/agents/ops/sample.md`], remote)).toContain('Member edit after restore.');
    expect(git(['ls-tree', '-r', '--name-only', branch], remote)).not.toContain('.teamai/agents/sample.yaml');
  });

  it.each([false, true])('converts a placed agent behind its own merge, deleted upstream: %s', async (deleted) => {
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    fs.mkdirSync(active('.teamai/agents'), { recursive: true });
    fs.writeFileSync(active('.teamai/agents/sample.md'), '---\nname: sample\ndescription: Sample\n---\nOriginal instructions.\n');
    expect((await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home)).output).toContain('Pushed branch');
    await mergePushAndPull(false);
    if (deleted) {
      git(['rm', '.teamai/agents/ops/sample.md'], teammate);
      git(['commit', '-q', '-m', 'remove placed agent'], teammate);
      git(['push', '-q', 'origin', 'main'], teammate);
      fs.mkdirSync(active('.claude/agents'), { recursive: true });
      fs.writeFileSync(active('.claude/agents/sample.md'), '---\nname: sample\ndescription: Sample\n---\nRemaining tool copy.\n');
    }
    fs.rmSync(active('.teamai/agents/sample.md'));
    fs.writeFileSync(active('.teamai/agents/sample.yaml'), 'name: sample\ndescription: Sample\ninstructions: Converted instructions.\n');
    const push = await runCLI(['push', '--all', '--role', 'ops'], projectRoot, home);
    if (deleted) {
      const stateFile = path.join(home, '.teamai/projects', projectSlug(projectRoot), 'state.json');
      expect(push.output, fs.readFileSync(stateFile, 'utf8')).not.toContain('Pushed branch');
      expect(push.output).toContain('removed from the team');
      expect(pushBranches()).toEqual([]);
    } else {
      expect(push.code, push.output).toBe(1);
      expect(push.output).toContain('Pushed branch');
      const [branch] = pushBranches();
      expect(git(['diff', '--name-status', 'main', branch], remote)).toContain('D\t.teamai/agents/ops/sample.md');
      expect(git(['show', `${branch}:.teamai/agents/ops/sample.yaml`], remote)).toContain('Converted instructions.');
    }
  });
});
