import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@teamai/shared/log', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { deployBuiltinRules } from '../builtin-rules.js';
import { contentHash, openLedger } from '../resources/delivered-copies.js';
import { resolveInstructionBlocks } from '../pull.js';
import { log } from '@teamai/shared/log';
import { LocalConfigSchema, TeamaiConfigSchema } from '../types.js';

const GOLDEN = path.join(import.meta.dirname, 'fixtures', 'recall-golden');
const golden = (file: string): string => fs.readFileSync(path.join(GOLDEN, file), 'utf8');

/** A team's replacement of rules/teamai-recall/ that keeps the contract (#1787). */
const TEAM_RULE = '# Recall (our team)\n\nRun `teamai recall` first. If it prints `Nothing was searched:`, say so.\nRecall skips the older index when told.\n';
const TEAM_BLOCK = '## Recall (our team)\n\nAsk the teamai-recall subagent first.\n';
const TEAM_DIRECT = '## Recall (our team)\n\nRun `teamai recall`. Show any `Nothing was searched:` line.\n';

/** `body` between the recall markers, as pull writes a recall block. */
const wrapped = (body: string): string => [
  '<!-- [teamai:recall-rules:start] -->',
  '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
  '',
  body.replace(/\n$/, ''),
  '',
  '<!-- [teamai:recall-rules:end] -->',
].join('\n');

