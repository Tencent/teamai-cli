import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { managedMcpWorkspaceId } from '../../types.js';
import { claudeHookOtherHostSkip } from '../../hooks.js';
import { projectSlug } from '../../utils/partition.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(cwd: string, home: string, args = ['hooks', 'inject']): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('issue #373 project hook isolation (real CLI)', () => {
  let sandbox: string;
  let home: string;
  let projectA: string;
  let projectB: string;
  let worktreeA: string;

  type Settings = { hooks: { SessionStart?: Array<unknown>; Stop: Array<{ description?: string; hooks: Array<{ command: string }> }> } };
  const expectedCommand = (file: string, command: string): string =>
    file.includes('.claude') ? `${claudeHookOtherHostSkip('Stop', undefined, command)}${command}` : command;
  const readSettings = (file: string): Settings => JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
  const mainFiles = (project: string): string[] => [
    path.join(project, '.claude', 'settings.local.json'),
    path.join(project, '.codex', 'hooks.json'),
  ];

  beforeEach(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before e2e tests');
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-373-e2e-'));
    home = path.join(sandbox, 'home');
    projectA = path.join(sandbox, 'project-a');
    projectB = path.join(sandbox, 'project-b');
    worktreeA = path.join(sandbox, 'worktree-a');
    for (const tool of ['.claude', '.codex', '.codebuddy']) {
      fs.mkdirSync(path.join(home, tool), { recursive: true });
    }
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(project, '.teamai', 'team-repo', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), [
        'repo:',
        `  localPath: ${path.join(project, '.teamai', 'team-repo')}`,
        '  remote: https://example.test/team.git',
        'username: e2e',
        'scope: project',
        'codexTrustEnabled: false',
        `projectRoot: ${project}`,
      ].join('\n') + '\n');
    }
    fs.writeFileSync(path.join(projectA, '.teamai', 'team-repo', 'teamai.yaml'), [
      'team: e2e-team', 'repo: https://example.test/team.git',
      'toolPaths:', '  claude:', '    settings: .claude/settings.json',
      '  codex:', '    settings: .codex/hooks.json',
      '  codebuddy:', '    settings: .codebuddy/settings.json',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectB, '.teamai', 'team-repo', 'teamai.yaml'), [
      'team: e2e-team', 'repo: https://example.test/team.git',
      'toolPaths:', '  claude:', '    settings: .claude/settings.json',
      '  codex:', '    settings: .codex/hooks.json',
      '  codebuddy:', '    settings: .codebuddy/settings.json',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectA, '.teamai', 'team-repo', 'hooks', 'hooks.yaml'), [
      'hooks:', '  - id: a', '    description: project a', '    event: Stop', '    command: echo A',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectB, '.teamai', 'team-repo', 'hooks', 'hooks.yaml'), [
      'hooks:', '  - id: b', '    description: project b', '    event: Stop', '    command: echo B',
    ].join('\n') + '\n');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
    };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectA, env: gitEnv });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'fixture'], { cwd: projectA, env: gitEnv });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'worktree-a', worktreeA], { cwd: projectA, env: gitEnv });
  });

  const installWorktreeConfig = (): void => {
    fs.mkdirSync(path.join(worktreeA, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(worktreeA, '.teamai', 'config.yaml'),
      fs.readFileSync(path.join(projectA, '.teamai', 'config.yaml'), 'utf8')
        .replace(`projectRoot: ${projectA}`, `projectRoot: ${worktreeA}`));
  };

  afterEach(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

  it('injects both projects, gates execution by cwd, and removes only the caller project', async () => {
    const a = await runCLI(projectA, home);
    const b = await runCLI(projectB, home);
    expect(a.code, a.output).toBe(0);
    expect(b.code, b.output).toBe(0);

    for (const [project, command] of [[projectA, 'echo A'], [projectB, 'echo B']]) {
      for (const file of mainFiles(project)) {
        const settings = readSettings(file);
        expect(settings.hooks.Stop.map((entry) => entry.hooks[0].command)).toEqual([expectedCommand(file, command)]);
        expect(settings.hooks.SessionStart).toBeUndefined();
      }
    }
    for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
      const settings = readSettings(path.join(home, file));
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.Stop.map((entry) => entry.hooks[0].command).join('\n')).not.toMatch(/echo [AB]/);
    }

    // CodeBuddy still shares HOME and gates each project's team hooks by cwd.
    const settingsPath = path.join(home, '.codebuddy', 'settings.json');
    const team = readSettings(settingsPath).hooks.Stop.filter((entry) => entry.description?.startsWith('[teamai:hook:'));
    expect(team).toHaveLength(2);
    const commandA = team.find((entry) => entry.hooks[0].command.includes('echo A'))!.hooks[0].command;
    const commandB = team.find((entry) => entry.hooks[0].command.includes('echo B'))!.hooks[0].command;
    expect(commandA).toContain('$PWD');
    expect(commandB).toContain('$PWD');
    expect(execFileSync('sh', ['-c', commandA], { cwd: projectA, encoding: 'utf8' })).toBe('A\n');
    expect(execFileSync('sh', ['-c', commandA], { cwd: projectB, encoding: 'utf8' })).toBe('');
    expect(execFileSync('sh', ['-c', commandB], { cwd: projectB, encoding: 'utf8' })).toBe('B\n');
    expect(execFileSync('sh', ['-c', commandB], { cwd: projectA, encoding: 'utf8' })).toBe('');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'managed-hooks.json'), 'utf8')).codebuddy).toHaveLength(2);

    const removed = await runCLI(projectA, home, ['hooks', 'remove']);
    expect(removed.code, removed.output).toBe(0);
    for (const file of mainFiles(projectA)) expect(readSettings(file).hooks.Stop ?? []).toEqual([]);
    for (const file of mainFiles(projectB)) {
      expect(readSettings(file).hooks.Stop.map((entry) => entry.hooks[0].command)).toEqual([expectedCommand(file, 'echo B')]);
    }
    const remaining = readSettings(settingsPath).hooks.Stop.filter((entry) => entry.description?.startsWith('[teamai:hook:'));
    expect(remaining.map((entry) => entry.hooks[0].command)).toEqual([commandB]);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'managed-hooks.json'), 'utf8')).codebuddy).toHaveLength(1);
    for (const project of [projectA, projectB]) {
      expect(fs.existsSync(path.join(project, '.codebuddy', 'settings.json'))).toBe(false);
    }
  });

  it('shares one ungated Claude/Codex team-hook file in the main checkout with a linked worktree', async () => {
    installWorktreeConfig();
    const main = await runCLI(projectA, home);
    expect(main.code, main.output).toBe(0);
    const before = mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'));

    const linked = await runCLI(worktreeA, home);
    expect(linked.code, linked.output).toBe(0);
    expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before);
    for (const file of mainFiles(worktreeA)) expect(fs.existsSync(file)).toBe(false);
    for (const file of mainFiles(projectA)) {
      const [command] = readSettings(file).hooks.Stop.map((entry) => entry.hooks[0].command);
      expect(command).toBe(expectedCommand(file, 'echo A'));
      expect(command).not.toContain('$PWD');
      expect(execFileSync('sh', ['-c', command], { cwd: worktreeA, encoding: 'utf8' })).toBe('A\n');
      if (file.includes('.claude')) {
        // The main-checkout layout preserves #950's other-host check without a cwd gate.
        const cursorFile = path.join(home, '.cursor', 'hooks.json');
        const env = { ...process.env, HOME: home, CURSOR_VERSION: 'test', CURSOR_PROJECT_DIR: '', COPILOT_PROJECT_DIR: '' };
        fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
        fs.writeFileSync(cursorFile, JSON.stringify({ hooks: { stop: [{ command: 'teamai hook-dispatch stop --tool cursor' }] } }));
        expect(execFileSync('sh', ['-c', command], { cwd: worktreeA, env, encoding: 'utf8' })).toBe('');
        fs.rmSync(cursorFile);
        expect(execFileSync('sh', ['-c', command], { cwd: worktreeA, env, encoding: 'utf8' })).toBe('A\n');
      }
    }
  });

  // v0.22.0 recorded the worktree's copy in the worktree's own data home and
  // appended a second entry to each main-checkout file.
  const seedOlderWorktreeInstall = (): void => {
    const ownership = JSON.parse(fs.readFileSync(path.join(projectA, '.teamai', 'managed-main-checkout-hooks.json'), 'utf8'));
    ownership.codex[0].codexEntryIndex = 1;
    fs.writeFileSync(path.join(worktreeA, '.teamai', 'managed-main-checkout-hooks.json'), JSON.stringify(ownership));
    for (const file of mainFiles(projectA)) {
      const settings = readSettings(file);
      settings.hooks.Stop.push(settings.hooks.Stop[0]);
      fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    }
  };

  it('removes the duplicate team hooks an older CLI appended from a linked worktree', async () => {
    installWorktreeConfig();
    const injected = await runCLI(projectA, home);
    expect(injected.code, injected.output).toBe(0);
    const single = mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'));
    seedOlderWorktreeInstall();

    const linked = await runCLI(worktreeA, home);
    expect(linked.code, linked.output).toBe(0);
    expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(single);
    const main = await runCLI(projectA, home);
    expect(main.code, main.output).toBe(0);
    expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(single);
  });

  it('keeps one main checkout team hook when a linked worktree with an older install removes its own', async () => {
    installWorktreeConfig();
    const injected = await runCLI(projectA, home);
    expect(injected.code, injected.output).toBe(0);
    const single = mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'));
    for (const args of [['hooks', 'remove'], ['uninstall', '--force']]) {
      seedOlderWorktreeInstall();
      const removed = await runCLI(worktreeA, home, args);
      expect(removed.code, removed.output).toBe(0);
      expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8')), args.join(' ')).toEqual(single);
    }
  });

  it.each([['hooks', 'remove'], ['uninstall', '--force']])(
    'main checkout %s releases its duplicated hooks and preserves the worktree copy',
    async (...args) => {
      installWorktreeConfig();
      const injected = await runCLI(projectA, home);
      expect(injected.code, injected.output).toBe(0);
      const single = mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'));
      seedOlderWorktreeInstall();
      const removed = await runCLI(projectA, home, args);
      expect(removed.code, removed.output).toBe(0);
      expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(single);
    },
  );

  it.each(['main', 'worktree'])('keeps the shared hook after main reinjects an older duplicated install, then %s removes', async (checkout) => {
    installWorktreeConfig();
    const injected = await runCLI(projectA, home);
    expect(injected.code, injected.output).toBe(0);
    seedOlderWorktreeInstall();
    const reinjected = await runCLI(projectA, home);
    expect(reinjected.code, reinjected.output).toBe(0);
    const removed = await runCLI(checkout === 'main' ? projectA : worktreeA, home, ['hooks', 'remove']);
    expect(removed.code, removed.output).toBe(0);
    for (const file of mainFiles(projectA)) expect(readSettings(file).hooks.Stop).toHaveLength(1);
  });

  it.each([[true, false], [true, true], [false, false]])('targeted Claude uninstall preserves Codex ownership with main = %s and legacy tracking = %s', async (mainInstalled, legacyTracking) => {
    installWorktreeConfig();
    if (mainInstalled) {
      const injected = await runCLI(projectA, home);
      expect(injected.code, injected.output).toBe(0);
    } else {
      fs.rmSync(path.join(projectA, '.teamai', 'config.yaml'));
    }
    const injected = await runCLI(worktreeA, home);
    expect(injected.code, injected.output).toBe(0);
    const manifestFile = path.join(projectA, '.teamai', 'managed-main-checkout-hooks.json');
    if (legacyTracking) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      manifest.checkouts = manifest.checkouts.codex;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    const removed = await runCLI(worktreeA, home, ['uninstall', '--agent', 'claude', '--force']);
    expect(removed.code, removed.output).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    expect(manifest.checkouts.codex).toContain(fs.realpathSync(worktreeA));
    expect(manifest.codex).toHaveLength(1);
    if (mainInstalled) {
      const removedMain = await runCLI(projectA, home, ['hooks', 'remove']);
      expect(removedMain.code, removedMain.output).toBe(0);
    }
    expect(readSettings(mainFiles(projectA)[1]).hooks.Stop).toHaveLength(1);
  });

  it.each(['enabledAgents: [codex]', 'disabledAgents: [claude]'])('releases the last Claude hook when main excludes Claude through %s', async (selection) => {
    installWorktreeConfig();
    fs.appendFileSync(path.join(projectA, '.teamai', 'config.yaml'), `${selection}\n`);
    for (const checkout of [projectA, worktreeA]) {
      const injected = await runCLI(checkout, home);
      expect(injected.code, injected.output).toBe(0);
    }
    const removed = await runCLI(worktreeA, home, ['hooks', 'remove']);
    expect(removed.code, removed.output).toBe(0);
    expect(readSettings(mainFiles(projectA)[0]).hooks.Stop ?? []).toHaveLength(0);
    expect(readSettings(mainFiles(projectA)[1]).hooks.Stop).toHaveLength(1);
  });

  it('uninstalls the remaining legacy worktree hook after main releases its copy', async () => {
    installWorktreeConfig();
    const injected = await runCLI(projectA, home);
    expect(injected.code, injected.output).toBe(0);
    seedOlderWorktreeInstall();
    const removedMain = await runCLI(projectA, home, ['hooks', 'remove']);
    expect(removedMain.code, removedMain.output).toBe(0);
    for (const file of mainFiles(projectA)) expect(readSettings(file).hooks.Stop).toHaveLength(1);
    const uninstalled = await runCLI(worktreeA, home, ['uninstall', '--force']);
    expect(uninstalled.code, uninstalled.output).toBe(0);
    for (const file of mainFiles(projectA)) expect(readSettings(file).hooks.Stop ?? []).toHaveLength(0);
  });

  it.each([
    { order: [0, 1, 2] }, { order: [0, 2, 1] }, { order: [1, 0, 2] },
    { order: [1, 2, 0] }, { order: [2, 0, 1] }, { order: [2, 1, 0] },
  ])('removes legacy Codex copies in order $order and keeps an identical user entry', async ({ order }) => {
    installWorktreeConfig();
    const second = path.join(sandbox, 'worktree-a2');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'worktree-a2', second], { cwd: projectA });
    fs.mkdirSync(path.join(second, '.teamai'));
    fs.writeFileSync(path.join(second, '.teamai', 'config.yaml'),
      fs.readFileSync(path.join(worktreeA, '.teamai', 'config.yaml'), 'utf8').replace(`projectRoot: ${worktreeA}`, `projectRoot: ${second}`));
    const injected = await runCLI(projectA, home);
    expect(injected.code, injected.output).toBe(0);
    seedOlderWorktreeInstall();
    const manifestFile = path.join(worktreeA, '.teamai', 'managed-main-checkout-hooks.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.codex[0].codexEntryIndex = 2;
    fs.writeFileSync(path.join(second, '.teamai', 'managed-main-checkout-hooks.json'), JSON.stringify(manifest));
    for (const file of mainFiles(projectA)) {
      const settings = readSettings(file);
      settings.hooks.Stop.push(settings.hooks.Stop[0]);
      fs.writeFileSync(file, JSON.stringify(settings));
    }
    const codexFile = mainFiles(projectA)[1];
    const codex = readSettings(codexFile);
    const userEntry = codex.hooks.Stop[0];
    codex.hooks.Stop.push(userEntry);
    fs.writeFileSync(codexFile, JSON.stringify(codex));
    const checkouts = [projectA, worktreeA, second];
    for (const [step, index] of order.entries()) {
      const checkout = checkouts[index];
      const removed = await runCLI(checkout, home, ['hooks', 'remove']);
      expect(removed.code, removed.output).toBe(0);
      expect(readSettings(codexFile).hooks.Stop ?? [], checkout).toHaveLength(3 - step);
    }
    expect(readSettings(codexFile).hooks.Stop).toEqual([userEntry]);
  });

  it('removes only the caller hook file in an installed bare worktree', async () => {
    const bare = path.join(sandbox, 'bare.git');
    const teamRepo = path.join(sandbox, 'bare-team');
    fs.cpSync(path.join(projectA, '.teamai', 'team-repo'), teamRepo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-q', bare]);
    const worktrees = [path.join(sandbox, 'bare-a'), path.join(sandbox, 'bare-b')];
    for (const worktree of worktrees) {
      execFileSync('git', ['--git-dir', bare, 'worktree', 'add', '--orphan', worktree]);
      fs.mkdirSync(path.join(worktree, '.teamai'));
      fs.writeFileSync(path.join(worktree, '.teamai', 'config.yaml'),
        fs.readFileSync(path.join(projectB, '.teamai', 'config.yaml'), 'utf8')
          .replace(path.join(projectB, '.teamai', 'team-repo'), teamRepo)
          .replace(`projectRoot: ${projectB}`, `projectRoot: ${worktree}`));
    }
    for (const worktree of worktrees) {
      const injected = await runCLI(worktree, home);
      expect(injected.code, injected.output).toBe(0);
    }
    const removed = await runCLI(worktrees[0], home, ['hooks', 'remove']);
    expect(removed.code, removed.output).toBe(0);
    for (const file of mainFiles(worktrees[0])) expect(readSettings(file).hooks.Stop ?? []).toHaveLength(0);
    for (const file of mainFiles(worktrees[1])) expect(readSettings(file).hooks.Stop).toHaveLength(1);
    const removedSecond = await runCLI(worktrees[1], home, ['hooks', 'remove']);
    expect(removedSecond.code, removedSecond.output).toBe(0);
    for (const file of mainFiles(worktrees[1])) expect(readSettings(file).hooks.Stop ?? []).toHaveLength(0);
  });

  it.each([false, true])('clears absent shared hook ownership with targeted uninstall = %s', async (targeted) => {
    installWorktreeConfig();
    const teamRepo = path.join(sandbox, 'absent-hook-team');
    fs.renameSync(path.join(projectA, '.teamai', 'team-repo'), teamRepo);
    const configFile = path.join(worktreeA, '.teamai', 'config.yaml');
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8')
      .replace(path.join(projectA, '.teamai', 'team-repo'), teamRepo));
    fs.rmSync(path.join(projectA, '.teamai'), { recursive: true });
    const injected = await runCLI(worktreeA, home);
    expect(injected.code, injected.output).toBe(0);
    for (const file of targeted ? mainFiles(projectA).slice(0, 1) : mainFiles(projectA)) fs.rmSync(file);
    const removed = await runCLI(worktreeA, home,
      ['uninstall', '--force', ...(targeted ? ['--agent', 'claude'] : [])]);
    expect(removed.code, removed.output).toBe(0);
    const manifestFile = path.join(projectA, '.teamai', 'managed-main-checkout-hooks.json');
    if (targeted) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      expect(manifest.claude ?? []).toEqual([]);
      expect(manifest.codex).toHaveLength(1);
      expect(manifest.checkouts.codex).toEqual([fs.realpathSync(worktreeA)]);
      expect(readSettings(mainFiles(projectA)[1]).hooks.Stop).toHaveLength(1);
      const remaining = await runCLI(worktreeA, home, ['uninstall', '--force']);
      expect(remaining.code, remaining.output).toBe(0);
    }
    expect(fs.existsSync(manifestFile)).toBe(false);
    expect(fs.existsSync(path.join(projectA, '.teamai'))).toBe(false);
    expect(fs.existsSync(path.join(worktreeA, '.teamai'))).toBe(false);
  });

  it.each([false, true])('retains shared partition hooks for an uninjected linked worktree with legacy tracking = %s', async (legacyTracking) => {
    const partition = path.join(home, '.teamai', 'projects', projectSlug(fs.realpathSync(projectA)));
    fs.mkdirSync(path.dirname(partition), { recursive: true });
    fs.renameSync(path.join(projectA, '.teamai'), partition);
    const configFile = path.join(partition, 'config.yaml');
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8')
      .replace(path.join(projectA, '.teamai', 'team-repo'), path.join(partition, 'team-repo')));
    expect(fs.existsSync(path.join(worktreeA, '.teamai', 'config.yaml'))).toBe(false);
    const injected = await runCLI(projectA, home);
    expect(injected.code, injected.output).toBe(0);
    if (legacyTracking) {
      const manifestFile = path.join(partition, 'workspaces', managedMcpWorkspaceId(fs.realpathSync(projectA)), 'managed-main-checkout-hooks.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      delete manifest.checkouts;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    for (const [checkout, left] of [[projectA, 1], [worktreeA, 0]] as const) {
      const removed = await runCLI(checkout, home, ['hooks', 'remove']);
      expect(removed.code, removed.output).toBe(0);
      for (const file of mainFiles(projectA)) expect(readSettings(file).hooks.Stop ?? [], checkout).toHaveLength(left);
    }
  });

  it.each([
    { caller: 'main', targeted: false }, { caller: 'linked', targeted: false },
    { caller: 'main', targeted: true }, { caller: 'linked', targeted: true },
  ])('removes selected shared partition hooks from $caller with targeted = $targeted', async ({ caller, targeted }) => {
    const partition = path.join(home, '.teamai', 'projects', projectSlug(fs.realpathSync(projectA)));
    fs.mkdirSync(path.dirname(partition), { recursive: true });
    fs.renameSync(path.join(projectA, '.teamai'), partition);
    const configFile = path.join(partition, 'config.yaml');
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8')
      .replace(path.join(projectA, '.teamai', 'team-repo'), path.join(partition, 'team-repo')));
    for (const checkout of [projectA, worktreeA]) {
      const injected = await runCLI(checkout, home);
      expect(injected.code, injected.output).toBe(0);
    }
    const uninstalled = await runCLI(caller === 'main' ? projectA : worktreeA, home,
      ['uninstall', '--force', ...(targeted ? ['--agent', 'claude'] : [])]);
    expect(uninstalled.code, uninstalled.output).toBe(0);
    expect(readSettings(mainFiles(projectA)[0]).hooks.Stop ?? []).toHaveLength(0);
    expect(readSettings(mainFiles(projectA)[1]).hooks.Stop ?? []).toHaveLength(targeted ? 1 : 0);
    expect(fs.existsSync(partition)).toBe(targeted);
    if (targeted) {
      const manifest = JSON.parse(fs.readFileSync(path.join(partition, 'workspaces', managedMcpWorkspaceId(fs.realpathSync(projectA)), 'managed-main-checkout-hooks.json'), 'utf8'));
      expect(manifest.checkouts.claude ?? []).toEqual([]);
      expect(manifest.checkouts.codex).toHaveLength(2);
      expect(manifest.codex).toHaveLength(1);
      expect(fs.readFileSync(configFile, 'utf8')).toContain('claude');
    }
  });

  it('shares one main checkout team hook between two worktree installs when the main checkout has none', async () => {
    const projectC = path.join(sandbox, 'project-c');
    const teamRepo = path.join(sandbox, 'team-c');
    const worktrees = [path.join(sandbox, 'worktree-c1'), path.join(sandbox, 'worktree-c2')];
    fs.cpSync(path.join(projectA, '.teamai', 'team-repo'), teamRepo, { recursive: true });
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
    };
    fs.mkdirSync(projectC);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectC, env: gitEnv });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'fixture'], { cwd: projectC, env: gitEnv });
    for (const [i, worktree] of worktrees.entries()) {
      execFileSync('git', ['worktree', 'add', '-q', '-b', `worktree-c${i + 1}`, worktree], { cwd: projectC, env: gitEnv });
      fs.mkdirSync(path.join(worktree, '.teamai'));
      fs.writeFileSync(path.join(worktree, '.teamai', 'config.yaml'),
        fs.readFileSync(path.join(projectB, '.teamai', 'config.yaml'), 'utf8')
          .replace(path.join(projectB, '.teamai', 'team-repo'), teamRepo)
          .replace(`projectRoot: ${projectB}`, `projectRoot: ${worktree}`));
    }
    const stops = (): number[] => mainFiles(projectC).map((file) => (readSettings(file).hooks.Stop ?? []).length);

    for (const worktree of worktrees) {
      const injected = await runCLI(worktree, home);
      expect(injected.code, injected.output).toBe(0);
    }
    expect(stops()).toEqual([1, 1]);
    for (const [worktree, left] of [[worktrees[0], [1, 1]], [worktrees[1], [0, 0]]] as const) {
      const removed = await runCLI(worktree, home, ['uninstall', '--force']);
      expect(removed.code, removed.output).toBe(0);
      expect(stops(), worktree).toEqual(left);
    }
  });
});
