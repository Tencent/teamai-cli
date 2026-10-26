import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadV2Plugin } from '../helpers/opencode-plugin.js';

// Real-CLI coverage for #945: a pull writes the instruction blocks (culture,
// claudemd, recall) only where an installed tool reads them, and strips the
// blocks an earlier pull left in a target no installed tool uses anymore.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const CULTURE_START = '<!-- [teamai:culture:start] -->';
const CULTURE_END = '<!-- [teamai:culture:end] -->';
const CLAUDEMD_START = '<!-- [teamai:claudemd:start] -->';
const CLAUDEMD_END = '<!-- [teamai:claudemd:end] -->';
const RECALL_START = '<!-- [teamai:recall-rules:start] -->';

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], env: Record<string, string>, cwd: string, stdin = ''): Promise<RunResult & { stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.end(stdin);
    child.on('close', (code) => resolve({ code, output, stdout }));
  });
}

/** The context `teamai hook-dispatch instructions` hands an extension for a session in `cwd`. */
async function sessionInstructions(tool: string, home: string, cwd: string): Promise<string> {
  const result = await runCLI(['hook-dispatch', 'instructions', '--tool', tool], { HOME: home }, cwd, JSON.stringify({ cwd }));
  expect(result.code, result.output).toBe(0);
  if (!result.stdout.trim()) return '';
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

/** A user-scope sandbox HOME with the given tool directories installed. */
function makeUserSandbox(toolDirs: string[], options: { rule?: boolean } = {}): { sandbox: string; home: string } {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
  const home = path.join(sandbox, 'home');
  const remote = path.join(sandbox, 'team-remote');
  const localRepo = path.join(home, '.teamai', 'team-repo');

  fs.mkdirSync(path.join(remote, 'claudemd', 'common'), { recursive: true });
  fs.writeFileSync(
    path.join(remote, 'teamai.yaml'),
    ['team: issue-945-e2e', `repo: ${remote}`, 'provider: git', 'sharing:', '  recall:', '    enabled: true'].join('\n'),
  );
  fs.writeFileSync(path.join(remote, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind.\n');
  fs.writeFileSync(path.join(remote, 'claudemd', 'common', 'note.md'), 'Shared team instructions.\n');
  if (options.rule) {
    fs.mkdirSync(path.join(remote, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'rules', 'style.md'), 'RULE-SENTINEL: keep functions small.\n');
  }
  git(['init', '-q'], remote);
  git(['add', '-A'], remote);
  git(['commit', '-q', '-m', 'fixture'], remote);

  fs.mkdirSync(home, { recursive: true });
  git(['clone', '-q', remote, localRepo], sandbox);
  for (const dir of toolDirs) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.teamai', 'config.yaml'),
    [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remote}`,
      'username: ci-user',
      'updatePolicy: auto',
      'scope: user',
      'recallEnabled: true',
    ].join('\n'),
  );
  return { sandbox, home };
}

const PROJECT_AGENTS_MD = '# Project\n\nAuthored project instructions.\n';

it('pulls Pi rules and instructions into the existing override and preserves personal text on uninstall', async () => {
  const { sandbox, home } = makeUserSandbox(['.pi/agent'], { rule: true });
  const normal = path.join(home, '.pi/agent/AGENTS.md');
  const override = path.join(home, '.pi/agent/AGENTS.override.md');
  fs.writeFileSync(normal, `# Personal normal\n\n${CULTURE_START}\nOLD-CULTURE\n${CULTURE_END}\n`);
  fs.writeFileSync(override, '# Personal override\n');
  try {
    const pull = await runCLI(['pull', '--force'], { HOME: home }, home);
    expect(pull.code, pull.output).toBe(0);
    const doctor = await runCLI(['doctor'], { HOME: home }, home);
    expect(doctor.code, doctor.output).toBe(0);
    expect(pull.output).not.toContain('pi does not read');
    const read = fs.readFileSync(override, 'utf8');
    expect(read).toContain('# Personal override');
    expect(read).toContain('Be kind.');
    expect(read).toContain('Shared team instructions.');
    expect(read).toContain('RULE-SENTINEL');
    expect(fs.readFileSync(normal, 'utf8')).toBe('# Personal normal\n');
    const uninstall = await runCLI(['uninstall', '--force'], { HOME: home }, home);
    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.readFileSync(override, 'utf8')).toBe('# Personal override\n');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

/**
 * A team whose roles select different `claudemd/` namespaces, and a project
 * repo with an authored, committed AGENTS.md (#945).
 */
function makeTeamAndProject(
  sandbox: string,
  options: { teamYaml?: string[]; files?: Record<string, string> } = {},
): { remote: string; projectOrigin: string } {
  const seed = path.join(sandbox, 'team-seed');
  const remote = path.join(sandbox, 'team.git');
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), text);
  };
  write('teamai.yaml', [
    'team: issue-945-project-e2e', `repo: ${remote}`, 'provider: git', 'sharing:', '  recall:', '    enabled: true',
    ...options.teamYaml ?? [], '',
  ].join('\n'));
  for (const [rel, text] of Object.entries(options.files ?? {})) write(rel, text);
  write('culture.md', '---\ncompany:\n  name: Acme\n---\n\nBe kind.\n');
  write('claudemd/common.md', 'COMMON-SENTINEL shared by every role.\n');
  write('claudemd/development/dev.md', 'DEVELOPMENT-SENTINEL for developers.\n');
  write('claudemd/product/product.md', 'PRODUCT-SENTINEL for product.\n');
  write('manifest/roles.yaml', [
    'version: 1',
    'roles:',
    '  - id: developer',
    '    description: Developer',
    '    resources:',
    '      knowledge: [development]',
    '      skills: []',
    '  - id: product',
    '    description: Product',
    '    resources:',
    '      knowledge: [product]',
    '      skills: []',
    '',
  ].join('\n'));
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], sandbox);

  const projectSeed = path.join(sandbox, 'project-seed');
  const projectOrigin = path.join(sandbox, 'project.git');
  fs.mkdirSync(projectSeed, { recursive: true });
  fs.writeFileSync(path.join(projectSeed, 'AGENTS.md'), PROJECT_AGENTS_MD);
  fs.writeFileSync(path.join(projectSeed, 'app.txt'), 'v1\n');
  git(['init', '-q', '-b', 'main'], projectSeed);
  git(['add', '-A'], projectSeed);
  git(['commit', '-q', '-m', 'project'], projectSeed);
  git(['clone', '-q', '--bare', projectSeed, projectOrigin], sandbox);
  return { remote, projectOrigin };
}

interface ProjectMember {
  home: string;
  projectRoot: string;
}

/**
 * One member's checkout of the project, in project scope, with their role and
 * the given tool directories installed under the project root.
 */
function makeProjectMember(
  sandbox: string,
  fixture: { remote: string; projectOrigin: string },
  name: string,
  role: string,
  toolDirs: string[],
): ProjectMember {
  const home = path.join(sandbox, `${name}-home`);
  const projectRoot = path.join(sandbox, `${name}-project`);
  fs.mkdirSync(home, { recursive: true });
  git(['clone', '-q', fixture.projectOrigin, projectRoot], sandbox);
  const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
  git(['clone', '-q', fixture.remote, teamRepo], sandbox);
  for (const dir of toolDirs) fs.mkdirSync(path.join(projectRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
    'repo:',
    `  localPath: ${teamRepo}`,
    `  remote: ${fixture.remote}`,
    `username: ${name}`,
    'updatePolicy: auto',
    'scope: project',
    `projectRoot: ${projectRoot}`,
    `primaryRole: ${role}`,
    'additionalRoles: []',
    'recallEnabled: true',
    '',
  ].join('\n'));
  return { home, projectRoot };
}

/**
 * Where a member's project config and team clone live once the first pull has
 * moved them out of the project's `.teamai/` into the per-project data home.
 */
function memberData(member: ProjectMember): { config: string; teamRepo: string } {
  const projects = path.join(member.home, '.teamai', 'projects');
  const [dir] = fs.readdirSync(projects);
  return { config: path.join(projects, dir, 'config.yaml'), teamRepo: path.join(projects, dir, 'team-repo') };
}

