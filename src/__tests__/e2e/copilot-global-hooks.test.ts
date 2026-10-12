import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist/index.js');
type Hooks = { version: number; hooks: Record<string, Array<{ bash?: string; command?: string }>> };

let sandbox: string;
let home: string;
let copilotHome: string;
let env: NodeJS.ProcessEnv;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function cli(args: string[], cwd: string, input?: string): string {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: 'utf8', timeout: 30_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  expect(result.status, output).toBe(0);
  return output;
}

function project(name: string): string {
  const dir = path.join(sandbox, name);
  const repo = path.join(dir, '.teamai/team-repo');
  write(path.join(repo, 'teamai.yaml'), `team: ${name}\nrepo: https://example.test/${name}.git\nsharing:\n  hooks:\n    autoApply: true\n    requireTeamScripts: false\n`);
  write(path.join(repo, 'hooks/hooks.yaml'), 'hooks:\n  - id: project-hook\n    description: Project hook\n    event: Stop\n    tools: [copilot]\n    command: echo team-hook\n');
  write(path.join(dir, '.teamai/config.yaml'), [
    'repo:', `  localPath: ${repo}`, `  remote: https://example.test/${name}.git`,
    'username: test', 'scope: project', `projectRoot: ${dir}`, 'enabledAgents: [copilot]', '',
  ].join('\n'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  return dir;
}

function hooks(file: string): Hooks {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Hooks;
}

// Copilot passes one payload, with its millisecond timestamp, to every copy of an event.
const EVENT_TIME = 1_760_000_000_000;

function dispatch(
  entry: Hooks['hooks'][string][number], launchDir: string, dir: string, sessionId: string,
  event: { timestamp?: number | null; env?: NodeJS.ProcessEnv } = {},
): void {
  const command = entry.bash?.match(/teamai (hook-dispatch [^"]+?) 2>\/dev\/null/);
  expect(command, 'generated Copilot dispatcher command').not.toBeNull();
  const timestamp = event.timestamp === null ? {} : { timestamp: event.timestamp ?? EVENT_TIME };
  const saved = env;
  env = { ...env, ...event.env };
  try {
    cli(command![1].split(' '), launchDir, JSON.stringify({ ...timestamp, cwd: dir, session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'implement the feature' }));
  } finally {
    env = saved;
  }
}

beforeEach(() => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-global-hooks-')));
  home = path.join(sandbox, 'home');
  copilotHome = path.join(sandbox, 'copilot-home');
  fs.mkdirSync(copilotHome, { recursive: true });
  env = { ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: copilotHome, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'TeamAI Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'TeamAI Test', GIT_COMMITTER_EMAIL: 'test@example.test', GIT_TERMINAL_PROMPT: '0' };
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe('Copilot built-in hooks in project scope', () => {
  it('installs built-ins globally while keeping project and personal hooks in the project', () => {
    const dir = project('a');
    const localFile = path.join(dir, '.github/hooks/teamai.json');
    write(localFile, JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', bash: 'echo personal-hook; echo teamai pull' }] } }));

    cli(['hooks', 'inject'], dir);

    const global = hooks(path.join(copilotHome, 'hooks/teamai.json'));
    expect(global.hooks.SessionStart).toHaveLength(1);
    expect(global.hooks.SessionStart[0].bash).toContain('teamai hook-dispatch session-start --tool copilot --copilot-global');
    const local = hooks(localFile);
    expect(local.hooks.SessionStart).toBeUndefined();
    expect(local.hooks.Stop.map((entry) => entry.bash)).toEqual(['echo personal-hook; echo teamai pull', 'echo team-hook']);
  });

  it('runs each event once before and after migrating legacy project hooks', () => {
    const a = project('a');
    const b = project('b');
    cli(['hooks', 'inject'], a);
    const globalFile = path.join(copilotHome, 'hooks/teamai.json');
    const global = hooks(globalFile);
    const legacy = JSON.parse(JSON.stringify(global).replaceAll(/ --copilot-global [^ "\r\n]+/g, '')) as Hooks;
    write(path.join(b, '.github/hooks/teamai.json'), JSON.stringify(legacy));
    for (const dir of [a, b]) {
      dispatch(global.hooks.UserPromptSubmit[0], a, dir, path.basename(dir));
      if (dir === b) dispatch(legacy.hooks.UserPromptSubmit[0], a, dir, path.basename(dir));
    }
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'prompt_submit').map(event => event.sessionId)).toEqual(['a', 'b']);
    expect(events[0].dataHomeKey).not.toBe(events[1].dataHomeKey);
    cli(['hooks', 'inject'], b);
    expect(hooks(path.join(b, '.github/hooks/teamai.json')).hooks.UserPromptSubmit).toBeUndefined();
    expect(hooks(globalFile).hooks.UserPromptSubmit).toHaveLength(1);
    // The host may still have the old project command loaded after pull migrates its file.
    dispatch(global.hooks.UserPromptSubmit[0], a, b, 'b-after-sync');
    dispatch(legacy.hooks.UserPromptSubmit[0], a, b, 'b-after-sync');
    const after = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(after.filter(event => event.sessionId === 'b-after-sync')).toHaveLength(1);
  });

  it('selects one global dispatcher across configured filenames and cached copies', () => {
    const a = project('a');
    const b = project('b');
    for (const dir of [a, b]) {
      const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
      write(teamFile, fs.readFileSync(teamFile, 'utf8') + `toolPaths:\n  copilot:\n    hooks: .github/hooks/teamai.json\n    userScope:\n      hooks: hooks/${path.basename(dir)}.json\n`);
    }
    cli(['hooks', 'inject'], a);
    const aFile = path.join(copilotHome, 'hooks/a.json');
    const globalA = hooks(aFile);
    const legacy = JSON.parse(JSON.stringify(globalA).replaceAll(/ --copilot-global [^ "\r\n]+/g, '')) as Hooks;
    write(path.join(b, '.github/hooks/teamai.json'), JSON.stringify(legacy));
    dispatch(globalA.hooks.UserPromptSubmit[0], a, b, 'before-b');
    dispatch(legacy.hooks.UserPromptSubmit[0], a, b, 'before-b');
    cli(['hooks', 'inject'], b);
    const globalB = hooks(path.join(copilotHome, 'hooks/b.json'));
    dispatch(globalA.hooks.UserPromptSubmit[0], a, b, 'both-global');
    dispatch(globalB.hooks.UserPromptSubmit[0], a, b, 'both-global');
    fs.rmSync(aFile);
    dispatch(globalA.hooks.UserPromptSubmit[0], a, b, 'cached-global');
    dispatch(globalB.hooks.UserPromptSubmit[0], a, b, 'cached-global');
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.sessionId)).toEqual(['before-b', 'both-global', 'cached-global']);
  });

  // Each event runs once among the copies the session loaded, whatever is on disk now.
  it('runs each event once among the loaded copies, whatever the hooks directory holds now', () => {
    const a = project('a');
    const b = project('b');
    for (const dir of [a, b]) {
      const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
      write(teamFile, fs.readFileSync(teamFile, 'utf8') + `toolPaths:\n  copilot:\n    hooks: .github/hooks/teamai.json\n    userScope:\n      hooks: hooks/${path.basename(dir)}.json\n`);
    }
    cli(['hooks', 'inject'], b);
    const globalB = hooks(path.join(copilotHome, 'hooks/b.json')).hooks.UserPromptSubmit[0];
    const legacy = { bash: globalB.bash!.replace(/ --copilot-global [^ "\r\n]+/, '') };
    // A later sync adds a.json, which sorts first; sessions started earlier never loaded it.
    cli(['hooks', 'inject'], a);
    const globalA = hooks(path.join(copilotHome, 'hooks/a.json')).hooks.UserPromptSubmit[0];
    const claims = path.join(home, '.teamai/copilot-hook-claims');
    // [case, copies the session loaded, payload, events expected]
    const rows: Array<[string, Array<typeof globalA>, Parameters<typeof dispatch>[4] | 'per-copy' | 'per-session' | 'unwritable', number]> = [
      ['session loaded only b.json', [globalB], {}, 1],
      ['session loaded only the legacy project copy', [legacy], {}, 1],
      ['session loaded a.json and b.json', [globalA, globalB], {}, 1],
      ['session loaded b.json and the legacy project copy', [globalB, legacy], {}, 1],
      ['two events with their own timestamps', [globalB, globalB], 'per-copy', 2],
      ['two Copilot sessions with the same payload', [globalA, globalB], 'per-session', 2],
      ['payload without a timestamp', [globalA, globalB], { timestamp: null }, 2],
      ['claim directory unwritable', [globalA, globalB], 'unwritable', 2],
    ];
    for (const [name, copies, payload, expected] of rows) {
      const sessionId = name.replaceAll(' ', '-');
      if (payload === 'unwritable') {
        fs.rmSync(claims, { recursive: true, force: true });
        write(claims, 'not a directory');
      }
      copies.forEach((copy, i) => dispatch(copy, a, b, sessionId,
        payload === 'per-copy' ? { timestamp: EVENT_TIME + i }
          : payload === 'per-session' ? { env: { COPILOT_AGENT_SESSION_ID: `copilot-${i}` } }
            : payload === 'unwritable' ? {} : payload));
      if (payload === 'unwritable') fs.rmSync(claims, { force: true });
      const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.type === 'prompt_submit' && event.sessionId === sessionId), name).toHaveLength(expected);
    }
    // Claims from earlier days are removed on the next claim.
    write(path.join(claims, '2000-01-01', 'old'), '');
    dispatch(globalB, a, b, 'cleanup');
    expect(fs.existsSync(path.join(claims, '2000-01-01'))).toBe(false);
  });

  it('removes the built-ins from every global file, whichever project configured it', () => {
    const a = project('a');
    const b = project('b');
    for (const dir of [a, b]) {
      const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
      write(teamFile, fs.readFileSync(teamFile, 'utf8') + `toolPaths:\n  copilot:\n    hooks: .github/hooks/teamai.json\n    userScope:\n      hooks: hooks/${path.basename(dir)}.json\n`);
      cli(['hooks', 'inject'], dir);
    }
    const personal = path.join(copilotHome, 'hooks/personal.json');
    write(personal, JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', bash: 'echo personal' }] } }));
    const globalA = hooks(path.join(copilotHome, 'hooks/a.json'));
    cli(['hooks', 'remove'], b);
    for (const name of ['a.json', 'b.json']) {
      expect(Object.values(hooks(path.join(copilotHome, 'hooks', name)).hooks).flat(), name).toEqual([]);
    }
    expect(hooks(personal).hooks.Stop.map(entry => entry.bash)).toEqual(['echo personal']);
    // A copy Copilot cached before the removal no longer runs either.
    dispatch(globalA.hooks.UserPromptSubmit[0], a, b, 'after-remove');
    expect(fs.existsSync(path.join(home, '.teamai/dashboard/events.jsonl'))).toBe(false);
  });

  // A cached copy runs only while its install is on disk: a global copy in a
  // user hook file, a legacy project copy in its project's or a user hook file.
  it('runs a cached copy only while its install is on disk, through upgrade and removal', () => {
    const a = project('a');
    const b = project('b');
    cli(['hooks', 'inject'], a);
    const globalFile = path.join(copilotHome, 'hooks/teamai.json');
    const global = hooks(globalFile).hooks.UserPromptSubmit[0];
    const legacyFile = JSON.parse(JSON.stringify(hooks(globalFile)).replaceAll(/ --copilot-global [^ "\r\n]+/g, '')) as Hooks;
    const legacy = legacyFile.hooks.UserPromptSubmit[0];
    const states: Array<[string, () => void]> = [
      ['before the upgrade', () => {
        fs.rmSync(globalFile);
        write(path.join(b, '.github/hooks/teamai.json'), JSON.stringify(legacyFile));
      }],
      ['after the upgrade', () => cli(['hooks', 'inject'], b)],
      ['after hooks remove', () => cli(['hooks', 'remove'], b)],
    ];
    // [state, copy the session cached, events expected]
    const rows: Array<[string, string, number]> = [
      ['before the upgrade', 'legacy', 1],
      ['before the upgrade', 'global', 0],
      ['after the upgrade', 'legacy', 1],
      ['after the upgrade', 'global', 1],
      ['after hooks remove', 'legacy', 0],
      ['after hooks remove', 'global', 0],
    ];
    const recorded = (sessionId: string) => {
      const file = path.join(home, '.teamai/dashboard/events.jsonl');
      if (!fs.existsSync(file)) return 0;
      return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .filter(event => event.type === 'prompt_submit' && event.sessionId === sessionId).length;
    };
    for (const [state, enter] of states) {
      enter();
      for (const [rowState, copy, expected] of rows.filter(([rowState]) => rowState === state)) {
        const sessionId = `${rowState}-${copy}`.replaceAll(' ', '-');
        dispatch(copy === 'legacy' ? legacy : global, a, b, sessionId);
        expect(recorded(sessionId), `${rowState}: ${copy} copy`).toBe(expected);
      }
    }
  });

  it('lists and diagnoses hooks configured only in user scope', () => {
    const dir = project('a');
    const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
    write(teamFile, fs.readFileSync(teamFile, 'utf8') + 'provider: git\ntoolPaths:\n  copilot:\n    userScope:\n      hooks: hooks/custom.json\n');
    cli(['hooks', 'inject'], dir);
    expect(cli(['hooks', 'list'], dir)).toMatch(new RegExp(`copilot\\s+installed\\s+${path.join(copilotHome, 'hooks/custom.json')}`));
    expect(cli(['doctor'], dir)).toMatch(/✔.*teamai hooks in copilot settings/);
  });

  it('lists the global install and removes owned hooks while preserving personal hooks', () => {
    const dir = project('a');
    const globalFile = path.join(copilotHome, 'hooks/teamai.json');
    const localFile = path.join(dir, '.github/hooks/teamai.json');
    write(globalFile, JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', bash: 'echo global-personal; echo teamai pull' }] } }));
    write(localFile, JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', bash: 'echo local-personal; echo teamai pull' }] } }));
    cli(['hooks', 'inject'], dir);
    expect(cli(['hooks', 'list'], dir)).toMatch(new RegExp(`copilot\\s+installed\\s+${globalFile}`));
    cli(['hooks', 'remove'], dir);
    expect(hooks(globalFile).hooks.Stop.map(entry => entry.bash)).toEqual(['echo global-personal; echo teamai pull']);
    expect(hooks(globalFile).hooks.SessionStart ?? []).toEqual([]);
    expect(hooks(localFile).hooks.Stop.map(entry => entry.bash)).toEqual(['echo local-personal; echo teamai pull']);
  });

  it('suppresses the Claude copy when Copilot has global built-ins', () => {
    const dir = project('a');
    cli(['hooks', 'inject'], dir);
    env.COPILOT_PROJECT_DIR = dir;
    const payload = JSON.stringify({ cwd: dir, session_id: 'copilot-session', hook_event_name: 'UserPromptSubmit', prompt: 'implement the feature' });
    cli(['hook-dispatch', 'prompt-submit', '--tool', 'claude'], dir, payload);
    expect(fs.existsSync(path.join(home, '.teamai/dashboard/events.jsonl'))).toBe(false);
    dispatch(hooks(path.join(copilotHome, 'hooks/teamai.json')).hooks.UserPromptSubmit[0], dir, dir, 'copilot-session');
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.tool)).toEqual(['copilot']);
  });

  // A cached project copy came from the project Copilot loaded, which may not be the event's cwd.
  it.each([
    ['b', 'a', 1],
    ['a', 'b', 0],
  ])('runs a cached legacy copy loaded from project %s with the event in project %s -> %i', (loaded, cwd, expected) => {
    const projects: Record<string, string> = { a: project('a'), b: project('b') };
    cli(['hooks', 'inject'], projects.a);
    const globalFile = path.join(copilotHome, 'hooks/teamai.json');
    const legacyFile = JSON.parse(JSON.stringify(hooks(globalFile)).replaceAll(/ --copilot-global [^ "\r\n]+/g, '')) as Hooks;
    fs.rmSync(globalFile);
    write(path.join(projects.b, '.github/hooks/teamai.json'), JSON.stringify(legacyFile));
    dispatch(legacyFile.hooks.UserPromptSubmit[0], projects[cwd], projects[cwd], 'mismatch', { env: { COPILOT_PROJECT_DIR: projects[loaded] } });
    const file = path.join(home, '.teamai/dashboard/events.jsonl');
    const events = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    expect(events.filter(event => event.type === 'prompt_submit')).toHaveLength(expected);
  });

  it('keeps self built-ins local when a global install also exists', () => {
    const a = project('a');
    cli(['hooks', 'inject'], a);
    const dir = project('self');
    write(path.join(dir, '.teamai/teamai.yaml'), fs.readFileSync(path.join(dir, '.teamai/team-repo/teamai.yaml'), 'utf8'));
    const configFile = path.join(dir, '.teamai/config.yaml');
    write(configFile, fs.readFileSync(configFile, 'utf8').replace('repo:\n', 'repo:\n  kind: self\n'));
    cli(['hooks', 'inject'], dir);
    const local = hooks(path.join(dir, '.github/hooks/teamai.json'));
    expect(local.hooks.SessionStart).toHaveLength(1);
    expect(local.hooks.SessionStart[0].bash).not.toContain('--copilot-global');
    dispatch(hooks(path.join(copilotHome, 'hooks/teamai.json')).hooks.UserPromptSubmit[0], a, dir, 'self-session');
    dispatch(local.hooks.UserPromptSubmit[0], a, dir, 'self-session');
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.sessionId)).toEqual(['self-session']);
  });

  // The global copy yields to a self project only when Copilot loaded that project's local copy.
  it.each([
    ['self', 1],
    ['a', 1],
  ])('runs a self project event once when Copilot loaded project %s', (loaded, expected) => {
    const a = project('a');
    cli(['hooks', 'inject'], a);
    const dir = project('self');
    write(path.join(dir, '.teamai/teamai.yaml'), fs.readFileSync(path.join(dir, '.teamai/team-repo/teamai.yaml'), 'utf8'));
    const configFile = path.join(dir, '.teamai/config.yaml');
    write(configFile, fs.readFileSync(configFile, 'utf8').replace('repo:\n', 'repo:\n  kind: self\n'));
    cli(['hooks', 'inject'], dir);
    const copilotEnv = { env: { COPILOT_PROJECT_DIR: loaded === 'self' ? dir : a } };
    dispatch(hooks(path.join(copilotHome, 'hooks/teamai.json')).hooks.UserPromptSubmit[0], dir, dir, 'self-session', copilotEnv);
    if (loaded === 'self') dispatch(hooks(path.join(dir, '.github/hooks/teamai.json')).hooks.UserPromptSubmit[0], dir, dir, 'self-session', copilotEnv);
    const file = path.join(home, '.teamai/dashboard/events.jsonl');
    const events = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    expect(events.filter(event => event.type === 'prompt_submit' && event.sessionId === 'self-session')).toHaveLength(expected);
  });

  it.each([[false, false], [true, false], [true, true]])('keeps Claude-only self hooks active with gitExclude=%s and legacyGuard=%s', (gitExclude, legacyGuard) => {
    const a = project('a');
    cli(['hooks', 'inject'], a);
    const dir = project('self-claude');
    const configFile = path.join(dir, '.teamai/config.yaml');
    write(configFile, fs.readFileSync(configFile, 'utf8').replace('repo:\n', 'repo:\n  kind: self\n').replace('[copilot]', '[claude]') + `gitExcludeEnabled: ${gitExclude}\n`);
    const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
    write(teamFile, fs.readFileSync(teamFile, 'utf8').replace('sharing:\n', `sharing:\n  gitExclude:\n    enabled: ${gitExclude}\n`));
    write(path.join(dir, '.teamai/teamai.yaml'), fs.readFileSync(teamFile, 'utf8') + 'mode: self\n');
    const teamHooksFile = path.join(dir, '.teamai/team-repo/hooks/hooks.yaml');
    write(teamHooksFile, fs.readFileSync(teamHooksFile, 'utf8').replace('[copilot]', '[claude]'));
    write(path.join(dir, '.teamai/hooks/hooks.yaml'), fs.readFileSync(teamHooksFile, 'utf8'));
    execFileSync('git', ['add', '.teamai/teamai.yaml', '.teamai/hooks/hooks.yaml'], { cwd: dir, env });
    execFileSync('git', ['commit', '-q', '-m', 'self hook fixture'], { cwd: dir, env });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    cli(['hooks', 'inject'], dir);
    env.COPILOT_PROJECT_DIR = dir;
    const payload = JSON.stringify({ cwd: dir, session_id: 'self-claude', hook_event_name: 'UserPromptSubmit', prompt: 'implement the feature' });
    cli(['hook-dispatch', 'prompt-submit', '--tool', 'claude'], dir, payload);
    dispatch(hooks(path.join(copilotHome, 'hooks/teamai.json')).hooks.UserPromptSubmit[0], a, dir, 'self-claude');
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.tool)).toEqual(['claude']);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, gitExclude ? '.claude/settings.local.json' : '.claude/settings.json'), 'utf8'));
    const teamCommand = settings.hooks.Stop.find((entry: { description: string }) => entry.description.startsWith('[teamai:hook:')).hooks[0].command as string;
    const shell = spawnSync('bash', ['-c', teamCommand], { cwd: dir, env, encoding: 'utf8' });
    expect(shell.status).toBe(0);
    expect(shell.stdout.trim()).toBe('team-hook');
    if (legacyGuard) {
      const cursorPrefix = teamCommand.slice(0, teamCommand.indexOf('if [ -n "$COPILOT_PROJECT_DIR" ]'));
      const entry = settings.hooks.Stop.find((entry: { description: string }) => entry.description.startsWith('[teamai:hook:'));
      entry.hooks[0].command = cursorPrefix + 'if [ -n "$COPILOT_PROJECT_DIR" ] && grep -q -- \'--tool copilot\' "$COPILOT_PROJECT_DIR/.github/hooks/teamai.json" 2>/dev/null; then exit 0; fi; echo team-hook';
      write(path.join(dir, '.claude/settings.local.json'), JSON.stringify(settings));
    }
    // Recover ownership from committed team hooks if the installation manifest is lost.
    for (const file of fs.readdirSync(sandbox, { recursive: true }) as string[]) {
      if (path.basename(file).startsWith('managed-') && file.endsWith('.json')) fs.rmSync(path.join(sandbox, file));
    }
    cli(['uninstall', '--agent', 'claude', '--force'], dir);
    const remaining = JSON.parse(fs.readFileSync(path.join(dir, gitExclude ? '.claude/settings.local.json' : '.claude/settings.json'), 'utf8'));
    expect(remaining.hooks.Stop ?? []).toEqual([]);
  });

  it('installs with init, migrates with pull and keeps shared hooks on project uninstall', () => {
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'origin.git');
    const url = 'https://example.test/team/copilot.git';
    write(path.join(seed, 'teamai.yaml'), `team: copilot-test\nrepo: ${url}\nprovider: git\nusageReport: false\nsharing:\n  hooks:\n    autoApply: true\n    requireTeamScripts: false\n  env:\n    injectShellProfile: false\n`);
    write(path.join(seed, 'hooks/hooks.yaml'), 'hooks:\n  - id: custom\n    description: Custom hook\n    event: Stop\n    tools: [copilot]\n    command: echo custom\n');
    const git = (args: string[], cwd = sandbox): void => { execFileSync('git', args, { cwd, env, stdio: 'pipe' }); };
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'team fixture'], seed);
    git(['clone', '-q', '--bare', seed, remote]);
    fs.mkdirSync(home, { recursive: true });
    git(['config', '--global', `url.${remote}.insteadOf`, url]);
    git(['config', '--global', 'user.name', 'TeamAI Test']);
    git(['config', '--global', 'user.email', 'test@example.test']);
    const dir = path.join(sandbox, 'app');
    fs.mkdirSync(dir);
    git(['init', '-q', '-b', 'main'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'app fixture'], dir);
    cli(['init', url, '--provider', 'git', '--agent', 'copilot', '--force'], dir);
    const globalFile = path.join(copilotHome, 'hooks/teamai.json');
    const localFile = path.join(dir, '.github/hooks/teamai.json');
    const global = hooks(globalFile);
    expect(global.hooks.SessionStart).toHaveLength(1);
    const local = hooks(localFile);
    local.hooks.SessionStart = JSON.parse(JSON.stringify(global.hooks.SessionStart).replaceAll(/ --copilot-global [^ "\r\n]+/g, ''));
    local.hooks.Stop.push({ bash: 'echo personal' });
    write(localFile, JSON.stringify(local));
    cli(['pull', '--silent'], dir);
    expect(hooks(localFile).hooks.SessionStart).toBeUndefined();
    expect(hooks(localFile).hooks.Stop.map(entry => entry.bash)).toEqual(['echo personal', 'echo custom']);
    expect(cli(['doctor'], dir)).toMatch(/✔.*teamai hooks in copilot settings/);
    const uninstall = cli(['uninstall', '--force'], dir);
    expect(uninstall).toContain(globalFile);
    expect(hooks(globalFile).hooks.SessionStart).toHaveLength(1);
    expect(hooks(localFile).hooks.Stop.map(entry => entry.bash)).toEqual(['echo personal']);
  });

  it('preserves an unreadable legacy hook file and reports how to repair it', () => {
    const dir = project('a');
    const localFile = path.join(dir, '.github/hooks/teamai.json');
    const broken = '{"version":1,"hooks":';
    write(localFile, broken);
    const result = spawnSync(process.execPath, [CLI, 'hooks', 'inject'], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Fix it, then run the command again');
    expect(fs.readFileSync(localFile, 'utf8')).toBe(broken);
  });

  it('marks existing global built-ins even when team hooks cannot be resolved', () => {
    const a = project('a');
    const b = project('b');
    cli(['hooks', 'inject'], a);
    const globalFile = path.join(copilotHome, 'hooks/teamai.json');
    const legacy = JSON.parse(fs.readFileSync(globalFile, 'utf8').replaceAll(/ --copilot-global [^ "\r\n]+/g, '')) as Hooks;
    write(globalFile, JSON.stringify(legacy));
    write(path.join(b, '.github/hooks/teamai.json'), JSON.stringify(legacy));
    write(path.join(b, '.teamai/team-repo/hooks/hooks.yaml'), 'hooks:\n  - id: broken\n');
    const result = spawnSync(process.execPath, [CLI, 'hooks', 'inject'], { cwd: b, env, encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(1);
    const global = hooks(globalFile);
    expect(global.hooks.UserPromptSubmit[0].bash).toContain('--copilot-global');
    dispatch(global.hooks.UserPromptSubmit[0], a, b, 'legacy-global');
    dispatch(legacy.hooks.UserPromptSubmit[0], a, b, 'legacy-global');
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.sessionId)).toEqual(['legacy-global']);
  });

  it('suppresses Claude when the global Copilot hook filename is configured', () => {
    const dir = project('a');
    const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
    write(teamFile, fs.readFileSync(teamFile, 'utf8') + 'toolPaths:\n  claude:\n    settings: .claude/settings.json\n  copilot:\n    hooks: .github/hooks/teamai.json\n    userScope:\n      hooks: hooks/teamai-custom.json\n');
    const configFile = path.join(dir, '.teamai/config.yaml');
    write(configFile, fs.readFileSync(configFile, 'utf8').replace('[copilot]', '[claude, copilot]'));
    const teamHooksFile = path.join(dir, '.teamai/team-repo/hooks/hooks.yaml');
    write(teamHooksFile, fs.readFileSync(teamHooksFile, 'utf8').replace('[copilot]', '[claude, copilot]'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'app fixture'], { cwd: dir, env });
    cli(['hooks', 'inject'], dir);
    env.COPILOT_PROJECT_DIR = dir;
    const claude = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
    const teamCommand = claude.hooks.Stop[0].hooks[0].command as string;
    const shell = spawnSync('bash', ['-c', teamCommand], { cwd: dir, env, encoding: 'utf8' });
    expect(shell.status).toBe(0);
    expect(shell.stdout).toBe('');
    const payload = JSON.stringify({ cwd: dir, session_id: 'custom-global', hook_event_name: 'UserPromptSubmit', prompt: 'implement the feature' });
    cli(['hook-dispatch', 'prompt-submit', '--tool', 'claude'], dir, payload);
    dispatch(hooks(path.join(copilotHome, 'hooks/teamai-custom.json')).hooks.UserPromptSubmit[0], dir, dir, 'custom-global');
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.tool)).toEqual(['copilot']);
  });

  it.each(['disabled', 'invalid'])('keeps Claude built-ins active when the global Copilot file is %s', (state) => {
    const dir = project('a');
    const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
    write(teamFile, fs.readFileSync(teamFile, 'utf8') + 'toolPaths:\n  claude:\n    settings: .claude/settings.json\n  copilot:\n    hooks: .github/hooks/teamai.json\n    userScope:\n      hooks: hooks/teamai.json\n');
    const configFile = path.join(dir, '.teamai/config.yaml');
    write(configFile, fs.readFileSync(configFile, 'utf8').replace('[copilot]', '[claude, copilot]'));
    const teamHooksFile = path.join(dir, '.teamai/team-repo/hooks/hooks.yaml');
    write(teamHooksFile, fs.readFileSync(teamHooksFile, 'utf8').replace('[copilot]', '[claude, copilot]'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    cli(['hooks', 'inject'], dir);
    const globalFile = path.join(copilotHome, 'hooks/teamai.json');
    const global = hooks(globalFile);
    write(globalFile, state === 'disabled' ? JSON.stringify({ ...global, disableAllHooks: true }) : fs.readFileSync(globalFile, 'utf8').slice(0, -2));
    env.COPILOT_PROJECT_DIR = dir;
    const payload = JSON.stringify({ cwd: dir, session_id: state, hook_event_name: 'UserPromptSubmit', prompt: 'implement the feature' });
    cli(['hook-dispatch', 'prompt-submit', '--tool', 'claude'], dir, payload);
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.tool)).toEqual(['claude']);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
    const shell = spawnSync('bash', ['-c', settings.hooks.Stop[0].hooks[0].command], { cwd: dir, env, encoding: 'utf8' });
    expect(shell.status).toBe(0);
    // The project's Copilot copy, not the global file, decides team hooks.
    expect(shell.stdout.trim()).toBe('');
  });

  // The shared file holds every built-in; each project's `builtin.disabled` applies when its event runs.
  it.each(['a', 'b'])('applies each project\'s disabled built-ins when %s syncs last', (last) => {
    const a = project('a');
    const b = project('b');
    const aHooks = path.join(a, '.teamai/team-repo/hooks/hooks.yaml');
    write(aHooks, fs.readFileSync(aHooks, 'utf8') + 'builtin:\n  disabled: [Hook dispatch prompt-submit]\n');
    for (const dir of last === 'a' ? [b, a] : [a, b]) cli(['hooks', 'inject'], dir);
    const global = hooks(path.join(copilotHome, 'hooks/teamai.json'));
    expect(global.hooks.UserPromptSubmit).toHaveLength(1);
    dispatch(global.hooks.UserPromptSubmit[0], a, a, 'a-session');
    dispatch(global.hooks.UserPromptSubmit[0], a, b, 'b-session');
    const events = fs.readFileSync(path.join(home, '.teamai/dashboard/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.sessionId)).toEqual(['b-session']);
  });

  // A Claude team hook yields under Copilot only to the same hook in the event's project.
  it.each([
    ['claude', 'team-hook'],
    ['claude, copilot', ''],
  ])('runs a Claude team hook under Copilot in a project with agents [%s] -> %j', (agents, output) => {
    const other = project('other');
    cli(['hooks', 'inject'], other);
    const dir = project('claude-project');
    const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
    write(teamFile, fs.readFileSync(teamFile, 'utf8') + 'toolPaths:\n  claude:\n    settings: .claude/settings.json\n  copilot:\n    hooks: .github/hooks/teamai.json\n    userScope:\n      hooks: hooks/teamai.json\n');
    const configFile = path.join(dir, '.teamai/config.yaml');
    write(configFile, fs.readFileSync(configFile, 'utf8').replace('[copilot]', `[${agents}]`));
    const teamHooksFile = path.join(dir, '.teamai/team-repo/hooks/hooks.yaml');
    write(teamHooksFile, fs.readFileSync(teamHooksFile, 'utf8').replace('[copilot]', '[claude, copilot]'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    cli(['hooks', 'inject'], dir);
    env.COPILOT_PROJECT_DIR = dir;
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
    const shell = spawnSync('bash', ['-c', settings.hooks.Stop[0].hooks[0].command], { cwd: dir, env, encoding: 'utf8' });
    expect(shell.status).toBe(0);
    expect(shell.stdout.trim()).toBe(output);
  });

  // The same command on another Copilot event or matcher is no replacement for the Claude hook.
  it.each([
    ['Stop', '', 'Stop', '', ''],
    ['Stop', '', 'SessionStart', '', 'team-hook'],
    ['PostToolUse', 'Bash', 'PostToolUse', 'Bash', ''],
    ['PostToolUse', 'Bash', 'PostToolUse', 'Edit', 'team-hook'],
  ])('runs a Claude %s(%s) team hook when Copilot delivers it for %s(%s) -> %j', (claudeEvent, claudeMatcher, copilotEvent, copilotMatcher, output) => {
    const dir = project('claude-project');
    const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
    write(teamFile, fs.readFileSync(teamFile, 'utf8') + 'toolPaths:\n  claude:\n    settings: .claude/settings.json\n  copilot:\n    hooks: .github/hooks/teamai.json\n    userScope:\n      hooks: hooks/teamai.json\n');
    const configFile = path.join(dir, '.teamai/config.yaml');
    write(configFile, fs.readFileSync(configFile, 'utf8').replace('[copilot]', '[claude, copilot]'));
    const hook = (id: string, tool: string, event: string, matcher: string) =>
      `  - id: ${id}\n    description: ${id}\n    event: ${event}\n${matcher ? `    matcher: ${matcher}\n` : ''}    tools: [${tool}]\n    command: echo team-hook\n`;
    write(path.join(dir, '.teamai/team-repo/hooks/hooks.yaml'),
      `hooks:\n${hook('claude-hook', 'claude', claudeEvent, claudeMatcher)}${hook('copilot-hook', 'copilot', copilotEvent, copilotMatcher)}`);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    cli(['hooks', 'inject'], dir);
    env.COPILOT_PROJECT_DIR = dir;
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
    const shell = spawnSync('bash', ['-c', settings.hooks[claudeEvent][0].hooks[0].command], { cwd: dir, env, encoding: 'utf8' });
    expect(shell.status).toBe(0);
    expect(shell.stdout.trim()).toBe(output);
  });

  it('keeps a custom project hook filename in the user hooks directory', () => {
    const dir = project('a');
    const teamFile = path.join(dir, '.teamai/team-repo/teamai.yaml');
    write(teamFile, fs.readFileSync(teamFile, 'utf8') + 'provider: git\ntoolPaths:\n  copilot:\n    hooks: .github/hooks/custom.json\n');
    cli(['hooks', 'inject'], dir);
    const globalFile = path.join(copilotHome, 'hooks/custom.json');
    expect(fs.existsSync(path.join(copilotHome, '.github'))).toBe(false);
    expect(hooks(globalFile).hooks.SessionStart).toHaveLength(1);
    expect(hooks(path.join(dir, '.github/hooks/custom.json')).hooks.Stop.map(entry => entry.bash)).toEqual(['echo team-hook']);
    expect(cli(['hooks', 'list'], dir)).toMatch(new RegExp(`copilot\\s+installed\\s+${globalFile}`));
    expect(cli(['doctor'], dir)).toMatch(/✔.*teamai hooks in copilot settings/);
    cli(['hooks', 'remove'], dir);
    expect(hooks(globalFile).hooks.SessionStart ?? []).toEqual([]);
    cli(['hooks', 'inject'], dir);
    expect(cli(['uninstall', '--force'], dir)).toContain(globalFile);
    expect(hooks(globalFile).hooks.SessionStart).toHaveLength(1);
  });

});
