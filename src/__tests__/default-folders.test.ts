import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('@teamai/shared/log', async (importOriginal) => ({
  ...await importOriginal<typeof import('@teamai/shared/log')>(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { DefaultFolders } from '../default-folders.js';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { deliverHookFolders, resolveTeamHooks } from '../resources/hooks.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';
import { resolveStart } from '../workflow/cache.js';

describe('a default hook text', () => {
  it('fills its variables in one pass, so a value that reads like a variable is printed as written', async () => {
    const mrHint = await DefaultFolders.load({ kind: 'hooks', name: 'teamai-mr-hint' }, null);

    expect(mrHint.text('offer-command', 'en').render({
      count: '1',
      mr_lines: '- Document {{ command }} in the README (merged: 2026-11-02)',
      command: 'teamai import-from-mr --since 7d',
    })).toBe([
      '[teamai:mr-hint] Found 1 recently merged MR(s) not yet imported into the team knowledge base.',
      '',
      'After this task, tell the user they can turn these MRs into learnings with:',
      '',
      '- Document {{ command }} in the README (merged: 2026-11-02)',
      '',
      '  teamai import-from-mr --since 7d',
    ].join('\n'));
  });
});

describe('a team replacement of a default hook', () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai default hooks '));
    vi.stubEnv('HOME', sandbox);
    vi.stubEnv('USERPROFILE', sandbox);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(sandbox);
  });

  it('is read by its hint from a data home whose path holds spaces and non-ASCII characters', async () => {
    const repo = path.join(sandbox, 'team');
    const member: LocalConfig = {
      repo: { localPath: repo, remote: 'https://example.test/acme/team.git' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
      dataHome: path.join(sandbox, 'Zoë Müller 张伟', '.teamai'),
      // The TodoWrite hint speaks only while recall is on.
      recallEnabled: true,
    };
    const dir = path.join(repo, 'hooks', 'teamai-todowrite-hint');
    await fse.copy(path.join(__dirname, '..', '..', 'hooks', 'teamai-todowrite-hint'), dir);
    await fse.outputFile(path.join(dir, 'message.md'), '[acme] Plan made: read the team runbook before you start.\n');

    const resolved = await resolveTeamHooks(TeamaiConfigSchema.parse({ team: 'acme', repo: member.repo.remote }), member, { silent: true });
    await deliverHookFolders(member, resolved.ok ? resolved.folders : []);
    const todoWrite = buildHandlerRegistry().find(({ handler }) => handler.name === 'todowrite-hint');
    const output = await todoWrite?.handler.execute({ session_id: 'replacement-session', tool_name: 'TodoWrite' }, 'claude', member);
    const context = typeof output === 'string' ? (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : output;

    expect(context).toBe('[acme] Plan made: read the team runbook before you start.');
  });
});

describe('a team\'s params.yaml for a default workflow', () => {
  let root: string;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai default workflow params '));
  });

  afterEach(async () => {
    await fse.remove(root);
  });

  function member(): LocalConfig {
    return {
      repo: { localPath: path.join(root, 'knowledge'), remote: 'local', kind: 'self' },
      username: 'tester',
      scope: 'project',
      additionalRoles: [],
      projectRoot: root,
      dataHome: path.join(root, 'data'),
    };
  }

  const PROMOTE = { kind: 'workflows', name: 'teamai-promote-learning' } as const;
  const TEAMAI = { min_confidence: 0.9, min_upvoted: 5, min_users: 2, min_age_days: 14 };

  async function commit(params: string): Promise<void> {
    await fse.outputFile(path.join(root, 'knowledge', 'workflows', 'teamai-promote-learning', 'params.yaml'), params);
  }

  it('sets the keys it holds over teamai\'s, and the workflow keeps teamai\'s steps', async () => {
    const config = member();
    await commit('min_users: 1\n');

    await syncScorersThenWorkflows(config);

    expect([(await DefaultFolders.load(PROMOTE, config)).params, (await resolveStart(config, PROMOTE.name)).workflow?.definition.steps[0]?.id])
      .toEqual([{ ...TEAMAI, min_users: 1 }, 'learning']);
  });

  it('is refused by pull with the file and the field named, and the version pull last took stays in force', async () => {
    const config = member();
    await commit('min_users: 1\n');
    await syncScorersThenWorkflows(config);
    await commit('min_confidence: 2\n');

    const { invalid } = await syncScorersThenWorkflows(config);

    expect([invalid.map(({ message }) => message), (await DefaultFolders.load(PROMOTE, config)).params]).toEqual([
      ['workflows/teamai-promote-learning/params.yaml: min_confidence must be a number from 0 to 1'],
      { ...TEAMAI, min_users: 1 },
    ]);
  });

  it('leaves teamai\'s values in force when pull never took a version', async () => {
    const config = member();
    await commit('min_votes: 3\n');

    const { invalid } = await syncScorersThenWorkflows(config);

    expect([invalid.map(({ message }) => message), (await DefaultFolders.load(PROMOTE, config)).params]).toEqual([
      ['workflows/teamai-promote-learning/params.yaml: min_votes is not a parameter of teamai-promote-learning'],
      TEAMAI,
    ]);
  });
});