const pullAs = (member: ProjectMember, args: string[] = [], env: Record<string, string> = {}): Promise<RunResult> =>
  runCLI(['pull', '--force', ...args], { HOME: member.home, ...env }, member.projectRoot);

it('doctor detects oversized ZCode project rule replies and honors a larger configured byte cap', async () => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-zcode-budget-')));
  try {
    const fixture = makeTeamAndProject(sandbox, { files: { 'rules/common.md': '界'.repeat(11_000) } });
    const member = makeProjectMember(sandbox, fixture, 'pm', 'product', ['.zcode']);
    const pulled = await pullAs(member);
    expect(pulled.code, pulled.output).toBe(0);
    const doctor = async () => {
      const result = await runCLI(['doctor', '--json'], { HOME: member.home }, member.projectRoot);
      const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; ok: boolean; fix?: string }> };
      return report.checks.find(check => check.name === 'Project rules fit the zcode hook stdout budget');
    };
    const failed = await doctor();
    expect(failed?.ok).toBe(false);
    expect(failed?.fix).toContain('UTF-8');
    expect(failed?.fix).toContain('32768');
    const file = path.join(member.home, '.zcode/cli/config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.hooks.maxOutputBytes = 65_536;
    fs.writeFileSync(file, JSON.stringify(config));
    expect((await doctor())?.ok).toBe(true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('instruction block targets on real CLI pull (#945)', () => {
  const sandboxes: string[] = [];

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
  });

  afterEach(() => {
    // SessionStart's detached pull/plugin workers may finish writing after the
    // foreground hook exits. Retry transient ENOTEMPTY, as other hook E2Es do.
    for (const dir of sandboxes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('writes no ~/AGENTS.md when only Claude is installed', async () => {
    const { sandbox, home } = makeUserSandbox(['.claude']);
    sandboxes.push(sandbox);

    const result = await runCLI(['pull'], { HOME: home }, sandbox);
    expect(result.code, result.output).toBe(0);

    const claudeMd = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(CULTURE_START);
    expect(claudeMd).toContain(CLAUDEMD_START);
    expect(claudeMd).toContain(RECALL_START);
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
  });

  it('gives Hermes its user blocks in $HERMES_HOME/SOUL.md beside the rules block, and moves them out of ~/AGENTS.md', async () => {
    const { sandbox, home } = makeUserSandbox(['.claude'], { rule: true });
    sandboxes.push(sandbox);
    const hermesHome = path.join(sandbox, 'hermes-home');
    fs.mkdirSync(hermesHome, { recursive: true });
    const soul = path.join(hermesHome, 'SOUL.md');
    fs.writeFileSync(soul, '# Persona\n');
    const agentsMd = path.join(home, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `${CULTURE_START}\nold culture\n${CULTURE_END}\n`);

    const result = await runCLI(['pull'], { HOME: home, HERMES_HOME: hermesHome }, sandbox);
    expect(result.code, result.output).toBe(0);

    const content = fs.readFileSync(soul, 'utf8');
    expect(content).toContain('# Persona');
    expect(content).toContain('<!-- [teamai:rules:start] -->');
    expect(content).toContain('RULE-SENTINEL');
    expect(content).toContain(CULTURE_START);
    expect(content).toContain(CLAUDEMD_START);
    expect(fs.existsSync(agentsMd)).toBe(false);

    // A second pull keeps both blocks, and a project pull leaves the user blocks alone.
    const again = await runCLI(['pull', '--force'], { HOME: home, HERMES_HOME: hermesHome }, sandbox);
    expect(again.code, again.output).toBe(0);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const projectPull = await runCLI(['pull', '--force'], { HOME: member.home, HERMES_HOME: hermesHome }, member.projectRoot);
    expect(projectPull.code, projectPull.output).toBe(0);
    const after = fs.readFileSync(soul, 'utf8');
    expect(after).toContain(CULTURE_START);
    expect(after).toContain('Shared team instructions.');
    expect(after).not.toContain('DEVELOPMENT-SENTINEL');
  });

  it('keeps only the hand-written text of a ~/AGENTS.md no installed tool reads', async () => {
    const { sandbox, home } = makeUserSandbox(['.claude']);
    sandboxes.push(sandbox);
    const agentsMd = path.join(home, 'AGENTS.md');
    fs.writeFileSync(agentsMd, [
      '# My notes',
      '',
      CULTURE_START,
      'old culture',
      CULTURE_END,
      '',
      CLAUDEMD_START,
      'old shared instructions',
      CLAUDEMD_END,
      '',
    ].join('\n'));

    const result = await runCLI(['pull'], { HOME: home }, sandbox);
    expect(result.code, result.output).toBe(0);

    expect(fs.readFileSync(agentsMd, 'utf8')).toBe('# My notes\n');
  });

  it('leaves the project AGENTS.md alone when Hermes is not installed', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);
  });

  it('reports the cleanup of an old AGENTS.md block in a dry run, then removes it and keeps the authored text', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const agentsMd = path.join(member.projectRoot, 'AGENTS.md');
    const leftover = `${PROJECT_AGENTS_MD}\n${CLAUDEMD_START}\nanother member's selection\n${CLAUDEMD_END}\n`;
    fs.writeFileSync(agentsMd, leftover);

    const dryRun = await pullAs(member, ['--dry-run']);
    expect(dryRun.code, dryRun.output).toBe(0);
    expect(dryRun.output).toContain(`Would remove teamai instruction blocks from ${agentsMd}`);
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(leftover);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Removed teamai instruction blocks from ${agentsMd}`);
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(PROJECT_AGENTS_MD);
  });

  it('does not rewrite an instruction file whose blocks are already current', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);

    const first = await pullAs(member);
    expect(first.code, first.output).toBe(0);
    const written = fs.readdirSync(member.projectRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.parentPath.includes(`${path.sep}.git`) && !entry.parentPath.includes('.teamai'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((file) => fs.readFileSync(file, 'utf8').includes(CLAUDEMD_START));
    expect(written.length).toBeGreaterThan(0);
    const mtimes = written.map((file) => fs.statSync(file).mtimeMs);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await pullAs(member);
    expect(second.code, second.output).toBe(0);
    expect(written.map((file) => fs.statSync(file).mtimeMs)).toEqual(mtimes);
  });

  it('gives two members of one project their own role selection without touching the shared AGENTS.md (Claude)', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox);
    const developer = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.claude/skills']);
    const product = makeProjectMember(sandbox, fixture, 'pm', 'product', ['.claude/skills']);
    const context = (member: ProjectMember): string =>
      fs.readFileSync(path.join(member.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8');

    for (const member of [developer, product, developer]) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }

    expect(context(developer)).toContain('COMMON-SENTINEL');
    expect(context(developer)).toContain('DEVELOPMENT-SENTINEL');
    expect(context(developer)).not.toContain('PRODUCT-SENTINEL');
    expect(context(developer)).toContain(CULTURE_START);
    expect(context(developer)).toContain(RECALL_START);
    expect(context(product)).toContain('COMMON-SENTINEL');
    expect(context(product)).toContain('PRODUCT-SENTINEL');
    expect(context(product)).not.toContain('DEVELOPMENT-SENTINEL');
    for (const member of [developer, product]) {
      expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);
      expect(fs.existsSync(path.join(member.projectRoot, '.claude', 'CLAUDE.md'))).toBe(false);
      expect(fs.existsSync(path.join(member.projectRoot, 'CLAUDE.local.md'))).toBe(false);
    }
  });

  it('moves Claude blocks an earlier release left in .claude/CLAUDE.md, keeping the authored text', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const legacy = path.join(member.projectRoot, '.claude', 'CLAUDE.md');
    fs.writeFileSync(legacy, `# Team notes\n\n${CLAUDEMD_START}\nold selection\n${CLAUDEMD_END}\n`);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(result.output).toContain(`Removed teamai instruction blocks from ${legacy}`);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('# Team notes\n');
    expect(fs.readFileSync(path.join(member.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8')).toContain('DEVELOPMENT-SENTINEL');
  });

  it('gives Cursor an always-applied teamai-context.mdc in both scopes', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.cursor/skills']);
    const projectRule = path.join(member.projectRoot, '.cursor', 'rules', 'teamai-context.mdc');

    for (let i = 0; i < 2; i++) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }
    const rule = fs.readFileSync(projectRule, 'utf8');
    expect(rule.startsWith('---\nalwaysApply: true\n---\n\n')).toBe(true);
    expect(rule).toContain('DEVELOPMENT-SENTINEL');
    expect(rule).toContain(RECALL_START);
    expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);

    const user = makeUserSandbox(['.cursor']);
    sandboxes.push(user.sandbox);
    const userPull = await runCLI(['pull'], { HOME: user.home }, user.sandbox);
    expect(userPull.code, userPull.output).toBe(0);
    const userRule = fs.readFileSync(path.join(user.home, '.cursor', 'rules', 'teamai-context.mdc'), 'utf8');
    expect(userRule.startsWith('---\nalwaysApply: true\n---\n\n')).toBe(true);
    expect(userRule).toContain(CLAUDEMD_START);
    expect(fs.existsSync(path.join(user.home, 'AGENTS.md'))).toBe(false);
  });

  it('gives CodeBuddy and WorkBuddy one shared rule file and keeps it while either tool remains', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.codebuddy/skills', '.workbuddy/skills']);
    const rule = path.join(member.projectRoot, '.codebuddy', 'rules', 'teamai-context.md');
    const legacy = path.join(member.projectRoot, '.codebuddy', 'CODEBUDDY.md');
    const agentsMd = path.join(member.projectRoot, 'AGENTS.md');
    fs.writeFileSync(legacy, `# CodeBuddy notes\n\n${CLAUDEMD_START}\nold selection\n${CLAUDEMD_END}\n`);
    fs.writeFileSync(agentsMd, `${PROJECT_AGENTS_MD}\n${CULTURE_START}\nold culture\n${CULTURE_END}\n`);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    const content = fs.readFileSync(rule, 'utf8');
    expect(content.startsWith('---\nalwaysApply: true\n---\n\n')).toBe(true);
    expect(content).toContain('DEVELOPMENT-SENTINEL');
    expect(content.split(CLAUDEMD_START).length - 1).toBe(1);
    expect(fs.existsSync(path.join(member.projectRoot, '.workbuddy', 'rules', 'teamai-context.md'))).toBe(false);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('# CodeBuddy notes\n');
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(PROJECT_AGENTS_MD);

    const uninstall = await runCLI(['uninstall', '--agent', 'workbuddy', '--force'], { HOME: member.home }, member.projectRoot);
    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.readFileSync(rule, 'utf8')).toContain('DEVELOPMENT-SENTINEL');
  });

  it('gives WorkBuddy its user blocks in ~/.workbuddy/rules, not ~/AGENTS.md', async () => {
    const { sandbox, home } = makeUserSandbox(['.workbuddy']);
    sandboxes.push(sandbox);

    const result = await runCLI(['pull'], { HOME: home }, sandbox);
    expect(result.code, result.output).toBe(0);

    const rule = fs.readFileSync(path.join(home, '.workbuddy', 'rules', 'teamai-context.md'), 'utf8');
    expect(rule.startsWith('---\nalwaysApply: true\n---\n\n')).toBe(true);
    expect(rule).toContain(CLAUDEMD_START);
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
  });

  it('gives Oh My Pi its project blocks through the extension, its user blocks in RULES.md, and frees both context files', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox);
    const developer = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.omp/skills']);
    const product = makeProjectMember(sandbox, fixture, 'pm', 'product', ['.omp/skills']);
    const legacy = path.join(developer.projectRoot, '.omp', 'AGENTS.md');
    fs.writeFileSync(legacy, `${CLAUDEMD_START}\nold selection\n${CLAUDEMD_END}\n`);
    for (const member of [developer, product]) {
      fs.mkdirSync(path.join(member.home, '.omp'), { recursive: true });
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }

    expect(fs.existsSync(legacy)).toBe(false);
    const sub = path.join(developer.projectRoot, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const devContext = await sessionInstructions('omp', developer.home, sub);
    expect(devContext).toContain('DEVELOPMENT-SENTINEL');
    expect(devContext).not.toContain('PRODUCT-SENTINEL');
    expect(devContext).toContain('Acme');
    expect(devContext).toContain('teamai-recall');
    const pmContext = await sessionInstructions('omp', product.home, product.projectRoot);
    expect(pmContext).toContain('PRODUCT-SENTINEL');
    expect(pmContext).not.toContain('DEVELOPMENT-SENTINEL');
    expect(await sessionInstructions('claude', developer.home, developer.projectRoot)).toBe('');
    for (const member of [developer, product]) {
      expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);
    }

    const user = makeUserSandbox(['.omp']);
    sandboxes.push(user.sandbox);
    const userContextFile = path.join(user.home, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(userContextFile), { recursive: true });
    fs.writeFileSync(userContextFile, `${CULTURE_START}\nold culture\n${CULTURE_END}\n`);
    const userPull = await runCLI(['pull'], { HOME: user.home }, user.sandbox);
    expect(userPull.code, userPull.output).toBe(0);
    expect(fs.readFileSync(path.join(user.home, '.omp', 'agent', 'RULES.md'), 'utf8')).toContain(CLAUDEMD_START);
    expect(fs.existsSync(userContextFile)).toBe(false);
    expect(await sessionInstructions('omp', user.home, user.sandbox)).toBe('');
  });

  it('gives Pi its project blocks through the extension and stops writing the project AGENTS.md', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'pm', 'product', ['.pi/skills']);
    const agentsMd = path.join(member.projectRoot, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `${PROJECT_AGENTS_MD}\n${CLAUDEMD_START}\nanother member's selection\n${CLAUDEMD_END}\n`);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(PROJECT_AGENTS_MD);
    const context = await sessionInstructions('pi', member.home, member.projectRoot);
    expect(context).toContain('PRODUCT-SENTINEL');
    expect(context).not.toContain('DEVELOPMENT-SENTINEL');
    expect(context).toContain('Acme');
    // Pi has no recall subagent: it is told to run the command itself.
    expect(context).toContain('teamai recall "');
    expect(context).not.toContain('teamai-recall');
  });

  it('suppresses Pi hook blocks while a blocked WorkBuddy replacement retains shared native instructions', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-held-native-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.workbuddy/skills']);
    fs.mkdirSync(path.join(member.home, '.pi'), { recursive: true });
    const legacy = path.join(member.projectRoot, 'AGENTS.md');
    const original = `${PROJECT_AGENTS_MD}${CLAUDEMD_START}\nPRODUCT-STALE\n${CLAUDEMD_END}\n`;
    fs.writeFileSync(legacy, original);
    const replacement = path.join(member.projectRoot, '.codebuddy/rules/teamai-context.md');
    fs.mkdirSync(path.dirname(replacement), { recursive: true });
    fs.writeFileSync(replacement, '# Foreign file\n');

    const blocked = await pullAs(member);
    expect(blocked.code, blocked.output).toBe(0);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(original);
    const held = await sessionInstructions('pi', member.home, member.projectRoot);
    expect(held).not.toContain('DEVELOPMENT-SENTINEL');
    expect(held).not.toContain('PRODUCT-STALE');
    expect(held).toContain('Acme');
    console.log('blocked WorkBuddy replacement: native prompt retained; Pi hook omits that block and still delivers culture');

    fs.unlinkSync(replacement);
    const retry = await runCLI(['pull'], { HOME: member.home }, member.projectRoot);
    expect(retry.code, retry.output).toBe(0);
    expect(fs.readFileSync(replacement, 'utf8')).toContain('DEVELOPMENT-SENTINEL');
    expect(fs.readFileSync(legacy, 'utf8')).toBe(PROJECT_AGENTS_MD);
    expect(await sessionInstructions('pi', member.home, member.projectRoot)).toContain('DEVELOPMENT-SENTINEL');
    console.log('WorkBuddy repair: legacy block removed; Pi hook resumes the developer prompt');
  });

  it('retains Claude legacy instructions until a foreign replacement is repaired', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-migration-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const legacy = path.join(member.projectRoot, '.claude', 'CLAUDE.md');
    const original = `# Mine\n${CLAUDEMD_START}\nworking old prompt\n${CLAUDEMD_END}\n`;
    fs.writeFileSync(legacy, original);
    const replacement = path.join(member.projectRoot, '.claude', 'rules', 'teamai-context.md');
    fs.mkdirSync(path.dirname(replacement), { recursive: true });
    fs.writeFileSync(replacement, '# Foreign file\n');
    const blocked = await pullAs(member);
    expect(blocked.code, blocked.output).toBe(0);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(original);
    console.log('pull with foreign Claude target: old working prompt retained');
    fs.unlinkSync(replacement);
    // Exercise the unchanged-revision path as well as the first full pull.
    const retry = await runCLI(['pull'], { HOME: member.home }, member.projectRoot);
    expect(retry.code, retry.output).toBe(0);
    expect(fs.readFileSync(replacement, 'utf8')).toContain('DEVELOPMENT-SENTINEL');
    expect(fs.readFileSync(legacy, 'utf8')).toBe('# Mine\n');
    console.log('pull after repair: replacement delivered, old prompt removed');
  });

  it('keeps unreadable culture in its retired file until that block is delivered', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-block-migration-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const source = path.join(member.projectRoot, '.teamai/team-repo/culture.md');
    fs.unlinkSync(source);
    fs.mkdirSync(source);
    const legacy = path.join(member.projectRoot, '.claude/CLAUDE.md');
    fs.writeFileSync(legacy, `# Mine\n${CULTURE_START}\nWORKING-CULTURE\n${CULTURE_END}\n${CLAUDEMD_START}\nold prompt\n${CLAUDEMD_END}\n`);
    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Failed to read team culture');
    expect(fs.readFileSync(legacy, 'utf8')).toContain('WORKING-CULTURE');
    expect(fs.readFileSync(legacy, 'utf8')).not.toContain('old prompt');
    const replacement = path.join(member.projectRoot, '.claude/rules/teamai-context.md');
    expect(fs.readFileSync(replacement, 'utf8')).toContain('DEVELOPMENT-SENTINEL');
    console.log('unreadable culture: old culture retained; resolved shared instructions delivered and retired');

    const repaired = path.join(memberData(member).teamRepo, 'culture.md');
    fs.rmdirSync(repaired);
    fs.writeFileSync(repaired, '---\ncompany:\n  name: Acme\n---\n\nRESTORED-CULTURE\n');
    const retry = await runCLI(['pull'], { HOME: member.home }, member.projectRoot);
    expect(retry.code, retry.output).toBe(0);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('# Mine\n');
    expect(fs.readFileSync(replacement, 'utf8')).toContain('RESTORED-CULTURE');
    console.log('culture repair: replacement delivered; retired culture removed on the next pull');
  });

  it('keeps globally installed Pi delivering after project WorkBuddy uninstall', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-active-hook-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.workbuddy/skills']);
    const config = path.join(member.projectRoot, '.teamai/config.yaml');
    fs.appendFileSync(config, '\nenabledAgents: [workbuddy, pi]\n');
    fs.mkdirSync(path.join(member.home, '.pi'), { recursive: true });
    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);
    expect(fs.existsSync(path.join(member.projectRoot, '.pi'))).toBe(false);
    const data = memberData(member);
    const removed = await runCLI(['uninstall', '--force', '--agent', 'workbuddy'], { HOME: member.home }, member.projectRoot);
    expect(removed.code, removed.output).toBe(0);
    expect(fs.existsSync(data.config)).toBe(true);
    expect(fs.existsSync(path.join(member.projectRoot, '.codebuddy/rules/teamai-context.md'))).toBe(false);
    expect(await sessionInstructions('pi', member.home, member.projectRoot)).toContain('DEVELOPMENT-SENTINEL');
    console.log('WorkBuddy project uninstall: project state preserved; global-only Pi still receives member instructions');
  });

  it('previews the cleanup a real pull does once it installs the Pi extension, and none behind a foreign one', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-dryrun-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'pm', 'product', ['.pi/skills']);
    fs.mkdirSync(path.join(member.home, '.pi'), { recursive: true });
    const legacy = path.join(member.projectRoot, 'AGENTS.md');
    fs.writeFileSync(legacy, `${PROJECT_AGENTS_MD}${CLAUDEMD_START}\nworking old prompt\n${CLAUDEMD_END}\n`);
    const extension = path.join(member.home, '.pi', 'agent', 'extensions', 'teamai-hooks.ts');
    const removal = `Would remove teamai instruction blocks from ${legacy}`;

    const preview = await pullAs(member, ['--dry-run']);
    expect(preview.code, preview.output).toBe(0);
    expect(preview.output).toContain(removal);
    expect(fs.existsSync(extension)).toBe(false);

    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.writeFileSync(extension, '// Foreign extension\n');
    const blocked = await pullAs(member, ['--dry-run']);
    expect(blocked.code, blocked.output).toBe(0);
    expect(blocked.output).not.toContain(removal);
  });

  it('retains Pi legacy instructions until its extension is ready, and protects exclusions', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-migration-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'pm', 'product', ['.pi/skills']);
    const extension = path.join(member.home, '.pi', 'agent', 'extensions', 'teamai-hooks.ts');
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.writeFileSync(extension, '// Foreign extension\n');
    const legacy = path.join(member.projectRoot, 'AGENTS.md');
    const original = `${PROJECT_AGENTS_MD}${CLAUDEMD_START}\nworking old prompt\n${CLAUDEMD_END}\n`;
    fs.writeFileSync(legacy, original);
    const blocked = await pullAs(member);
    expect(blocked.code, blocked.output).toBe(0);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(original);
    console.log('pull with foreign Pi extension: old working prompt retained');
    fs.unlinkSync(extension);
    const configFile = memberData(member).config;
    const config = fs.readFileSync(configFile, 'utf8');
    fs.writeFileSync(configFile, `${config}\ndisabledAgents: [pi]\n`);
    const excluded = await pullAs(member);
    expect(excluded.code, excluded.output).toBe(0);
    expect(fs.existsSync(extension)).toBe(false);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(original);
    console.log('pull with Pi excluded: extension and legacy instructions unchanged');
    fs.writeFileSync(configFile, config);
    const repaired = await runCLI(['pull'], { HOME: member.home }, member.projectRoot);
    expect(repaired.code, repaired.output).toBe(0);
    expect(fs.readFileSync(extension, 'utf8')).toContain('hook-dispatch');
    expect(fs.readFileSync(legacy, 'utf8')).toBe(PROJECT_AGENTS_MD);
    console.log('pull with Pi enabled: extension installed before old prompt removed');
  });

  it('previews and cancels empty-plan Pi exclusion without changing project config on the real CLI', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-empty-uninstall-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', []);
    fs.mkdirSync(path.join(member.home, '.pi'), { recursive: true });
    fs.appendFileSync(path.join(member.projectRoot, '.teamai/config.yaml'), '\nenabledAgents: [pi]\n');
    const prepared = await pullAs(member);
    expect(prepared.code, prepared.output).toBe(0);
    const config = memberData(member).config;
    const before = fs.readFileSync(config, 'utf8');
    const hooks = path.join(member.home, '.pi/agent/extensions/teamai-hooks.ts');
    const adapter = fs.readFileSync(hooks, 'utf8');
    const preview = await runCLI(['uninstall', '--agent', 'pi', '--dry-run'], { HOME: member.home }, member.projectRoot);
    expect(preview.code, preview.output).toBe(0);
    expect(preview.output).toContain('Exclude pi from this project');
    expect(preview.output).toContain('Dry run');
    expect(fs.readFileSync(config, 'utf8')).toBe(before);
    const cancelled = await runCLI(['uninstall', '--agent', 'pi'], { HOME: member.home }, member.projectRoot);
    expect(cancelled.code, cancelled.output).toBe(0);
    expect(cancelled.output).toContain('Cancelled');
    expect(fs.readFileSync(config, 'utf8')).toBe(before);
    const confirmed = await runCLI(['uninstall', '--agent', 'pi', '--force'], { HOME: member.home }, member.projectRoot);
    expect(confirmed.code, confirmed.output).toBe(0);
    expect(confirmed.output).toContain('Excluded pi from this project');
    expect(fs.readFileSync(config, 'utf8')).toContain('disabledAgents:');
    expect(fs.readFileSync(hooks, 'utf8')).toBe(adapter);
    console.log('real Pi uninstall: dry-run and cancellation keep config unchanged; --force records exclusion and keeps global adapter');
  });

  it('uninstalls Pi from one project while keeping delivery to another project on the same machine', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-uninstall-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox);
    const developer = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.pi/skills']);
    const product = { ...makeProjectMember(sandbox, fixture, 'pm', 'product', ['.pi/skills']), home: developer.home };
    fs.mkdirSync(path.join(developer.home, '.pi'), { recursive: true });
    for (const member of [developer, product]) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }
    const extension = path.join(developer.home, '.pi', 'agent', 'extensions', 'teamai-hooks.ts');
    const before = fs.readFileSync(extension, 'utf8');
    const removed = await runCLI(['uninstall', '--force', '--agent', 'pi'], { HOME: developer.home }, developer.projectRoot);
    expect(removed.code, removed.output).toBe(0);
    expect(fs.readFileSync(extension, 'utf8')).toBe(before);
    expect(await sessionInstructions('pi', product.home, product.projectRoot)).toContain('PRODUCT-SENTINEL');
    expect(await sessionInstructions('pi', developer.home, developer.projectRoot)).toBe('');
    console.log('uninstall Pi from project A: global extension unchanged; project B instructions still delivered; project A empty');
  });

  it.each([true, false])('preserves global Codex delivery across two projects on project uninstall, targeted: %s', async (targeted) => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-codex-uninstall-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox);
    const developer = makeProjectMember(sandbox, fixture, 'dev', 'developer', []);
    const product = { ...makeProjectMember(sandbox, fixture, 'pm', 'product', []), home: developer.home };
    fs.mkdirSync(path.join(developer.home, '.codex'), { recursive: true });
    for (const member of [developer, product]) {
      fs.appendFileSync(path.join(member.projectRoot, '.teamai/config.yaml'), '\nenabledAgents: [codex]\n');
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }
    const hooks = path.join(developer.home, '.codex/hooks.json');
    const before = fs.readFileSync(hooks, 'utf8');
    const removed = await runCLI(['uninstall', '--force', ...targeted ? ['--agent', 'codex'] : []], { HOME: developer.home }, developer.projectRoot);
    expect(removed.code, removed.output).toBe(0);
    expect(fs.readFileSync(hooks, 'utf8')).toBe(before);
    expect(await sessionInstructions('codex', product.home, product.projectRoot)).toContain('PRODUCT-SENTINEL');
    expect(await sessionInstructions('codex', developer.home, developer.projectRoot)).toBe('');
    if (targeted) expect(fs.readFileSync(memberData(developer).config, 'utf8')).toContain('codex');
    console.log(`Codex project ${targeted ? 'targeted' : 'full'} uninstall: global hooks unchanged; project B delivered; project A empty`);
  });

  it('gives Hermes its project blocks through its plugin and frees the project AGENTS.md', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', []);
    const hermesHome = path.join(sandbox, 'hermes-home');
    fs.mkdirSync(hermesHome, { recursive: true });
    const agentsMd = path.join(member.projectRoot, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `${PROJECT_AGENTS_MD}\n${CULTURE_START}\nold culture\n${CULTURE_END}\n`);

    const result = await pullAs(member, [], { HERMES_HOME: hermesHome });
    expect(result.code, result.output).toBe(0);

    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(PROJECT_AGENTS_MD);
    expect(fs.readFileSync(path.join(hermesHome, 'plugins', 'teamai-instructions', '__init__.py'), 'utf8'))
      .toContain('register_system_prompt_section');
    expect(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')).toMatch(/plugins:\n\s+enabled:\n\s+- teamai-instructions/);
    const sub = path.join(member.projectRoot, 'docs');
    fs.mkdirSync(sub, { recursive: true });
    const run = await runCLI(['hook-dispatch', 'instructions', '--tool', 'hermes'], { HOME: member.home, HERMES_HOME: hermesHome }, sub, JSON.stringify({ cwd: sub }));
    const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('DEVELOPMENT-SENTINEL');
    expect(context).not.toContain('PRODUCT-SENTINEL');
    expect(context).not.toContain('teamai-recall');
    expect(context).toContain('teamai recall "');
  });

  it('says Hermes cannot load project instructions over its 4,000-character section, without cutting them or using AGENTS.md', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', []);
    const teamRepo = path.join(member.projectRoot, '.teamai', 'team-repo');
    fs.writeFileSync(path.join(teamRepo, 'claudemd', 'development', 'long.md'), `${'Long developer guidance. '.repeat(200)}\n`);
    const hermesHome = path.join(sandbox, 'hermes-home');
    fs.mkdirSync(hermesHome, { recursive: true });

    const result = await pullAs(member, [], { HERMES_HOME: hermesHome });
    expect(result.code, result.output).toBe(0);

    expect(result.output).toMatch(/hermes cannot load this project's team instructions: they are \d+ characters, over the 4000-character limit/);
    expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);
  });

  it('gives OpenCode its project blocks in .opencode/teamai-context.md, registered in .opencode/opencode.json', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.opencode/skills']);
    const config = path.join(member.projectRoot, '.opencode', 'opencode.json');
    fs.writeFileSync(config, JSON.stringify({ instructions: ['docs/style.md'], theme: 'dark' }, null, 2));

    for (let i = 0; i < 2; i++) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }

    expect(fs.readFileSync(path.join(member.projectRoot, '.opencode', 'teamai-context.md'), 'utf8')).toContain('DEVELOPMENT-SENTINEL');
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ instructions: ['docs/style.md', '.opencode/teamai-context.md'], theme: 'dark' });
    expect(fs.existsSync(path.join(member.projectRoot, 'opencode.json'))).toBe(false);
    expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);

    const uninstall = await runCLI(['uninstall', '--agent', 'opencode', '--force'], { HOME: member.home }, member.projectRoot);
    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.existsSync(path.join(member.projectRoot, '.opencode', 'teamai-context.md'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ instructions: ['docs/style.md'], theme: 'dark' });
  });

  it('gives OpenCode its user blocks in its config dir, registered with an absolute path, and lists no copy beside its Claude fallback', async () => {
    const own = makeUserSandbox(['.config/opencode']);
    sandboxes.push(own.sandbox);
    const ocDir = path.join(own.home, '.config', 'opencode');
    fs.writeFileSync(path.join(ocDir, 'AGENTS.md'), '# My OpenCode notes\n');
    fs.writeFileSync(path.join(ocDir, 'opencode.json'), JSON.stringify({ instructions: ['~/notes.md'] }));
    const result = await runCLI(['pull'], { HOME: own.home }, own.sandbox);
    expect(result.code, result.output).toBe(0);
    const contextFile = path.join(ocDir, 'teamai-context.md');
    expect(fs.readFileSync(contextFile, 'utf8')).toContain(CLAUDEMD_START);
    expect(JSON.parse(fs.readFileSync(path.join(ocDir, 'opencode.json'), 'utf8')).instructions).toEqual(['~/notes.md', contextFile]);
    expect(fs.readFileSync(path.join(ocDir, 'AGENTS.md'), 'utf8')).toBe('# My OpenCode notes\n');

    // No native user AGENTS.md: OpenCode V1 falls back to ~/.claude/CLAUDE.md, which already holds the blocks,
    // so the copy V2 reads through teamai's plugin is not listed for V1 (#993 bug 6).
    const fallback = makeUserSandbox(['.config/opencode', '.claude']);
    sandboxes.push(fallback.sandbox);
    const env = { HOME: fallback.home, XDG_CONFIG_HOME: path.join(fallback.home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
    const fallbackContext = path.join(fallback.home, '.config', 'opencode', 'teamai-context.md');
    const listed = (): unknown[] => {
      const file = path.join(fallback.home, '.config', 'opencode', 'opencode.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).instructions ?? [] : [];
    };
    const viaClaude = await runCLI(['pull'], env, fallback.sandbox);
    expect(viaClaude.code, viaClaude.output).toBe(0);
    expect(fs.readFileSync(path.join(fallback.home, '.claude', 'CLAUDE.md'), 'utf8')).toContain(CLAUDEMD_START);
    expect(fs.readFileSync(fallbackContext, 'utf8')).toContain(CLAUDEMD_START);
    expect(listed()).toEqual([]);
    expect(viaClaude.output).toContain('OpenCode reads the team instructions from');
    const recall = await runCLI(['recall', 'enable'], env, fallback.sandbox);
    expect(recall.code, recall.output).toBe(0);
    expect(fs.readFileSync(fallbackContext, 'utf8')).toContain(RECALL_START);
    expect(listed()).toEqual([]);
  });

  it('has doctor report what keeps a tool from loading its instructions, not just whether a file was written', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.opencode/skills']);
    const pulled = await pullAs(member);
    expect(pulled.code, pulled.output).toBe(0);
    const doctor = async (): Promise<Map<string, { ok: boolean; fix?: string }>> => {
      const run = await runCLI(['doctor', '--json'], { HOME: member.home }, member.projectRoot);
      const report = JSON.parse(run.stdout) as { checks: Array<{ name: string; ok: boolean; fix?: string }> };
      return new Map(report.checks.map((c) => [c.name, c]));
    };

    const healthy = await doctor();
    expect(healthy.get('Team instructions are current for opencode')?.ok).toBe(true);
    expect(healthy.get('Team instructions are listed in opencode instructions')?.ok).toBe(true);
    expect(healthy.get('No team instruction blocks are left in files no tool loads them from')?.ok).toBe(true);

    fs.writeFileSync(path.join(member.projectRoot, '.opencode', 'opencode.json'), '{}\n');
    fs.appendFileSync(path.join(member.projectRoot, 'AGENTS.md'), `\n${CLAUDEMD_START}\nold\n${CLAUDEMD_END}\n`);
    const broken = await doctor();
    expect(broken.get('Team instructions are listed in opencode instructions')).toMatchObject({ ok: false });
    expect(broken.get('Team instructions are listed in opencode instructions')?.fix).toContain('.opencode/teamai-context.md');
    expect(broken.get('No team instruction blocks are left in files no tool loads them from')).toMatchObject({ ok: false });
    expect(broken.get('No team instruction blocks are left in files no tool loads them from')?.fix).toContain('AGENTS.md');
  });

  const ALL_FILE_TOOLS = ['.claude/skills', '.cursor/skills', '.codebuddy/skills', '.workbuddy/skills', '.opencode/skills', '.omp/skills', '.pi/skills'];

  it('keeps the shared AGENTS.md byte-identical for two roles with every tool installed, across role and content changes', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox);
    const developer = makeProjectMember(sandbox, fixture, 'dev', 'developer', ALL_FILE_TOOLS);
    const product = makeProjectMember(sandbox, fixture, 'pm', 'product', ALL_FILE_TOOLS);
    const agentsMd = (m: ProjectMember) => fs.readFileSync(path.join(m.projectRoot, 'AGENTS.md'), 'utf8');
    const generated = (m: ProjectMember) => fs.readFileSync(path.join(m.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8');

    for (const member of [developer, product]) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
      expect(agentsMd(member)).toBe(PROJECT_AGENTS_MD);
    }
    expect(generated(developer)).not.toBe(generated(product));

    // The developer changes role, and the team edits a claudemd file.
    const { config, teamRepo } = memberData(developer);
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('primaryRole: developer', 'primaryRole: product'));
    fs.writeFileSync(path.join(teamRepo, 'claudemd', 'common.md'), 'COMMON-SENTINEL, revised.\n');
    const again = await pullAs(developer);
    expect(again.code, again.output).toBe(0);
    expect(agentsMd(developer)).toBe(PROJECT_AGENTS_MD);
    expect(generated(developer)).toContain('PRODUCT-SENTINEL');
    expect(generated(developer)).not.toContain('DEVELOPMENT-SENTINEL');
    expect(generated(developer)).toContain('revised');
  });

  it('leaves an existing task diff and the staged diff unchanged when generated targets are excluded', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ALL_FILE_TOOLS);
    const root = member.projectRoot;
    // The team's own choice, made by the test, never by teamai.
    const exclude = path.join(root, '.git', 'info', 'exclude');
    fs.appendFileSync(exclude, ['.teamai/', '.teamai.bak/', '.claude/', '.cursor/', '.codebuddy/', '.workbuddy/', '.opencode/', '.omp/', '.pi/', ''].join('\n'));
    const first = await pullAs(member);
    expect(first.code, first.output).toBe(0);

    fs.writeFileSync(path.join(root, 'app.txt'), 'v2 staged\n');
    git(['add', 'app.txt'], root);
    fs.writeFileSync(path.join(root, 'app.txt'), 'v3 unstaged\n');
    const snapshot = () => ({
      diff: execFileSync('git', ['diff'], { cwd: root, encoding: 'utf8' }),
      staged: execFileSync('git', ['diff', '--cached'], { cwd: root, encoding: 'utf8' }),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
      index: fs.readFileSync(path.join(root, '.git', 'index')).toString('base64'),
      exclude: fs.readFileSync(exclude, 'utf8'),
    });
    const before = snapshot();

    fs.writeFileSync(path.join(memberData(member).teamRepo, 'claudemd', 'common.md'), 'COMMON-SENTINEL, updated instructions.\n');
    const update = await pullAs(member);
    expect(update.code, update.output).toBe(0);

    expect(fs.readFileSync(path.join(root, '.claude', 'rules', 'teamai-context.md'), 'utf8')).toContain('updated instructions');
    expect(snapshot()).toEqual(before);
  });

  it('removes the generated content when recall is disabled, a source is deleted, or a namespace is left', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills', '.omp/skills', '.pi/skills']);
    fs.mkdirSync(path.join(member.home, '.omp'), { recursive: true });
    const context = () => fs.readFileSync(path.join(member.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8');
    expect((await pullAs(member)).code).toBe(0);
    expect(context()).toContain(RECALL_START);
    expect(await sessionInstructions('omp', member.home, member.projectRoot)).toContain('teamai-recall');
    expect(await sessionInstructions('pi', member.home, member.projectRoot)).toContain('teamai recall "');

    const disable = await runCLI(['recall', 'disable'], { HOME: member.home }, member.projectRoot);
    expect(disable.code, disable.output).toBe(0);
    expect(context()).not.toContain(RECALL_START);
    expect(await sessionInstructions('omp', member.home, member.projectRoot)).not.toContain('teamai-recall');
    expect(await sessionInstructions('pi', member.home, member.projectRoot)).not.toContain('teamai recall "');

    const { config, teamRepo } = memberData(member);
    fs.rmSync(path.join(teamRepo, 'claudemd', 'common.md'));
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('primaryRole: developer', 'primaryRole: product'));
    expect((await pullAs(member)).code).toBe(0);
    expect(context()).not.toContain('COMMON-SENTINEL');
    expect(context()).not.toContain('DEVELOPMENT-SENTINEL');
    const omp = await sessionInstructions('omp', member.home, member.projectRoot);
    expect(omp).not.toContain('COMMON-SENTINEL');
    expect(omp).not.toContain('DEVELOPMENT-SENTINEL');
    expect(omp).toContain('PRODUCT-SENTINEL');
  });

  it('reports no OMP channel problem for a member without OMP in a project that has .omp/', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills', '.omp/skills']);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(result.output).not.toMatch(/omp sessions in this project get no team instructions/);
  });

  it('leaves a tracked Copilot file alone for a member without Copilot', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const copilot = path.join(member.projectRoot, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(copilot), { recursive: true });
    // A teammate with Copilot committed their selection; this member has no Copilot.
    fs.writeFileSync(copilot, `# Copilot notes\n\n${CLAUDEMD_START}\nthe teammate's selection\n${CLAUDEMD_END}\n`);
    git(['add', '.github/copilot-instructions.md'], member.projectRoot);
    git(['commit', '-q', '-m', 'copilot instructions'], member.projectRoot);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(execFileSync('git', ['status', '--porcelain', '--', '.github', 'AGENTS.md'], { cwd: member.projectRoot, encoding: 'utf8' })).toBe('');
  });

  it('strips the blocks an earlier release left in a claudemd path the team configured', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox, {
      teamYaml: ['toolPaths:', '  claude:', '    skills: .claude/skills', '    rules: .claude/rules', '    claudemd: CLAUDE.md'],
    });
    const member = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.claude/skills']);
    // An earlier release wrote another member's selection to the configured path.
    const configured = path.join(member.projectRoot, 'CLAUDE.md');
    fs.writeFileSync(configured, `# Project notes\n\n${CLAUDEMD_START}\nPRODUCT-SENTINEL from the last pull\n${CLAUDEMD_END}\n`);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(result.output).toContain(`Removed teamai instruction blocks from ${configured}`);
    expect(fs.readFileSync(configured, 'utf8')).toBe('# Project notes\n');
    expect(fs.readFileSync(path.join(member.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8')).toContain('DEVELOPMENT-SENTINEL');
  });

  it('delivers the team instructions, not a team rule named teamai-context, to the context rule file', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox, { files: { 'rules/teamai-context.md': 'RESERVED-RULE-SENTINEL\n' } });
    const member = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.claude/skills', '.cursor/skills']);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(result.output).toMatch(/rules\/teamai-context\.md is not delivered: teamai-context is the name of teamai's own instruction file/);
    for (const file of [path.join('.claude', 'rules', 'teamai-context.md'), path.join('.cursor', 'rules', 'teamai-context.mdc')]) {
      const content = fs.readFileSync(path.join(member.projectRoot, file), 'utf8');
      expect(content).toContain('DEVELOPMENT-SENTINEL');
      expect(content).not.toContain('RESERVED-RULE-SENTINEL');
    }
  });

  it('does not list a teamai-context.md teamai did not write in OpenCode\'s instructions', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.opencode/skills']);
    const contextFile = path.join(member.projectRoot, '.opencode', 'teamai-context.md');
    fs.writeFileSync(contextFile, '# My own notes\n');
    const config = path.join(member.projectRoot, '.opencode', 'opencode.json');
    fs.writeFileSync(config, JSON.stringify({ instructions: ['docs/style.md'] }, null, 2));

    for (const args of [['--dry-run'], []]) {
      const result = await pullAs(member, args);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(`${contextFile} was not written by teamai`);
      expect(result.output).not.toContain('.opencode/teamai-context.md" to the instructions');
    }

    expect(fs.readFileSync(contextFile, 'utf8')).toBe('# My own notes\n');
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ instructions: ['docs/style.md'] });
  });

  it('activates OpenCode instructions only after repairing a malformed target', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.opencode/skills']);
    const contextFile = path.join(member.projectRoot, '.opencode', 'teamai-context.md');
    const config = path.join(member.projectRoot, '.opencode', 'opencode.json');
    const malformed = `${CULTURE_START}\nOLD-CULTURE\n${CULTURE_END}\n\n${CLAUDEMD_START}\nPRODUCT-STALE\n`;
    fs.writeFileSync(contextFile, malformed);
    fs.writeFileSync(config, JSON.stringify({ instructions: ['docs/style.md'] }));
    for (const args of [['--dry-run'], []]) {
      const pull = await pullAs(member, args);
      expect(pull.code, pull.output).toBe(0);
      expect(pull.output).toContain('incomplete teamai claudemd block');
      expect(fs.readFileSync(contextFile, 'utf8')).toBe(malformed);
      expect(JSON.parse(fs.readFileSync(config, 'utf8')).instructions).toEqual(['docs/style.md']);
      console.log(`pull ${args.join(' ')}: malformed target warned; OpenCode instructions=${JSON.stringify(JSON.parse(fs.readFileSync(config, 'utf8')).instructions)}`);
    }
    fs.writeFileSync(contextFile, `${CLAUDEMD_START}\nPRODUCT-STALE\n${CLAUDEMD_END}\n`);
    const retry = await pullAs(member);
    expect(retry.code, retry.output).toBe(0);
    const content = fs.readFileSync(contextFile, 'utf8');
    expect(content).toContain('DEVELOPMENT-SENTINEL');
    expect(content).not.toContain('PRODUCT-STALE');
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).instructions).toEqual(['docs/style.md', '.opencode/teamai-context.md']);
    console.log('pull after repair: DEVELOPMENT=1 PRODUCT-STALE=0; OpenCode instructions=["docs/style.md",".opencode/teamai-context.md"]');
  });

  it('reports OpenCode delivery only after its config lists the replacement', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-registration-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.opencode/skills']);
    const config = path.join(member.projectRoot, '.opencode', 'opencode.json');
    fs.writeFileSync(config, '{ invalid JSON');
    const blocked = await pullAs(member);
    expect(blocked.code, blocked.output).toBe(0);
    expect(blocked.output).not.toContain('Synced team culture');
    expect(blocked.output).not.toContain('Synced shared instructions');
    expect(fs.readFileSync(config, 'utf8')).toBe('{ invalid JSON');
    expect(fs.readFileSync(path.join(member.projectRoot, '.opencode', 'teamai-context.md'), 'utf8')).toContain('DEVELOPMENT-SENTINEL');
    console.log('pull with malformed OpenCode config: replacement file written; delivery not reported as successful');
    fs.writeFileSync(config, '{}');
    const repaired = await runCLI(['pull'], { HOME: member.home }, member.projectRoot);
    expect(repaired.code, repaired.output).toBe(0);
    expect(repaired.output).toContain('Synced shared instructions');
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).instructions).toEqual(['.opencode/teamai-context.md']);
    console.log('pull after OpenCode config repair: entry listed; delivery reported as successful');
  });

  it('includes a freshly downloaded HTTP prompt in the first real Codex SessionStart', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-first-http-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', []);
    fs.mkdirSync(path.join(member.home, '.codex', 'skills'), { recursive: true });
    const prepared = await pullAs(member);
    expect(prepared.code, prepared.output).toBe(0);
    const workers = path.join(sandbox, 'workers');
    fs.mkdirSync(workers);
    const preload = path.join(sandbox, 'capture-workers.cjs');
    fs.writeFileSync(preload, [
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      `const workers = ${JSON.stringify(workers)};`,
      'const spawn = cp.spawn;',
      'cp.spawn = (command, args, options) => {',
      // Keep the fixture's output pipes open until detached workers exit, so
      // runCLI's close event joins them before server/filesystem teardown.
      "  if (options?.detached) options = { ...options, stdio: [Array.isArray(options.stdio) ? options.stdio[0] : 'ignore', 'inherit', 'inherit'] };",
      '  const child = spawn(command, args, options);',
      "  if (options?.detached && child.pid) fs.writeFileSync(workers + '/' + child.pid + '.started', '');",
      '  return child;',
      '};',
      "require('node:module').syncBuiltinESMExports();",
      "process.on('exit', () => fs.writeFileSync(workers + '/' + process.pid + '.done', ''));",
    ].join('\n'));
    let endpoint = '';
    let syncRequests = 0;
    const acks: Array<{ status: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        if (request.url?.endsWith('/local-agent/sync')) syncRequests++;
        if (request.url?.endsWith('/first.md')) {
          setTimeout(() => response.end('FIRST-HTTP-PROMPT-SENTINEL'), 100);
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.endsWith('/commands/ack')) acks.push(JSON.parse(body));
        response.end(JSON.stringify(request.url?.endsWith('/local-agent/sync') ? {
          ok: true, cmds: [{ id: 1, type: 'install_prompt_rule', handle_type: 'prompt', slug: 'first', version: '1',
            scope: 'workspace', workspace_path: member.projectRoot, download_url: `${endpoint}/first.md`,
          }],
        } : { ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const agentDir = path.join(member.home, '.teamai', 'local-agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({ endpoint, token: 'fixture-token',
        localAgentId: 'fixture', createdAt: '2026-01-01T00:00:00.000Z', workspaceBindings: {},
      }));
      const first = await runCLI(['hook-dispatch', 'session-start', '--tool', 'codex'], { HOME: member.home, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }, member.projectRoot,
        JSON.stringify({ cwd: member.projectRoot, session_id: 'first-http', hook_event_name: 'SessionStart', source: 'startup' }));
      expect(first.code, first.output).toBe(0);
      expect(first.stdout).toContain('FIRST-HTTP-PROMPT-SENTINEL');
      expect(acks).toEqual([expect.objectContaining({ status: 'success' })]);
      const started = fs.readdirSync(workers).filter((file) => file.endsWith('.started'));
      expect(started.length).toBeGreaterThan(0);
      for (const file of started) {
        expect(fs.existsSync(path.join(workers, file.replace('.started', '.done'))), `Worker ${file} must exit before fixture cleanup`).toBe(true);
      }
      console.log('real Codex SessionStart: empty HTTP cache → download ACK success → FIRST-HTTP-PROMPT-SENTINEL in first output');
      const removed = await runCLI(['uninstall', '--agent', 'codex', '--force'], { HOME: member.home }, member.projectRoot);
      expect(removed.code, removed.output).toBe(0);
      const before = syncRequests;
      for (const [event, hook_event_name] of [['session-start', 'SessionStart'], ['subagent-start', 'SubagentStart']] as const) {
        const excluded = await runCLI(['hook-dispatch', event, '--tool', 'codex'], { HOME: member.home, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }, member.projectRoot,
          JSON.stringify({ cwd: member.projectRoot, session_id: 'excluded-http', hook_event_name, source: 'startup' }));
        expect(excluded.code, excluded.output).toBe(0);
        expect(excluded.stdout).not.toContain('FIRST-HTTP-PROMPT-SENTINEL');
      }
      expect(syncRequests).toBe(before);
      console.log('after project Codex uninstall: SessionStart/SubagentStart inject no cached HTTP prompt and send no HTTP sync');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('drops OpenCode\'s instructions entry on uninstall even when the member\'s text keeps the file', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.opencode/skills']);
    const contextFile = path.join(member.projectRoot, '.opencode', 'teamai-context.md');
    const config = path.join(member.projectRoot, '.opencode', 'opencode.json');

    const pull = await pullAs(member);
    expect(pull.code, pull.output).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).instructions).toEqual(['.opencode/teamai-context.md']);
    fs.appendFileSync(contextFile, '\n# My own notes\n');

    const uninstall = await runCLI(['uninstall', '--agent', 'opencode', '--force'], { HOME: member.home }, member.projectRoot);
    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.readFileSync(contextFile, 'utf8')).toBe('# My own notes\n');
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).instructions ?? []).toEqual([]);
  });
});

