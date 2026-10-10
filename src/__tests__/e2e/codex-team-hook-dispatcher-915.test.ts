/**
 * E2E (#915): when a project's `.codex/hooks.json` holds entries teamai does not
 * own (the team tracks it, or the member added their own), teamai stops writing
 * the team's Codex hooks into it. They run from one dispatcher entry per event
 * in `~/.codex/hooks.json` (`teamai hook-dispatch <E> --tool codex
 * --team-hooks`), which finds the project from the hook's `cwd`. The switch
 * happens on the pull that sees the change, both ways, and only while
 * `sharing.gitExclude` is on.
 *
 * The dispatcher is invoked as Codex would: the command from
 * `~/.codex/hooks.json`, through a shell, with the hook payload on stdin and the
 * session's cwd. Each case gets its own HOME, team remote and business repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeCodex } from '../helpers/fake-codex.js';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; stdout: string; stderr: string; output: string }

let sandbox: string;
let fakeCodexDir: string;
let detached: ReturnType<typeof trackDetachedProcesses>;

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const readJson = (file: string): any => JSON.parse(read(file));
const writeJson = (file: string, data: unknown): void => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

interface TeamHook { id: string; event: string; command: string; matcher?: string; timeout?: number }

const hooksYaml = (hooks: TeamHook[]): string => `hooks:\n${hooks.map((h) => [
  `  - id: ${h.id}`,
  `    description: ${h.id}`,
  `    event: ${h.event}`,
  `    command: ${JSON.stringify(h.command)}`,
  ...h.matcher ? [`    matcher: ${h.matcher}`] : [],
  ...h.timeout !== undefined ? [`    timeout: ${h.timeout}`] : [],
].join('\n')).join('\n')}\n`;

const teamaiYaml = (name: string, url: string, gitExclude: boolean): string => [
  `team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []',
  'sharing:', ...gitExclude ? ['  gitExclude:', '    enabled: true'] : [],
  '  hooks:', '    autoApply: true', '    requireTeamScripts: false', '  coAuthor:', '    enabled: false', '',
].join('\n');

/** The team's own hook file, as a business repo might commit it. */
const TEAM_OWN_HOOKS = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo team-own' }] }] } }, null, 2)}\n`;

/** One member's machine: a HOME, a team remote, and a business repo with teamai set up. */
interface Machine {
  caseDir: string;
  dir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  ok(args: string[]): Run;
  git(args: string[], cwd?: string): string;
  status(): string[];
  deliveredLines(): string[];
  teamCommit(files: Record<string, string | null>): void;
  /** The Codex hook file in HOME, or null. */
  homeHooks(): any;
  /** Run the dispatcher entry `~/.codex/hooks.json` holds for `event`, as Codex would. */
  dispatch(event: string, payload: Record<string, unknown>, cwd?: string): Run & { ms: number };
}

interface MachineOptions {
  hooks: TeamHook[];
  gitExclude?: boolean;
  committed?: Record<string, string>;
  business?: Record<string, string>;
}

