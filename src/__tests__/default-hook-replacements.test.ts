import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  resolveAnchors: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('@teamai/shared/log', async (importOriginal) => ({
  ...await importOriginal<typeof import('@teamai/shared/log')>(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { writeContributeState } from '../contribute-check.js';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { reconcileTeamHooksForConfig } from '../hooks.js';
import { computePackageHintOutput } from '../pkg/pkg-hint.js';
import { log } from '@teamai/shared/log';
import { resetWarnOnce } from '../utils/warn-once.js';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';

// A team replaces one of teamai's default hook folders by copying it to the root of its repo
// and editing it; pull checks the copy and delivers it, and the hint reads it (#1787).

let home: string;
let repo: string;

const teamConfig = TeamaiConfigSchema.parse({ team: 'acme', repo: 'https://example.test/acme/team.git', toolPaths: { claude: { settings: '.claude/settings.json' } } });

/** teamai's own folder for `name`, as the npm package ships it. */
const shipped = (name: string): string => path.join(__dirname, '..', '..', 'hooks', name);

function member(): LocalConfig {
  return { repo: { localPath: repo, remote: 'https://example.test/acme/team.git' }, username: 'tester', scope: 'user', additionalRoles: [] };
}

/** `hooks/<name>/` at the root of the team repo: teamai's folder copied, with these files written over it, or removed (null). */
async function replace(name: string, files: Record<string, string | null>): Promise<void> {
  const dir = path.join(repo, 'hooks', name);
  await fse.copy(shipped(name), dir);

  for (const [file, content] of Object.entries(files)) {
    if (content === null) await fse.remove(path.join(dir, file));
    else await fse.outputFile(path.join(dir, file), content);
  }
}

/** `hooks/<name>/` at the root of the team repo holding only `files`: every other file comes from teamai's folder. */
async function own(name: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) await fse.outputFile(path.join(repo, 'hooks', name, file), content);
}

/** teamai's action line when the reminder offers teamai-share-learnings, as it does in a scope that can run it. */
const SHARE_LEARNINGS = 'Offer the person the teamai-share-learnings workflow: run `teamai workflow start --describe teamai-share-learnings --driver skill` '
  + 'and start it with the inputs it proposes, once the person confirms them.';

const stdin = { session_id: 'replacement-session', cwd: os.tmpdir() };

/** What the Stop hook prints to Claude Code for a session whose cached friction score is 30 after `toolCount` tool calls, with `friction`. */
async function stopHint(toolCount: number, friction = { interrupt: 0, toolReject: 0, correction: 0, toolError: 0 }): Promise<string | null> {
  await writeContributeState(stdin.session_id, {
    contributed: false,
    smartScore: 30,
    toolCount,
    lastEvaluated: Date.now(),
    friction,
  });
  const stop = buildHandlerRegistry().find(({ handler }) => handler.name === 'contribute-check');
  const output = await stop?.handler.execute(stdin, 'claude', member());

  if (typeof output !== 'string') return null;

  return (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

beforeEach(async () => {
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-default-hook-home-'));
  repo = path.join(home, '.teamai', 'repo');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  await fse.ensureDir(path.join(home, '.claude'));
  // The friction reminder needs a team with recall on (#748).
  await fse.outputFile(path.join(repo, 'teamai.yaml'), 'team: acme\nrepo: https://example.test/acme/team.git\nsharing:\n  recall:\n    enabled: true\n');
  await fse.outputFile(path.join(home, '.teamai', 'config.yaml'), `repo:\n  localPath: ${JSON.stringify(repo)}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n`);
  resetWarnOnce();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(home);
});

describe('a team replacement of teamai-friction-reminder', () => {
  it('prints its own problem.md at Stop once pull delivered it', async () => {
    await replace('teamai-friction-reminder', { 'problem.md': '[acme] Worth a write-up? This session hit a snag.\n' });

    await reconcileTeamHooksForConfig(teamConfig, member());

    expect(await stopHint(20)).toBe(`[acme] Worth a write-up? This session hit a snag.\n\n${SHARE_LEARNINGS}`);
  });

  it('holding only its problem.md, gets teamai\'s other files delivered with it', async () => {
    await own('teamai-friction-reminder', { 'problem.md': '[acme] Worth a write-up?\n' });

    await reconcileTeamHooksForConfig(teamConfig, member());

    const delivered = path.join(home, '.teamai', 'hooks', 'teamai-friction-reminder');
    expect({
      hint: await stopHint(20),
      problem: await fse.readFile(path.join(delivered, 'problem.md'), 'utf8'),
      gap: await fse.readFile(path.join(delivered, 'gap.md'), 'utf8'),
      zh: await fse.pathExists(path.join(delivered, 'problem.zh.md')),
    }).toEqual({
      hint: `[acme] Worth a write-up?\n\n${SHARE_LEARNINGS}`,
      problem: '[acme] Worth a write-up?\n',
      gap: await fse.readFile(path.join(shipped('teamai-friction-reminder'), 'gap.md'), 'utf8'),
      zh: false,
    });
  });

  it('words a reason with its own reason-tool-reject.md, which may read {{ count }}', async () => {
    await own('teamai-friction-reminder', { 'reason-tool-reject.md': 'refused {{ count }} calls\n' });

    await reconcileTeamHooksForConfig(teamConfig, member());

    expect(await stopHint(20, { interrupt: 2, toolReject: 3, correction: 0, toolError: 0 }))
      .toBe(`[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, refused 3 calls.\n\n${SHARE_LEARNINGS}`);
  });

  it('with a file teamai\'s folder does not have, warns naming it and keeps teamai\'s file in force', async () => {
    await own('teamai-friction-reminder', { 'problem.md': '[acme] Worth a write-up?\n', 'problems.md': '[acme] A typo\n' });

    await reconcileTeamHooksForConfig(teamConfig, member());

    expect({
      warned: vi.mocked(log.warn).mock.calls.map(([message]) => message).filter((message) => String(message).includes('teamai-friction-reminder')),
      stray: await fse.pathExists(path.join(home, '.teamai', 'hooks', 'teamai-friction-reminder', 'problems.md')),
      hint: await stopHint(20),
    }).toEqual({
      warned: ['hooks/teamai-friction-reminder/problems.md replaces no file of teamai\'s default, so it is not used and teamai\'s files stay in force. '
        + 'Name it after the file it replaces, or replace the folder\'s marker too, so it can name the file.'],
      stray: false,
      hint: `[acme] Worth a write-up?\n\n${SHARE_LEARNINGS}`,
    });
  });

  it('reminds after as few tool calls as its params.yaml min_tools says, the parameters it leaves out keeping teamai\'s values', async () => {
    await own('teamai-friction-reminder', { 'params.yaml': 'min_tools: 3\n' });

    await reconcileTeamHooksForConfig(teamConfig, member());

    expect(await stopHint(5)).toBe(`[teamai] This session may contain a problem worth documenting.\n\n${SHARE_LEARNINGS}`);
  });

  describe('for a team whose language is zh', () => {
    const SHARE_LEARNINGS_ZH = '向用户提议使用 teamai-share-learnings 工作流：运行 `teamai workflow start --describe teamai-share-learnings --driver skill`，'
      + '等用户确认它建议的输入后，用这些输入启动它。';

    beforeEach(async () => {
      await fse.appendFile(path.join(repo, 'teamai.yaml'), 'language: zh\n');
    });

    it('prints its problem.zh.md', async () => {
      await replace('teamai-friction-reminder', { 'problem.zh.md': '[acme] 这次会话卡住过，要不要写下来？\n' });

      await reconcileTeamHooksForConfig(teamConfig, member());

      expect(await stopHint(20)).toBe(`[acme] 这次会话卡住过，要不要写下来？\n\n${SHARE_LEARNINGS_ZH}`);
    });

    it('words its own reason-interrupt.md, which has no .zh.md, in English beside teamai\'s Chinese reasons', async () => {
      await own('teamai-friction-reminder', { 'reason-interrupt.md': 'you interrupted the AI {{ times }}\n' });

      await reconcileTeamHooksForConfig(teamConfig, member());

      expect(await stopHint(20, { interrupt: 2, toolReject: 1, correction: 0, toolError: 0 }))
        .toBe(`[teamai] 这次会话可能有值得记录下来的问题：you interrupted the AI twice，你拒绝了 1 次工具调用。\n\n${SHARE_LEARNINGS_ZH}`);
    });

    it('prints its own problem.md when it has no problem.zh.md, never teamai\'s', async () => {
      await replace('teamai-friction-reminder', { 'problem.md': '[acme] Worth a write-up?\n', 'problem.zh.md': null });

      await reconcileTeamHooksForConfig(teamConfig, member());

      expect(await stopHint(20)).toBe(`[acme] Worth a write-up?\n\n${SHARE_LEARNINGS_ZH}`);
    });

    it('prints its own problem.md once the team deletes the problem.zh.md an earlier pull delivered', async () => {
      await replace('teamai-friction-reminder', { 'problem.md': '[acme] Worth a write-up?\n', 'problem.zh.md': '[acme] 这次会话卡住过，要不要写下来？\n' });
      await reconcileTeamHooksForConfig(teamConfig, member());

      await fse.remove(path.join(repo, 'hooks', 'teamai-friction-reminder', 'problem.zh.md'));
      await reconcileTeamHooksForConfig(teamConfig, member());

      expect(await stopHint(20)).toBe(`[acme] Worth a write-up?\n\n${SHARE_LEARNINGS_ZH}`);
    });
  });
});

describe('a team replacement read for a team whose language is zh', () => {
  beforeEach(async () => {
    await fse.appendFile(path.join(repo, 'teamai.yaml'), 'language: zh\n');
  });

  it('gives teamai-env-hint its variables.zh.md at session start', async () => {
    await fse.outputFile(path.join(repo, 'env', 'env.yaml'), 'variables:\n  - key: API_URL\n    value: https://api.example.com\n    description: the staging API\n');
    await replace('teamai-env-hint', { 'variables.zh.md': '这个范围里有团队环境变量：{{ variables }}。\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());

    const hint = buildHandlerRegistry().find(({ handler }) => handler.name === 'team-env-hint');
    const output = await hint?.handler.execute({}, 'claude', member());
    const context = typeof output === 'string' ? (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : output;

    expect(context).toBe('这个范围里有团队环境变量：API_URL (the staging API)。 '
      + 'Run the commands that need them through `teamai env exec -- <command>` so they get this directory\'s team values.');
  });

  it('gives teamai-package-hint its message.zh.md at session start', async () => {
    await fse.appendFile(path.join(repo, 'teamai.yaml'), 'packages:\n  npm:\n    - name: typescript\n      version: "*"\n');
    await replace('teamai-package-hint', { 'message.zh.md': '[acme] 团队声明的包变了（{{ summary }}），运行 `teamai packages` 应用。\n' });
    await reconcileTeamHooksForConfig(teamConfig, member());
    const cwd = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-default-hook-cwd-'));

    try {
      const output = await computePackageHintOutput(cwd);
      const context = output === null ? null : (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

      expect(context).toBe('[acme] 团队声明的包变了（1 npm package），运行 `teamai packages` 应用。');
    } finally {
      await fse.remove(cwd);
    }
  });
});

describe('pull refuses a replacement of a default hook that breaks its contract, and teamai\'s default stays in force', () => {
  const TEAM_PROBLEM = '[acme] Worth a write-up?\n';

  it.each<{ broken: string; files: Record<string, string | null>; refusal: string }>([
    {
      broken: 'a parameter out of its range',
      files: { 'params.yaml': 'min_tools: 5000\n' },
      refusal: 'hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: params.yaml: min_tools must be a whole number from 1 to 1000',
    },
    {
      broken: 'a parameter the default does not take',
      files: { 'params.yaml': 'max_tools: 30\n' },
      refusal: 'hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: params.yaml: max_tools is not a parameter of teamai-friction-reminder',
    },
    {
      broken: 'its parameters left in HOOK.yaml',
      files: { 'HOOK.yaml': 'description: Ask sooner\nwith:\n  min_tools: 3\n' },
      refusal: 'hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: HOOK.yaml: with is not a key of a default hook, whose parameters are in params.yaml. Move the keys of with to params.yaml',
    },
    {
      broken: 'a variable its text does not offer',
      files: { 'task.zh.md': '任务：{{ title }}\n' },
      refusal: 'hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: task.zh.md reads {{ title }}, which the task text does not offer: it offers {{ task }}',
    },
    {
      broken: 'a command',
      files: { 'HOOK.yaml': 'description: Our own nudge\ncommand: bash "${TEAMAI_HOOK_DIR}/nudge.sh"\n' },
      refusal: 'hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: HOOK.yaml: command is not taken by a default hook, which runs teamai\'s own handler. Remove it, or give a hook of your own another name',
    },
    {
      broken: 'an event',
      files: { 'HOOK.yaml': 'description: Remind at the end\nevent: Stop\n' },
      refusal: 'hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: HOOK.yaml: event is not a key of a default hook, whose HOOK.yaml holds only description',
    },
    {
      broken: 'a text in one language without its base file',
      files: { 'gap.md': null },
      refusal: 'hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: gap.md is missing: the folder replaces the gap text in another language, which replaces every language of it. Add gap.md',
    },
  ])('$broken', async ({ files, refusal }) => {
    await replace('teamai-friction-reminder', { 'problem.md': TEAM_PROBLEM, ...files });

    await reconcileTeamHooksForConfig(teamConfig, member());

    expect({
      warned: vi.mocked(log.warn).mock.calls.map(([message]) => message).filter((message) => String(message).includes('teamai-friction-reminder')),
      delivered: await fse.pathExists(path.join(home, '.teamai', 'hooks', 'teamai-friction-reminder')),
      hint: await stopHint(20),
    }).toEqual({ warned: [refusal], delivered: false, hint: `[teamai] This session may contain a problem worth documenting.\n\n${SHARE_LEARNINGS}` });
  });

  it('a symlink in it', async () => {
    await replace('teamai-friction-reminder', { 'problem.md': TEAM_PROBLEM });
    await fse.symlink(path.join(home, '.teamai', 'config.yaml'), path.join(repo, 'hooks', 'teamai-friction-reminder', 'notes.md'));

    await reconcileTeamHooksForConfig(teamConfig, member());

    expect({
      warned: vi.mocked(log.warn).mock.calls.map(([message]) => message).filter((message) => String(message).includes('teamai-friction-reminder')),
      delivered: await fse.pathExists(path.join(home, '.teamai', 'hooks', 'teamai-friction-reminder')),
    }).toEqual({
      warned: ['hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: notes.md is a symlink'],
      delivered: false,
    });
  });

  it.each([{ holding: 'every file of teamai\'s folder', copied: true }, { holding: 'only the file it changes', copied: false }])('in a namespace, holding $holding', async ({ copied }) => {
    await fse.outputFile(path.join(repo, 'manifest', 'projects.yaml'), 'version: 1\nprojects:\n  - id: checkout\n    resources: { hooks: [payments] }\n');

    if (copied) await fse.copy(shipped('teamai-friction-reminder'), path.join(repo, 'hooks', 'payments', 'teamai-friction-reminder'));
    await fse.outputFile(path.join(repo, 'hooks', 'payments', 'teamai-friction-reminder', 'problem.md'), TEAM_PROBLEM);

    await reconcileTeamHooksForConfig(teamConfig, { ...member(), projects: ['checkout'] });

    expect({
      warned: vi.mocked(log.warn).mock.calls.map(([message]) => message).filter((message) => String(message).includes('teamai-friction-reminder')),
      hint: await stopHint(20),
    }).toEqual({
      warned: ['hooks/payments/teamai-friction-reminder/ is refused, and teamai\'s default stays in force: a default hook is replaced at the root of the team repo only. Move it to hooks/teamai-friction-reminder/'],
      hint: `[teamai] This session may contain a problem worth documenting.\n\n${SHARE_LEARNINGS}`,
    });
  });
});
