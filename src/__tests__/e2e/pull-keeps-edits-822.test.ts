/**
 * E2E (#822 item 5): pull keeps a skill, rule or agent the member changed
 * since teamai delivered it, instead of overwriting it.
 *
 * Pull records the sha256 of the bytes it writes at each destination in the
 * checkout's record. A copy is edited when it has a record and no longer
 * matches it; it is kept and named, per tool, while the other tools' copies
 * update. A copy teamai has no record of (the first pull on this version) is
 * overwritten as before, and protected from then on.
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

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const SKILL_MD = '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n';
const agentYaml = (instructions: string): string => [
  'name: team-helper',
  'description: Team helper fixture',
  'targets:',
  '  - claude',
  '  - cursor',
  'instructions: |',
  `  ${instructions}`,
  '',
].join('\n');

describe('pull keeps a delivered copy the member changed (#822 item 5)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let teammate: string;

  const claudeSkill = () => path.join(projectRoot, '.claude', 'skills', 'team-skill');
  const claudeScript = () => path.join(claudeSkill(), 'scripts', 'run.sh');
  const claudeRule = () => path.join(projectRoot, '.claude', 'rules', 'team-rule.md');
  const cursorRule = () => path.join(projectRoot, '.cursor', 'rules', 'team-rule.mdc');
  const claudeAgent = () => path.join(projectRoot, '.claude', 'agents', 'team-helper.md');
  const cursorAgent = () => path.join(projectRoot, '.cursor', 'agents', 'team-helper.md');
  const cursorScript = () => path.join(projectRoot, '.cursor', 'skills', 'team-skill', 'scripts', 'run.sh');
  const statePath = () => path.join(home, '.teamai', 'projects', projectSlug(projectRoot), 'state.json');
  const read = (file: string) => fs.readFileSync(file, 'utf8');

  beforeEach(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue822-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    teammate = path.join(sandbox, 'teammate');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(seed, 'skills', 'team-skill', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: issue-822-e2e\nrepo: https://example.com/team.git\nprovider: tgit\n');
    fs.writeFileSync(path.join(seed, 'skills', 'team-skill', 'SKILL.md'), SKILL_MD);
    fs.writeFileSync(path.join(seed, 'skills', 'team-skill', 'scripts', 'run.sh'), 'echo one\n');
    fs.writeFileSync(path.join(seed, 'rules', 'team-rule.md'), '# Team rule\n\nVersion one.\n');
    fs.writeFileSync(path.join(seed, 'agents', 'team-helper.yaml'), agentYaml('Version one.'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, teammate], sandbox);

    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.teamai/\n.cursor/\n.claude/\n');
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ci-822',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude, cursor]',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const pull = async (...flags: string[]): Promise<string> => {
    const r = await runCLI(['pull', ...flags], projectRoot, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  /** A teammate's commit to the team repo, pushed to its remote. */
  const teamCommit = (change: (repo: string) => void): void => {
    git(['pull', '-q'], teammate);
    change(teammate);
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', 'teammate'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
  };
  const teamUpdatesAll = (repo: string): void => {
    fs.writeFileSync(path.join(repo, 'skills', 'team-skill', 'scripts', 'run.sh'), 'echo two\n');
    fs.writeFileSync(path.join(repo, 'rules', 'team-rule.md'), '# Team rule\n\nVersion two.\n');
    fs.writeFileSync(path.join(repo, 'agents', 'team-helper.yaml'), agentYaml('Version two.'));
  };
  const editClaudeCopies = (): void => {
    fs.writeFileSync(claudeScript(), 'echo mine\n');
    fs.writeFileSync(claudeRule(), '# Team rule\n\nMy version.\n');
    fs.appendFileSync(claudeAgent(), '\nMy extra instruction.\n');
  };

  it('updates every copy nobody edited when the team changes it', async () => {
    await pull();
    teamCommit(teamUpdatesAll);

    const output = await pull();

    expect(output).not.toContain('Kept');
    expect(read(claudeScript())).toBe('echo two\n');
    expect(read(claudeRule())).toContain('Version two.');
    expect(read(cursorRule())).toContain('Version two.');
    expect(read(claudeAgent())).toContain('Version two.');
    expect(read(cursorAgent())).toContain('Version two.');
  });

  it('keeps an edited copy on a forced full sync of an unchanged team repo, and restores one the member deleted', async () => {
    await pull();
    editClaudeCopies();
    const agentEdit = read(claudeAgent());

    const output = await pull('--force');

    expect(read(claudeScript())).toBe('echo mine\n');
    expect(read(claudeRule())).toContain('My version.');
    expect(read(claudeAgent())).toBe(agentEdit);
    for (const kept of [claudeSkill(), claudeRule(), claudeAgent()]) {
      expect(output).toContain(`Kept ${kept}: you changed it since teamai delivered it. Share it with \`teamai push\``);
    }
    expect(output).not.toContain('has changed since');

    fs.rmSync(claudeSkill(), { recursive: true });
    fs.rmSync(claudeRule());
    const restored = await pull('--force');
    expect(read(claudeScript())).toBe('echo one\n');
    expect(read(claudeRule())).toContain('Version one.');
    expect(restored).not.toContain(`Kept ${claudeSkill()}`);
    expect(restored).not.toContain(`Kept ${claudeRule()}`);
    expect(restored).toContain(`Kept ${claudeAgent()}`);
  });

  it('keeps an edited copy the team changed since and warns, while the other tools\' copies update', async () => {
    await pull();
    editClaudeCopies();
    const agentEdit = read(claudeAgent());
    teamCommit(teamUpdatesAll);

    const output = await pull();

    expect(read(claudeScript())).toBe('echo mine\n');
    expect(read(claudeRule())).toContain('My version.');
    expect(read(claudeAgent())).toBe(agentEdit);
    expect(output).toContain(`Kept ${claudeSkill()}: you changed it, and the team version (skills/team-skill) has changed since.`);
    expect(output).toContain(`Kept ${claudeRule()}: you changed it, and the team version (rules/team-rule.md) has changed since.`);
    expect(output).toContain(`Kept ${claudeAgent()}: you changed it, and the team version (agents/team-helper.yaml) has changed since.`);
    // Per tool: the Cursor render of the same rule and agent is not the member's, so it updates.
    expect(read(cursorRule())).toContain('Version two.');
    expect(read(cursorAgent())).toContain('Version two.');
    expect(read(cursorScript())).toBe('echo two\n');
  });

  const pushDryRun = async (): Promise<string> => {
    const r = await runCLI(['push', '--dry-run'], projectRoot, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };
  const teamChangedWarning = (relPath: string, dest: string): string => (
    `The team changed ${relPath} since teamai delivered ${dest}; pushing replaces that change unless you merged it.`
  );

  it('warns at push about a kept copy the team changed since, after a silent pull kept it', async () => {
    await pull();
    editClaudeCopies();
    teamCommit(teamUpdatesAll);
    // The SessionStart pull: it keeps the copies and prints nothing.
    await pull('--silent');

    const output = await pushDryRun();

    expect(output).toContain(teamChangedWarning('skills/team-skill', claudeSkill()));
    expect(output).toContain(teamChangedWarning('rules/team-rule.md', claudeRule()));
    expect(output).toContain(teamChangedWarning('agents/team-helper.yaml', claudeAgent()));
    expect(output).not.toContain(`delivered ${cursorRule()}`);
  });

  it('warns at push once the team amends a pushed copy, and not while the team is unchanged', async () => {
    await pull();
    fs.writeFileSync(claudeRule(), '# Team rule\n\nMy version.\n');
    expect(await pushDryRun()).not.toContain('The team changed');

    // The review amends the member's change before it merges.
    teamCommit((repo) => fs.writeFileSync(path.join(repo, 'rules', 'team-rule.md'), '# Team rule\n\nMy version, amended.\n'));
    await pull();

    expect(await pushDryRun()).toContain(teamChangedWarning('rules/team-rule.md', claudeRule()));
  });

  it('names the copies --dry-run would keep and writes nothing', async () => {
    await pull();
    editClaudeCopies();
    teamCommit(teamUpdatesAll);
    const stateBefore = read(statePath());
    const cursorRuleBefore = read(cursorRule());

    const output = await pull('--dry-run');

    for (const kept of [claudeSkill(), claudeRule(), claudeAgent()]) {
      expect(output).toContain(`[dry-run] Would keep ${kept}: you changed it since teamai delivered it.`);
    }
    expect(output).not.toContain(`Would keep ${cursorRule()}`);
    expect(read(statePath())).toBe(stateBefore);
    expect(read(cursorRule())).toBe(cursorRuleBefore);
    expect(read(claudeScript())).toBe('echo mine\n');
  });

  it('keeps an edited copy of a resource the team removed, and removes the untouched copies', async () => {
    await pull();
    fs.writeFileSync(claudeScript(), 'echo mine\n');
    fs.writeFileSync(claudeRule(), '# Team rule\n\nMy version.\n');
    fs.appendFileSync(claudeAgent(), '\nMy extra instruction.\n');
    teamCommit((repo) => {
      fs.rmSync(path.join(repo, 'skills', 'team-skill'), { recursive: true });
      fs.rmSync(path.join(repo, 'rules', 'team-rule.md'));
      fs.rmSync(path.join(repo, 'agents', 'team-helper.yaml'));
      fs.writeFileSync(path.join(repo, 'skills', '.removed'), 'team-skill\n');
      fs.writeFileSync(path.join(repo, 'rules', '.removed'), 'team-rule\n');
      fs.writeFileSync(path.join(repo, 'agents', '.removed'), 'team-helper\n');
    });

    const output = await pull();

    expect(read(claudeScript())).toBe('echo mine\n');
    expect(read(claudeRule())).toContain('My version.');
    expect(output).toContain(`Kept ${claudeSkill()}: the team removed team-skill, but you changed this copy.`);
    expect(output).toContain(`Kept ${claudeRule()}: the team removed team-rule, but you changed this copy.`);
    expect(output).toContain(`Kept ${claudeAgent()}: the team removed team-helper, but you changed this copy.`);
    expect(read(claudeAgent())).toContain('My extra instruction.');
    expect(fs.existsSync(cursorScript())).toBe(false);
    expect(fs.existsSync(cursorRule())).toBe(false);
    expect(fs.existsSync(cursorAgent())).toBe(false);
  });

  it('keeps an edited copy of a rule the team deleted without a tombstone, and removes the untouched one', async () => {
    await pull();
    fs.writeFileSync(claudeRule(), '# Team rule\n\nMy version.\n');
    teamCommit((repo) => {
      fs.rmSync(path.join(repo, 'rules', 'team-rule.md'));
      fs.writeFileSync(path.join(repo, 'rules', 'other-rule.md'), '# Other rule\n');
    });

    const output = await pull();

    expect(read(claudeRule())).toContain('My version.');
    expect(output).toContain(`Kept ${claudeRule()}: teamai no longer delivers team-rule here, but you changed this copy.`);
    expect(fs.existsSync(cursorRule())).toBe(false);
  });

  it('keeps another worktree\'s record of what it delivered through a forced full sync', async () => {
    await pull();
    const worktree = path.join(sandbox, 'wt');
    git(['worktree', 'add', '-q', worktree, '-b', 'wt'], projectRoot);
    fs.mkdirSync(path.join(worktree, '.claude'), { recursive: true });
    const inWorktree = async (): Promise<string> => {
      const r = await runCLI(['pull'], worktree, home);
      expect(r.code, r.output).toBe(0);
      return r.output;
    };
    await inWorktree();
    const worktreeRule = path.join(worktree, '.claude', 'rules', 'team-rule.md');
    fs.writeFileSync(worktreeRule, '# Team rule\n\nMy version.\n');
    // What `roles set`, `projects set` and `skill exclude` do: clear the shared
    // revision, so the next pull resets every other checkout's record.
    const state = JSON.parse(read(statePath())) as { lastPullRev: string | null };
    state.lastPullRev = null;
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    await pull();
    teamCommit(teamUpdatesAll);

    const output = await inWorktree();

    expect(read(worktreeRule)).toContain('My version.');
    expect(output).toContain(`Kept ${worktreeRule}: you changed it, and the team version (rules/team-rule.md) has changed since.`);
  });

  it('overwrites an edited copy teamai has no record of, as before, and protects it from then on', async () => {
    await pull();
    // The state an older CLI leaves: a checkout record without `delivered`.
    const state = JSON.parse(read(statePath())) as { lastPullByWorkspace: Record<string, { delivered?: unknown }> };
    for (const record of Object.values(state.lastPullByWorkspace)) delete record.delivered;
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    fs.writeFileSync(claudeRule(), '# Team rule\n\nMy version.\n');
    teamCommit(teamUpdatesAll);

    const upgraded = await pull();

    expect(upgraded).not.toContain('Kept');
    expect(read(claudeRule())).toContain('Version two.');

    fs.writeFileSync(claudeRule(), '# Team rule\n\nMy version again.\n');
    teamCommit((repo) => fs.writeFileSync(path.join(repo, 'rules', 'team-rule.md'), '# Team rule\n\nVersion three.\n'));
    const protectedPull = await pull();
    expect(read(claudeRule())).toContain('My version again.');
    expect(protectedPull).toContain(`Kept ${claudeRule()}: you changed it, and the team version (rules/team-rule.md) has changed since.`);
  });
});