function machine(base: string, opts: MachineOptions): Machine {
  const caseDir = fs.mkdtempSync(path.join(sandbox, `${base}-`));
  const name = path.basename(caseDir);
  const home = path.join(caseDir, 'home');
  for (const dir of ['.claude', '.codex']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    CODEX_HOME: path.join(home, '.codex'),
    PATH: `${fakeCodexDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FORCE_COLOR: '0',
    // Every teamai process, git hooks' included, registers what it detaches, so afterAll can join it.
    NODE_OPTIONS: detached.nodeOptions,
  };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (command: string, args: string[], cwd: string, input = ''): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.stdout;
  };
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(caseDir, 'seed');
  const remote = path.join(caseDir, 'team.git');
  writeFile(path.join(seed, 'teamai.yaml'), teamaiYaml(name, url, opts.gitExclude ?? true));
  writeFile(path.join(seed, 'hooks', 'hooks.yaml'), hooksYaml(opts.hooks));
  gitOk(['init', '-q', '-b', 'main'], seed);
  gitOk(['add', '-A'], seed);
  gitOk(['commit', '-q', '-m', 'seed'], seed);
  gitOk(['clone', '-q', '--bare', seed, remote], caseDir);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], caseDir);

  const dir = path.join(caseDir, 'biz');
  writeFile(path.join(dir, 'README.md'), '# app\n');
  for (const [rel, content] of Object.entries(opts.committed ?? {})) writeFile(path.join(dir, rel), content);
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(opts.business ?? {})) writeFile(path.join(dir, rel), content);
  const realDir = fs.realpathSync.native(dir);

  const ok = (args: string[]): Run => {
    const r = run(process.execPath, [CLI, ...args], realDir);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
    return r;
  };
  const excludeFile = path.join(realDir, '.git', 'info', 'exclude');
  const homeHooksFile = path.join(home, '.codex', 'hooks.json');
  ok(['init', url, '--provider', 'git', '--agent', 'codex', '--scope', 'project', '--force']);
  return {
    caseDir,
    dir: realDir,
    home,
    env,
    ok,
    git: (args, cwd = realDir) => gitOk(args, cwd),
    status: () => gitOk(['status', '--porcelain', '-uall'], realDir).split('\n').filter(Boolean),
    deliveredLines: () => {
      const lines = fs.existsSync(excludeFile) ? read(excludeFile).split('\n') : [];
      const start = lines.indexOf('# [teamai:delivered:start]');
      const end = lines.indexOf('# [teamai:delivered:end]');
      return start < 0 || end < start ? [] : lines.slice(start + 1, end);
    },
    teamCommit: (files) => {
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) fs.rmSync(path.join(seed, rel), { force: true });
        else writeFile(path.join(seed, rel), content);
      }
      gitOk(['add', '-A'], seed);
      gitOk(['commit', '-q', '-m', 'team change'], seed);
      gitOk(['push', '-q', remote, 'main'], seed);
    },
    homeHooks: () => (fs.existsSync(homeHooksFile) ? readJson(homeHooksFile) : null),
    dispatch: (event, payload, cwd = realDir) => {
      const entry = dispatcherEntries(readJson(homeHooksFile), event)[0];
      if (!entry) throw new Error(`no dispatcher entry for ${event} in ${homeHooksFile}`);
      const started = Date.now();
      const r = spawnSync('/bin/sh', ['-c', entry.hooks[0].command], {
        cwd,
        encoding: 'utf8',
        env,
        input: JSON.stringify({ hook_event_name: event, cwd, session_id: 's1', ...payload }),
      });
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}`, ms: Date.now() - started };
    },
  };
}

/** The team-hook dispatcher entries of `event` in a Codex hook file. */
function dispatcherEntries(hooksJson: any, event: string): any[] {
  return (hooksJson?.hooks?.[event] ?? []).filter((group: any) =>
    /hook-dispatch \S+ --tool codex --team-hooks/.test(group.hooks?.[0]?.command ?? ''));
}

/** Every event that has a dispatcher entry in a Codex hook file. */
function dispatcherEvents(hooksJson: any): string[] {
  return Object.keys(hooksJson?.hooks ?? {}).filter((event) => dispatcherEntries(hooksJson, event).length > 0).sort();
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatcher-e2e-')));
  fakeCodexDir = installFakeCodex();
  detached = trackDetachedProcesses(sandbox);
});

afterAll(async () => {
  // A team hook the dispatcher timed out may still be exiting; join it before HOME goes.
  await detached?.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  if (fakeCodexDir) fs.rmSync(fakeCodexDir, { recursive: true, force: true });
});