// #993 bug 6: OpenCode V2 parses `instructions` and ignores it, so teamai's
// plugin in HOME reads the files itself in its V2 setup.
describe('OpenCode V2 delivery through the teamai plugin (#993 bug 6)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The sandbox env for a member: HOME, its XDG config and no system git config. */
  const isolated = (home: string): Record<string, string> => ({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' });

  /** What the plugin the CLI installed adds to a V2 session's system prompt in `directory`, through `hook`. */
  async function systemTexts(home: string, directory: string, hook: 'context' | 'compaction'): Promise<string[]> {
    const source = fs.readFileSync(path.join(home, '.config', 'opencode', 'plugin', 'teamai-hooks.ts'), 'utf8');
    const host = await loadV2Plugin(source, {}, directory);
    const event = { sessionID: 'ses_v2', system: [] as Array<{ type: string; text: string }> };
    await host.callbacks[`session.${hook}`](event);
    await host.cleanup?.();
    return event.system.map((part) => part.text);
  }
  const sources = (texts: string[]): string[] => texts.map((text) => text.split('\n')[0].replace('Instructions from: ', ''));

  it('adds the nearest project\'s context and rules, and the user-scope ones everywhere, on context and compaction', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-993-oc-v2-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox, { files: { 'rules/style.md': 'RULE-SENTINEL: keep functions small.\n' } });
    const member = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.opencode/skills']);
    const userDir = path.join(member.home, '.config', 'opencode');
    fs.mkdirSync(path.join(userDir, 'rules', 'ns'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'teamai-context.md'), 'USER-CONTEXT-SENTINEL\n');
    fs.writeFileSync(path.join(userDir, 'rules', 'z.md'), 'USER-RULE-Z\n');
    fs.writeFileSync(path.join(userDir, 'rules', 'ns', 'a.md'), 'USER-RULE-NS-A\n');
    fs.writeFileSync(path.join(userDir, 'rules', 'notes.txt'), 'not a rule\n');

    const pulled = await pullAs(member, [], isolated(member.home));
    expect(pulled.code, pulled.output).toBe(0);

    const deep = path.join(member.projectRoot, 'src', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    const inProject = await systemTexts(member.home, deep, 'context');
    const userSources = [path.join(userDir, 'teamai-context.md'), path.join(userDir, 'rules', 'ns', 'a.md'), path.join(userDir, 'rules', 'z.md')];
    const projectContext = path.join(member.projectRoot, '.opencode', 'teamai-context.md');
    expect(sources(inProject).slice(0, 4)).toEqual([...userSources, projectContext]);
    expect(inProject[0]).toBe(`Instructions from: ${userSources[0]}\nUSER-CONTEXT-SENTINEL\n`);
    expect(inProject[3]).toContain('DEVELOPMENT-SENTINEL');
    const rulesDir = path.join(member.projectRoot, '.opencode', 'rules');
    const projectRules = sources(inProject).slice(4);
    expect(projectRules).toContain(path.join(rulesDir, 'style.md'));
    expect(projectRules).toEqual([...projectRules].sort());
    expect(projectRules.every((file) => file.startsWith(rulesDir + path.sep))).toBe(true);
    expect(inProject.join('\n')).toContain('RULE-SENTINEL');

    expect(await systemTexts(member.home, deep, 'compaction')).toEqual(inProject);
    expect(sources(await systemTexts(member.home, sandbox, 'context'))).toEqual(userSources);
  });

  it('has doctor check the plugin on OpenCode V2 and `instructions` on V1', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-993-oc-v2-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox, { files: { 'rules/style.md': 'RULE-SENTINEL: keep functions small.\n' } });
    const member = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.opencode/skills']);
    const bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    /** `opencode` on PATH prints `version`, as the installed binary does. */
    const withOpencode = (version: string): Record<string, string> => {
      fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\necho '${version}'\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'opencode.cmd'), `@echo ${version}\r\n`);
      return { ...isolated(member.home), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    };
    const doctor = async (env: Record<string, string>): Promise<Map<string, { ok: boolean; fix?: string }>> => {
      const run = await runCLI(['doctor', '--json'], env, member.projectRoot);
      const report = JSON.parse(run.stdout) as { checks: Array<{ name: string; ok: boolean; fix?: string }> };
      return new Map(report.checks.map((c) => [c.name, c]));
    };
    const pulled = await pullAs(member, [], withOpencode('opencode v2.0.24'));
    expect(pulled.code, pulled.output).toBe(0);
    // V2 ignores these entries: doctor does not ask for them.
    fs.writeFileSync(path.join(member.projectRoot, '.opencode', 'opencode.json'), '{}\n');

    const v2 = await doctor(withOpencode('opencode v2.0.24'));
    expect(v2.get('Team rules are active in opencode')?.ok).toBe(true);
    expect(v2.get('opencode adds the team instructions to its prompt')?.ok).toBe(true);
    expect(v2.has('Team instructions are listed in opencode instructions')).toBe(false);

    const plugin = path.join(member.home, '.config', 'opencode', 'plugin', 'teamai-hooks.ts');
    fs.rmSync(plugin);
    const noPlugin = await doctor(withOpencode('opencode v2.0.24'));
    for (const name of ['Team rules are active in opencode', 'opencode adds the team instructions to its prompt']) {
      expect(noPlugin.get(name)).toMatchObject({ ok: false });
      expect(noPlugin.get(name)?.fix).toContain(plugin);
    }

    const v1 = await doctor(withOpencode('1.18.35'));
    expect(v1.get('Team rules are active in opencode')).toMatchObject({ ok: false });
    expect(v1.get('Team rules are active in opencode')?.fix).toContain('`instructions`');
    expect(v1.get('Team instructions are listed in opencode instructions')).toMatchObject({ ok: false });
    expect(v1.has('opencode adds the team instructions to its prompt')).toBe(false);
  });
});
