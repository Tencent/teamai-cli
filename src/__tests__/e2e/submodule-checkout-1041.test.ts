import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeCodex, readFakeCodexState } from '../helpers/fake-codex.js';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;
let fakeBin: string;
let detached: ReturnType<typeof trackDetachedProcesses>;
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (file: string) => fs.readFileSync(file, 'utf8');
const json = (file: string) => JSON.parse(read(file));
const skill = (name: string) => `---\nname: ${name}\ndescription: fixture\n---\n${name}\n`;

function fixture(name: string, oldGit = false) {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  if (oldGit) {
    write(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'git version 2.40.0'; else exec '${realGit}' "$@"; fi\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    PATH: [bin, fakeBin, process.env.PATH].join(path.delimiter), FORCE_COLOR: '0',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' ') };
  const run = (command: string, args: string[], cwd = base) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return `${result.stdout}${result.stderr}`;
  };
  const git = (args: string[], cwd = base) => run('git', args, cwd).trim();
  const cli = (args: string[], cwd: string) => run(process.execPath, [CLI, ...args], cwd);
  git(['config', '--global', 'protocol.file.allow', 'always']);
  const team = path.join(base, 'team');
  const url = `https://team.example.com/team/${name}.git`;
  write(path.join(team, 'teamai.yaml'), `team: fixture\nrepo: ${url}\nprovider: git\nreviewers: []\nsharing:\n  hooks:\n    autoApply: true\n    requireTeamScripts: false\n  gitExclude:\n    enabled: true\n`);
  write(path.join(team, 'skills/fixture/SKILL.md'), skill('fixture'));
  write(path.join(team, 'hooks/hooks.yaml'), 'hooks:\n  - id: fixture\n    description: fixture\n    event: Stop\n    command: echo fixture\n');
  git(['init', '-q', '-b', 'main'], team);
  git(['add', '-A'], team);
  git(['commit', '-qm', 'team'], team);
  const remote = path.join(base, 'team.git');
  git(['clone', '-q', '--bare', team, remote]);
  git(['config', '--global', `url.${remote}.insteadOf`, url]);
  const source = path.join(base, 'source');
  const parent = path.join(base, 'parent');
  for (const root of [source, parent]) {
    write(path.join(root, 'README.md'), '# fixture\n');
    git(['init', '-q', '-b', 'main'], root);
    git(['add', '-A'], root);
    git(['commit', '-qm', 'init'], root);
  }
  git(['submodule', 'add', '-q', source, 'service'], parent);
  git(['commit', '-qam', 'service'], parent);
  const checkout = path.join(parent, 'service');
  return { base, home, parent, checkout, git, cli, url, env, team, remote };
}