describe('a .codex/hooks.json the business repo tracks', () => {
  it('stays as the team committed it, and the team hooks run from the dispatcher in ~/.codex/hooks.json', () => {
    const m = machine('tracked', {
      committed: { '.codex/hooks.json': TEAM_OWN_HOOKS },
      hooks: [
        { id: 'team-stop', event: 'Stop', command: 'printf \'{"systemMessage":"team-stop ran in %s"}\' "$PWD"', timeout: 20 },
        { id: 'team-stop-2', event: 'Stop', command: 'true', timeout: 45 },
        { id: 'team-guard', event: 'PreToolUse', matcher: 'Bash', command: 'echo "no shell here" >&2; exit 2' },
      ],
    });
    m.ok(['pull']);
    const file = path.join(m.dir, '.codex', 'hooks.json');
    expect(read(file)).toBe(TEAM_OWN_HOOKS);
    expect(m.status()).toEqual([]);

    const home = m.homeHooks();
    expect(dispatcherEvents(home)).toEqual(['PreToolUse', 'Stop']);
    expect(dispatcherEntries(home, 'Stop')).toHaveLength(1);
    expect(dispatcherEntries(home, 'Stop')[0].hooks[0].timeout).toBe(45);
    expect(JSON.stringify(home)).not.toContain('team-stop');

    const stop = m.dispatch('Stop', {});
    expect(stop.code).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({ systemMessage: `team-stop ran in ${m.dir}` });

    const blocked = m.dispatch('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('no shell here');
    const other = m.dispatch('PreToolUse', { tool_name: 'Read' });
    expect(other).toMatchObject({ code: 0, stdout: '' });

    // Outside the project the dispatcher runs nothing.
    const elsewhere = path.join(m.caseDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    expect(m.dispatch('Stop', {}, elsewhere)).toMatchObject({ code: 0, stdout: '' });
  });
});

describe('a teamai-only .codex/hooks.json', () => {
  it('switches to the dispatcher on the pull that sees the member\'s entry, and back once the file is gone', () => {
    const m = machine('switch', { hooks: [{ id: 'team-stop', event: 'Stop', command: 'echo team-stop' }] });
    const file = path.join(m.dir, '.codex', 'hooks.json');
    expect(read(file)).toContain('echo team-stop');
    expect(m.deliveredLines()).toContain('/.codex/hooks.json');
    expect(dispatcherEvents(m.homeHooks())).toEqual([]);

    const mine = { hooks: [{ type: 'command', command: 'echo my-own' }] };
    const data = readJson(file);
    data.hooks.Stop.push(mine);
    writeJson(file, data);
    const pulled = m.ok(['pull']);
    expect(pulled.output).toContain('.codex/hooks.json now holds entries teamai does not own, so git can see it.');
    expect(readJson(file)).toEqual({ hooks: { Stop: [mine] } });
    expect(m.status()).toContain('?? .codex/hooks.json');
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);
    expect(m.dispatch('Stop', {}).stdout).toContain('team-stop');

    // Steady: the next pull changes nothing.
    m.ok(['pull']);
    expect(readJson(file)).toEqual({ hooks: { Stop: [mine] } });
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);

    fs.rmSync(file);
    m.ok(['pull']);
    expect(read(file)).toContain('echo team-stop');
    expect(m.deliveredLines()).toContain('/.codex/hooks.json');
    expect(m.status()).not.toContain('?? .codex/hooks.json');
    expect(dispatcherEvents(m.homeHooks())).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('keeps the team hooks in the project file while the dispatcher cannot be installed, and switches once it can', () => {
    const m = machine('no-dispatcher', { hooks: [{ id: 'team-stop', event: 'Stop', command: 'echo team-stop' }] });
    const file = path.join(m.dir, '.codex', 'hooks.json');
    const homeFile = path.join(m.home, '.codex', 'hooks.json');
    const mine = { hooks: [{ type: 'command', command: 'echo my-own' }] };
    const data = readJson(file);
    data.hooks.Stop.push(mine);
    writeJson(file, data);
    if (!fs.existsSync(homeFile)) writeJson(homeFile, {});
    const homeBefore = read(homeFile);
    fs.chmodSync(homeFile, 0o444);
    fs.chmodSync(path.dirname(homeFile), 0o555);
    try {
      m.ok(['pull']);
    } finally {
      fs.chmodSync(path.dirname(homeFile), 0o755);
      fs.chmodSync(homeFile, 0o644);
    }

    expect(read(homeFile)).toBe(homeBefore);
    expect(read(file)).toContain('echo team-stop');
    expect(readJson(file).hooks.Stop).toContainEqual(mine);

    m.ok(['pull']);
    expect(readJson(file)).toEqual({ hooks: { Stop: [mine] } });
    expect(m.dispatch('Stop', {}).stdout).toContain('team-stop');
  });

  it('a team-owned file holding an unrecorded teamai copy of a team hook: the hook then runs only from the dispatcher', () => {
    const m = machine('unrecorded', { gitExclude: false, hooks: [{ id: 'team-stop', event: 'Stop', command: 'echo team-stop' }] });
    const file = path.join(m.dir, '.codex', 'hooks.json');
    // An older setup left teamai's copy in the file the team then committed, and teamai's records are gone.
    const copy = readJson(file).hooks.Stop;
    writeJson(file, { hooks: { Stop: [...JSON.parse(TEAM_OWN_HOOKS).hooks.Stop, ...copy] } });
    m.git(['add', '.codex/hooks.json']);
    m.git(['commit', '-q', '-m', 'team hooks']);
    for (const manifest of filesNamed(path.join(m.home, '.teamai'), 'managed-main-checkout-hooks.json')) fs.rmSync(manifest);

    const name = path.basename(m.caseDir);
    m.teamCommit({ 'teamai.yaml': teamaiYaml(name, `https://git.example.com/team/${name}.git`, true) });
    m.ok(['pull']);
    expect(read(file)).toBe(TEAM_OWN_HOOKS);
    expect(read(file)).not.toContain('team-stop');
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);
    expect(m.dispatch('Stop', {}).stdout.trim()).toBe('team-stop');
  });
});

describe('single-repo mode', () => {
  it('keeps the committed .codex/hooks.json to the built-ins and runs the team hooks from the dispatcher', () => {
    const caseDir = fs.mkdtempSync(path.join(sandbox, 'self-'));
    const home = path.join(caseDir, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1', CODEX_HOME: path.join(home, '.codex'), PATH: `${fakeCodexDir}${path.delimiter}${process.env.PATH ?? ''}`, FORCE_COLOR: '0', NODE_OPTIONS: detached.nodeOptions,
    };
    delete env.CLAUDE_CONFIG_DIR;
    const run = (command: string, args: string[], cwd: string, input = ''): string => {
      const r = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
      if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
      return r.stdout;
    };
    const dir = path.join(caseDir, 'biz');
    writeFile(path.join(dir, 'README.md'), '# app\n');
    writeFile(path.join(dir, '.teamai', 'hooks', 'hooks.yaml'), hooksYaml([{ id: 'team-stop', event: 'Stop', command: 'echo team-stop' }]));
    run('git', ['init', '-q', '-b', 'main'], dir);
    run('git', ['add', '-A'], dir);
    run('git', ['commit', '-q', '-m', 'app'], dir);
    // `init .` only parses the origin: an https URL on a closed local port.
    run('git', ['remote', 'add', 'origin', `https://127.0.0.1:9/team/${path.basename(caseDir)}.git`], dir);
    const realDir = fs.realpathSync.native(dir);
    run(process.execPath, [CLI, 'init', '.', '--provider', 'git', '--agent', 'codex'], realDir);
    run(process.execPath, [CLI, 'pull'], realDir);

    const committed = run('git', ['show', 'HEAD:.codex/hooks.json'], realDir);
    expect(committed).toContain('hook-dispatch session-start');
    expect(committed).not.toContain('team-stop');
    expect(read(path.join(realDir, '.codex', 'hooks.json'))).toBe(committed);
    expect(run('git', ['status', '--porcelain', '-uall', '--', '.codex'], realDir)).toBe('');

    const homeHooks = readJson(path.join(home, '.codex', 'hooks.json'));
    expect(dispatcherEvents(homeHooks)).toEqual(['Stop']);
    const homeFile = fs.realpathSync.native(path.join(home, '.codex', 'hooks.json'));
    const stopIndex = (homeHooks.hooks.Stop as any[]).findIndex((g) => /--team-hooks/.test(g.hooks[0].command));
    expect(Object.keys(readJson(path.join(home, '.codex', 'fake-state.json')).hooksState)).toContain(`${homeFile}:stop:${stopIndex}:0`);
    const command = dispatcherEntries(homeHooks, 'Stop')[0].hooks[0].command;
    const out = run('/bin/sh', ['-c', command], realDir, JSON.stringify({ hook_event_name: 'Stop', cwd: realDir, session_id: 's1' }));
    expect(out.trim()).toBe('team-stop');

    // Uninstall takes the dispatcher entries with it.
    run(process.execPath, [CLI, 'uninstall', '--force'], realDir);
    expect(dispatcherEvents(readJson(path.join(home, '.codex', 'hooks.json')))).toEqual([]);
  });
});

describe('uninstall --agent codex', () => {
  it('stops the team hooks of a project whose Codex gets nothing but them', () => {
    const m = machine('uninstall-agent', {
      committed: { '.codex/hooks.json': TEAM_OWN_HOOKS },
      hooks: [{ id: 'team-stop', event: 'Stop', command: 'echo team-stop' }],
    });
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);
    // Without the built-in skill, nothing of Codex's is left in the project but the team hooks.
    fs.rmSync(path.join(m.dir, '.codex', 'skills'), { recursive: true });

    const r = m.ok(['uninstall', '--agent', 'codex', '--force']);
    expect(r.output).toContain('Excluded codex from this project');
    expect(dispatcherEvents(m.homeHooks())).toEqual([]);
    expect(read(path.join(m.dir, '.codex', 'hooks.json'))).toBe(TEAM_OWN_HOOKS);
    // The next pull leaves them stopped: Codex is excluded from the project.
    m.ok(['pull']);
    expect(dispatcherEvents(m.homeHooks())).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('keeps the project in the dispatcher index while ~/.codex/hooks.json cannot be written, so the retry removes its entries', () => {
    const m = machine('uninstall-retry', {
      committed: { '.codex/hooks.json': TEAM_OWN_HOOKS },
      hooks: [{ id: 'team-stop', event: 'Stop', command: 'echo team-stop' }],
    });
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);
    fs.rmSync(path.join(m.dir, '.codex', 'skills'), { recursive: true });
    const homeFile = path.join(m.home, '.codex', 'hooks.json');
    const index = path.join(m.home, '.teamai', 'codex-team-hooks.json');
    fs.chmodSync(homeFile, 0o444);
    fs.chmodSync(path.dirname(homeFile), 0o555);
    let first: ReturnType<typeof spawnSync>;
    try {
      first = spawnSync(process.execPath, [CLI, 'uninstall', '--agent', 'codex', '--force'], { cwd: m.dir, encoding: 'utf8', env: m.env });
    } finally {
      fs.chmodSync(path.dirname(homeFile), 0o755);
      fs.chmodSync(homeFile, 0o644);
    }

    const output = `${first.stdout}${first.stderr}`;
    expect(first.status, output).toBe(1);
    expect(output).toContain(`Uninstall incomplete`);
    expect(output).toContain(`the Codex team-hook dispatchers in ${homeFile}`);
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);
    expect(Object.keys(readJson(index).projects)).toEqual([m.dir]);

    m.ok(['uninstall', '--agent', 'codex', '--force']);
    expect(dispatcherEvents(m.homeHooks())).toEqual([]);
    expect(fs.existsSync(index)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('a full uninstall keeps the project and its records while ~/.codex/hooks.json cannot be written, so the retry removes its entries', () => {
    const m = machine('uninstall-full-retry', {
      committed: { '.codex/hooks.json': TEAM_OWN_HOOKS },
      hooks: [{ id: 'team-stop', event: 'Stop', command: 'echo team-stop' }],
    });
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);
    fs.rmSync(path.join(m.dir, '.codex', 'skills'), { recursive: true });
    const homeFile = path.join(m.home, '.codex', 'hooks.json');
    const index = path.join(m.home, '.teamai', 'codex-team-hooks.json');
    fs.chmodSync(homeFile, 0o444);
    fs.chmodSync(path.dirname(homeFile), 0o555);
    let first: ReturnType<typeof spawnSync>;
    try {
      first = spawnSync(process.execPath, [CLI, 'uninstall', '--force'], { cwd: m.dir, encoding: 'utf8', env: m.env });
    } finally {
      fs.chmodSync(path.dirname(homeFile), 0o755);
      fs.chmodSync(homeFile, 0o644);
    }

    const output = `${first.stdout}${first.stderr}`;
    expect(first.status, output).toBe(1);
    expect(output).toContain(`Uninstall incomplete`);
    expect(output).toContain(`the Codex team-hook dispatchers in ${homeFile}`);
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);
    expect(Object.keys(readJson(index).projects)).toEqual([m.dir]);

    m.ok(['uninstall', '--force']);
    expect(dispatcherEvents(m.homeHooks())).toEqual([]);
    expect(fs.existsSync(index)).toBe(false);
  });
});

/** Every file named `name` under `dir`, recursively. */
function filesNamed(dir: string, name: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesNamed(full, name) : entry.name === name ? [full] : [];
  });
}

