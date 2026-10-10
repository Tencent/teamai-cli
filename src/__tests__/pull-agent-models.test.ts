/**
 * Recorded agent models on the "Already synced" path (#830): pull records
 * the model and effort each agent copy received, and an ordinary pull with an
 * unchanged team revision redeploys the agents whose model it would now write
 * differently, such as a `model: strong` an older CLI copied literally.
 * Asserted through `pull`, on the files in tool dirs and the state it saves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import matter from 'gray-matter';
import { parse as parseToml } from 'smol-toml';
import YAML from 'yaml';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    persist: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../source.js', () => ({ pullSources: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn().mockResolvedValue(undefined),
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue({ ok: true, defs: [] }),
  deliveredHookFiles: vi.fn().mockResolvedValue([]),
  unreadableHookFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
}));
vi.mock('../team-push.js', () => ({ reportUsageToTeam: vi.fn().mockResolvedValue(true) }));
vi.mock('../usage-tracker.js', () => ({
  readUsageEvents: vi.fn().mockResolvedValue([]),
  truncateUsageAfterReport: vi.fn().mockResolvedValue(undefined),
  capUsageEvents: vi.fn().mockResolvedValue(undefined),
}));
// pull() takes a real lock file; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { getHeadRev } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { renderForTool, serializeAgentYaml, type AgentSpec } from '../resources/agent-format.js';
import { ModelProfileSchema, resolveProfile, type ModelAgent } from '../models/profile.js';
import { restoreModelProfiles, switchModelProfile } from '../models/switch.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const STRONG = {
  aliases: {
    strong: {
      claude: { model: 'opus', effort: 'high' },
      codex: { model: 'gpt-6-sol', effort: 'high' },
    },
  },
};

const IMPLEMENTER: AgentSpec = {
  name: 'implementer',
  description: 'Implements a change',
  instructions: 'Make the change.',
  model: 'strong',
};

describe('pull: recorded agent models on an unchanged team revision', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-models-')));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await fse.ensureDir(path.join(homeDir, '.codex'));
    vi.stubEnv('HOME', homeDir);
    // The switch reads these to find each tool's live settings.
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME']) vi.stubEnv(key, '');
    vi.clearAllMocks();
    vi.mocked(detectProjectConfig).mockResolvedValue(null);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { agents: '.claude/agents' },
        codex: { agents: '.codex/agents' },
      },
    } as TeamaiConfig;
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'member',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    await fse.remove(tmpDir);
  });

  const writeAliases = (aliases: unknown): Promise<void> => fse.outputFile(path.join(repoPath, 'models/aliases.yaml'), YAML.stringify(aliases));
  const writeAgent = (spec: AgentSpec): Promise<void> => fse.outputFile(path.join(repoPath, 'agents', `${spec.name}.yaml`), serializeAgentYaml(spec));
  const claudeFile = (name = 'implementer'): string => path.join(homeDir, '.claude', 'agents', `${name}.md`);
  const codexFile = (name = 'implementer'): string => path.join(homeDir, '.codex', 'agents', `${name}.toml`);
  const claudeModel = async (name?: string): Promise<Record<string, unknown>> => matter(await fse.readFile(claudeFile(name), 'utf-8')).data;
  const codexModel = async (name?: string): Promise<Record<string, unknown>> => parseToml(await fse.readFile(codexFile(name), 'utf-8'));
  const logged = (level: 'warn' | 'info' | 'success', pattern: RegExp): boolean => (
    vi.mocked(log[level]).mock.calls.some((args) => pattern.test(args.map(String).join(' ')))
  );
  const alreadySynced = (): boolean => logged('success', /Already synced at abc1234/);
  const homeRecord = async () => Object.values((await loadStateForScope(localConfig)).lastPullByWorkspace ?? {})[0];

  /** A first full pull, then a clean slate of log calls for the pull under test. */
  async function pullOnce(): Promise<void> {
    await pull({ silent: true });
    expect(alreadySynced()).toBe(false);
    vi.clearAllMocks();
  }

  /**
   * The state an older CLI leaves: `spec` copied to Claude with its `model`
   * as written, that copy's hash on record, and no agent models.
   */
  async function writtenByOlderCli(spec: AgentSpec): Promise<void> {
    const literal = renderForTool(spec, 'claude').content;
    await fse.writeFile(claudeFile(spec.name), literal);
    const state = await loadStateForScope(localConfig);
    const record = Object.values(state.lastPullByWorkspace ?? {})[0]!;
    record.delivered = { ...record.delivered, [claudeFile(spec.name)]: crypto.createHash('sha256').update(literal).digest('hex') };
    delete record.agentModels;
    await saveStateForScope(state, localConfig);
  }

  it('records what each tool received on a full pull', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();

    expect((await homeRecord())?.agentModels).toEqual({
      implementer: {
        claude: { step: 'team', model: 'opus', effort: 'high', source: 'models/aliases.yaml', alias: 'strong' },
        codex: { step: 'team', model: 'gpt-6-sol', effort: 'high', source: 'models/aliases.yaml', alias: 'strong' },
      },
    });
  });

  it('rewrites nothing when every agent\'s model matches its record', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await writeAgent({ ...IMPLEMENTER, name: 'plain', model: 'sonnet' });
    await pullOnce();
    const before = await Promise.all([claudeFile(), codexFile(), claudeFile('plain')].map((file) => fse.stat(file)));

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(logged('success', /Updated the model/)).toBe(false);
    const after = await Promise.all([claudeFile(), codexFile(), claudeFile('plain')].map((file) => fse.stat(file)));
    expect(after.map((stat) => stat.mtimeMs)).toEqual(before.map((stat) => stat.mtimeMs));
  });

  it('fixes a model an older CLI wrote literally, with no record, on an ordinary pull', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();
    await writtenByOlderCli(IMPLEMENTER);
    expect(await claudeModel()).toMatchObject({ model: 'strong' });

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(await claudeModel()).toMatchObject({ model: 'opus', effort: 'high' });
    expect(logged('success', /Updated the model of 1 agent\(s\): implementer/)).toBe(true);
    expect((await homeRecord())?.agentModels?.['implementer']?.['claude']).toEqual({ step: 'team', model: 'opus', effort: 'high', source: 'models/aliases.yaml', alias: 'strong' });

    // Recorded now, so the next pull leaves it alone.
    vi.clearAllMocks();
    await pull({ silent: true });
    expect(logged('success', /Updated the model/)).toBe(false);
  });

  it('does not rewrite an agent without an alias for want of a record', async () => {
    const plain = { ...IMPLEMENTER, name: 'plain', model: 'sonnet' };
    await writeAgent(plain);
    await pullOnce();
    await writtenByOlderCli(plain);
    const before = await fse.stat(claudeFile('plain'));

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(logged('success', /Updated the model/)).toBe(false);
    expect((await fse.stat(claudeFile('plain'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('redeploys an agent whose resolution changed since its record', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();
    // The aliases change while the recorded revision does not, as a local
    // alias file or a switched tool will.
    await writeAliases({ aliases: { strong: { claude: 'fable', codex: STRONG.aliases.strong.codex } } });

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    const claude = await claudeModel();
    expect(claude).toMatchObject({ model: 'fable' });
    expect(claude).not.toHaveProperty('effort');
    expect(await codexModel()).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    expect((await homeRecord())?.agentModels?.['implementer']?.['claude']).toEqual({ step: 'team', model: 'fable', source: 'models/aliases.yaml', alias: 'strong' });
  });

  it('keeps a copy the member changed, and its record', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();
    const edited = `${await fse.readFile(claudeFile(), 'utf-8')}\nMy own note.\n`;
    await fse.writeFile(claudeFile(), edited);
    await writeAliases({ aliases: { strong: { claude: 'fable', codex: 'gpt-6-luna' } } });

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(await fse.readFile(claudeFile(), 'utf-8')).toBe(edited);
    expect(logged('warn', /Kept .*implementer\.md: you changed it/)).toBe(true);
    expect(await codexModel()).toMatchObject({ model: 'gpt-6-luna' });
    const recorded = (await homeRecord())?.agentModels?.['implementer'];
    expect(recorded?.['claude']).toEqual({ step: 'team', model: 'opus', effort: 'high', source: 'models/aliases.yaml', alias: 'strong' });
    expect(recorded?.['codex']).toEqual({ step: 'team', model: 'gpt-6-luna', source: 'models/aliases.yaml', alias: 'strong' });
  });

  describe('local override', () => {
    const writeLocal = (text: string): Promise<void> => fse.outputFile(path.join(homeDir, '.teamai/models/aliases.yaml'), text);

    it('applies an edited override on an ordinary pull, and ~ or default sends the tool to its default', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();
      await writeLocal('aliases:\n  strong:\n    codex: { model: gpt-6-astra, effort: low }\n');

      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      expect(await codexModel()).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'low' });
      expect(await claudeModel()).toMatchObject({ model: 'opus', effort: 'high' });
      expect((await homeRecord())?.agentModels?.['implementer']?.['codex']).toEqual({ step: 'local', model: 'gpt-6-astra', effort: 'low', source: path.join(homeDir, '.teamai/models/aliases.yaml'), alias: 'strong' });

      vi.clearAllMocks();
      await writeLocal('aliases:\n  strong:\n    codex: default\n');
      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      const codex = await codexModel();
      expect(codex).toHaveProperty('name', 'implementer');
      expect(codex).not.toHaveProperty('model');
      expect(codex).not.toHaveProperty('model_reasoning_effort');
      expect((await homeRecord())?.agentModels?.['implementer']?.['codex']).toEqual({ step: 'local', source: path.join(homeDir, '.teamai/models/aliases.yaml'), alias: 'strong' });
    });

    it('says a kept copy\'s deployed version changed without blaming the team', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();
      await fse.writeFile(claudeFile(), `${await fse.readFile(claudeFile(), 'utf-8')}\nMy own note.\n`);
      // Codex's change is what makes the ordinary pull redeploy the agent;
      // an edited copy alone is left to the full sync.
      await writeLocal('aliases:\n  strong:\n    claude: sonnet\n    codex: gpt-6-luna\n');

      await pull({ silent: true });

      expect(logged('warn', /Kept .*implementer\.md: you changed it, and the version teamai would deploy there \(agents\/implementer\.yaml\) has changed since/)).toBe(true);
      expect(logged('warn', /team version/)).toBe(false);
    });

    it('applies in a project checkout too', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await writeLocal('aliases:\n  strong:\n    claude: sonnet\n');
      const projectRoot = path.join(tmpDir, 'project');
      await fse.ensureDir(path.join(projectRoot, '.git'));
      await fse.ensureDir(path.join(projectRoot, '.claude'));
      vi.mocked(detectProjectConfig).mockResolvedValue({ ...localConfig, scope: 'project', projectRoot });

      await pull({ silent: true });

      const projectCopy = path.join(projectRoot, '.claude', 'agents', 'implementer.md');
      expect(matter(await fse.readFile(projectCopy, 'utf-8')).data).toMatchObject({ model: 'sonnet' });
    });
  });

  describe('tools switched to a model profile', () => {
    /** `teamai models switch` for `agents`, to a gateway serving Claude and Codex models. */
    async function switchTo(agents: ModelAgent[]): Promise<void> {
      const profile = ModelProfileSchema.parse({
        id: 'gateway',
        name: 'Gateway',
        base_url: 'https://gateway.example.test',
        api_key: '${API_KEY}',
        model_groups: [
          { protocols: ['anthropic'], models: ['claude-opus-4-8', 'claude-haiku-4-6'] },
          { protocols: ['openai-responses'], models: ['gpt-gateway'] },
        ],
      });
      const resolved = resolveProfile({ source: 'team', profile, team: 'another-team' }, {
        'team:gateway@https://gateway.example.test': { API_KEY: { value: 'secret' } },
      });
      const results = await switchModelProfile(resolved, agents);
      expect(results.map((result) => result.status)).toEqual(agents.map(() => 'switched'));
    }

    it('drops the alias model and effort from Codex, keeps Claude\'s opus without effort, and restore brings them back', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();

      await switchTo(['codex', 'claude']);
      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      const codex = await codexModel();
      expect(codex).toHaveProperty('name', 'implementer');
      expect(codex).not.toHaveProperty('model');
      expect(codex).not.toHaveProperty('model_reasoning_effort');
      const claude = await claudeModel();
      expect(claude).toMatchObject({ model: 'opus' });
      expect(claude).not.toHaveProperty('effort');
      expect((await homeRecord())?.agentModels?.['implementer']).toEqual({
        claude: { step: 'switched', model: 'opus', source: 'models/aliases.yaml', alias: 'strong' },
        codex: { step: 'switched', source: 'models/aliases.yaml', alias: 'strong' },
      });

      vi.clearAllMocks();
      expect((await restoreModelProfiles(['codex', 'claude'])).map((result) => result.status)).toEqual(['restored', 'restored']);
      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      expect(await codexModel()).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
      expect(await claudeModel()).toMatchObject({ model: 'opus', effort: 'high' });
    });

    it('drops a Claude model the switch does not route', async () => {
      await writeAliases({ aliases: { strong: { claude: [{ model: 'fable', effort: 'high' }] } } });
      await writeAgent(IMPLEMENTER);
      await switchTo(['claude']);

      await pull({ silent: true });

      const claude = await claudeModel();
      expect(claude).toHaveProperty('name', 'implementer');
      expect(claude).not.toHaveProperty('model');
      expect(claude).not.toHaveProperty('effort');
    });

    it('does not count a switch recorded for another CODEX_HOME', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      const otherCodexHome = path.join(tmpDir, 'other-codex');
      await fse.ensureDir(otherCodexHome);
      vi.stubEnv('CODEX_HOME', otherCodexHome);
      await switchTo(['codex']);
      vi.stubEnv('CODEX_HOME', '');

      await pull({ silent: true });

      expect(await codexModel()).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    });

    it('does not count a switch whose settings the member took over', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await switchTo(['codex']);
      await fse.writeFile(path.join(homeDir, '.codex', 'config.toml'), 'model = "gpt-mine"\n');

      await pull({ silent: true });

      expect(await codexModel()).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    });
  });

  it('says once per reason which agents it held, and does not count them as synced', async () => {
    await fse.outputFile(path.join(repoPath, 'models/aliases.yaml'), 'aliases: [broken');
    await writeAgent(IMPLEMENTER);
    await writeAgent({ ...IMPLEMENTER, name: 'planner' });
    await writeAgent({ ...IMPLEMENTER, name: 'bare', model: undefined });

    await pull({ silent: true });

    const held = vi.mocked(log.warn).mock.calls.map((args) => String(args[0])).filter((line) => line.includes('Held '));
    expect(held).toHaveLength(1);
    expect(held[0]).toContain('[agents] Held implementer.yaml, planner.yaml: Invalid model aliases YAML at models/aliases.yaml');
    expect(held[0]).toContain('Their deployed copies are kept and no new ones are written until the file is fixed.');
    // The parser's position, without its code frame.
    expect(held[0]).toMatch(/at line \d+, column \d+\. Their/);
    expect(held[0]).not.toContain('\n');
    expect(logged('success', /Synced 1 agents \(2 held\)/)).toBe(true);
    expect(await fse.pathExists(claudeFile('bare'))).toBe(true);
  });

  it('delivers an agent held while an aliases file was broken once the file is fixed, on an ordinary pull', async () => {
    const localFile = path.join(homeDir, '.teamai/models/aliases.yaml');
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await writeAgent({ ...IMPLEMENTER, name: 'plain', model: 'sonnet' });
    await fse.outputFile(localFile, 'aliases: [broken');
    await pullOnce();
    // The local file can make no name an alias, so a literal model does not wait for it.
    expect(await claudeModel('plain')).toMatchObject({ model: 'sonnet' });
    expect(await fse.pathExists(claudeFile())).toBe(false);

    await fse.outputFile(localFile, 'aliases:\n  strong:\n    codex: gpt-6-luna\n');
    await pull({ silent: true });

    // The pull that held them did not count the revision as synced.
    expect(alreadySynced()).toBe(false);
    expect(await claudeModel('plain')).toMatchObject({ model: 'sonnet' });
    expect(await codexModel('plain')).toMatchObject({ model: 'sonnet' });
    expect(await claudeModel()).toMatchObject({ model: 'opus', effort: 'high' });
    expect(await codexModel()).toMatchObject({ model: 'gpt-6-luna' });
    expect((await homeRecord())?.agentModels?.['plain']?.['claude']).toEqual({ step: 'literal', model: 'sonnet' });
  });

  it('stays quiet about a tool the alias does not map, which gets no model field', async () => {
    await writeAliases({ aliases: { strong: { claude: 'opus' } } });
    await writeAgent(IMPLEMENTER);

    await pull({ silent: true });

    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    expect(await codexModel()).not.toHaveProperty('model');
    expect((await homeRecord())?.agentModels?.['implementer']?.['codex']).toEqual({ step: 'default', source: 'models/aliases.yaml', alias: 'strong' });
  });

  it('warns when a model resolved by an alias at the last pull is now written literally', async () => {
    await writeAliases({ aliases: { reviewer: { claude: { model: 'opus', effort: 'max' } } } });
    await writeAgent({ ...IMPLEMENTER, model: 'reviewer' });
    await pullOnce();
    expect(await claudeModel()).toMatchObject({ model: 'opus' });
    await writeAliases({ aliases: {} });

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(await claudeModel()).toMatchObject({ model: 'reviewer' });
    expect(logged('warn', /agents\/implementer\.yaml sets model: reviewer, which is no longer a model alias.*claude received "opus" at the last pull/)).toBe(true);
  });

  describe('agents held on a full sync', () => {
    const localFile = (): string => path.join(homeDir, '.teamai/models/aliases.yaml');

    it('delivers a team change held by a broken local override once the member fixes it, on an ordinary pull', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();

      // The member breaks their override; a teammate then changes the agent.
      await fse.outputFile(localFile(), 'aliases: [broken');
      await writeAgent({ ...IMPLEMENTER, instructions: 'Make the change carefully.' });
      vi.mocked(getHeadRev).mockResolvedValue('def5678');
      await pull({ silent: true });
      expect(logged('warn', /Held implementer\.yaml/)).toBe(true);
      expect(matter(await fse.readFile(claudeFile(), 'utf-8')).content.trim()).toBe('Make the change.');

      await fse.remove(localFile());
      vi.clearAllMocks();
      await pull({ silent: true });

      expect(matter(await fse.readFile(claudeFile(), 'utf-8')).content.trim()).toBe('Make the change carefully.');
      expect(await claudeModel()).toMatchObject({ model: 'opus', effort: 'high' });

      // Delivered, so the pull after it is the fast path again.
      vi.clearAllMocks();
      await pull({ silent: true });
      expect(logged('success', /Already synced at def5678/)).toBe(true);
    });

    it('does not report a pull that held agents as complete', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      const first = { completed: false };
      await pull({ silent: true }, first);
      expect(first.completed).toBe(true);

      await fse.outputFile(localFile(), 'aliases: [broken');
      vi.mocked(getHeadRev).mockResolvedValue('def5678');
      const held = { completed: false };
      await pull({ silent: true }, held);

      expect(logged('success', /Already synced/)).toBe(false);
      expect(logged('warn', /Held implementer\.yaml/)).toBe(true);
      expect(held.completed).toBe(false);
    });

    it('does not hold an agent whose every targeted tool pins its model in the extras while the team file is broken', async () => {
      const pinned: AgentSpec = { ...IMPLEMENTER, targets: ['claude'], tool_extras: { claude: { model: 'opus' } } };
      await fse.outputFile(path.join(repoPath, 'models/aliases.yaml'), 'aliases: [broken');
      await writeAgent(pinned);

      await pull({ silent: true, dryRun: true });
      expect(logged('warn', /Would hold/)).toBe(false);
      expect(logged('info', /\[user\] \[dry-run\] Would pull 1 agents$/)).toBe(true);

      vi.clearAllMocks();
      const outcome = { completed: false };
      await pull({ silent: true }, outcome);

      expect(logged('warn', /Held /)).toBe(false);
      expect(await claudeModel()).toMatchObject({ model: 'opus' });
      expect(outcome.completed).toBe(true);
      expect((await loadStateForScope(localConfig)).lastPullRev).toBe('abc1234');

      vi.clearAllMocks();
      await pull({ silent: true });
      expect(alreadySynced()).toBe(true);
      expect(logged('warn', /Held /)).toBe(false);
    });

    it('names the tools it holds when a broken team file holds some of an agent\'s tools and others are pinned', async () => {
      const partlyPinned: AgentSpec = { ...IMPLEMENTER, targets: ['claude', 'codex'], tool_extras: { claude: { model: 'opus' } } };
      await fse.outputFile(path.join(repoPath, 'models/aliases.yaml'), 'aliases: [broken');
      await writeAgent(partlyPinned);

      await pull({ silent: true });

      expect(logged('warn', /Held implementer\.yaml for codex: Invalid model aliases YAML at models\/aliases\.yaml/)).toBe(true);
      expect(logged('warn', /no new ones are written/)).toBe(false);
      expect(await claudeModel()).toMatchObject({ model: 'opus' });
      expect(await fse.pathExists(codexFile())).toBe(false);
    });
  });

  describe('agents held on an unchanged team revision', () => {
    const localFile = (): string => path.join(homeDir, '.teamai/models/aliases.yaml');
    const teamFile = (): string => path.join(repoPath, 'models/aliases.yaml');
    const heldLines = (): string[] => vi.mocked(log.warn).mock.calls.map((args) => String(args[0])).filter((line) => line.includes('Held '));

    it.each([
      ['the member\'s local override', localFile, (): string => `Invalid model aliases YAML at ${localFile()}`],
      ['the team aliases file', teamFile, (): string => 'Invalid model aliases YAML at models/aliases.yaml'],
    ])('says it held agents while %s is broken, and syncs in full once it is fixed', async (_case, file, reason) => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await writeAgent({ ...IMPLEMENTER, name: 'planner' });
      await pullOnce();
      const before = await fse.readFile(claudeFile(), 'utf-8');

      await fse.outputFile(file(), 'aliases: [broken');
      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      expect(heldLines()).toHaveLength(1);
      expect(heldLines()[0]).toContain(`[agents] Held implementer.yaml, planner.yaml: ${reason()}`);
      expect(heldLines()[0]).toContain('Their deployed copies are kept');
      expect(await fse.readFile(claudeFile(), 'utf-8')).toBe(before);

      // Fixed: the checkout was not counted as synced, so this is a full sync.
      await fse.outputFile(localFile(), 'aliases:\n  strong:\n    codex: gpt-6-luna\n');
      if (file === teamFile) await writeAliases(STRONG);
      vi.clearAllMocks();
      await pull({ silent: true });

      expect(alreadySynced()).toBe(false);
      expect(heldLines()).toEqual([]);
      expect(await codexModel()).toMatchObject({ model: 'gpt-6-luna' });

      vi.clearAllMocks();
      await pull({ silent: true });
      expect(alreadySynced()).toBe(true);
    });

    it('does the same for a project checkout, leaving its record\'s push base', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      const projectRoot = path.join(tmpDir, 'project');
      await fse.ensureDir(path.join(projectRoot, '.git'));
      await fse.ensureDir(path.join(projectRoot, '.claude'));
      const projectConfig: LocalConfig = { ...localConfig, scope: 'project', projectRoot };
      vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
      await pullOnce();
      const projectCopy = path.join(projectRoot, '.claude', 'agents', 'implementer.md');
      expect(matter(await fse.readFile(projectCopy, 'utf-8')).data).toMatchObject({ model: 'opus' });

      await fse.outputFile(localFile(), 'aliases: [broken');
      await pull({ silent: true });

      expect(heldLines().some((line) => line.includes(`Held implementer.yaml: Invalid model aliases YAML at ${localFile()}`))).toBe(true);
      const record = Object.values((await loadStateForScope(projectConfig)).lastPullByWorkspace ?? {})[0];
      expect(record?.pushBaseRevs).toEqual(['abc1234']);

      await fse.outputFile(localFile(), 'aliases:\n  strong:\n    claude: sonnet\n');
      vi.clearAllMocks();
      await pull({ silent: true });

      expect(logged('success', /\[project\] Already synced/)).toBe(false);
      expect(matter(await fse.readFile(projectCopy, 'utf-8')).data).toMatchObject({ model: 'sonnet' });
    });

    it('does not report the pull as complete when another scope synced in full', async () => {
      // The inherited user scope reads a repo of its own, with no alias agent, so it syncs in full and completes.
      const userRepo = path.join(tmpDir, 'user-repo');
      await fse.outputFile(path.join(userRepo, 'agents', 'plain.yaml'), serializeAgentYaml({ ...IMPLEMENTER, name: 'plain', model: 'sonnet' }));
      vi.mocked(loadLocalConfigForScope).mockResolvedValue({
        ...localConfig,
        repo: { localPath: userRepo, remote: 'https://example.com/test/user-repo.git' },
      });
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      const projectRoot = path.join(tmpDir, 'project');
      await fse.ensureDir(path.join(projectRoot, '.git'));
      await fse.ensureDir(path.join(projectRoot, '.claude'));
      vi.mocked(detectProjectConfig).mockResolvedValue({ ...localConfig, scope: 'project', projectRoot, inheritUserScope: true });
      await pullOnce();

      await fse.outputFile(localFile(), 'aliases: [broken');
      vi.mocked(getHeadRev).mockImplementation(async (repo) => (repo === userRepo ? 'def5678' : 'abc1234'));
      const outcome = { completed: false };
      await pull({ silent: true }, outcome);

      expect(logged('success', /\[user\] Already synced/)).toBe(false);
      expect(logged('success', /\[project\] Already synced at abc1234/)).toBe(true);
      expect(heldLines().some((line) => line.includes('Held implementer.yaml'))).toBe(true);
      expect(outcome.completed).toBe(false);
    });
  });

  describe('pull --dry-run', () => {
    const localFile = (): string => path.join(homeDir, '.teamai/models/aliases.yaml');
    const teamFile = (): string => path.join(repoPath, 'models/aliases.yaml');
    const warned = (): string[] => vi.mocked(log.warn).mock.calls.map((args) => String(args[0]));
    /** Every file under HOME, by path: state, delivery records and tool copies alike. */
    const homeFiles = async (dir = homeDir): Promise<Record<string, string>> => {
      const files: Record<string, string> = {};
      for (const entry of await fse.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) Object.assign(files, await homeFiles(full));
        else files[full] = await fse.readFile(full, 'utf-8');
      }
      return files;
    };

    // The member's file holds alias agents only; a team file holds every agent with a model, as a real pull does.
    it.each([
      ['the member\'s local override', localFile, (): string => `implementer.yaml, planner.yaml: Invalid model aliases YAML at ${localFile()}`, '1 agents (2 held)'],
      ['the team aliases file', teamFile, (): string => 'implementer.yaml, plain.yaml, planner.yaml: Invalid model aliases YAML at models/aliases.yaml', '0 agents (3 held)'],
    ])('says which agents it would hold while %s is broken, and writes nothing', async (_case, file, held, count) => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await writeAgent({ ...IMPLEMENTER, name: 'planner' });
      await writeAgent({ ...IMPLEMENTER, name: 'plain', model: 'sonnet' });
      await pullOnce();

      await fse.outputFile(file(), 'aliases: [broken');
      // A team change the dry run must not deliver either.
      await writeAgent({ ...IMPLEMENTER, instructions: 'Make the change carefully.' });
      const before = await homeFiles();
      await pull({ silent: true, dryRun: true });

      const would = warned().filter((line) => line.includes('Would hold'));
      expect(would).toHaveLength(1);
      expect(would[0]).toContain(`[user] [dry-run] Would hold ${held()}`);
      expect(would[0]).toContain('Their deployed copies are kept');
      expect(warned().some((line) => line.includes('[agents] Held'))).toBe(false);
      expect(vi.mocked(log.info).mock.calls.map((args) => String(args[0]))).toContain(`[user] [dry-run] Would pull ${count}`);
      expect(await homeFiles()).toEqual(before);
    });

    it('says nothing about holds when every model resolves', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);

      await pull({ silent: true, dryRun: true });

      expect(warned().some((line) => line.includes('Would hold'))).toBe(false);
      expect(logged('info', /\[user\] \[dry-run\] Would pull 1 agents$/)).toBe(true);
    });
  });

  describe('what the fast path says it did', () => {
    const writeLocal = (text: string): Promise<void> => fse.outputFile(path.join(homeDir, '.teamai/models/aliases.yaml'), text);

    it('keeps a copy the member changed on the fast path, and names it with the step that takes the new model', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();
      const edited = `${await fse.readFile(claudeFile(), 'utf-8')}\nMy own note.\n`;
      await fse.writeFile(claudeFile(), edited);
      await writeLocal('aliases:\n  strong:\n    claude: sonnet\n');

      // Said on every pull while the copy stays edited, as nothing else would tell the member.
      for (let i = 0; i < 2; i += 1) {
        vi.clearAllMocks();
        await pull({ silent: true });
        expect(alreadySynced()).toBe(true);
        expect(logged('success', /Updated the model/)).toBe(false);
        expect(logged('warn', /Kept .*implementer\.md: you changed it, .*`teamai pull --force`/)).toBe(true);
      }
      expect(await fse.readFile(claudeFile(), 'utf-8')).toBe(edited);

      // The full sync still names it.
      vi.clearAllMocks();
      vi.mocked(getHeadRev).mockResolvedValue('def5678');
      await pull({ silent: true });
      expect(logged('warn', /Kept .*implementer\.md: you changed it/)).toBe(true);
    });

    it('says it delivered an agent that had no copy, not that it updated its model', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();
      // An agent never delivered here: no copy and no record, as an older CLI or a held pull leaves it.
      await fse.remove(claudeFile());
      await fse.remove(codexFile());
      const state = await loadStateForScope(localConfig);
      delete Object.values(state.lastPullByWorkspace ?? {})[0]!.agentModels;
      await saveStateForScope(state, localConfig);

      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      expect(await claudeModel()).toMatchObject({ model: 'opus' });
      expect(logged('success', /Updated the model/)).toBe(false);
      expect(logged('success', /Delivered 1 agent\(s\) missing from a tool: implementer/)).toBe(true);
    });

    it('delivers a recorded agent whose copy was deleted since the last pull', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();
      await fse.remove(codexFile());

      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      expect(await codexModel()).toMatchObject({ model: 'gpt-6-sol' });
      expect(logged('success', /Delivered 1 agent\(s\) missing from a tool: implementer/)).toBe(true);
    });
  });

  describe('copies an older CLI rendered with another tool\'s extras', () => {
    const COLORED: AgentSpec = { ...IMPLEMENTER, name: 'colored', model: 'sonnet', tool_extras: { claude: { color: 'red' } } };
    const qoderFile = (): string => path.join(homeDir, '.qoder', 'agents', 'colored.md');
    /** The Qoder copy an older CLI wrote: rendered with `tool_extras.claude`. */
    const olderQoderRender = (): string => renderForTool({ ...COLORED, tool_extras: { qoder: { color: 'red' } } }, 'qoder').content;

    beforeEach(async () => {
      teamConfig.toolPaths = { ...teamConfig.toolPaths, qoder: { agents: '.qoder/agents' } };
      await fse.ensureDir(path.join(homeDir, '.qoder'));
    });

    /** `bytes` at the Qoder copy, `recorded` as delivered (or no record at all), and no agent models. */
    async function olderQoderCopy(bytes: string, recorded: string | null): Promise<void> {
      await fse.writeFile(qoderFile(), bytes);
      const state = await loadStateForScope(localConfig);
      const record = Object.values(state.lastPullByWorkspace ?? {})[0]!;
      if (recorded === null) delete record.delivered;
      else record.delivered = { ...record.delivered, [qoderFile()]: crypto.createHash('sha256').update(recorded).digest('hex') };
      delete record.agentModels;
      await saveStateForScope(state, localConfig);
    }

    it('re-renders an untouched copy on an ordinary pull', async () => {
      await writeAgent(COLORED);
      await pullOnce();
      await olderQoderCopy(olderQoderRender(), olderQoderRender());

      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      expect(matter(await fse.readFile(qoderFile(), 'utf-8')).data).not.toHaveProperty('color');
      expect(logged('success', /colored/)).toBe(true);
      expect(logged('success', /Updated the model/)).toBe(false);
    });

    it('leaves a copy the member edited, and one with no delivered record', async () => {
      await writeAgent(COLORED);
      await pullOnce();
      const edited = `${olderQoderRender()}\nMy own note.\n`;
      await olderQoderCopy(edited, olderQoderRender());

      await pull({ silent: true });
      expect(await fse.readFile(qoderFile(), 'utf-8')).toBe(edited);

      await olderQoderCopy(olderQoderRender(), null);
      vi.clearAllMocks();
      await pull({ silent: true });
      expect(await fse.readFile(qoderFile(), 'utf-8')).toBe(olderQoderRender());
      expect(logged('success', /colored/)).toBe(false);
    });
  });

  describe('an alias removed while it gave a tool no model', () => {
    it('warns when the name would now be written literally', async () => {
      await writeAliases({ aliases: { reviewer: { codex: 'gpt-6-sol' } } });
      await writeAgent({ ...IMPLEMENTER, model: 'reviewer' });
      await pullOnce();
      expect(await claudeModel()).not.toHaveProperty('model');
      await writeAliases({ aliases: {} });

      await pull({ silent: true });

      expect(await claudeModel()).toMatchObject({ model: 'reviewer' });
      expect(logged('warn', /agents\/implementer\.yaml sets model: reviewer, which is no longer a model alias.*claude received no model field at the last pull/)).toBe(true);
    });

    it('does not warn when the team replaces the alias with a concrete model, or gives a model-less agent one', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await writeAgent({ ...IMPLEMENTER, name: 'bare', model: undefined });
      await pullOnce();
      await writeAgent({ ...IMPLEMENTER, model: 'sonnet' });
      await writeAgent({ ...IMPLEMENTER, name: 'bare', model: 'sonnet' });
      vi.mocked(getHeadRev).mockResolvedValue('def5678');

      await pull({ silent: true });

      expect(await claudeModel()).toMatchObject({ model: 'sonnet' });
      expect(await claudeModel('bare')).toMatchObject({ model: 'sonnet' });
      expect(logged('warn', /no longer a model alias/)).toBe(false);
    });

    it('still warns from a record written before it named the alias', async () => {
      await writeAliases({ aliases: { reviewer: { claude: 'opus' } } });
      await writeAgent({ ...IMPLEMENTER, model: 'reviewer' });
      await pullOnce();
      const state = await loadStateForScope(localConfig);
      const record = Object.values(state.lastPullByWorkspace ?? {})[0]!;
      record.agentModels = { implementer: { claude: { step: 'team', model: 'opus', source: 'models/aliases.yaml' } } };
      await saveStateForScope(state, localConfig);
      await writeAliases({ aliases: {} });

      await pull({ silent: true });

      expect(logged('warn', /sets model: reviewer, which is no longer a model alias.*claude received "opus" at the last pull/)).toBe(true);
    });
  });

  it('keeps separate records for the user scope and a project checkout', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();

    const projectRoot = path.join(tmpDir, 'project');
    await fse.ensureDir(path.join(projectRoot, '.git'));
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    const projectConfig: LocalConfig = { ...localConfig, scope: 'project', projectRoot };
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    await pull({ silent: true });
    const projectCopy = path.join(projectRoot, '.claude', 'agents', 'implementer.md');
    expect(matter(await fse.readFile(projectCopy, 'utf-8')).data).toMatchObject({ model: 'opus' });
    const projectRecord = Object.values((await loadStateForScope(projectConfig)).lastPullByWorkspace ?? {})[0];
    expect(projectRecord?.agentModels?.['implementer']?.['claude']).toEqual({ step: 'team', model: 'opus', effort: 'high', source: 'models/aliases.yaml', alias: 'strong' });

    // The project checkout's copy goes back to an older CLI's; the user
    // scope's record is untouched, and the project pull fixes only its own.
    const literal = renderForTool(IMPLEMENTER, 'claude').content;
    await fse.writeFile(projectCopy, literal);
    const projectState = await loadStateForScope(projectConfig);
    const record = Object.values(projectState.lastPullByWorkspace ?? {})[0]!;
    record.delivered = { ...record.delivered, [projectCopy]: crypto.createHash('sha256').update(literal).digest('hex') };
    delete record.agentModels;
    await saveStateForScope(projectState, projectConfig);
    const userCopyBefore = await fse.stat(claudeFile());
    vi.clearAllMocks();

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(matter(await fse.readFile(projectCopy, 'utf-8')).data).toMatchObject({ model: 'opus', effort: 'high' });
    expect((await fse.stat(claudeFile())).mtimeMs).toBe(userCopyBefore.mtimeMs);
    expect((await homeRecord())?.agentModels?.['implementer']?.['claude']).toEqual({ step: 'team', model: 'opus', effort: 'high', source: 'models/aliases.yaml', alias: 'strong' });
  });
});
