/**
 * `doctor` on model aliases (#830): per alias agent and tool, the model and
 * effort a tool receives and the step that decided it, as notes; and a failing
 * check while the aliases cannot be resolved, which pull says only on a full
 * sync. Asserted through `doctor --json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
  isSilent: () => false,
  setSilent: vi.fn(),
}));

import { loadLocalConfig, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { doctor, type CheckResult, type DoctorReport } from '../doctor.js';
import { AgentsHandler } from '../resources/agents.js';
import { openLedger } from '../resources/delivered-copies.js';
import { serializeAgentYaml, type AgentSpec } from '../resources/agent-format.js';
import { checkoutKey } from '../pull.js';
import { ModelProfileSchema, resolveProfile } from '../models/profile.js';
import { switchModelProfile } from '../models/switch.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const CHECK = 'Agent model aliases can be resolved';

describe('doctor — how agents resolved their model alias', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  const team = (rel: string, content: unknown): Promise<void> => (
    fse.outputFile(path.join(repoPath, rel), typeof content === 'string' ? content : YAML.stringify(content)));
  const localFile = (): string => path.join(homeDir, '.teamai/models/aliases.yaml');
  const writeLocal = (content: unknown): Promise<void> => fse.outputFile(localFile(), YAML.stringify(content));
  const agent = (spec: Partial<AgentSpec> & { name: string }): Promise<void> => team(`agents/${spec.name}.yaml`, serializeAgentYaml({
    description: `does ${spec.name} things`, instructions: 'Do the thing.', ...spec,
  }));

  async function report(): Promise<DoctorReport> {
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)); });
    try {
      await doctor({ json: true });
    } finally {
      spy.mockRestore();
    }
    const json = printed.find((line) => line.trimStart().startsWith('{'));
    if (!json) throw new Error('doctor printed no JSON report');
    return JSON.parse(json) as DoctorReport;
  }

  const check = (doctorReport: DoctorReport, name: string): CheckResult | undefined => doctorReport.checks.find((c) => c.name === name);
  const modelNotes = (doctorReport: DoctorReport): string[] => (doctorReport.notes ?? []).filter((note) => note.startsWith('models: how'));

  /** Pull every team agent the way a pull does, recording what each copy received. */
  async function pullAgents(): Promise<void> {
    const handler = new AgentsHandler();
    const ledger = openLedger(undefined);
    for (const item of await handler.scanTeamForPull(teamConfig, localConfig)) {
      await handler.pullItem(item, teamConfig, localConfig, ledger);
    }
    const state = await loadStateForScope(localConfig);
    state.lastPullByWorkspace = { [await checkoutKey(homeDir)]: {
      rev: 'abc1234', targets: ['claude', 'codex'], delivered: ledger.hashes, agentModels: ledger.agentModels,
    } };
    await saveStateForScope(state, localConfig);
  }

  async function switchCodex(): Promise<void> {
    const profile = ModelProfileSchema.parse({
      id: 'gateway',
      name: 'Gateway',
      base_url: 'https://gateway.example.test',
      api_key: '${API_KEY}',
      model_groups: [{ protocols: ['anthropic', 'openai-responses', 'openai-chat-completions'], models: ['claude-opus-4-8', 'gpt-gateway'] }],
    });
    const resolved = resolveProfile({ source: 'team', profile, team: 'another-team' }, {
      'team:gateway@https://gateway.example.test': { API_KEY: { value: 'secret' } },
    });
    const results = await switchModelProfile(resolved, ['codex']);
    expect(results.map((result) => result.status)).toEqual(['switched']);
  }

  beforeEach(async () => {
    tempDir = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-doctor-models-')));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);
    // The switch reads these to find each tool's live settings.
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME']) vi.stubEnv(key, '');
    for (const dir of ['.claude/agents', '.codex/agents', '.cursor/agents']) await fse.ensureDir(path.join(homeDir, dir));
    await team('teamai.yaml', 'team: test\n');

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: {
        claude: { agents: '.claude/agents' },
        codex: { agents: '.codex/agents' },
        cursor: { agents: '.cursor/agents' },
      },
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('lists, per alias agent, what each tool receives and which step decided it', async () => {
    await team('models/aliases.yaml', {
      aliases: {
        strong: { claude: [{ model: 'opus', effort: 'high' }], codex: 'gpt-6-sol' },
        fast: { claude: 'haiku', codex: { model: 'gpt-6-luna', effort: 'low' } },
      },
    });
    await writeLocal({ aliases: { fast: { codex: 'default' } } });
    await agent({ name: 'implementer', model: 'strong' });
    await agent({ name: 'planner', model: 'strong' });
    await agent({ name: 'pinned', model: 'strong', tool_extras: { codex: { model: 'gpt-pinned', model_reasoning_effort: 'medium' } } });
    await agent({ name: 'quick', model: 'fast' });
    await agent({ name: 'plain', model: 'sonnet' });
    await agent({ name: 'bare' });

    const doctorReport = await report();

    const cursorDefault = '    cursor: tool default  [default: models/aliases.yaml does not map cursor]';
    expect(modelNotes(doctorReport)).toEqual([
      [
        'models: how model: strong resolves for agents implementer, planner:',
        '    claude: opus, effort high  [team: models/aliases.yaml]',
        '    codex: gpt-6-sol, no effort, so the session\'s effort carries over  [team: models/aliases.yaml]',
        cursorDefault,
      ].join('\n'),
      [
        'models: how model: strong resolves for agent pinned:',
        '    claude: opus, effort high  [team: models/aliases.yaml]',
        '    codex: gpt-pinned, effort medium  [extras: tool_extras.codex sets the model]',
        cursorDefault,
      ].join('\n'),
      [
        'models: how model: fast resolves for agent quick:',
        '    claude: haiku  [team: models/aliases.yaml]',
        `    codex: tool default (chosen in ${localFile()})  [local]`,
        cursorDefault,
      ].join('\n'),
    ]);
    expect(check(doctorReport, CHECK)).toEqual({ name: CHECK, ok: true });
  });

  it('says the Cursor CLI does not read the user agents it checks for Cursor (#1218)', async () => {
    await agent({ name: 'plain' });

    const doctorReport = await report();

    expect(check(doctorReport,
      'Agents delivered to cursor (the Cursor IDE reads them; the Cursor CLI reads agents only from the workspace)',
    )).toBeDefined();
    expect(check(doctorReport, 'Agents delivered to cursor')).toBeUndefined();
    expect(doctorReport.notes?.some((note) => note.startsWith('Cursor:'))).toBe(false);
  });

  it('keeps the Cursor agents check unqualified in project scope (#1218)', async () => {
    localConfig.scope = 'project';
    localConfig.projectRoot = homeDir;
    await agent({ name: 'plain' });

    const doctorReport = await report();

    expect(doctorReport.checks.filter((c) => c.name.startsWith('Agents delivered to cursor')).map((c) => c.name))
      .toEqual(['Agents delivered to cursor']);
  });

  it('shows a switched Codex, the member\'s override, and what the last pull deployed until pull updates it', async () => {
    await team('models/aliases.yaml', { aliases: { strong: { claude: [{ model: 'opus', effort: 'high' }], codex: { model: 'gpt-6-sol', effort: 'high' } } } });
    await agent({ name: 'implementer', model: 'strong', targets: ['claude', 'codex'] });
    await switchCodex();
    await pullAgents();
    await writeLocal({ aliases: { strong: { claude: 'sonnet' } } });

    const doctorReport = await report();

    expect(modelNotes(doctorReport)).toEqual([[
      'models: how model: strong resolves for agent implementer:',
      `    claude: sonnet  [local: ${localFile()}]; the last pull deployed opus, effort high  [team: models/aliases.yaml], which \`teamai pull\` updates`,
      '    codex: tool default  [switched: codex runs a model profile and picks the model natively]',
    ].join('\n')]);
    // A changed override is not a delivery problem: the next pull redeploys it (spec story 52).
    expect(check(doctorReport, 'Agents delivered to claude')?.ok).toBe(true);
    expect(check(doctorReport, 'Agents delivered to codex')?.ok).toBe(true);
  });

  it('still names a changed model, and what fixes it, beside a real delivery problem', async () => {
    await team('models/aliases.yaml', { aliases: { strong: { claude: 'opus' } } });
    await agent({ name: 'implementer', model: 'strong', targets: ['claude'] });
    await agent({ name: 'planner', targets: ['claude'] });
    await pullAgents();
    await writeLocal({ aliases: { strong: { claude: 'sonnet' } } });
    await fse.remove(path.join(homeDir, '.claude/agents/planner.md'));

    const claude = check(await report(), 'Agents delivered to claude');

    expect(claude?.ok).toBe(false);
    expect(claude?.fix).toContain('model changed since the last pull: implementer');
    expect(claude?.fix).toContain('A plain `teamai pull` redeploys an agent whose model changed.');
    expect(claude?.fix).toContain('For the rest, run `teamai pull --force`');
  });

  it('fails the check, naming the tool and the cause, while a switched tool\'s settings cannot be read', async () => {
    await team('models/aliases.yaml', { aliases: { strong: { claude: 'opus', codex: 'gpt-6-sol' } } });
    await agent({ name: 'implementer', model: 'strong', targets: ['claude', 'codex'] });
    await switchCodex();
    await pullAgents();
    await fse.writeFile(path.join(homeDir, '.codex/config.toml'), 'model = [unterminated\n');

    const doctorReport = await report();

    expect(doctorReport.ok).toBe(false);
    const failing = check(doctorReport, CHECK);
    expect(failing?.ok).toBe(false);
    expect(failing?.fix).toContain('In codex, Cannot tell whether a tool is switched to a model profile: Cannot parse Codex config.toml');
    expect(failing?.fix).toContain('Pull keeps the copies there of implementer, and writes none, until it can tell.');
    expect(modelNotes(doctorReport)[0]).toContain(`    codex: held, its copy is kept  [see the failing check "${CHECK}"]`);
    expect(check(doctorReport, 'Every team agent reaches a tool')).toBeUndefined();
  });

  it('fails the check while an aliases file that is not active here is broken, and shows no view', async () => {
    await team('models/aliases.yaml', { aliases: { strong: { claude: 'opus' } } });
    await team('models/billing/aliases.yaml', 'aliases: [broken');
    await agent({ name: 'implementer', model: 'strong' });
    await agent({ name: 'bare' });

    const doctorReport = await report();

    const failing = check(doctorReport, CHECK);
    expect(failing?.ok).toBe(false);
    expect(failing?.fix).toContain('Invalid model aliases YAML at models/billing/aliases.yaml');
    expect(failing?.fix).toContain('pull keeps the deployed copies of every agent that sets a `model` and writes no new ones');
    expect(failing?.fix).toContain('Held here: implementer.');
    expect(modelNotes(doctorReport)).toEqual([]);
    // Held, not unreachable: the check above names the cause.
    expect(check(doctorReport, 'Every team agent reaches a tool')).toBeUndefined();
  });

  it('fails the check on a local file it cannot parse, even with no agent using an alias', async () => {
    await fse.outputFile(localFile(), 'aliases: [broken');
    await agent({ name: 'bare' });

    const failing = check(await report(), CHECK);
    expect(failing?.ok).toBe(false);
    expect(failing?.fix).toContain(`Invalid model aliases YAML at ${localFile()}`);
  });

  it('names only the alias agents a broken local file holds', async () => {
    await team('models/aliases.yaml', { aliases: { strong: { claude: 'opus' } } });
    await fse.outputFile(localFile(), 'aliases: [broken');
    await agent({ name: 'implementer', model: 'strong' });
    await agent({ name: 'plain', model: 'sonnet' });

    const failing = check(await report(), CHECK);
    expect(failing?.ok).toBe(false);
    expect(failing?.fix).toContain(`Invalid model aliases YAML at ${localFile()}`);
    expect(failing?.fix).toContain('pull keeps the deployed copies of every agent whose `model` is a model alias');
    expect(failing?.fix).toContain('Held here: implementer.');
  });

  it('prints each dropped aliases entry as a note', async () => {
    await team('models/aliases.yaml', { aliases: { strong: { claude: 'opus', 'claude-next': 'opus-6' } } });
    await agent({ name: 'implementer', model: 'strong' });

    expect((await report()).notes).toContain('models/aliases.yaml: alias "strong" maps "claude-next", which is not a tool teamai knows, '
      + 'so that entry is ignored. Fix the tool id, or update teamai if a newer version added that tool.');
  });

  it('lists nothing for a team whose agents use no alias', async () => {
    await agent({ name: 'plain', model: 'sonnet' });
    await agent({ name: 'bare' });

    const doctorReport = await report();
    expect(modelNotes(doctorReport)).toEqual([]);
    expect(check(doctorReport, CHECK)).toBeUndefined();
  });
});