describe('sharing.gitExclude', () => {
  it('off: teamai writes the team hooks into the tracked file; on moves them out, off moves them back', () => {
    const m = machine('flag', {
      gitExclude: false,
      committed: { '.codex/hooks.json': TEAM_OWN_HOOKS },
      hooks: [{ id: 'team-stop', event: 'Stop', command: 'echo team-stop' }],
    });
    const file = path.join(m.dir, '.codex', 'hooks.json');
    const name = path.basename(m.caseDir);
    const url = `https://git.example.com/team/${name}.git`;
    expect(read(file)).toContain('echo team-stop');
    expect(m.status().filter((line) => line.includes('hooks.json'))).toEqual([' M .codex/hooks.json']);
    expect(dispatcherEvents(m.homeHooks())).toEqual([]);

    m.teamCommit({ 'teamai.yaml': teamaiYaml(name, url, true) });
    m.ok(['pull']);
    expect(read(file)).toBe(TEAM_OWN_HOOKS);
    expect(m.status()).toEqual([]);
    expect(dispatcherEvents(m.homeHooks())).toEqual(['Stop']);
    expect(m.dispatch('Stop', {}).stdout).toContain('team-stop');

    m.teamCommit({ 'teamai.yaml': teamaiYaml(name, url, false) });
    m.ok(['pull']);
    expect(read(file)).toContain('echo team-stop');
    expect(m.status().filter((line) => line.includes('hooks.json'))).toEqual([' M .codex/hooks.json']);
    expect(dispatcherEvents(m.homeHooks())).toEqual([]);
  });
});