describe('a team replacement of rules/teamai-recall/ (#1787)', () => {
  let home: string;
  let repo: string;
  let originalHome: string | undefined;

  const write = (file: string, content: string): void => {
    const full = path.join(repo, 'rules', 'teamai-recall', file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const deployed = async (language?: 'en' | 'zh'): Promise<string> => {
    const rules = path.join(home, '.claude', 'rules');
    fs.mkdirSync(rules, { recursive: true });
    const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo', language, toolPaths: { claude: { rules: '.claude/rules' } } });
    const localConfig = LocalConfigSchema.parse({ repo: { localPath: repo, remote: '' }, username: 'member', scope: 'user', enabledAgents: ['claude'] });

    await deployBuiltinRules(teamConfig, localConfig);

    return fs.readFileSync(path.join(rules, 'teamai-recall.md'), 'utf8');
  };

  const blocks = async (language?: 'en' | 'zh') => {
    const localConfig = LocalConfigSchema.parse({ repo: { localPath: repo, remote: '' }, username: 'member', recallEnabled: true });

    return (await resolveInstructionBlocks(TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo', language }), localConfig, null)).blocks;
  };

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-folder-home-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-folder-repo-'));
    process.env.HOME = home;
    vi.clearAllMocks();
    write('RULE.md', TEAM_RULE);
    write('block.md', TEAM_BLOCK);
    write('block-direct.md', TEAM_DIRECT);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('delivers the team\'s rule and blocks in place of teamai\'s', async () => {
    expect(await deployed()).toBe(TEAM_RULE);
    expect(await blocks()).toMatchObject({ recall: wrapped(TEAM_BLOCK), directRecall: wrapped(TEAM_DIRECT) });
  });

  it('refuses a replacement whose language variant drops a required line, and keeps teamai\'s', async () => {
    write('RULE.en.md', '# Recall\n\nIf it prints `Nothing was searched:`, say so.\n');

    expect(await deployed('en')).toBe(golden('rule.en.md'));
    expect(await blocks('en')).toMatchObject({ recall: golden('block.en.md'), directRecall: golden('block-direct.en.md') });
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      'rules/teamai-recall/ is not used, so teamai\'s recall rule stays in force: RULE.en.md does not contain '
      + '"Recall skips the older index". Fix the folder in the team repo.',
    );
  });

  it('delivers a replacement holding RULE.old.md without the required lines: only en and zh are language variants', async () => {
    write('RULE.old.md', '# Our first recall rule\n');

    expect(await deployed()).toBe(TEAM_RULE);
  });

  it('records the copies of a team replacement in the delivery ledger, and not teamai\'s', async () => {
    const dest = path.join(home, '.claude', 'rules', 'teamai-recall.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo', toolPaths: { claude: { rules: '.claude/rules' } } });
    const deploy = async (localPath: string) => {
      const ledger = openLedger(undefined);
      await deployBuiltinRules(teamConfig, LocalConfigSchema.parse({ repo: { localPath, remote: '' }, username: 'member', scope: 'user', enabledAgents: ['claude'] }), { ledger });

      return ledger.hashes[dest];
    };

    expect(await deploy(repo)).toBe(contentHash(Buffer.from(TEAM_RULE)));
    expect(await deploy(path.join(repo, 'elsewhere'))).toBeUndefined();
  });

  it('takes teamai\'s file for each file a replacement leaves out', async () => {
    fs.rmSync(path.join(repo, 'rules', 'teamai-recall', 'block-direct.md'));

    expect(await deployed()).toBe(TEAM_RULE);
    expect(await blocks()).toMatchObject({ recall: wrapped(TEAM_BLOCK), directRecall: golden('block-direct.md') });
  });

  it('takes teamai\'s rule and its languages for a replacement holding only block.md', async () => {
    fs.rmSync(path.join(repo, 'rules', 'teamai-recall'), { recursive: true });
    write('block.md', TEAM_BLOCK);

    expect(await deployed('en')).toBe(golden('rule.en.md'));
    expect(await blocks('en')).toMatchObject({ recall: wrapped(TEAM_BLOCK), directRecall: golden('block-direct.en.md') });
  });

  it('warns about a file of a replacement that replaces no file of teamai\'s, and leaves it out', async () => {
    fs.rmSync(path.join(repo, 'rules', 'teamai-recall'), { recursive: true });
    write('block.md', TEAM_BLOCK);
    write('blocks.md', '## A typo\n');

    expect(await blocks()).toMatchObject({ recall: wrapped(TEAM_BLOCK) });
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      'rules/teamai-recall/blocks.md replaces no file of teamai\'s default, so it is not used and teamai\'s files stay in force. '
      + 'Name it after the file it replaces, or replace the folder\'s marker too, so it can name the file.',
    );
  });

  it('refuses a replacement holding a symlink, and delivers nothing it points at', async () => {
    const outside = path.join(home, 'private.txt');
    fs.writeFileSync(outside, 'PRIVATE KEY MATERIAL\n');
    fs.rmSync(path.join(repo, 'rules', 'teamai-recall', 'block.md'));
    fs.symlinkSync(outside, path.join(repo, 'rules', 'teamai-recall', 'block.md'));

    expect(await deployed()).toBe(golden('rule.md'));
    expect(await blocks()).toMatchObject({ recall: golden('block.md'), directRecall: golden('block-direct.md') });
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      'rules/teamai-recall/ is not used, so teamai\'s recall rule stays in force: rules/teamai-recall/block.md is a symlink. Fix the folder in the team repo.',
    );
  });

  it('refuses a replacement that names ${TEAMAI_RULE_DIR}, which no recall file is rendered with', async () => {
    write('block.md', '## Recall (our team)\n\nRead `${TEAMAI_RULE_DIR}/examples.md` first.\n');
    write('examples.md', '- search before you plan\n');

    expect(await blocks()).toMatchObject({ recall: golden('block.md'), directRecall: golden('block-direct.md') });
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      'rules/teamai-recall/ is not used, so teamai\'s recall rule stays in force: block.md names ${TEAMAI_RULE_DIR}, '
      + 'but the text of a teamai default rule is delivered alone, without the other files of its folder. Put what it points at in the file. Fix the folder in the team repo.',
    );
  });

  it('falls back to the replacement\'s own base file for a language it lacks, and takes a direct block in that language', async () => {
    write('block-direct.en.md', '## Recall\n\nRun `teamai recall`. Quote any `Nothing was searched:` line.\n');

    expect(await deployed('en')).toBe(TEAM_RULE);
    expect(await blocks('en')).toMatchObject({
      recall: wrapped(TEAM_BLOCK),
      directRecall: wrapped('## Recall\n\nRun `teamai recall`. Quote any `Nothing was searched:` line.\n'),
    });
  });
});
