import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// resolveTeamaiEntryScript() finds dist/index.js only in a built CLI, so the
// real ensureTeamaiWrapper returns null under vitest. Point it at the test
// HOME's bin dir; the tests create the wrapper file it reports.
const wrapperDirRef = vi.hoisted(() => ({ dir: null as string | null }));
vi.mock('../builtin-hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../builtin-hooks.js')>();
  return { ...actual, ensureTeamaiWrapper: () => wrapperDirRef.dir };
});
import { codexTeamHookIndexPath, dispatchedCodexHooks, isCodexTeamHookDispatcher, reconcileCodexDispatchers, setCodexDispatcherHooks, type CodexTeamHook } from '../codex-team-hooks.js';

const hook = (command: string): CodexTeamHook[] => [{ id: 'team', event: 'Stop', command }];

describe('Codex team-hook index keeps each checkout\'s own hooks', () => {
  const originalHome = process.env.HOME;
  let root: string;
  let project: string;
  let a: string;
  let b: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-index-')));
    process.env.HOME = path.join(root, 'home');
    [project, a, b] = ['project', 'a', 'b'].map((name) => path.join(root, name));
    for (const dir of [project, a, b]) fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seed = (record: unknown) => {
    fs.mkdirSync(path.dirname(codexTeamHookIndexPath()), { recursive: true });
    fs.writeFileSync(codexTeamHookIndexPath(), JSON.stringify({ projects: { [project]: record } }));
  };

  it.each([
    { name: 'no record', seeded: undefined, before: { a: undefined, b: undefined }, after: { a: undefined } },
    { name: 'per-checkout record', seeded: () => ({ checkouts: { [a]: hook('echo a') } }), before: { a: 'echo a', b: undefined }, after: { a: 'echo a' } },
    { name: 'shared list of checkouts', seeded: () => ({ hooks: hook('echo a'), checkouts: [a] }), before: { a: 'echo a', b: undefined }, after: { a: 'echo a' } },
  ])('$name: B registering its hooks leaves A\'s, and B stopping leaves A\'s', async ({ seeded, before, after }) => {
    if (seeded) seed(seeded());
    const command = async (checkout: string) => (await dispatchedCodexHooks(project, checkout))?.[0]?.command;
    expect({ a: await command(a), b: await command(b) }).toEqual(before);

    expect(await setCodexDispatcherHooks(project, hook('echo b'), b)).toBe(true);
    expect({ a: await command(a), b: await command(b) }).toEqual({ ...after, b: 'echo b' });

    expect(await setCodexDispatcherHooks(project, null, b)).toBe(true);
    expect({ a: await command(a), b: await command(b) }).toEqual({ ...after, b: undefined });
  });

  it('a project-wide record under a Git directory identity leaves no entry once the other checkout stops', async () => {
    // No checkout is recoverable from the identity: the Git directory is not one.
    seed({ hooks: hook('echo old') });
    expect(await setCodexDispatcherHooks(project, hook('echo b'), b)).toBe(true);
    expect(await dispatchedCodexHooks(project, project)).toBeUndefined();
    expect(await setCodexDispatcherHooks(project, null, b)).toBe(true);
    expect(fs.existsSync(codexTeamHookIndexPath())).toBe(false);
  });

  it('a project-wide record keeps running for its original checkout after another checkout registers', async () => {
    fs.mkdirSync(path.join(project, '.git'));
    seed({ hooks: hook('echo old') });
    expect((await dispatchedCodexHooks(project))?.[0]?.command).toBe('echo old');

    expect(await setCodexDispatcherHooks(project, hook('echo b'), b)).toBe(true);
    // A checkout keyed by itself (self mode) is its own original checkout.
    expect((await dispatchedCodexHooks(project, project))?.[0]?.command).toBe('echo old');
    expect((await dispatchedCodexHooks(project, b))?.[0]?.command).toBe('echo b');
  });
});

describe('reconcileCodexDispatchers — the dispatcher command is the portable absolute-wrapper form (#1215)', () => {
  const originalHome = process.env.HOME;
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-1215-'));
    process.env.HOME = path.join(root, 'home');
    wrapperDirRef.dir = path.join(process.env.HOME, '.teamai', 'bin');
    fs.mkdirSync(wrapperDirRef.dir, { recursive: true });
    fs.writeFileSync(path.join(wrapperDirRef.dir, 'teamai'), '#!/bin/sh\n', { mode: 0o755 });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seedIndex = (hooksFile: string) => {
    const project = path.join(root, 'proj');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(codexTeamHookIndexPath()), { recursive: true });
    fs.writeFileSync(codexTeamHookIndexPath(), JSON.stringify({
      version: 1,
      projects: { [project]: { hooks: [{ id: 't', event: 'Stop', command: 'teamai pull', timeout: 30 }] } },
    }));
    return hooksFile;
  };

  it('writes the absolute wrapper path, not a shell wrapper', async () => {
    const hooksFile = path.join(process.env.HOME!, '.codex', 'hooks.json');
    seedIndex(hooksFile);
    await reconcileCodexDispatchers(hooksFile);
    const doc = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
    const command = doc.hooks.Stop[0].hooks[0].command as string;
    // Shell-free: PowerShell on Windows parses it exactly like POSIX sh does.
    expect(command).toMatch(/^"[^"]+" hook-dispatch Stop --tool codex --team-hooks$/);
    expect(command).toContain(path.join('.teamai', 'bin'));
    for (const shellSyntax of ['bash', '-lc', '||', ';', '2>']) {
      expect(command).not.toContain(shellSyntax);
    }
    // The wrapper the command names must exist after the reconcile.
    const wrapper = command.slice(1, command.indexOf('"', 1));
    expect(fs.existsSync(wrapper)).toBe(true);
  });

  it('recognizes legacy shell-wrapped dispatchers for replacement', () => {
    // Entries written before #1215: bash-wrapped, or with a Git Bash path.
    expect(isCodexTeamHookDispatcher('bash -lc "teamai hook-dispatch Stop --tool codex --team-hooks"')).toBe(true);
    expect(isCodexTeamHookDispatcher('"C:\\Program Files\\Git\\bin\\bash.exe" -lc "teamai hook-dispatch Stop --tool codex --team-hooks"')).toBe(true);
    // And the new absolute-wrapper form.
    expect(isCodexTeamHookDispatcher(`"${path.join(process.env.HOME!, '.teamai', 'bin', 'teamai')}" hook-dispatch Stop --tool codex --team-hooks`)).toBe(true);
    // Built-in dispatches (no --team-hooks) are not dispatchers.
    expect(isCodexTeamHookDispatcher('teamai hook-dispatch session-start --tool codex')).toBe(false);
  });

  it('replaces a legacy dispatcher entry in place', async () => {
    const hooksFile = path.join(process.env.HOME!, '.codex', 'hooks.json');
    seedIndex(hooksFile);
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'bash -lc "teamai hook-dispatch Stop --tool codex --team-hooks"', timeout: 30 }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo user hook' }] }],
      },
    }));
    await reconcileCodexDispatchers(hooksFile);
    const doc = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
    expect(doc.hooks.Stop).toHaveLength(1);
    expect(doc.hooks.Stop[0].hooks[0].command).toMatch(/^"[^"]+" hook-dispatch Stop --tool codex --team-hooks$/);
    // The user's own entry is left byte-identical (#993).
    expect(doc.hooks.SessionStart[0].hooks[0].command).toBe('echo user hook');
  });
});
