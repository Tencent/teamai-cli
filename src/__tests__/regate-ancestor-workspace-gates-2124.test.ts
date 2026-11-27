import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  resolveAnchors: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

// A pull that registers a workspace nested under another re-gates the ancestor's
// team hooks at once (#2124). The manifest and each tool's settings file are
// shared by every project on the machine, so only the ancestor's own entries may
// change: another project's gate stays as it is.

import { realpathSync, readFileSync } from 'node:fs';
import { hookSettingsFile } from '../locate.js';
import { reconcileTeamHooksForConfig, regateAncestorWorkspaceGates, releaseRemovedCheckoutHooks } from '../hooks.js';
import { getCodebuddyTeamHookDispatchCommand } from '../builtin-hooks.js';
import { encodeCodebuddyProjectGate } from '../codebuddy-team-hooks.js';
import { resolveHookScope } from '../types.js';
import { writeWorkspaceRoot } from '../utils/partition.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const TOOL = 'codebuddy';
const SETTINGS = '.codebuddy/settings.json';
const GUARD = 'echo team-hook-v1';

/** The team hook commands the settings file holds, by event. */
function commandsOf(file: string): Record<string, string[]> {
  const settings = fse.readJsonSync(file, { throws: false }) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  const out: Record<string, string[]> = {};

  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    out[event] = (entries ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
  }

  return out;
}

/** The team hook's gated entries under `event`: not the built-in dispatcher entries teamai adds beside them. */
function teamGates(file: string, event = 'SessionStart'): string[] {
  return (commandsOf(file)[event] ?? []).filter((command) => command.includes(GUARD));
}

/** The entry of the workspace rooted at `root`: gated to `root` as its `$PWD` prefix. */
function gateOf(gates: readonly string[], root: string): string | undefined {
  const prefix = `if [ "$PWD" = '${root}' ]`;

  return gates.find((command) => command.startsWith(prefix));
}

/** Whether `command` may fire in `cwd`: the gate's own verdict, run as the host runs it. */
function firesIn(command: string, cwd: string): boolean {
  const run = spawnSync('/bin/bash', ['-c', command], { cwd, encoding: 'utf8' });

  return run.status === 0 && run.stdout.includes('team-hook-v1');
}

