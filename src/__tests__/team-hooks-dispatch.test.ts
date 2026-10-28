/**
 * #1492: the live team-hook dispatcher behind OpenCode's and OMP's user-wide
 * bridges. It runs only what a pull applied (recorded after the team-hook
 * security gates), resolved from the payload's cwd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

import { runTeamHooksFor } from '../team-hooks-dispatch.js';
import { recordAppliedTeamHooks, teamHookBridgeIndexPath } from '../team-hook-bridges.js';
import type { HookDef } from '../types.js';

function def(over: Partial<HookDef>): HookDef {
  return {
    source: 'team',
    key: 'hook',
    event: 'SessionStart',
    command: 'printf TEAM_CONTEXT',
    description: 'test hook',
    ...over,
  };
}

describe('live team hooks for OpenCode and OMP (#1492)', () => {
  let root = '';
  let home = '';
  let repo = '';

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-live-team-hooks-')));
    home = path.join(root, 'home');
    repo = path.join(root, 'team');
    fse.ensureDirSync(path.join(home, '.teamai'));
    fse.ensureDirSync(path.join(repo, 'hooks'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    fse.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: test\nrepo: https://example.com/team.git\n');
    fse.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${repo}`,
      '  remote: https://example.com/team.git',
      'username: tester',
      'scope: user',
      'additionalRoles: []',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function apply(hooks: HookDef[], tool = 'opencode'): Promise<void> {
    await recordAppliedTeamHooks(tool, hooks, { scope: 'user' });
  }

  it('runs the applied hooks for the event and tool, and passes their stdout through', async () => {
    await apply([def({ key: 'context', tools: ['opencode', 'omp'] })], 'opencode');
    await apply([def({ key: 'context', tools: ['opencode', 'omp'] }), def({ key: 'omp-only', command: 'printf WRONG_TOOL', tools: ['omp'] })], 'omp');

    expect(await runTeamHooksFor('opencode', 'SessionStart', '{}', { cwd: home }))
      .toEqual({ code: 0, stdout: 'TEAM_CONTEXT', stderr: '' });
    expect((await runTeamHooksFor('omp', 'SessionStart', '{}', { cwd: home })).stdout)
      .toBe('TEAM_CONTEXT\nWRONG_TOOL');
  });

  it('keeps exit 2 as the blocking decision and its stderr', async () => {
    await apply([def({ key: 'block', event: 'UserPromptSubmit', command: 'printf blocked >&2; exit 2' })]);

    const result = await runTeamHooksFor('opencode', 'UserPromptSubmit', '{"prompt":"x"}', { cwd: home });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('blocked');
    expect(result.stdout).toBe('');
  });

  it('matches tool matchers in the lower-case spelling the bridges report', async () => {
    await apply([def({ key: 'bash-only', event: 'PostToolUse', matcher: 'Bash', command: 'printf BASH_HOOK' })]);

    expect((await runTeamHooksFor('opencode', 'PostToolUse', '', { cwd: home, tool_name: 'bash' })).stdout).toBe('BASH_HOOK');
    expect((await runTeamHooksFor('opencode', 'PostToolUse', '', { cwd: home, tool_name: 'read' })).stdout).toBe('');
  });

  it("injects a hook's additionalContext, not its JSON envelope (#1492)", async () => {
    await apply([
      def({ key: 'json-context', command: 'printf \'{"hookSpecificOutput":{"additionalContext":"JSON_CONTEXT"}}\'' }),
      def({ key: 'json-control', command: 'printf \'{"decision":"approve"}\'' }),
    ]);

    expect((await runTeamHooksFor('opencode', 'SessionStart', '{}', { cwd: home })).stdout).toBe('JSON_CONTEXT');
  });

  it('runs nothing a pull did not apply, even when hooks.yaml declares it', async () => {
    fse.writeFileSync(path.join(repo, 'hooks', 'hooks.yaml'), [
      'hooks:',
      '  - id: unapplied',
      '    description: not applied',
      '    event: SessionStart',
      '    command: printf NOT_APPLIED',
      '    tools: [opencode]',
      '',
    ].join('\n'));

    expect(await runTeamHooksFor('opencode', 'SessionStart', '{}', { cwd: home }))
      .toEqual({ code: 0, stdout: '', stderr: '' });
    expect(fse.pathExistsSync(teamHookBridgeIndexPath())).toBe(false);
  });

  it("keeps a timed-out hook's stderr after the timeout diagnostic", async () => {
    const command = `"${process.execPath}" -e "console.error('HUNG_REASON'); for (;;) {}"`;
    await apply([def({ key: 'hung', command, timeout: 0.1 })]);

    const result = await runTeamHooksFor('opencode', 'SessionStart', '{}', { cwd: home });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('HUNG_REASON');
    expect(result.stderr.indexOf('HUNG_REASON')).toBeGreaterThan(result.stderr.indexOf('timed out'));
  });

  it('stops already-applied hooks under the kill switch', async () => {
    await apply([def({ key: 'context' })]);
    vi.stubEnv('TEAMAI_HOOKS_DISABLED', '1');

    expect(await runTeamHooksFor('opencode', 'SessionStart', '{}', { cwd: home }))
      .toEqual({ code: 0, stdout: '', stderr: '' });
  });
});