describe('the dispatcher', () => {
  it('gives its entry a timeout that covers the slowest team hook, counting 600 s for a hook that names none', () => {
    // Codex stops the entry at its own timeout, so it must outlast every team hook the dispatcher runs.
    const m = machine('slowest', {
      committed: { '.codex/hooks.json': TEAM_OWN_HOOKS },
      hooks: [
        { id: 'bounded', event: 'Stop', command: 'true', timeout: 30 },
        { id: 'unbounded', event: 'Stop', command: 'true' },
      ],
    });
    const entries = dispatcherEntries(m.homeHooks(), 'Stop');
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].timeout).toBe(600);
  });

  it('stops a team hook at its own timeout and still returns the others\' output', async () => {
    const m = machine('timeout', {
      committed: { '.codex/hooks.json': TEAM_OWN_HOOKS },
      hooks: [
        { id: 'slow', event: 'UserPromptSubmit', command: 'sh -c \'sleep 4; touch "$HOME/late"\'; true', timeout: 1 },
        { id: 'fast', event: 'UserPromptSubmit', command: 'echo fast-context' },
      ],
    });
    // Codex's default (600 s) for the hook that names none is the largest.
    expect(dispatcherEntries(m.homeHooks(), 'UserPromptSubmit')[0].hooks[0].timeout).toBe(600);
    const r = m.dispatch('UserPromptSubmit', { prompt: 'hi' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('fast-context');
    expect(r.stderr).toContain('team hook slow timed out after 1s');
    expect(r.ms).toBeLessThan(3500);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(fs.existsSync(path.join(m.home, 'late'))).toBe(false);
  });

  it('keeps its entries and their trust as worktrees come and go, and runs the team hooks in each', () => {
    const m = machine('worktrees', {
      committed: { '.codex/hooks.json': TEAM_OWN_HOOKS },
      hooks: [{ id: 'team-stop', event: 'Stop', command: 'printf \'{"systemMessage":"ran in %s"}\' "$PWD"' }],
    });
    const homeFile = fs.realpathSync.native(path.join(m.home, '.codex', 'hooks.json'));
    const trusted = (): Record<string, unknown> => Object.fromEntries(
      Object.entries(readJson(path.join(m.home, '.codex', 'fake-state.json')).hooksState as Record<string, unknown>)
        .filter(([key]) => key.startsWith(`${homeFile}:stop:`)),
    );
    const before = read(homeFile);
    const stopIndex = (readJson(homeFile).hooks.Stop as any[]).findIndex((g) => /--team-hooks/.test(g.hooks[0].command));
    expect(Object.keys(trusted())).toContain(`${homeFile}:stop:${stopIndex}:0`);
    const trust = trusted();

    const wt = path.join(m.caseDir, 'wt');
    m.git(['worktree', 'add', '-q', '-b', 'feature', wt]);
    const realWt = fs.realpathSync.native(wt);
    const pulled = spawnSync(process.execPath, [CLI, 'pull'], { cwd: realWt, env: m.env, encoding: 'utf8' });
    expect(pulled.status, pulled.stderr).toBe(0);
    expect(read(homeFile)).toBe(before);
    expect(trusted()).toEqual(trust);
    expect(JSON.parse(m.dispatch('Stop', {}, realWt).stdout)).toEqual({ systemMessage: `ran in ${realWt}` });

    m.git(['worktree', 'remove', '--force', wt]);
    m.ok(['pull']);
    expect(read(homeFile)).toBe(before);
    expect(trusted()).toEqual(trust);
  });
});
