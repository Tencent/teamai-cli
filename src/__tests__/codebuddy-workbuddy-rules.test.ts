import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import crypto from 'node:crypto';
import { RulesHandler } from '../resources/rules.js';
import { openLedger } from '../resources/delivered-copies.js';
import { log } from '../utils/logger.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * CodeBuddy and WorkBuddy run the same engine and read CodeBuddy's rules
 * format (#946). In a project both read `.codebuddy/rules`, so they share one
 * copy there; in user scope each has its own home.
 */
const SCOPED = '---\npaths: ["src/**/*.ts", "test/**"]\n---\n\nUse named exports.\n';
const RENDER = '---\nalwaysApply: false\npaths:\n  - "src/**/*.ts"\n  - "test/**"\n---\n\nUse named exports.\n';

describe('CodeBuddy and WorkBuddy rules (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let repoPath: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  const home = (rel: string) => path.join(homeDir, rel);
  const project = (rel: string) => path.join(projectRoot, rel);

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codebuddy-rules-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'rules', 'scoped.md'), SCOPED);
    await fse.ensureDir(projectRoot);
    vi.stubEnv('HOME', homeDir);
    vi.clearAllMocks();
    handler = new RulesHandler();
    teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['codebuddy', 'workbuddy'],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  const inProject = () => {
    localConfig = { ...localConfig, scope: 'project', projectRoot } as LocalConfig;
  };

  it('writes CodeBuddy\'s render to ~/.codebuddy/rules and ~/.workbuddy/rules in user scope', async () => {
    await fse.ensureDir(home('.codebuddy'));
    await fse.ensureDir(home('.workbuddy'));

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(home('.codebuddy/rules/scoped.md'), 'utf8')).toBe(RENDER);
    expect(await fse.readFile(home('.workbuddy/rules/scoped.md'), 'utf8')).toBe(RENDER);
  });

  it('writes one copy to the project\'s .codebuddy/rules for both tools, and nothing to .workbuddy/rules', async () => {
    inProject();
    await fse.ensureDir(project('.codebuddy'));
    await fse.ensureDir(project('.workbuddy'));

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(project('.codebuddy/rules/scoped.md'), 'utf8')).toBe(RENDER);
    expect(await fse.pathExists(project('.workbuddy/rules'))).toBe(false);
    const targets = await handler.deliveryTargets(teamConfig, localConfig, (await handler.scanTeamForPull(teamConfig, localConfig))[0]);
    expect(targets.map(({ dest }) => dest)).toEqual([project('.codebuddy/rules/scoped.md')]);
  });

  it('shares Qoder and Qoder CN\'s one project copy the same way, any two tools reading one file in one render', async () => {
    inProject();
    localConfig = { ...localConfig, enabledAgents: ['qoder', 'qoder-cn'] } as LocalConfig;
    await fse.ensureDir(project('.qoder'));

    const targets = await handler.deliveryTargets(teamConfig, localConfig, (await handler.scanTeamForPull(teamConfig, localConfig))[0]);

    expect(targets).toMatchObject([{ tool: 'qoder', dest: project('.qoder/rules/scoped.md'), sharedWith: ['qoder-cn'] }]);
  });

  it('delivers to .codebuddy/rules for WorkBuddy alone, probing .workbuddy for its install', async () => {
    inProject();
    localConfig = { ...localConfig, enabledAgents: ['workbuddy'] } as LocalConfig;

    await handler.pullAllRules(teamConfig, localConfig);
    expect(await fse.pathExists(project('.codebuddy/rules/scoped.md'))).toBe(false);

    await fse.ensureDir(project('.workbuddy'));
    await handler.pullAllRules(teamConfig, localConfig);
    expect(await fse.readFile(project('.codebuddy/rules/scoped.md'), 'utf8')).toBe(RENDER);
  });

  describe('the shared project copy', () => {
    beforeEach(async () => {
      inProject();
      await fse.ensureDir(project('.codebuddy'));
      await fse.ensureDir(project('.workbuddy'));
      await handler.pullAllRules(teamConfig, localConfig);
    });

    it.each([['codebuddy'], ['workbuddy']])('stays while only %s is enabled', async (tool) => {
      await fse.outputFile(path.join(repoPath, 'rules', 'scoped.md'), SCOPED.replace('named', 'default'));
      localConfig = { ...localConfig, enabledAgents: [tool] } as LocalConfig;

      await handler.pullAllRules(teamConfig, localConfig);

      expect(await fse.readFile(project('.codebuddy/rules/scoped.md'), 'utf8')).toBe(RENDER.replace('named', 'default'));
    });

    it('is not offered for push after a clean pull, and an edited body pushes without the CodeBuddy frontmatter', async () => {
      expect(await handler.scanLocalForPush(teamConfig, localConfig)).toEqual([]);

      await fse.writeFile(project('.codebuddy/rules/scoped.md'), RENDER.replace('named', 'default'));
      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      expect(items).toMatchObject([{ name: 'scoped', status: 'modified' }]);
      await handler.pushItem(items[0], teamConfig, localConfig);

      expect(await fse.readFile(path.join(repoPath, 'rules', 'scoped.md'), 'utf8')).toBe(SCOPED.replace('named', 'default'));
    });

    it("keeps a member's own CodeBuddy rule there on pull and never offers it as a new team rule", async () => {
      const mine = project('.codebuddy/rules/mine.md');
      await fse.writeFile(mine, '---\nalwaysApply: true\n---\n\nMine.\n');

      await handler.pullAllRules(teamConfig, localConfig);

      expect(await fse.pathExists(mine)).toBe(true);
      expect(await handler.scanLocalForPush(teamConfig, localConfig)).toEqual([]);
    });
  });

  const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  const warnings = () => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));

  describe('a project\'s .workbuddy/rules, which WorkBuddy never read', () => {
    const legacy = (file: string) => project(`.workbuddy/rules/${file}`);

    beforeEach(async () => {
      inProject();
      await fse.ensureDir(project('.workbuddy'));
    });

    it('reclaims the copies an older pull wrote there, and delivers to .codebuddy/rules instead', async () => {
      await fse.outputFile(legacy('scoped.md'), SCOPED);
      await fse.outputFile(legacy('mine.md'), 'My own WorkBuddy note.\n');

      await handler.pullAllRules(teamConfig, localConfig);

      expect(await fse.pathExists(legacy('scoped.md'))).toBe(false);
      expect(await fse.readFile(legacy('mine.md'), 'utf8')).toBe('My own WorkBuddy note.\n');
      expect(await fse.readFile(project('.codebuddy/rules/scoped.md'), 'utf8')).toBe(RENDER);
      expect(warnings()).toEqual([]);
    });

    it('removes the directory once nothing else is in it, and also for a WorkBuddy that is excluded', async () => {
      localConfig = { ...localConfig, enabledAgents: ['claude'] } as LocalConfig;
      await fse.outputFile(legacy('scoped.md'), SCOPED);

      await handler.pullAllRules(teamConfig, localConfig);

      expect(await fse.pathExists(project('.workbuddy/rules'))).toBe(false);
      expect(await fse.pathExists(project('.workbuddy'))).toBe(true);
    });

    it('keeps an edited copy and names it once, saying where WorkBuddy reads a project\'s rules', async () => {
      const edited = SCOPED.replace('named', 'my own');
      await fse.outputFile(legacy('scoped.md'), edited);

      await handler.pullAllRules(teamConfig, localConfig);

      expect(await fse.readFile(legacy('scoped.md'), 'utf8')).toBe(edited);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain(legacy('scoped.md'));
      expect(warnings()[0]).toContain('WorkBuddy reads a project\'s rules from .codebuddy/rules');
      expect(warnings()[0]).not.toContain('Codex');
    });
  });

  describe('the team rules WorkBuddy\'s one-time migration copied from ~/.codebuddy/rules', () => {
    const migrated = (file: string) => home(`.workbuddy/rules/${file}`);

    beforeEach(async () => {
      await fse.ensureDir(home('.codebuddy'));
      await fse.outputFile(home('.workbuddy/.migrated-from-codebuddy'), '2026-09-01T00:00:00.000Z');
      await fse.outputFile(path.join(repoPath, 'rules', 'backend.md'), 'Backend rule.\n');
      await fse.outputFile(path.join(repoPath, 'rules', 'frontend.md'), 'Frontend rule.\n');
    });

    it('re-renders a copy still delivered, removes unedited ones no longer delivered, and keeps the rest', async () => {
      // Delivered here: verbatim, as ~/.codebuddy/rules held it.
      await fse.outputFile(migrated('scoped.md'), SCOPED);
      // Not delivered to this member (filtered out): verbatim.
      await fse.outputFile(migrated('backend.md'), 'Backend rule.\n');
      // Not delivered: an older version, proven only by ~/.codebuddy/rules' record.
      await fse.outputFile(migrated('frontend.md'), 'Frontend rule, older.\n');
      // Not delivered, and the member changed it.
      await fse.outputFile(home('.workbuddy/rules/edited.md'), 'Edited.\n');
      await fse.outputFile(path.join(repoPath, 'rules', 'edited.md'), 'Team version.\n');
      // The member's own CodeBuddy rule, migrated with the rest.
      await fse.outputFile(migrated('mine.md'), 'Mine.\n');
      const ledger = openLedger({ [home('.codebuddy/rules/frontend.md')]: sha256('Frontend rule, older.\n') });
      const rules = (await handler.scanTeamForPull(teamConfig, localConfig)).filter((rule) => rule.name === 'scoped');

      await handler.pullAllRules(teamConfig, localConfig, rules, [], ledger);

      expect(await fse.readFile(migrated('scoped.md'), 'utf8')).toBe(RENDER);
      expect(ledger.hashes[migrated('scoped.md')]).toBe(sha256(RENDER));
      expect(await fse.pathExists(migrated('backend.md'))).toBe(false);
      expect(await fse.pathExists(migrated('frontend.md'))).toBe(false);
      expect(await fse.readFile(migrated('edited.md'), 'utf8')).toBe('Edited.\n');
      expect(await fse.readFile(migrated('mine.md'), 'utf8')).toBe('Mine.\n');
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain(migrated('edited.md'));
      expect(warnings()[0]).toContain('~/.codebuddy/rules');
      expect(warnings()[0]).not.toContain(migrated('mine.md'));
    });

    it('keeps an edited copy of a rule still delivered, as an edit of the copy it came from (#822)', async () => {
      const source = home('.codebuddy/rules/scoped.md');
      const edited = SCOPED.replace('named', 'my own');
      await fse.outputFile(migrated('scoped.md'), edited);
      const ledger = openLedger({ [source]: sha256(SCOPED) });

      await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);

      expect(await fse.readFile(migrated('scoped.md'), 'utf8')).toBe(edited);
      expect(ledger.kept.map(({ dest }) => dest)).toContain(migrated('scoped.md'));
      expect(ledger.hashes[migrated('scoped.md')]).toBe(sha256(SCOPED));
    });

    it.each([
      ['without the migration marker', async () => { await fse.remove(home('.workbuddy/.migrated-from-codebuddy')); }, {}],
      ['while WorkBuddy is excluded', async () => {}, { enabledAgents: ['codebuddy'] }],
    ])('leaves ~/.workbuddy/rules alone %s', async (_label, arrange, config) => {
      await arrange();
      localConfig = { ...localConfig, ...config } as LocalConfig;
      await fse.outputFile(migrated('backend.md'), 'Backend rule.\n');
      await fse.outputFile(migrated('edited.md'), 'Edited.\n');
      await fse.outputFile(path.join(repoPath, 'rules', 'edited.md'), 'Team version.\n');
      const rules = (await handler.scanTeamForPull(teamConfig, localConfig)).filter((rule) => rule.name === 'scoped');

      await handler.pullAllRules(teamConfig, localConfig, rules, [], openLedger({}));

      expect(await fse.readFile(migrated('backend.md'), 'utf8')).toBe('Backend rule.\n');
      expect(await fse.readFile(migrated('edited.md'), 'utf8')).toBe('Edited.\n');
      expect(warnings().filter((message) => message.includes('copied it from'))).toEqual([]);
    });
  });
});
