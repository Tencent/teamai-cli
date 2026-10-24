import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bundledRuntime from '../bundled-runtime.js';
import { _resetShellCache } from '../builtin-hooks.js';
import { codexTeamHookIndexPath, dispatchedCodexHooks, reconcileCodexDispatchers, setCodexDispatcherHooks, type CodexTeamHook } from '../codex-team-hooks.js';

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


describe('reconcileCodexDispatchers — the Windows override keeps the block contract (#1209)', () => {
  const originalHome = process.env.HOME;
  let root: string;
  let project: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-dispatch-')));
    process.env.HOME = path.join(root, 'home');
    project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetShellCache();
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seed = (record: unknown) => {
    fs.mkdirSync(path.dirname(codexTeamHookIndexPath()), { recursive: true });
    fs.writeFileSync(codexTeamHookIndexPath(), JSON.stringify({ projects: { [project]: record } }));
  };

  it.each(['linux', 'win32'] as const)('keeps the dispatcher exit contract on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.spyOn(bundledRuntime, 'findGitBashWindows').mockReturnValue('C:/Program Files/Git/bin/bash.exe');
    _resetShellCache();
    seed({ hooks: [{ id: 'team', event: 'Stop', command: 'echo blocked >&2; exit 2' }] });
    const hooksFile = path.join(root, 'hooks.json');
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }));

    await reconcileCodexDispatchers(hooksFile, { kind: 'disabled' });

    const entry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8')).hooks.Stop[0].hooks[0];
    // Codex uses commandWindows on Windows. Keep the shared command portable.
    expect(entry.command).toBe('bash -lc "teamai hook-dispatch Stop --tool codex --team-hooks"');
    // The Windows form is the bare dispatch: cmd /C propagates the exit code
    // and stderr natively, so exit 2 (block) passes through with nothing
    // redirected — no tail needed, no junk arguments (#1215).
    expect(entry.commandWindows).toBe('teamai hook-dispatch Stop --tool codex --team-hooks');
  });

  it('reconciles idempotently: a second run writes the same bytes', async () => {
    seed({ hooks: [{ id: 'team', event: 'Stop', command: 'echo a' }] });
    const hooksFile = path.join(root, 'hooks.json');
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }));
    await reconcileCodexDispatchers(hooksFile, { kind: 'disabled' });
    const first = fs.readFileSync(hooksFile, 'utf-8');
    await reconcileCodexDispatchers(hooksFile, { kind: 'disabled' });
    expect(fs.readFileSync(hooksFile, 'utf-8')).toBe(first);
  });
});