beforeAll(() => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-1041-e2e-')));
  fakeBin = installFakeCodex();
  detached = trackDetachedProcesses(sandbox);
});
afterAll(async () => {
  await detached.waitForExit();
  fs.rmSync(fakeBin, { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('multi-repo checkout delivery', () => {
  it('keeps the sibling Codex team hook dispatching when uninstalling a checkout sharing its identity', () => {
    const m = fixture('clone-dispatchers');
    write(path.join(m.checkout, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } }));
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'codex', '--force'], m.checkout);
    const homeFile = path.join(m.home, '.codex/hooks.json');
    expect(read(homeFile)).toContain('--team-hooks');
    const parentWorktree = path.join(m.base, 'parent-dispatchers');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'update', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    write(path.join(child, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } }));
    m.cli(['pull', '--force'], child);
    expect(read(homeFile)).toContain('--team-hooks');
    expect(read(path.join(child, '.codex/hooks.json'))).toContain('echo member');
    const dispatch = (cwd: string) => spawnSync(process.execPath, [CLI, 'hook-dispatch', 'Stop', '--tool', 'codex', '--team-hooks'], {
      cwd, env: m.env, encoding: 'utf8', input: JSON.stringify({ cwd, hook_event_name: 'Stop' }),
    });
    expect(dispatch(m.checkout).stdout).toContain('fixture');
    expect(dispatch(child).stdout).toContain('fixture');
    m.cli(['uninstall', '--agent', 'codex', '--force'], child);
    expect(read(homeFile)).toContain('--team-hooks');
    expect(dispatch(child).stdout).toBe('');
    expect(dispatch(m.checkout).stdout).toContain('fixture');
  });

  it('runs each checkout\'s own Codex team hooks when checkouts sharing an identity pulled different team revisions', () => {
    const m = fixture('per-checkout-dispatchers');
    write(path.join(m.checkout, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } }));
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'codex', '--force'], m.checkout);
    write(path.join(m.team, 'hooks/hooks.yaml'), 'hooks:\n  - id: fixture\n    description: fixture\n    event: Stop\n    command: echo second\n');
    m.git(['commit', '-qam', 'second'], m.team);
    m.git(['push', '-q', m.remote, 'main'], m.team);
    const parentWorktree = path.join(m.base, 'parent-per-checkout');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'update', '-q', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    write(path.join(child, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } }));
    m.cli(['pull', '--force'], child);
    const dispatch = (cwd: string) => spawnSync(process.execPath, [CLI, 'hook-dispatch', 'Stop', '--tool', 'codex', '--team-hooks'], {
      cwd, env: m.env, encoding: 'utf8', input: JSON.stringify({ cwd, hook_event_name: 'Stop' }),
    }).stdout;
    expect(dispatch(m.checkout)).toContain('fixture');
    expect(dispatch(m.checkout)).not.toContain('second');
    expect(dispatch(child)).toContain('second');
    expect(dispatch(child)).not.toContain('fixture');
  });

  it('uninstall --agent codex from a linked worktree stops its team hooks and keeps the main checkout\'s', () => {
    const m = fixture('linked-worktree-dispatchers');
    write(path.join(m.checkout, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } }));
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'codex', '--force'], m.checkout);
    const linked = path.join(m.base, 'service-linked-dispatchers');
    m.git(['worktree', 'add', '-q', '--detach', linked], m.checkout);
    write(path.join(linked, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } }));
    m.cli(['pull', '--force'], linked);
    const homeFile = path.join(m.home, '.codex/hooks.json');
    const dispatch = (cwd: string) => spawnSync(process.execPath, [CLI, 'hook-dispatch', 'Stop', '--tool', 'codex', '--team-hooks'], {
      cwd, env: m.env, encoding: 'utf8', input: JSON.stringify({ cwd, hook_event_name: 'Stop' }),
    });
    expect(dispatch(m.checkout).stdout).toContain('fixture');
    expect(dispatch(linked).stdout).toContain('fixture');
    m.cli(['uninstall', '--agent', 'codex', '--force'], linked);
    expect(read(homeFile)).toContain('--team-hooks');
    expect(dispatch(linked).stdout).toBe('');
    expect(dispatch(m.checkout).stdout).toContain('fixture');
  });

  it.each([
    { agent: 'codex', agents: 'codex', memberHooks: false, siblingKept: true },
    { agent: 'codex', agents: 'codex', memberHooks: true, siblingKept: true },
    { agent: 'claude', agents: 'claude,codex', memberHooks: false, siblingKept: true },
    { agent: 'claude', agents: 'claude', memberHooks: false, siblingKept: false },
  ])('uninstall --agent $agent with $agents (member hooks: $memberHooks) keeps a sibling clone\'s team hooks: $siblingKept', ({ agent, agents, memberHooks, siblingKept }) => {
    const m = fixture(`agent-uninstall-sibling-${agents.replace(',', '-')}-${agent}-${memberHooks}`);
    const memberFile = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } });
    if (memberHooks) write(path.join(m.checkout, '.codex/hooks.json'), memberFile);
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', agents, '--force'], m.checkout);
    const parentWorktree = path.join(m.base, 'parent-agent-uninstall');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'update', '-q', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    if (memberHooks) write(path.join(child, '.codex/hooks.json'), memberFile);
    m.cli(['pull', '--force'], child);
    const teamHooks = (cwd: string) => {
      if (memberHooks) {
        return spawnSync(process.execPath, [CLI, 'hook-dispatch', 'Stop', '--tool', 'codex', '--team-hooks'], {
          cwd, env: m.env, encoding: 'utf8', input: JSON.stringify({ cwd, hook_event_name: 'Stop' }),
        }).stdout;
      }
      const hookFile = path.join(cwd, agent === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json');
      return fs.existsSync(hookFile) ? read(hookFile) : '';
    };
    const before = teamHooks(child);
    expect(before).toContain('fixture');
    expect(teamHooks(m.checkout)).toContain('fixture');
    m.cli(['uninstall', '--agent', agent, '--force'], m.checkout);
    expect(teamHooks(m.checkout)).not.toContain('fixture');
    // A sibling's hooks go only with the data it shares, when this was the last tool.
    if (siblingKept) expect(teamHooks(child)).toBe(before);
    else expect(teamHooks(child)).not.toContain('fixture');
  });

  it('retires sibling Codex dispatchers when targeted uninstall removes the shared project data', () => {
    const m = fixture('targeted-claude-retires-dispatcher');
    const memberFile = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } });
    write(path.join(m.checkout, '.codex/hooks.json'), memberFile);
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude,codex', '--force'], m.checkout);
    const parentWorktree = path.join(m.base, 'parent-targeted-claude');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'update', '-q', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    write(path.join(child, '.codex/hooks.json'), memberFile);
    m.cli(['pull', '--force'], child);
    const dispatch = (cwd: string) => spawnSync(process.execPath, [CLI, 'hook-dispatch', 'Stop', '--tool', 'codex', '--team-hooks'], {
      cwd, env: m.env, encoding: 'utf8', input: JSON.stringify({ cwd, hook_event_name: 'Stop' }),
    });
    expect(dispatch(child).stdout).toContain('fixture');
    const dispatcherIndex = path.join(m.home, '.teamai/codex-team-hooks.json');
    const [identity] = Object.keys(json(dispatcherIndex).projects);

    m.cli(['uninstall', '--agent', 'codex', '--force'], m.checkout);
    expect(dispatch(child).stdout).toContain('fixture');
    m.cli(['uninstall', '--agent', 'claude', '--force'], m.checkout);

    expect(dispatch(child).stdout).toBe('');
    if (fs.existsSync(dispatcherIndex)) expect(json(dispatcherIndex).projects[identity]).toBeUndefined();
  });

  it('full uninstall leaves no registration for that identity', () => {
    const m = fixture('full-uninstall-dispatchers');
    write(path.join(m.checkout, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } }));
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'codex', '--force'], m.checkout);
    const parentWorktree = path.join(m.base, 'parent-full-uninstall');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'update', '-q', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    write(path.join(child, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } }));
    m.cli(['pull', '--force'], child);
    const index = json(path.join(m.home, '.teamai/codex-team-hooks.json'));
    const [identity] = Object.keys(index.projects);
    expect(Object.keys(index.projects[identity].checkouts).length).toBeGreaterThan(1);
    m.cli(['uninstall', '--force'], child);
    const after = path.join(m.home, '.teamai/codex-team-hooks.json');
    expect(fs.existsSync(after) ? json(after).projects[identity] : undefined).toBeUndefined();
  });

  it('full uninstall retires a linked checkout registered under its own path in a separate Git directory repo', () => {
    const m = fixture('separate-git-dir-full-uninstall');
    const memberFile = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo member' }] }] } });
    const main = path.join(m.base, 'separate');
    const gitDir = path.join(m.base, 'gitdirs/separate.git');
    write(path.join(main, 'README.md'), '# fixture\n');
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    m.git(['init', '-q', '-b', 'main', '--separate-git-dir', gitDir], main);
    expect(spawnSync('git', ['config', '--get', 'core.worktree'], { cwd: main, env: m.env }).status).not.toBe(0);
    m.git(['add', '-A'], main);
    m.git(['commit', '-qm', 'init'], main);
    const linked = path.join(m.base, 'separate-linked');
    m.git(['worktree', 'add', '-q', '--detach', linked], main);
    write(path.join(main, '.codex/hooks.json'), memberFile);
    write(path.join(linked, '.codex/hooks.json'), memberFile);
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'codex', '--force'], main);
    m.cli(['pull', '--force'], linked);
    const dispatch = (cwd: string) => spawnSync(process.execPath, [CLI, 'hook-dispatch', 'Stop', '--tool', 'codex', '--team-hooks'], {
      cwd, env: m.env, encoding: 'utf8', input: JSON.stringify({ cwd, hook_event_name: 'Stop' }),
    });
    const indexFile = path.join(m.home, '.teamai/codex-team-hooks.json');
    expect(Object.keys(json(indexFile).projects)).toHaveLength(2);
    expect(dispatch(linked).stdout).toContain('fixture');

    m.cli(['uninstall', '--force'], main);

    expect(dispatch(linked).stdout).toBe('');
    expect(fs.existsSync(indexFile) ? json(indexFile).projects : {}).toEqual({});
    expect(read(path.join(m.home, '.codex/hooks.json'))).not.toContain('--team-hooks');
  });

  it('cleans older team hooks from an inherited clone Git directory and keeps member hooks', () => {
    const m = fixture('inherited-clone-old-hooks');
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude', '--force'], m.checkout);
    const parentWorktree = path.join(m.base, 'parent-old-hooks');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'update', '-q', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    const gitDir = path.resolve(child, m.git(['rev-parse', '--git-common-dir'], child));
    const legacyHookFile = path.join(gitDir, '.claude/settings.local.json');
    const ownedHook = json(path.join(m.checkout, '.claude/settings.local.json')).hooks.Stop[0];
    write(legacyHookFile, JSON.stringify({ hooks: { Stop: [
      ownedHook,
      { hooks: [{ type: 'command', command: 'echo member' }] },
    ] } }));
    const partitions = path.join(m.home, '.teamai/projects');
    const dataHome = path.join(partitions, fs.readdirSync(partitions)[0]);
    const workspaces = path.join(dataHome, 'workspaces');
    const owned = fs.readdirSync(workspaces).map((id) => path.join(workspaces, id, 'managed-main-checkout-hooks.json'))
      .find((file) => fs.existsSync(file))!;
    write(path.join(dataHome, 'managed-main-checkout-hooks.json'), read(owned));
    m.cli(['pull', '--force'], child);
    const hooks = json(legacyHookFile).hooks.Stop;
    expect(JSON.stringify(hooks)).not.toContain('echo fixture');
    expect(JSON.stringify(hooks)).toContain('echo member');
  });

  it('delivers skills on the first pull of a submodule clone in a superproject worktree', () => {
    const m = fixture('first-clone-pull');
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude', '--force'], m.checkout);
    const parentWorktree = path.join(m.base, 'parent-first-pull');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'update', '-q', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    expect(fs.existsSync(path.join(child, '.claude'))).toBe(false);
    m.cli(['pull', '--silent'], child);
    expect(read(path.join(child, '.claude/skills/fixture/SKILL.md'))).toContain('name: fixture');
    expect(read(path.join(child, '.claude/skills/teamai/SKILL.md'))).toContain('name: teamai');
  });

  it('seeds the tool roots of a submodule clone that pulled before they were seeded, once', () => {
    const m = fixture('upgraded-clone-pull');
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude', '--force'], m.checkout);
    const parentWorktree = path.join(m.base, 'parent-upgraded-pull');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'update', '-q', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    m.cli(['pull', '--silent'], child);
    // An earlier release recorded the pull without seeding any root, so with no tool to deliver to.
    const states = fs.readdirSync(path.join(m.home, '.teamai'), { recursive: true, encoding: 'utf8' })
      .filter((file) => path.basename(file) === 'state.json')
      .map((file) => path.join(m.home, '.teamai', file))
      .filter((file) => json(file).lastPullByWorkspace);
    expect(states).not.toHaveLength(0);
    for (const file of states) {
      const state = json(file) as { lastPullByWorkspace: Record<string, Record<string, unknown>> };
      for (const record of Object.values(state.lastPullByWorkspace)) {
        delete record.rootsSeeded;
        record.targets = [];
      }
      write(file, JSON.stringify(state));
    }
    fs.rmSync(path.join(child, '.claude'), { recursive: true, force: true });
    m.cli(['pull', '--silent'], child);
    expect(read(path.join(child, '.claude/skills/fixture/SKILL.md'))).toContain('name: fixture');
    // The member removes the seeded root; a full sync leaves it removed.
    fs.rmSync(path.join(child, '.claude'), { recursive: true, force: true });
    m.cli(['pull', '--force', '--silent'], child);
    expect(fs.existsSync(path.join(child, '.claude/skills'))).toBe(false);
    // A forced full sync from another checkout resets this one's record and keeps it seeded.
    for (const file of states) write(file, JSON.stringify({ ...json(file), lastPullRev: null }));
    m.cli(['pull', '--silent'], m.checkout);
    const records = states.flatMap((file) => Object.values(json(file).lastPullByWorkspace) as Array<{ root: string; rev: string; rootsSeeded?: boolean }>);
    expect(records.find((record) => record.root === child)).toMatchObject({ rev: '', rootsSeeded: true });
  });

  it('retries inherited-root seeding after the original submodule checkout returns', () => {
    const m = fixture('retry-inherited-root-seed');
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude', '--force'], m.checkout);
    const parentWorktree = path.join(m.base, 'parent-retry-seed');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    m.git(['submodule', 'deinit', '--force', '--quiet', 'service'], m.parent);
    m.git(['submodule', 'update', '-q', '--init'], parentWorktree);
    const child = path.join(parentWorktree, 'service');
    const stateFiles = () => fs.readdirSync(path.join(m.home, '.teamai'), { recursive: true, encoding: 'utf8' })
      .filter((file) => path.basename(file) === 'state.json')
      .map((file) => path.join(m.home, '.teamai', file))
      .filter((file) => json(file).lastPullByWorkspace);
    const childRecord = () => stateFiles().flatMap((file) => Object.values(json(file).lastPullByWorkspace) as Array<{ root: string; rootsSeeded?: boolean }>)
      .find((record) => record.root === child);

    m.cli(['pull', '--silent'], child);
    expect(childRecord()?.rootsSeeded).toBeUndefined();

    m.git(['submodule', 'update', '-q', '--init'], m.parent);
    m.cli(['pull', '--silent'], child);
    expect(childRecord()?.rootsSeeded).toBe(true);
    expect(read(path.join(child, '.claude/skills/fixture/SKILL.md'))).toContain('name: fixture');
  });

  it('delivers, inherits, cleans up and uninstalls submodules through the real CLI', async () => {
    const m = fixture('submodules');
    fs.mkdirSync(path.join(m.checkout, '.claude'));
    fs.mkdirSync(path.join(m.checkout, '.agents/skills/local'), { recursive: true });
    fs.symlinkSync('../.agents/skills', path.join(m.checkout, '.claude/skills'));
    write(path.join(m.checkout, '.agents/skills/local/SKILL.md'), skill('local'));
    m.git(['add', '.claude/skills', '.agents/skills/local/SKILL.md'], m.checkout);
    m.git(['commit', '-qm', 'local skills'], m.checkout);
    const originalSkill = read(path.join(m.checkout, '.agents/skills/local/SKILL.md'));
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude,codex', '--force'], m.checkout);
    m.cli(['pull'], m.checkout);
    const anchor = path.join(m.parent, '.git/modules/service');
    const claude = path.join(m.checkout, '.claude/settings.local.json');
    const codex = path.join(m.checkout, '.codex/hooks.json');
    expect(read(claude)).toContain('echo fixture');
    expect(read(codex)).toContain('echo fixture');
    expect(readFakeCodexState(path.join(m.home, '.codex')).projects[m.checkout]?.trust_level).toBe('trusted');
    expect(readFakeCodexState(path.join(m.home, '.codex')).projects[anchor]).toBeUndefined();
    expect(read(path.join(m.checkout, '.agents/skills/teamai/SKILL.md'))).toContain('name: teamai');
    expect(read(path.join(m.checkout, '.agents/skills/fixture/SKILL.md'))).toContain('name: fixture');
    expect(m.git(['status', '--porcelain'], m.checkout)).toBe('');

    // Recreate the previous delivery target with its ownership and an unrelated entry.
    const partitions = path.join(m.home, '.teamai/projects');
    const dataHome = path.join(partitions, fs.readdirSync(partitions)[0]);
    const workspaces = path.join(dataHome, 'workspaces');
    const owned = fs.readdirSync(workspaces).map((id) => path.join(workspaces, id, 'managed-main-checkout-hooks.json'))
      .find((file) => fs.existsSync(file))!;
    const leftovers = json(claude);
    leftovers.member = true;
    leftovers.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo member' }] });
    write(path.join(anchor, '.claude/settings.local.json'), JSON.stringify(leftovers));
    write(path.join(anchor, '.codex/hooks.json'), read(codex));
    write(path.join(dataHome, 'managed-main-checkout-hooks.json'), read(owned));
    const fakeStateFile = path.join(m.home, '.codex/fake-state.json');
    const fakeState = json(fakeStateFile);
    fakeState.projects[anchor] = { trust_level: 'trusted' };
    write(fakeStateFile, JSON.stringify(fakeState));
    const stateFile = path.join(dataHome, 'state.json');
    const state = json(stateFile);
    state.codexProjectTrust = [...state.codexProjectTrust ?? [], { home: path.join(m.home, '.codex'), project: anchor }];
    write(stateFile, JSON.stringify(state));
    m.cli(['pull', '--force'], m.checkout);
    expect(json(path.join(anchor, '.claude/settings.local.json')).member).toBe(true);
    expect(read(path.join(anchor, '.claude/settings.local.json'))).not.toContain('echo fixture');
    expect(read(path.join(anchor, '.codex/hooks.json'))).not.toContain('echo fixture');
    expect(readFakeCodexState(path.join(m.home, '.codex')).projects[anchor]).toBeUndefined();

    const linked = path.join(m.base, 'service-linked');
    m.git(['worktree', 'add', '-q', '--detach', linked], m.checkout);
    await detached.waitForExit();
    m.cli(['pull', '--force'], linked);
    expect(fs.existsSync(path.join(linked, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(linked, '.codex'))).toBe(true);

    // A versioned parent hook initializes each clone before its first session.
    const hooks = path.join(m.parent, '.hooks');
    write(path.join(hooks, 'post-checkout'), '#!/bin/sh\ngit submodule update --init\n');
    fs.chmodSync(path.join(hooks, 'post-checkout'), 0o755);
    m.git(['add', '.hooks'], m.parent);
    m.git(['commit', '-qm', 'initialize submodules'], m.parent);
    m.git(['config', 'core.hooksPath', '.hooks'], m.parent);
    const parentWorktree = path.join(m.base, 'parent-linked');
    m.git(['worktree', 'add', '-q', '--detach', parentWorktree], m.parent);
    const child = path.join(parentWorktree, 'service');
    expect(fs.existsSync(path.join(child, '.git'))).toBe(true);
    m.git(['config', 'core.hooksPath', hooks], child);
    const parentHookBefore = read(path.join(hooks, 'post-checkout'));
    m.cli(['pull', '--force'], child);
    expect(read(path.join(child, '.claude/settings.local.json'))).toContain('echo fixture');
    expect(read(path.join(child, '.codex/hooks.json'))).toContain('echo fixture');
    expect(m.git(['config', '--get', 'hook.teamai-post-checkout.command'], child)).toContain('hook-dispatch');
    expect(read(path.join(hooks, 'post-checkout'))).toBe(parentHookBefore);
    expect(fs.readdirSync(partitions)).toHaveLength(1);
    m.cli(['pull', '--force'], m.checkout);
    expect(read(path.join(m.checkout, '.agents/skills/local/SKILL.md'))).toBe(originalSkill);
    expect(m.git(['status', '--porcelain'], m.checkout)).toBe('');
    m.cli(['uninstall', '--force'], m.checkout);
    expect(m.git(['config', '--local', '--list'], child)).not.toContain('hook.teamai-');
    expect(read(claude)).not.toContain('echo fixture');
    expect(read(path.join(child, '.claude/settings.local.json'))).not.toContain('echo fixture');
    expect(fs.lstatSync(path.join(m.checkout, '.claude/skills')).isSymbolicLink()).toBe(true);
    expect(read(path.join(m.checkout, '.agents/skills/local/SKILL.md'))).toBe(originalSkill);
    expect(fs.existsSync(path.join(m.checkout, '.agents/skills/teamai/SKILL.md'))).toBe(false);
  });

  it.each([false, true])('uses the older-Git fallback with hooksPath=%s', async (hooksPath) => {
    const m = fixture(`old-git-${hooksPath}`, true);
    const sharedHook = path.join(m.parent, '.hooks/post-checkout');
    if (hooksPath) {
      write(sharedHook, '#!/bin/sh\necho parent\n');
      fs.chmodSync(sharedHook, 0o755);
      m.git(['config', 'core.hooksPath', path.dirname(sharedHook)], m.checkout);
    }
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude', '--force'], m.checkout);
    expect(read(path.join(m.checkout, '.claude/settings.local.json'))).toContain('echo fixture');
    const childHook = path.join(m.parent, '.git/modules/service/hooks/post-checkout');
    if (hooksPath) {
      expect(read(sharedHook)).toBe('#!/bin/sh\necho parent\n');
      expect(fs.existsSync(childHook)).toBe(false);
    } else expect(read(childHook)).toContain('hook-dispatch');
  });

  it('rejects a skill root pointing outside the checkout without writes', () => {
    const m = fixture('foreign-skills');
    const external = path.join(m.base, 'external');
    fs.mkdirSync(external);
    fs.mkdirSync(path.join(m.checkout, '.claude'));
    fs.symlinkSync(external, path.join(m.checkout, '.claude/skills'));
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude', '--force'], m.checkout);
    m.cli(['pull'], m.checkout);
    expect(fs.readdirSync(external)).toEqual([]);
  });

  it.each(['remove', 'tombstone', 'uninstall'])('keeps delivered skills when the root is redirected outside the checkout during %s', (action) => {
    const m = fixture(`redirected-${action}`);
    m.cli(['init', m.url, '--provider', 'git', '--scope', 'project', '--agent', 'claude', '--force'], m.checkout);
    m.cli(['pull'], m.checkout);
    const root = path.join(m.checkout, '.claude/skills');
    const external = path.join(m.base, 'external-skills');
    fs.renameSync(root, external);
    fs.symlinkSync(external, root);
    const before = read(path.join(external, 'fixture/SKILL.md'));
    if (action === 'tombstone') {
      m.cli(['remove', 'skills', 'fixture', '--force'], m.checkout);
      m.cli(['pull', '--force'], m.checkout);
    } else if (action === 'remove') m.cli(['remove', 'skills', 'fixture', '--force'], m.checkout);
    else m.cli(['uninstall', '--force'], m.checkout);
    expect(read(path.join(external, 'fixture/SKILL.md'))).toBe(before);
    expect(read(path.join(external, 'teamai/SKILL.md'))).toContain('name: teamai');
  });
});
