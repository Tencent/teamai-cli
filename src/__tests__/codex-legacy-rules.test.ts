import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
}));

vi.mock('@teamai/shared/log', () => ({
  log: {
    persist: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { RulesHandler } from '../resources/rules.js';
import { deployBuiltinRules } from '../builtin-rules.js';
import { openLedger, type DeliveredHashes } from '../resources/delivered-copies.js';
import { loadStateForScope } from '../config.js';
import { log } from '../utils/logger.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const CODEX_FAMILY = ['codex', 'codex-internal', 'tcodex'];

describe('pull reclaims the .codex/rules copies earlier pulls wrote (#938)', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let repoPath: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  const legacyDir = () => path.join(projectRoot, '.codex', 'rules');
  const legacy = (file: string) => path.join(legacyDir(), file);

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-legacy-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(homeDir);
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(projectRoot, '.codex'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    vi.stubEnv('HOME', homeDir);
    vi.clearAllMocks();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);

    handler = new RulesHandler();
    teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
      enabledAgents: ['codex'],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it.each(CODEX_FAMILY)('removes an unchanged %s rule copy, and the directory once nothing else is in it', async (tool) => {
    localConfig = { ...localConfig, enabledAgents: [tool] } as LocalConfig;
    const dir = path.join(projectRoot, `.${tool}`, 'rules');
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'codeword.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(dir, 'codeword.md'))).toBe(false);
    expect(await fse.pathExists(dir)).toBe(false);
  });

  /** The recall rule as a pull before #938 deployed it to `.codex/rules`. */
  async function deployLegacyRecallRule(): Promise<string> {
    await fse.ensureDir(legacyDir());
    const legacyConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, codex: { ...teamConfig.toolPaths.codex, rules: '.codex/rules' } },
    };
    await deployBuiltinRules(legacyConfig, localConfig);
    return fse.readFile(legacy('teamai-recall.md'), 'utf8');
  }

  it('removes the built-in teamai-recall.md as teamai deployed it', async () => {
    await deployLegacyRecallRule();

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('teamai-recall.md'))).toBe(false);
    expect(await fse.pathExists(legacyDir())).toBe(false);
  });

  it('keeps a teamai-recall.md the member edited after the last pull that wrote it', async () => {
    const deployed = await deployLegacyRecallRule();
    const edited = `${deployed}\nAlso read docs/onboarding.md first.\n`;
    await fse.writeFile(legacy('teamai-recall.md'), edited);

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(legacy('teamai-recall.md'), 'utf8')).toBe(edited);
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(legacy('teamai-recall.md'));
  });

  it.each(CODEX_FAMILY)('keeps an edited %s copy and names it once in an English warning with how to remove it', async (tool) => {
    localConfig = { ...localConfig, enabledAgents: [tool] } as LocalConfig;
    const copy = (file: string) => path.join(projectRoot, `.${tool}`, 'rules', file);
    await fse.writeFile(path.join(repoPath, 'rules', 'style.md'), 'Use tabs.\n');
    await fse.ensureDir(path.dirname(copy('x')));
    await fse.writeFile(copy('codeword.md'), 'The team codeword is PELICAN-42.\nMy own note.\n');
    await fse.writeFile(copy('style.md'), 'Use spaces.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(copy('codeword.md'), 'utf8')).toBe('The team codeword is PELICAN-42.\nMy own note.\n');
    expect(await fse.readFile(copy('style.md'), 'utf8')).toBe('Use spaces.\n');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(copy('codeword.md'));
    expect(warnings[0]).toContain(copy('style.md'));
    expect(warnings[0]).toContain('AGENTS.md');
    expect(warnings[0]).toMatch(/[Dd]elete/);
  });

  it('keeps a member\'s link at a legacy copy\'s path, even when its target holds the copy teamai wrote (#993)', async () => {
    await fse.ensureDir(legacyDir());
    const target = path.join(tmpDir, 'mine', 'codeword.md');
    await fse.outputFile(target, 'The team codeword is PELICAN-42.\n');
    await fse.symlink(target, legacy('codeword.md'));
    const recallTarget = path.join(tmpDir, 'mine', 'teamai-recall.md');
    await fse.outputFile(recallTarget, await deployLegacyRecallRule());
    await fse.remove(legacy('teamai-recall.md'));
    await fse.symlink(recallTarget, legacy('teamai-recall.md'));

    await handler.pullAllRules(teamConfig, localConfig);
    const copies = await handler.legacyRuleCopies(teamConfig, localConfig, undefined);

    expect((await fse.lstat(legacy('codeword.md'))).isSymbolicLink()).toBe(true);
    expect((await fse.lstat(legacy('teamai-recall.md'))).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(target, 'utf8')).toBe('The team codeword is PELICAN-42.\n');
    expect(copies.flatMap(({ owned, edited }) => [...owned, ...edited])).toEqual([]);
  });

  it('never touches Codex exec-policy files or files that are not team rules', async () => {
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(legacy('default.rules'), 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n');
    // Same bytes as a team rule, but not a team rule's name.
    await fse.writeFile(legacy('personal.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
    expect(await fse.readFile(legacy('default.rules'), 'utf8')).toContain('prefix_rule');
    expect(await fse.pathExists(legacy('personal.md'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reclaims the user-scope legacy copies under the recorded Codex root', async () => {
    const root = path.join(homeDir, '.config', 'codex-work');
    localConfig = { ...localConfig, scope: 'user', projectRoot: undefined, toolRoots: { codex: root } } as LocalConfig;
    await fse.outputFile(path.join(root, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(path.join(root, 'rules', 'default.rules'), 'prefix_rule(pattern = ["ls"], decision = "allow")\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(root, 'rules', 'codeword.md'))).toBe(false);
    expect(await fse.pathExists(path.join(root, 'rules', 'default.rules'))).toBe(true);
  });

  it.each([false, true])('reclaims a publisher\'s bare and namespaced legacy copies only while unchanged, edited: %s', async (edited) => {
    await fse.outputFile(path.join(repoPath, 'rules', 'frontend', 'style.md'), 'Frontend rule.\n');
    vi.mocked(loadStateForScope).mockImplementation(async () => ({ placedRules: { style: 'rules/frontend/style.md' } }) as never);
    const content = edited ? 'Frontend rule.\nMy own note.\n' : 'Frontend rule.\n';
    await fse.outputFile(legacy('style.md'), content);
    await fse.outputFile(legacy('frontend/style.md'), content);

    await handler.pullAllRules(teamConfig, localConfig);

    for (const file of [legacy('style.md'), legacy('frontend/style.md')]) {
      if (edited) expect(await fse.readFile(file, 'utf8')).toBe(content);
      else expect(await fse.pathExists(file)).toBe(false);
    }
  });

  it('keeps a bare same-name copy without a publisher placement record', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'frontend', 'style.md'), 'Frontend rule.\n');
    await fse.outputFile(legacy('style.md'), 'Frontend rule.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(legacy('style.md'), 'utf8')).toBe('Frontend rule.\n');
  });

  it.each([false, true])('reclaims a publisher\'s tombstoned bare copy only while its recorded hash matches, edited: %s', async (edited) => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'frontend/style\n');
    vi.mocked(loadStateForScope).mockImplementation(async () => ({ placedRules: { style: 'rules/frontend/style.md' } }) as never);
    const file = legacy('style.md');
    const content = edited ? 'Frontend rule.\nMy own note.\n' : 'Frontend rule.\n';
    await fse.outputFile(file, content);
    const ledger = openLedger({ [file]: crypto.createHash('sha256').update('Frontend rule.\n').digest('hex') });

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);

    if (edited) {
      expect(await fse.readFile(file, 'utf8')).toBe(content);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(file));
    } else {
      expect(await fse.pathExists(file)).toBe(false);
      expect(ledger.hashes[file]).toBeUndefined();
    }
  });

  it('removes a copy of the rule as it was at the revision this checkout last pulled', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } });
    run(['init', '-q', '-b', 'main']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'rule as delivered']);
    const deliveredRev = run(['rev-parse', 'HEAD']).trim();
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is HERON-7.\n');
    run(['commit', '-q', '-am', 'rule changed since']);
    vi.mocked(loadStateForScope).mockImplementation(async () => ({ lastPullRev: deliveredRev }) as never);
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('removes a copy the delivery ledger recorded, and forgets the record', async () => {
    await fse.ensureDir(legacyDir());
    const file = legacy('codeword.md');
    // Written by a build that delivered a since-reverted edit of the rule.
    await fse.writeFile(file, 'The team codeword was PELICAN-41.\n');
    const hash = crypto.createHash('sha256').update('The team codeword was PELICAN-41.\n').digest('hex');
    const ledger = openLedger({ [file]: hash });

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);

    expect(await fse.pathExists(file)).toBe(false);
    expect(ledger.hashes[file]).toBeUndefined();
  });

  it.each<DeliveredHashes | undefined>([undefined, {}, { unrelated: 'recorded-hash' }])('keeps a removed rule copy without a recorded delivery hash (%j)', async (previous) => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'retired\n');
    await fse.ensureDir(legacyDir());
    const file = legacy('retired.md');
    const edited = 'A rule the team retired.\nMy own note.\n';
    await fse.writeFile(file, edited);

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], openLedger(previous));

    expect(await fse.readFile(file, 'utf8')).toBe(edited);
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
    expect(warnings[0]).toContain('could not verify');
  });

  it('removes the recorded, unchanged copy of a rule the team has since removed', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'retired\n');
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('retired.md'), 'A rule the team retired.\n');
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');
    const hash = crypto.createHash('sha256').update('A rule the team retired.\n').digest('hex');
    const ledger = openLedger({ [legacy('retired.md')]: hash });

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);

    expect(await fse.pathExists(legacy('retired.md'))).toBe(false);
    expect(await fse.pathExists(legacyDir())).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps and names the copy of a removed rule the member changed since teamai delivered it (#822)', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'retired\n');
    await fse.ensureDir(legacyDir());
    const file = legacy('retired.md');
    await fse.writeFile(file, 'A rule the team retired.\nMy own note.\n');
    const delivered = crypto.createHash('sha256').update('A rule the team retired.\n').digest('hex');
    const ledger = openLedger({ [file]: delivered });

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);

    expect(await fse.readFile(file, 'utf8')).toBe('A rule the team retired.\nMy own note.\n');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });

  it('runs when no rule reaches this directory, and covers rules filtered out by roles or tags', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'backend-only.md'), 'Backend rule.\n');
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(legacy('backend-only.md'), 'Backend rule.\n');

    await handler.pullAllRules(teamConfig, localConfig, []);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
    expect(await fse.pathExists(legacy('backend-only.md'))).toBe(false);
    expect(await fse.pathExists(legacyDir())).toBe(false);
  });

  it('also reclaims the copies of a Codex that is excluded or not installed', async () => {
    // Excluded, and no hooks.json: nothing marks Codex as installed.
    localConfig = { ...localConfig, enabledAgents: ['claude'] } as LocalConfig;
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
  });

  it('leaves a directory the team still delivers rules to through its toolPaths', async () => {
    teamConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, codex: { ...teamConfig.toolPaths.codex, rules: '.codex/rules' } },
    };
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');
    // The built-in pull deploys there next to the team rules.
    await fse.writeFile(legacy('teamai-recall.md'), '# Team Knowledge Recall (teamai)\n\nRecall first.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(legacy('codeword.md'), 'utf8')).toBe('The team codeword is PELICAN-42.\n');
    expect(await fse.pathExists(legacy('teamai-recall.md'))).toBe(true);
  });

  it.each(['codex', 'codex-internal', 'tcodex'])('reclaims %s copies in user scope, and a second pull finds nothing to do', async (tool) => {
    // The default entries: no Codex-family id delivers to a rules dir.
    localConfig = { ...localConfig, scope: 'user', projectRoot: undefined } as unknown as LocalConfig;
    const dir = path.join(homeDir, `.${tool}`, 'rules');
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(path.join(dir, 'default.rules'), 'prefix_rule(pattern = ["ls"], decision = "allow")\n');

    await handler.pullAllRules(teamConfig, localConfig);
    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(dir, 'codeword.md'))).toBe(false);
    expect(await fse.pathExists(path.join(dir, 'default.rules'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