describe('registering a nested workspace re-gates its ancestor and nothing else (#2124)', () => {
  let home: string;
  let manifestPath: string;
  let settingsPath: string;

  const team = { toolPaths: { [TOOL]: { settings: SETTINGS } } } as unknown as TeamaiConfig;

  const configOf = (projectRoot: string, dataHome: string): LocalConfig => ({
    repo: { kind: 'git', localPath: path.join(dataHome, 'team-repo'), remote: 'https://example.invalid/acme/team.git' },
    username: 'tester', additionalRoles: [], scope: 'project', projectRoot, dataHome, enabledAgents: [TOOL],
  }) as LocalConfig;

  /** What a full pull of `root` does around registration, in pull's own order. */
  const pull = async (root: string, dataHome: string): Promise<void> => {
    const config = configOf(root, dataHome);

    await writeWorkspaceRoot(dataHome, root);
    await regateAncestorWorkspaceGates(team, config, resolveHookScope(config).manifestPath);
    await releaseRemovedCheckoutHooks(team, config);
    await reconcileTeamHooksForConfig(team, config);
  };

  /** A business repo with one commit and a worktree under it, both registered as workspaces. */
  const project = (name: string): { main: string; worktree: string; dataHome: string } => {
    const main = path.join(home, name);
    const dataHome = path.join(home, '.teamai', 'projects', name);

    // The team clone pull reads the team's hooks from: one gated SessionStart hook.
    fse.outputFileSync(path.join(dataHome, 'team-repo', 'hooks', 'hooks.yaml'), `hooks:\n  - id: startup-guard\n    description: Startup hook fixture\n    event: SessionStart\n    command: ${GUARD}\n`);
    fse.ensureDirSync(main);
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    fse.outputFileSync(path.join(main, '.gitignore'), '.teamai/\nworktree/\n');
    execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A']);
    execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
    const worktree = path.join(main, 'worktree', 'feature');

    fse.ensureDirSync(path.dirname(worktree));
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feature', worktree]);
    return { main, worktree, dataHome };
  };

  beforeEach(async () => {
    home = realpathSync(fse.mkdtempSync(path.join(os.tmpdir(), 'teamai-regate-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    manifestPath = path.join(home, '.teamai', 'managed-hooks.json');
    settingsPath = hookSettingsFile(TOOL, home, SETTINGS);
    fse.ensureDirSync(path.dirname(settingsPath));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(home);
  });

  it('the ancestor stops matching the nested checkout while the nested one keeps its own gate', async () => {
    const a = project('a');

    await pull(a.main, a.dataHome);
    expect(firesIn(gateOf(teamGates(settingsPath), a.main) ?? '', a.main)).toBe(true);

    await pull(a.worktree, a.dataHome);

    const gates = teamGates(settingsPath);

    // Two entries, one per workspace, and exactly one fires for any $PWD.
    expect(gates).toHaveLength(2);
    expect(gates.filter((command) => firesIn(command, a.worktree))).toHaveLength(1);
    expect(gates.filter((command) => firesIn(command, a.main))).toHaveLength(1);
  });

  it("leaves another project's gate untouched, byte for byte", async () => {
    const a = project('a');
    const b = project('b');

    // Project A pulled alone first: its gate is in the shared settings file.
    await pull(a.main, a.dataHome);
    const aGateBefore = gateOf(teamGates(settingsPath), a.main);

    expect(aGateBefore, 'project A has a gate').toBeDefined();

    const fileBefore = readFileSync(settingsPath, 'utf8');
    const manifestBefore = readFileSync(manifestPath, 'utf8');

    // Project B registers a workspace nested under its own checkout.
    await pull(b.main, b.dataHome);
    await pull(b.worktree, b.dataHome);

    // A's entry carries no exclusion for B's worktree: B's root is not inside A.
    expect(gateOf(teamGates(settingsPath), a.main)).toBe(aGateBefore);

    // A's manifest records are A's still: B's registration rewrote none of them.
    const manifestAfter = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, Array<{ command: string }>>;
    const aRecords = (manifestAfter[TOOL] ?? []).filter((record) => record.command.includes(a.main));

    expect(aRecords.length).toBeGreaterThan(0);
    for (const record of aRecords) expect(record.command).not.toContain(b.worktree);

    // And B's own ancestor gate did change, so the pass ran at all.
    // B's main checkout's entry now leaves B's worktree out, and B's worktree has its own.
    const bMainGate = gateOf(teamGates(settingsPath), b.main);

    expect(bMainGate).toBeDefined();
    expect(bMainGate).toContain(b.worktree);
    expect(firesIn(bMainGate ?? '', b.worktree)).toBe(false);
    expect(teamGates(settingsPath).filter((command) => firesIn(command, b.worktree))).toHaveLength(1);
    expect(fileBefore).not.toBe(readFileSync(settingsPath, 'utf8'));
    expect(manifestBefore).not.toBe(readFileSync(manifestPath, 'utf8'));
  });

  it('does nothing when the new workspace is not nested under another one', async () => {
    const a = project('a');

    await pull(a.main, a.dataHome);
    const before = readFileSync(settingsPath, 'utf8');

    // A sibling checkout elsewhere in HOME, with its own data home: no ancestor.
    const other = project('other');
    const config = configOf(other.main, other.dataHome);

    await writeWorkspaceRoot(other.dataHome, other.main);
    await regateAncestorWorkspaceGates(team, config, manifestPath);

    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it("does not take over another project's CodeBuddy encoded gate", async () => {
    // Windows CodeBuddy carries the gate as a base64url argument rather than a
    // shell prefix, and the regate for that form rewrites whatever root the
    // argument holds: only the ownership check in front of it keeps project B's
    // gate from being re-encoded to project A's root. Pinned on every platform.
    const a = project('a');
    const b = project('b');

    await pull(a.main, a.dataHome);
    await writeWorkspaceRoot(b.dataHome, b.main);

    const bGate = encodeCodebuddyProjectGate(b.main, []);
    const bCommand = getCodebuddyTeamHookDispatchCommand('SessionStart', 'startup-guard', bGate, Buffer.from(`(${GUARD})`, 'utf8').toString('base64url'));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

    // B's record sits in the shared manifest beside A's, the way a Windows pull of B leaves it.
    fse.writeJsonSync(manifestPath, { ...manifest, [TOOL]: [...((manifest[TOOL] as unknown[]) ?? []), { id: 'startup-guard', event: 'SessionStart', command: bCommand }] });

    // A registers a workspace nested under its own checkout.
    const config = configOf(path.join(a.main, 'worktree', 'feature'), a.dataHome);

    await writeWorkspaceRoot(a.dataHome, config.projectRoot!);
    await regateAncestorWorkspaceGates(team, config, manifestPath);

    const after = (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, Array<{ command: string }>>)[TOOL] ?? [];

    // A's own shell gate was re-gated, so the pass ran; B's encoded gate is still B's.
    expect(after.some((record) => record.command.includes(a.worktree ?? 'worktree/feature')), 'A record was re-gated').toBe(true);
    expect(after.some((record) => record.command === bCommand), 'B record still carries its own encoded gate').toBe(true);
    expect(after.some((record) => record.command.includes(encodeCodebuddyProjectGate(a.main, [config.projectRoot!]))), 'B gate was not re-encoded to A').toBe(false);
  });
});
