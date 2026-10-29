/**
 * Model aliases on pull (#830): an agent with `model: strong` receives, in
 * each tool, the model and effort the team maps for that tool in
 * `models/aliases.yaml`, and no model field where the team maps none.
 * Asserted through the agents handler, on the files it leaves in tool dirs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import matter from 'gray-matter';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: {
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
  })),
}));

import { AgentsHandler, reportHeldAgents, type AgentResourceItem } from '../resources/agents.js';
import type { AgentSpec, ToolName } from '../resources/agent-format.js';
import { serializeAgentYaml } from '../resources/agent-format.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { openLedger } from '../resources/delivered-copies.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { checkoutKey } from '../pull.js';
import { ModelProfileSchema, resolveProfile, type ModelAgent } from '../models/profile.js';
import { switchModelProfile } from '../models/switch.js';
import type { AgentModelRecords, LocalConfig, TeamaiConfig } from '../types.js';

const STRONG = {
  aliases: {
    strong: {
      claude: [{ model: 'opus', effort: 'high' }, { model: 'fable' }],
      codex: { model: 'gpt-6-sol', effort: 'high' },
    },
    fast: { claude: 'haiku', codex: 'gpt-6-luna' },
    reviewer: { claude: [{ model: 'opus', effort: 'max' }] },
  },
};

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'implementer',
    description: 'Implements a change',
    instructions: 'Make the change.',
    ...overrides,
  };
}

function teamConfigFor(tools: readonly ToolName[]): TeamaiConfig {
  return {
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
    // Copilot's user-scope base dir is ~/.copilot itself.
    toolPaths: Object.fromEntries(tools.map((tool) => [tool, { agents: tool === 'copilot' ? 'agents' : `.${tool}/agents` }])),
  } as TeamaiConfig;
}

describe('AgentsHandler pull: model aliases', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let handler: AgentsHandler;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-aliases-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'agents'));
    vi.stubEnv('HOME', homeDir);
    vi.mocked(log.warn).mockClear();
    resetWarnOnce();
    handler = new AgentsHandler();
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com' },
      username: 'testuser',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  async function writeAliases(content: unknown): Promise<void> {
    await fse.outputFile(path.join(repoPath, 'models/aliases.yaml'), typeof content === 'string' ? content : YAML.stringify(content));
  }

  /** Pull one YAML agent to `tools` and return what each tool's file holds. */
  async function pullTo(tools: readonly ToolName[], spec: AgentSpec): Promise<Record<string, Record<string, unknown>>> {
    const yamlPath = path.join(repoPath, 'agents', `${spec.name}.yaml`);
    await fse.writeFile(yamlPath, serializeAgentYaml(spec));
    for (const tool of tools) await fse.ensureDir(path.join(homeDir, `.${tool}`));
    const config = teamConfigFor(tools);
    await handler.pullItem({ name: spec.name, type: 'agents', sourcePath: yamlPath, relativePath: `agents/${spec.name}.yaml` }, config, localConfig);
    return Object.fromEntries(await Promise.all(tools.map(async (tool) => [tool, await readDeployed(tool, spec.name)] as const)));
  }

  async function readDeployed(tool: ToolName, name: string): Promise<Record<string, unknown>> {
    const dir = path.join(homeDir, `.${tool}/agents`);
    const toml = path.join(dir, `${name}.toml`);
    if (await fse.pathExists(toml)) return parseToml(await fse.readFile(toml, 'utf-8')) as Record<string, unknown>;
    const json = path.join(dir, `${name}.json`);
    if (await fse.pathExists(json)) return JSON.parse(await fse.readFile(json, 'utf-8')) as Record<string, unknown>;
    for (const ext of ['.agent.md', '.md']) {
      const md = path.join(dir, `${name}${ext}`);
      if (await fse.pathExists(md)) return matter(await fse.readFile(md, 'utf-8')).data as Record<string, unknown>;
    }
    return {};
  }

  /** Rewrite `tool`'s deployed copy of `name`: `edit` changes its fields in place. */
  async function editDeployed(tool: ToolName, name: string, edit: (fields: Record<string, unknown>) => void, body?: string): Promise<void> {
    const dir = path.join(homeDir, `.${tool}/agents`);
    const toml = path.join(dir, `${name}.toml`);
    if (await fse.pathExists(toml)) {
      const fields = { ...parseToml(await fse.readFile(toml, 'utf-8')) } as Record<string, unknown>;
      edit(fields);
      if (body !== undefined) fields['developer_instructions'] = body;
      await fse.writeFile(toml, stringifyToml(fields));
      return;
    }
    const md = path.join(dir, `${name}.md`);
    const parsed = matter(await fse.readFile(md, 'utf-8'));
    const fields = { ...parsed.data };
    edit(fields);
    await fse.writeFile(md, matter.stringify(body ?? parsed.content, fields));
  }

  const scan = (tools: readonly ToolName[]): Promise<AgentResourceItem[]> => handler.scanLocalForPush(teamConfigFor(tools), localConfig);

  it('writes the team model and effort in each tool\'s own field', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
    expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
    expect(files['codex']).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    expect(files['codex']).not.toHaveProperty('effort');
  });

  it('writes no Codex effort when the mapping has none', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'fast' }));
    expect(files['claude']).toMatchObject({ model: 'haiku' });
    expect(files['claude']).not.toHaveProperty('effort');
    expect(files['codex']).toMatchObject({ model: 'gpt-6-luna' });
    expect(files['codex']).not.toHaveProperty('model_reasoning_effort');
  });

  it('writes no model field for a tool the team does not map', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'reviewer' }));
    expect(files['claude']).toMatchObject({ model: 'opus', effort: 'max' });
    expect(files['codex']).toHaveProperty('name', 'implementer');
    expect(files['codex']).not.toHaveProperty('model');
  });

  it('writes no model field for strong when the team has no aliases file', async () => {
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
    for (const tool of ['claude', 'codex']) {
      expect(files[tool]).toHaveProperty('name', 'implementer');
      expect(files[tool]).not.toHaveProperty('model');
    }
  });

  it.each([['a concrete model', 'opus', {}], ['a name the team does not define', 'reviewer', undefined]] as const)(
    'writes %s literally', async (_label, model, aliases) => {
      if (aliases) await writeAliases(STRONG);
      const files = await pullTo(['claude', 'codex'], makeSpec({ model }));
      expect(files['claude']).toMatchObject({ model });
      expect(files['claude']).not.toHaveProperty('effort');
      expect(files['codex']).toMatchObject({ model });
    },
  );

  it.each([
    ['claude-internal', { model: 'opus', effort: 'high' }],
    ['tclaude', { model: 'opus', effort: 'high' }],
    ['codex-internal', { model: 'gpt-6-sol', model_reasoning_effort: 'high' }],
    ['tcodex', { model: 'gpt-6-sol', model_reasoning_effort: 'high' }],
  ] as const)('%s inherits its base tool\'s entry', async (tool, expected) => {
    await writeAliases(STRONG);
    const files = await pullTo([tool], makeSpec({ model: 'strong' }));
    expect(files[tool]).toMatchObject(expected);
  });

  it('an exact tool key wins over the inherited one', async () => {
    await writeAliases({ aliases: { strong: { claude: { model: 'opus', effort: 'high' }, tclaude: 'sonnet', tcodex: { model: 'gpt-6-astra', effort: 'xhigh' } } } });
    const files = await pullTo(['tclaude', 'claude', 'tcodex'], makeSpec({ model: 'strong' }));
    expect(files['tclaude']).toMatchObject({ model: 'sonnet' });
    expect(files['tclaude']).not.toHaveProperty('effort');
    expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
    expect(files['tcodex']).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'xhigh' });
  });

  it('writes OpenCode\'s effort as variant', async () => {
    await writeAliases({ aliases: { strong: { opencode: { model: 'anthropic/claude-opus-5-5', effort: 'max' } } } });
    const files = await pullTo(['opencode'], makeSpec({ model: 'strong' }));
    expect(files['opencode']).toMatchObject({ model: 'anthropic/claude-opus-5-5', variant: 'max' });
    expect(files['opencode']).not.toHaveProperty('effort');
  });

  it.each(['codebuddy', 'qoder', 'qoder-cn'] as const)('writes %s\'s effort as effort', async (tool) => {
    await writeAliases({ aliases: { strong: { [tool]: { model: 'performance', effort: 'xhigh' } } } });
    const files = await pullTo([tool], makeSpec({ model: 'strong' }));
    expect(files[tool]).toMatchObject({ model: 'performance', effort: 'xhigh' });
  });

  it('qoder-cn inherits the qoder entry, and its own key wins', async () => {
    await writeAliases({ aliases: {
      strong: { qoder: { model: 'performance', effort: 'high' } },
      fast: { qoder: 'lite', 'qoder-cn': { model: 'efficient', effort: 'low' } },
    } });
    expect((await pullTo(['qoder-cn'], makeSpec({ model: 'strong' })))['qoder-cn']).toMatchObject({ model: 'performance', effort: 'high' });
    expect((await pullTo(['qoder-cn'], makeSpec({ model: 'fast' })))['qoder-cn']).toMatchObject({ model: 'efficient', effort: 'low' });
  });

  it('qoder does not inherit the claude entry', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['qoder'], makeSpec({ model: 'strong' }));
    expect(files['qoder']).toHaveProperty('name', 'implementer');
    expect(files['qoder']).not.toHaveProperty('model');
  });

  it('writes Cursor\'s model as the team wrote it, bracket effort included', async () => {
    await writeAliases({ aliases: { strong: { cursor: 'claude-opus-5[effort=high]' } } });
    const files = await pullTo(['cursor'], makeSpec({ model: 'strong' }));
    expect(files['cursor']).toMatchObject({ model: 'claude-opus-5[effort=high]' });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('writes only the first Copilot entry, as one model string', async () => {
    await writeAliases({ aliases: { strong: { copilot: ['claude-opus-5', 'gpt-6-sol'] } } });
    const files = await pullTo(['copilot'], makeSpec({ model: 'strong' }));
    expect(files['copilot']).toMatchObject({ model: 'claude-opus-5' });
  });

  it.each(['cursor', 'copilot', 'kiro', 'workbuddy', 'joycode', 'zcode', 'omp'] as const)(
    'drops an effort mapped for %s with a warning and writes the model', async (tool) => {
      await writeAliases({ aliases: { strong: { [tool]: [{ model: 'claude-opus-5', effort: 'high' }, 'claude-sonnet-5'] } } });
      const files = await pullTo([tool], makeSpec({ model: 'strong' }));
      expect(files[tool]).toMatchObject({ model: 'claude-opus-5' });
      for (const field of ['effort', 'variant', 'model_reasoning_effort', 'reasoning-effort']) expect(files[tool]).not.toHaveProperty(field);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(
        `alias "strong" sets an effort for ${tool}, but effort is not supported for ${tool} agent files, so ${tool} receives the model without it.`,
      ));
    },
  );

  it('suggests Cursor\'s bracket form for a dropped Cursor effort', async () => {
    await writeAliases({ aliases: { strong: { cursor: { model: 'claude-opus-5', effort: 'high' } } } });
    await pullTo(['cursor'], makeSpec({ model: 'strong' }));
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('"claude-opus-5[effort=high]"'));
  });

  // agy picks the effort from the model id: `gemini-3.8-flash-high` (agy 1.4.10).
  it("suggests agy's effort suffix for a dropped agy effort", async () => {
    await writeAliases({ aliases: { strong: { agy: { model: 'gemini-3.8-flash', effort: 'high' } } } });
    await fse.ensureDir(path.join(homeDir, '.gemini', 'config'));
    await pullTo(['agy'], makeSpec({ model: 'strong' }));
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('"gemini-3.8-flash-high"'));
  });

  it('warns about a dropped effort once per alias and tool in a pull', async () => {
    await writeAliases({ aliases: { strong: { kiro: { model: 'claude-opus-5', effort: 'high' } } } });
    await pullTo(['kiro'], makeSpec({ model: 'strong' }));
    await pullTo(['kiro'], makeSpec({ name: 'reviewer', model: 'strong' }));
    expect(vi.mocked(log.warn).mock.calls.filter(([message]) => String(message).includes('sets an effort for kiro'))).toHaveLength(1);
  });

  it('an extras model skips the alias, effort included', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong', tool_extras: { claude: { model: 'sonnet' } } }));
    expect(files['claude']).toMatchObject({ model: 'sonnet' });
    expect(files['claude']).not.toHaveProperty('effort');
    expect(files['codex']).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
  });

  it('an extras effort without an extras model overrides the alias effort', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({
      model: 'strong',
      tool_extras: { claude: { effort: 'low' }, codex: { model_reasoning_effort: 'medium' } },
    }));
    expect(files['claude']).toMatchObject({ model: 'opus', effort: 'low' });
    expect(files['codex']).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'medium' });
  });

  it('skips a YAML agent whose model is not a string', async () => {
    const yamlPath = path.join(repoPath, 'agents/implementer.yaml');
    await fse.writeFile(yamlPath, 'name: implementer\ndescription: d\ninstructions: i\nmodel: [opus, sonnet]\n');
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await handler.pullItem({ name: 'implementer', type: 'agents', sourcePath: yamlPath, relativePath: 'agents/implementer.yaml' }, teamConfigFor(['claude']), localConfig);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/implementer.md'))).toBe(false);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('implementer.yaml field model must be a string'));
  });

  it('warns about an alias in a legacy .md agent and copies it as is', async () => {
    await writeAliases(STRONG);
    const mdPath = path.join(repoPath, 'agents/legacy.md');
    const content = '---\nname: legacy\ndescription: d\nmodel: reviewer\n---\nDo it.\n';
    await fse.writeFile(mdPath, content);
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await handler.pullItem(
      { name: 'legacy', type: 'agents', sourcePath: mdPath, relativePath: 'agents/legacy.md', legacy: true } as AgentResourceItem,
      teamConfigFor(['claude']),
      localConfig,
    );
    expect(await fse.readFile(path.join(homeDir, '.claude/agents/legacy.md'), 'utf-8')).toBe(content);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('agents/legacy.md sets model: reviewer, a model alias'));
  });

  it('holds agents with a model while the aliases file is invalid', async () => {
    await writeAliases(STRONG);
    await pullTo(['claude'], makeSpec({ model: 'strong' }));
    const deployed = path.join(homeDir, '.claude/agents/implementer.md');
    const before = await fse.readFile(deployed, 'utf-8');

    await writeAliases({ aliases: { Strong: { claude: 'opus' } } });
    const files = await pullTo(['claude'], makeSpec({ model: 'strong', instructions: 'Changed.' }));
    expect(await fse.readFile(deployed, 'utf-8')).toBe(before);
    expect(files['claude']).toMatchObject({ model: 'opus' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('Held implementer.yaml: Invalid model aliases file at models/aliases.yaml'));

    const never = await pullTo(['claude'], makeSpec({ name: 'never', model: 'opus' }));
    expect(never['claude']).toEqual({});
    const plain = await pullTo(['claude'], makeSpec({ name: 'plain' }));
    expect(plain['claude']).toHaveProperty('name', 'plain');
  });

  it('removes an inactive namespace agent written with the model its record names', async () => {
    await writeAliases(STRONG);
    const spec = makeSpec({ name: 'vr', model: 'strong' });
    const yamlPath = path.join(repoPath, 'agents', 'fe', 'vr.yaml');
    await fse.outputFile(yamlPath, serializeAgentYaml(spec));
    await fse.ensureDir(path.join(homeDir, '.claude'));
    const config = teamConfigFor(['claude']);
    await handler.pullItem({ name: 'vr', type: 'agents', sourcePath: yamlPath, relativePath: 'agents/fe/vr.yaml', namespace: 'fe' }, config, localConfig);
    const deployed = path.join(homeDir, '.claude/agents/vr.md');
    expect(matter(await fse.readFile(deployed, 'utf-8')).data).toMatchObject({ model: 'opus' });
    // What that pull recorded; the alias has changed since.
    const state = await loadStateForScope(localConfig);
    state.lastPullByWorkspace = { [await checkoutKey(homeDir)]: {
      rev: 'abc1234', targets: ['claude'], agentModels: { vr: { claude: { step: 'team', model: 'opus', effort: 'high' } } },
    } };
    await saveStateForScope(state, localConfig);
    await writeAliases({ aliases: { strong: { claude: 'fable' } } });

    await handler.cleanupInactiveNamespaces(config, localConfig, []);

    expect(await fse.pathExists(deployed)).toBe(false);
    expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).not.toMatch(/Kept agent/);
  });

  describe('local override', () => {
    const localFile = (): string => path.join(homeDir, '.teamai/models/aliases.yaml');
    async function writeLocal(content: unknown): Promise<void> {
      await fse.outputFile(localFile(), typeof content === 'string' ? content : YAML.stringify(content));
    }

    it('replaces the whole team entry for that tool, effort included', async () => {
      await writeAliases(STRONG);
      await writeLocal({ aliases: { strong: { codex: 'gpt-6-astra' } } });
      const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
      expect(files['codex']).toMatchObject({ model: 'gpt-6-astra' });
      expect(files['codex']).not.toHaveProperty('model_reasoning_effort');
      expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
    });

    it('writes the local effort in the tool\'s own field', async () => {
      await writeAliases(STRONG);
      await writeLocal({ aliases: { strong: { codex: { model: 'gpt-6-astra', effort: 'xhigh' } } } });
      const files = await pullTo(['codex'], makeSpec({ model: 'strong' }));
      expect(files['codex']).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'xhigh' });
    });

    it('sends a tool back to its default with ~ or default', async () => {
      await writeAliases(STRONG);
      await writeLocal('aliases:\n  strong:\n    claude: ~\n    codex: default\n');
      const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
      for (const tool of ['claude', 'codex']) {
        expect(files[tool]).toHaveProperty('name', 'implementer');
        expect(files[tool]).not.toHaveProperty('model');
      }
      expect(files['claude']).not.toHaveProperty('effort');
      expect(files['codex']).not.toHaveProperty('model_reasoning_effort');
    });

    it('maps strong without a team aliases file', async () => {
      await writeLocal({ aliases: { strong: { claude: { model: 'sonnet', effort: 'low' } } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'sonnet', effort: 'low' });
    });

    it('does not make a name an alias the team does not define', async () => {
      await writeLocal({ aliases: { reviewer: { claude: 'opus', kiro: { model: 'claude-opus-5', effort: 'high' } } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'reviewer' }));
      expect(files['claude']).toMatchObject({ model: 'reviewer' });
      expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    });

    it('a local claude entry wins over the team\'s tclaude entry, and a local tclaude entry over it', async () => {
      await writeAliases({ aliases: { strong: { claude: 'opus', tclaude: 'opus-internal' } } });
      await writeLocal({ aliases: { strong: { claude: 'sonnet' } } });
      expect((await pullTo(['tclaude'], makeSpec({ model: 'strong' })))['tclaude']).toMatchObject({ model: 'sonnet' });
      await writeLocal({ aliases: { strong: { claude: 'sonnet', tclaude: 'haiku' } } });
      expect((await pullTo(['tclaude'], makeSpec({ model: 'strong' })))['tclaude']).toMatchObject({ model: 'haiku' });
    });

    it('an extras model wins over the local entry', async () => {
      await writeLocal({ aliases: { strong: { claude: 'sonnet' } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'strong', tool_extras: { claude: { model: 'fable' } } }));
      expect(files['claude']).toMatchObject({ model: 'fable' });
    });

    it('holds agents with a model while the local file is invalid, naming it', async () => {
      await writeAliases(STRONG);
      await pullTo(['claude'], makeSpec({ model: 'strong' }));
      const deployed = path.join(homeDir, '.claude/agents/implementer.md');
      const before = await fse.readFile(deployed, 'utf-8');

      await writeLocal({ aliases: { strong: { claude: { effort: 'high' } } } });
      await pullTo(['claude'], makeSpec({ model: 'strong', instructions: 'Changed.' }));
      expect(await fse.readFile(deployed, 'utf-8')).toBe(before);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(`Held implementer.yaml: Invalid model aliases file at ${localFile()}`));
    });

    it('warns about a dropped local effort naming the local file', async () => {
      await writeLocal({ aliases: { strong: { kiro: { model: 'claude-opus-5', effort: 'high' } } } });
      await pullTo(['kiro'], makeSpec({ model: 'strong' }));
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(`${localFile()}: alias "strong" sets an effort for kiro`));
    });
  });

  describe('tools switched to a model profile', () => {
    beforeEach(async () => {
      // The switch finds each tool's live settings through these.
      for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG']) vi.stubEnv(key, '');
      vi.stubEnv('XDG_CONFIG_HOME', path.join(homeDir, '.config'));
    });

    /** `teamai models switch` for `agents`, to a gateway that serves every protocol. */
    async function switchTo(agents: ModelAgent[]): Promise<void> {
      for (const agent of agents) await fse.ensureDir(agent === 'opencode' ? path.join(homeDir, '.config/opencode') : path.join(homeDir, `.${agent}`));
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
      const results = await switchModelProfile(resolved, agents);
      expect(results.map((result) => result.status)).toEqual(agents.map(() => 'switched'));
    }

    const EVERY_TOOL_STRONG = {
      aliases: {
        strong: {
          claude: [{ model: 'opus', effort: 'high' }],
          codex: { model: 'gpt-6-sol', effort: 'high' },
          opencode: { model: 'anthropic/claude-opus-5-5', effort: 'high' },
          codebuddy: { model: 'gpt-6-sol', effort: 'high' },
          workbuddy: 'gpt-6-sol',
        },
      },
    };

    it('gives OpenCode, CodeBuddy and WorkBuddy no model and no effort', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['opencode', 'codebuddy', 'workbuddy']);
      const files = await pullTo(['opencode', 'codebuddy', 'workbuddy'], makeSpec({ model: 'strong' }));
      for (const tool of ['opencode', 'codebuddy', 'workbuddy']) {
        expect(files[tool]).toHaveProperty('description', 'Implements a change');
        for (const field of ['model', 'effort', 'variant']) expect(files[tool]).not.toHaveProperty(field);
      }
    });

    it('keeps Claude\'s sonnet and haiku from the local entry, and drops any other model', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['claude']);
      const localFile = path.join(homeDir, '.teamai/models/aliases.yaml');
      for (const model of ['sonnet', 'haiku']) {
        await fse.outputFile(localFile, YAML.stringify({ aliases: { strong: { claude: { model, effort: 'low' } } } }));
        const claude = (await pullTo(['claude'], makeSpec({ model: 'strong' })))['claude'];
        expect(claude).toMatchObject({ model });
        expect(claude).not.toHaveProperty('effort');
      }
      await fse.outputFile(localFile, YAML.stringify({ aliases: { strong: { claude: 'claude-opus-4-8' } } }));
      expect((await pullTo(['claude'], makeSpec({ model: 'strong' })))['claude']).not.toHaveProperty('model');
    });

    it('keeps the member\'s opt-out an opt-out', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await fse.outputFile(path.join(homeDir, '.teamai/models/aliases.yaml'), 'aliases:\n  strong:\n    claude: ~\n');
      await switchTo(['claude']);
      const claude = (await pullTo(['claude'], makeSpec({ model: 'strong' })))['claude'];
      expect(claude).toHaveProperty('name', 'implementer');
      expect(claude).not.toHaveProperty('model');
    });

    it('drops an extras effort too, unless the extras also pin a model', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['claude', 'codex']);
      const files = await pullTo(['claude', 'codex'], makeSpec({
        model: 'strong',
        tool_extras: { claude: { effort: 'max', color: 'red' }, codex: { model_reasoning_effort: 'xhigh' } },
      }));
      expect(files['claude']).toMatchObject({ model: 'opus', color: 'red' });
      expect(files['claude']).not.toHaveProperty('effort');
      expect(files['codex']).not.toHaveProperty('model_reasoning_effort');

      // The member's opt-out on a switched tool: still no effort.
      await fse.outputFile(path.join(homeDir, '.teamai/models/aliases.yaml'), 'aliases:\n  strong:\n    claude: ~\n');
      const optedOut = (await pullTo(['claude'], makeSpec({ model: 'strong', tool_extras: { claude: { effort: 'max' } } })))['claude'];
      expect(optedOut).not.toHaveProperty('model');
      expect(optedOut).not.toHaveProperty('effort');

      const pinned = (await pullTo(['codex'], makeSpec({
        model: 'strong', tool_extras: { codex: { model: 'gpt-pinned', model_reasoning_effort: 'xhigh' } },
      })))['codex'];
      expect(pinned).toMatchObject({ model: 'gpt-pinned', model_reasoning_effort: 'xhigh' });
    });

    it('never treats a variant as switched', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['claude', 'codex']);
      const files = await pullTo(['claude-internal', 'tclaude', 'codex-internal', 'tcodex'], makeSpec({ model: 'strong' }));
      for (const tool of ['claude-internal', 'tclaude']) expect(files[tool]).toMatchObject({ model: 'opus', effort: 'high' });
      for (const tool of ['codex-internal', 'tcodex']) expect(files[tool]).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    });

    it('leaves an extras model and a literal model as written', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['codex']);
      expect((await pullTo(['codex'], makeSpec({ model: 'strong', tool_extras: { codex: { model: 'gpt-pinned' } } })))['codex'])
        .toMatchObject({ model: 'gpt-pinned' });
      expect((await pullTo(['codex'], makeSpec({ model: 'gpt-literal' })))['codex']).toMatchObject({ model: 'gpt-literal' });
    });

    it('points push drift on a switched tool at models restore', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['codex']);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['codex'], spec);
      await editDeployed('codex', spec.name, (fields) => { fields['model'] = 'gpt-5'; });

      const [candidate] = await scan(['codex']);
      expect(candidate.mergedSpec).toBeUndefined();
      expect(candidate.skipReason).toContain('but model: strong gives codex no model, because codex is switched to a model profile.');
      expect(candidate.skipReason).toContain('Run `teamai models restore --agent codex` to take codex off the profile, or switch it to another one.');
    });

    it('holds alias agents in the tool whose switch state cannot be read, and only there', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['codex']);
      await fse.writeFile(path.join(homeDir, '.codex/config.toml'), 'model = [unterminated\n');
      const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
      expect(files['codex']).toEqual({});
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(
        'Held implementer.yaml for codex: Cannot tell whether a tool is switched to a model profile: Cannot parse Codex config.toml',
      ));
    });

    it('holds alias agents in every switchable tool, in one warning, while the switch records cannot be read', async () => {
      await writeAliases({ aliases: { strong: { ...EVERY_TOOL_STRONG.aliases.strong, cursor: 'claude-opus-5' } } });
      await fse.outputFile(path.join(homeDir, '.teamai/models/managed.json'), '{broken');
      const files = await pullTo(['claude', 'codex', 'cursor'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toEqual({});
      expect(files['codex']).toEqual({});
      expect(files['cursor']).toMatchObject({ model: 'claude-opus-5' });
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(
        'Held implementer.yaml for claude, codex: Cannot tell whether a tool is switched to a model profile: Cannot parse model ownership manifest',
      ));
    });
  });

  describe('team file opt-out values', () => {
    it('passes default through as a model value', async () => {
      await writeAliases({ aliases: { strong: { codebuddy: 'default' } } });
      const files = await pullTo(['codebuddy'], makeSpec({ model: 'strong' }));
      expect(files['codebuddy']).toMatchObject({ model: 'default' });
    });

    it('rejects ~, holding agents with a model', async () => {
      await writeAliases('aliases:\n  strong:\n    claude: ~\n');
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toEqual({});
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(
        'Held implementer.yaml: Invalid model aliases file at models/aliases.yaml: strong.claude: ~ is accepted only in a member\'s',
      ));
    });
  });

  describe('push', () => {
    it('does not report a pulled alias agent as edited', async () => {
      await writeAliases(STRONG);
      await pullTo(['claude', 'codex', 'tclaude'], makeSpec({ model: 'strong' }));
      expect(await handler.scanLocalForPush(teamConfigFor(['claude', 'codex', 'tclaude']), localConfig)).toEqual([]);
    });

    it('does not report a pulled alias agent with a variant or effort as edited', async () => {
      const tools = ['opencode', 'codebuddy', 'qoder-cn', 'kiro'] as const;
      await writeAliases({ aliases: { strong: {
        opencode: { model: 'anthropic/claude-opus-5-5', effort: 'max' },
        codebuddy: { model: 'glm-5', effort: 'high' },
        qoder: { model: 'performance', effort: 'high' },
        kiro: { model: 'claude-opus-5', effort: 'high' },
      } } });
      await pullTo(tools, makeSpec({ model: 'strong' }));
      expect(await handler.scanLocalForPush(teamConfigFor(tools), localConfig)).toEqual([]);
    });

    it('keeps model: strong when the instructions of an alias agent are edited', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude'], spec);
      const deployed = path.join(homeDir, '.claude/agents/implementer.md');
      const parsed = matter(await fse.readFile(deployed, 'utf-8'));
      await fse.writeFile(deployed, matter.stringify('Edited instructions.', parsed.data));

      const candidates = await handler.scanLocalForPush(teamConfigFor(['claude']), localConfig);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.' });
    });

    /** What the last pull recorded for this checkout's agent copies, and the bytes it wrote there. */
    async function recordModels(agentModels: AgentModelRecords, delivered?: Record<string, string>): Promise<void> {
      const state = await loadStateForScope(localConfig);
      state.lastPullByWorkspace = { [await checkoutKey(homeDir)]: {
        rev: 'abc1234', targets: ['claude', 'codex'], agentModels, ...(delivered ? { delivered } : {}),
      } };
      await saveStateForScope(state, localConfig);
    }

    const STRONG_RECORD: AgentModelRecords = { implementer: {
      claude: { step: 'team', model: 'opus', effort: 'high', source: 'models/aliases.yaml' },
      codex: { step: 'team', model: 'gpt-6-sol', effort: 'high', source: 'models/aliases.yaml' },
    } };

    const writeCanonical = (spec: AgentSpec): Promise<void> =>
      fse.writeFile(path.join(repoPath, 'agents', `${spec.name}.yaml`), serializeAgentYaml(spec));

    it.each([
      ['removed', {}],
      ['changed to a literal model', { model: 'sonnet' }],
    ] as const)('does not propose what the alias wrote after the canonical model was %s since the pull', async (_, now) => {
      await writeAliases(STRONG);
      await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
      await recordModels(STRONG_RECORD);
      const canonical = makeSpec(now);
      await writeCanonical(canonical);
      await editDeployed('claude', canonical.name, () => {}, 'Member edit.');

      const [candidate, ...rest] = await scan(['claude', 'codex']);
      expect(rest).toEqual([]);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.modelDrift).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...canonical, instructions: 'Member edit.' });
    });

    it('still proposes a model and effort the member changed after the canonical model stopped being an alias', async () => {
      await writeAliases(STRONG);
      await pullTo(['claude'], makeSpec({ model: 'strong' }));
      await recordModels(STRONG_RECORD);
      const canonical = makeSpec();
      await writeCanonical(canonical);
      await editDeployed('claude', canonical.name, (fields) => {
        fields['model'] = 'haiku';
        fields['effort'] = 'max';
      });

      const [candidate] = await scan(['claude']);
      expect(candidate.mergedSpec).toEqual({ ...canonical, model: 'haiku', tool_extras: { claude: { effort: 'max' } } });
    });

    it.each([
      ['tclaude', { claude: { model: 'sonnet' } }, 'color', 'blue'],
      ['tcodex', { codex: { model: 'gpt-6-luna' } }, 'sandbox_mode', 'read-only'],
    ] as const)('pushes an unrelated extras edit to %s while it inherits a model pin, and keeps the pin', async (tool, pin, key, value) => {
      const spec = makeSpec({ model: 'opus', tool_extras: pin });
      await pullTo([tool], spec);
      await editDeployed(tool, spec.name, (fields) => { fields[key] = value; });

      const [candidate] = await scan([tool]);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, tool_extras: { ...pin, [tool]: { [key]: value } } });
    });

    it.each([
      ['tclaude', { claude: { model: 'sonnet' } }],
      ['tcodex', { codex: { model: 'gpt-6-luna' } }],
    ] as const)('writes a model changed in %s over an inherited pin to its own extras, and refuses its removal', async (tool, pin) => {
      const spec = makeSpec({ model: 'opus', tool_extras: pin });
      await pullTo([tool], spec);
      await editDeployed(tool, spec.name, (fields) => { fields['model'] = 'haiku'; });
      const [changed] = await scan([tool]);
      expect(changed.skipReason).toBeUndefined();
      expect(changed.mergedSpec).toEqual({ ...spec, tool_extras: { ...pin, [tool]: { model: 'haiku' } } });

      await editDeployed(tool, spec.name, (fields) => { delete fields['model']; });
      const [removed] = await scan([tool]);
      expect(removed.mergedSpec).toBeUndefined();
      expect(removed.skipReason).toContain(`tool_extras.${tool}: {"inheritedFrom":"tool_extras.${tool.slice(1)}","removed":["model"]}`);
    });

    it('keeps a tcodex model pin equal to the inherited one while pushing an unrelated tcodex edit', async () => {
      const pins = { codex: { model: 'gpt-6-sol' }, tcodex: { model: 'gpt-6-sol' } };
      const spec = makeSpec({ model: 'opus', tool_extras: pins });
      await pullTo(['tcodex'], spec);
      await editDeployed('tcodex', spec.name, (fields) => { fields['sandbox_mode'] = 'read-only'; });

      const [candidate] = await scan(['tcodex']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, tool_extras: { ...pins, tcodex: { model: 'gpt-6-sol', sandbox_mode: 'read-only' } } });
    });

    it.each([
      ['qoder', 'performance', 'coder-model'],
      ['claude', 'sonnet', 'haiku'],
    ] as const)('writes a model changed in %s over its own extras pin back to that pin, and keeps the root model', async (tool, pin, edit) => {
      const spec = makeSpec({ model: 'opus', tool_extras: { [tool]: { model: pin } } });
      await pullTo([tool], spec);
      await editDeployed(tool, spec.name, (fields) => { fields['model'] = edit; });

      const [candidate] = await scan([tool]);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, tool_extras: { [tool]: { model: edit } } });
    });

    describe('a hand edit to tclaude under each kind of model pin', () => {
      // tclaude reads its own extras over claude's, so it covers the tool's own
      // pin, the inherited one, and both at once.
      const PINS = {
        none: undefined,
        own: { tclaude: { model: 'sonnet' } },
        inherited: { claude: { model: 'sonnet' } },
        'own and inherited': { claude: { model: 'sonnet' }, tclaude: { model: 'sonnet' } },
      } as const;
      const EDITS: Record<string, (fields: Record<string, unknown>) => void> = {
        model: (fields) => { fields['model'] = 'haiku'; },
        effort: (fields) => { fields['effort'] = 'max'; },
        'another field': (fields) => { fields['color'] = 'blue'; },
        'model removed': (fields) => { delete fields['model']; },
      };
      type Expected = Partial<AgentSpec> | { conflict: string };
      const CASES: Array<[keyof typeof PINS, string, Expected]> = [
        ['none', 'model', { model: 'haiku' }],
        ['none', 'effort', { tool_extras: { tclaude: { effort: 'max' } } }],
        ['none', 'another field', { tool_extras: { tclaude: { color: 'blue' } } }],
        ['none', 'model removed', { model: undefined }],
        ['own', 'model', { tool_extras: { tclaude: { model: 'haiku' } } }],
        ['own', 'effort', { tool_extras: { tclaude: { model: 'sonnet', effort: 'max' } } }],
        ['own', 'another field', { tool_extras: { tclaude: { model: 'sonnet', color: 'blue' } } }],
        ['own', 'model removed', { tool_extras: undefined }],
        ['inherited', 'model', { tool_extras: { claude: { model: 'sonnet' }, tclaude: { model: 'haiku' } } }],
        ['inherited', 'effort', { tool_extras: { claude: { model: 'sonnet' }, tclaude: { effort: 'max' } } }],
        ['inherited', 'another field', { tool_extras: { claude: { model: 'sonnet' }, tclaude: { color: 'blue' } } }],
        ['inherited', 'model removed', { conflict: '"removed":["model"]' }],
        ['own and inherited', 'model', { tool_extras: { claude: { model: 'sonnet' }, tclaude: { model: 'haiku' } } }],
        ['own and inherited', 'effort', { tool_extras: { claude: { model: 'sonnet' }, tclaude: { model: 'sonnet', effort: 'max' } } }],
        ['own and inherited', 'another field', { tool_extras: { claude: { model: 'sonnet' }, tclaude: { model: 'sonnet', color: 'blue' } } }],
        ['own and inherited', 'model removed', { conflict: '"removed":["model"]' }],
      ];

      it.each(CASES)('pin %s, edit %s: writes the edit where tclaude reads it, and nothing else', async (pin, edit, expected) => {
        const spec = makeSpec({ model: 'opus', ...(PINS[pin] ? { tool_extras: PINS[pin] } : {}) });
        await pullTo(['tclaude'], spec);
        await editDeployed('tclaude', spec.name, EDITS[edit]!);

        const [candidate] = await scan(['tclaude']);
        if ('conflict' in expected) {
          expect(candidate.mergedSpec).toBeUndefined();
          expect(candidate.skipReason).toContain(expected.conflict);
          return;
        }
        expect(candidate.skipReason).toBeUndefined();
        const merged: Record<string, unknown> = { ...spec, ...expected };
        for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
        expect(candidate.mergedSpec).toEqual(merged);
      });
    });

    it('does not propose a copy with the bytes teamai last delivered there, rendered by an older CLI', async () => {
      const spec = makeSpec({ model: 'opus', tool_extras: { claude: { color: 'red' } } });
      // A CLI before #830 gave Qoder the Claude extras.
      await pullTo(['qoder'], { ...spec, tool_extras: { ...spec.tool_extras, qoder: { color: 'red' } } });
      await writeCanonical(spec);
      const copy = path.join(homeDir, '.qoder/agents/implementer.md');
      const hash = crypto.createHash('sha256').update(await fse.readFile(copy)).digest('hex');
      await recordModels({}, { [copy]: hash });
      expect(await scan(['qoder'])).toEqual([]);

      await editDeployed('qoder', spec.name, () => {}, 'Member edit.');
      const [candidate] = await scan(['qoder']);
      expect(candidate.mergedSpec?.instructions).toBe('Member edit.');
    });

    it.each([
      ['claude', { claude: { model: 'opus', effort: 'high' } }, 'color', 'blue'],
      ['codex', { codex: { model: 'gpt-6-sol', effort: 'high' } }, 'sandbox_mode', 'read-only'],
      ['opencode', { opencode: { model: 'anthropic/claude-opus-5-5', effort: 'max' } }, 'temperature', 0.2],
      ['codebuddy', { codebuddy: { model: 'glm-5', effort: 'high' } }, 'color', 'blue'],
      ['qoder-cn', { qoder: { model: 'performance', effort: 'high' } }, 'color', 'blue'],
    ] as const)('proposes only the unrelated extras key added to %s, not the alias effort', async (tool, mapping, key, value) => {
      await writeAliases({ aliases: { strong: mapping } });
      const spec = makeSpec({ model: 'strong' });
      await pullTo([tool], spec);
      await editDeployed(tool, spec.name, (fields) => { fields[key] = value; });

      const [candidate, ...rest] = await scan([tool]);
      expect(rest).toEqual([]);
      expect(candidate.skipReason).toBeUndefined();
      const { tool_extras: extras, ...root } = candidate.mergedSpec!;
      expect(root).toEqual(spec);
      // OpenCode's reverse also carries the `mode: subagent` teamai renders (pre-existing).
      const { mode: _mode, ...own } = extras?.[tool] ?? {};
      expect(Object.keys(extras ?? {})).toEqual([tool]);
      expect(own).toEqual({ [key]: value });
    });

    it('does not read an effort the base tool\'s extras set as removed from tclaude', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong', tool_extras: { claude: { effort: 'low', color: 'blue' } } });
      await pullTo(['tclaude'], spec);
      await editDeployed('tclaude', spec.name, (fields) => { fields['memory'] = 'user'; });

      const [candidate] = await scan(['tclaude']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.mergedSpec?.tool_extras).toEqual({ claude: { effort: 'low', color: 'blue' }, tclaude: { memory: 'user' } });
    });

    it('does not report a copy written with the recorded resolution after the team changed the alias', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude', 'codex'], spec);
      await recordModels({ implementer: {
        claude: { step: 'team', model: 'opus', effort: 'high' },
        codex: { step: 'team', model: 'gpt-6-sol', effort: 'high' },
      } });
      await writeAliases({ aliases: { strong: { claude: 'fable', codex: { model: 'gpt-6-astra', effort: 'xhigh' } } } });
      expect(await scan(['claude', 'codex'])).toEqual([]);
      // What push's kept-copy warning compares with: the copy as recorded, not the new resolution.
      const item = { name: spec.name, type: 'agents' as const, sourcePath: path.join(repoPath, 'agents/implementer.yaml'), relativePath: 'agents/implementer.yaml' };
      const targets = await handler.recordedDeliveryTargets(teamConfigFor(['claude', 'codex']), localConfig, item);
      expect(targets.map((target) => target.tool)).toEqual(['claude', 'codex']);
      for (const target of targets) expect(target.content).toBe(await fse.readFile(target.dest, 'utf-8'));

      await editDeployed('codex', spec.name, () => {}, 'Edited instructions.');
      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.modelDrift).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.' });
    });

    it('never proposes a concrete model over an alias, and reports a copy unlike the current mapping as drift without a record', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude'], spec);
      await writeAliases({ aliases: { strong: { claude: 'fable' } } });

      const [candidate] = await scan(['claude']);
      expect(candidate.mergedSpec).toBeUndefined();
      expect(candidate.skipReason).toContain('its claude copy');
      expect(candidate.skipReason).toContain('sets model "opus" and effort "high", but model: strong gives claude model "fable" from');
    });

    it('pushes edits made in two tools while one of them changed the model by hand', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude', 'codex'], spec);
      await editDeployed('claude', spec.name, (fields) => { fields['model'] = 'sonnet'; }, 'Edited instructions.');
      await editDeployed('codex', spec.name, () => {}, 'Edited instructions.');

      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.' });
      expect(candidate.modelDrift).toEqual([expect.stringContaining('its claude copy')]);
    });

    it('reports a hand-set model and effort as drift, pointing at the member\'s override and the team file', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['codex'], spec);
      await editDeployed('codex', spec.name, (fields) => {
        fields['model'] = 'gpt-5';
        fields['model_reasoning_effort'] = 'low';
      });

      const [candidate] = await scan(['codex']);
      expect(candidate.mergedSpec).toBeUndefined();
      const localFile = path.join(homeDir, '.teamai/models/aliases.yaml');
      expect(candidate.skipReason).toBe(
        `its codex copy (${path.join(homeDir, '.codex/agents/implementer.toml')}) sets model "gpt-5" and model_reasoning_effort "low", `
        + 'but model: strong gives codex model "gpt-6-sol" and model_reasoning_effort "high" from the team\'s models/aliases.yaml. '
        + 'Push never writes a concrete model over a model alias, so this change stays on this machine. '
        + `To use it on this machine, map strong.codex in ${localFile}; for the whole team, change strong.codex in models/aliases.yaml.`,
      );
    });

    it('pushes instructions and unrelated extras while the effort drifted, without pinning it', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude'], spec);
      await editDeployed('claude', spec.name, (fields) => {
        fields['effort'] = 'max';
        fields['color'] = 'blue';
      }, 'Edited instructions.');

      const [candidate] = await scan(['claude']);
      expect(candidate.mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.', tool_extras: { claude: { color: 'blue' } } });
      expect(candidate.modelDrift).toEqual([expect.stringContaining('sets model "opus" and effort "max"')]);
    });

    it('points drift from the member\'s override at the override file', async () => {
      await writeAliases(STRONG);
      const localFile = path.join(homeDir, '.teamai/models/aliases.yaml');
      await fse.outputFile(localFile, YAML.stringify({ aliases: { strong: { codex: 'gpt-6-astra' } } }));
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['codex'], spec);
      await editDeployed('codex', spec.name, (fields) => { fields['model'] = 'gpt-5'; });

      const [candidate] = await scan(['codex']);
      expect(candidate.skipReason).toContain(`gives codex model "gpt-6-astra" from your ${localFile}.`);
      expect(candidate.skipReason).toContain(`To use it, change strong.codex in ${localFile}.`);
    });

    it.each([['strong', 'fast'], ['opus', 'strong']])('adopts model: %s -> %s written in a deployed file', async (from, to) => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: from });
      await pullTo(['claude', 'codex'], spec);
      await editDeployed('claude', spec.name, (fields) => { fields['model'] = to; });

      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.modelDrift).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, model: to });
    });

    it('does not read an extras model pin named like an alias as adopting that alias', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong', tool_extras: { claude: { model: 'fast' } } });
      await pullTo(['claude', 'codex'], spec);
      await editDeployed('claude', spec.name, () => {}, 'Edited instructions.');

      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.modelDrift).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.' });
    });

    it.each([
      ['current', {}],
      ['recorded', { strong: { codex: 'gpt-6-sol' } }],
    ])('does not read a %s resolution named like another alias as adopting it', async (_, later) => {
      const aliasNamedModel = { aliases: { ...STRONG.aliases, strong: { codex: 'gpt-5-codex' }, 'gpt-5-codex': { claude: 'sonnet' } } };
      await writeAliases(aliasNamedModel);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['codex'], spec);
      await recordModels({ implementer: { codex: { step: 'team', model: 'gpt-5-codex', source: 'models/aliases.yaml', alias: 'strong' } } });
      await writeAliases({ aliases: { ...aliasNamedModel.aliases, ...later } });
      await editDeployed('codex', spec.name, () => {}, 'Edited instructions.');

      const [candidate] = await scan(['codex']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.modelDrift).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.' });
    });

    it('reports an effort changed on a resolution named like another alias as drift, and does not adopt that alias', async () => {
      await writeAliases({ aliases: { ...STRONG.aliases, strong: { claude: { model: 'fast', effort: 'high' } } } });
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude', 'codex'], spec);
      await editDeployed('claude', spec.name, (fields) => { fields['effort'] = 'low'; });

      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.mergedSpec).toBeUndefined();
      expect(candidate.skipReason).toContain('sets model "fast" and effort "low", but model: strong gives claude model "fast" and effort "high"');
    });

    it('pushes a new native agent\'s literal model', async () => {
      await writeAliases(STRONG);
      await fse.outputFile(path.join(homeDir, '.claude/agents/fresh.md'),
        matter.stringify('Do it.', { name: 'fresh', description: 'New', model: 'opus', effort: 'high' }));

      const [candidate] = await scan(['claude']);
      expect(candidate.status).toBe('new');
      expect(candidate.mergedSpec).toMatchObject({ model: 'opus', tool_extras: { claude: { effort: 'high' } } });
    });

    it('skips an alias agent with a reason while the aliases file cannot be read', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude'], spec);
      await editDeployed('claude', spec.name, () => {}, 'Edited instructions.');
      await writeAliases('aliases: [broken');

      const [candidate] = await scan(['claude']);
      expect(candidate.mergedSpec).toBeUndefined();
      expect(candidate.skipReason).toContain('its model cannot be resolved: Invalid model aliases YAML at models/aliases.yaml');
    });
  });

  describe('invalid aliases files', () => {
    const warnings = (): string => vi.mocked(log.warn).mock.calls.flat().join('\n');
    const localFile = (): string => path.join(homeDir, '.teamai/models/aliases.yaml');

    const structural: Array<[string, unknown, string]> = [
      ['unparseable YAML', 'aliases: [broken', 'Invalid model aliases YAML at models/aliases.yaml'],
      ['an alias that is not a map', { aliases: { strong: 'opus' } }, 'Invalid model aliases file at models/aliases.yaml: aliases.strong'],
      ['an option of the wrong type', { aliases: { strong: { claude: 42 } } }, 'Invalid model aliases file at models/aliases.yaml: aliases.strong.claude'],
      ['an invalid alias name', { aliases: { Strong: { claude: 'opus' } } }, 'Invalid model aliases file at models/aliases.yaml: aliases.Strong'],
      ['an effort without a model', { aliases: { strong: { claude: { effort: 'high' } } } }, 'Invalid model aliases file at models/aliases.yaml: aliases.strong.claude'],
      ['~ in the team file', 'aliases:\n  strong:\n    claude: ~\n', 'Invalid model aliases file at models/aliases.yaml: strong.claude: ~ is accepted only in a member\'s'],
      ['a misspelled top-level key', { alias: { strong: { claude: 'opus' } } }, 'Invalid model aliases file at models/aliases.yaml: it has no top-level `aliases:` key (found `alias`)'],
    ];

    it.each(structural)('holds agents with a model on %s, deployed or not, and keeps their records', async (_case, broken, reason) => {
      await writeAliases(STRONG);
      await pullTo(['claude'], makeSpec({ model: 'strong' }));
      const deployed = path.join(homeDir, '.claude/agents/implementer.md');
      const before = await fse.readFile(deployed, 'utf-8');
      const records: AgentModelRecords = { implementer: { claude: { step: 'team', model: 'opus', effort: 'high' } } };
      const ledger = openLedger(undefined, records);
      await writeAliases(broken);

      const config = teamConfigFor(['claude']);
      for (const spec of [makeSpec({ model: 'strong', instructions: 'Changed.' }), makeSpec({ name: 'never', model: 'strong' }), makeSpec({ name: 'plain' })]) {
        const yamlPath = path.join(repoPath, 'agents', `${spec.name}.yaml`);
        await fse.writeFile(yamlPath, serializeAgentYaml(spec));
        await handler.pullItem({ name: spec.name, type: 'agents', sourcePath: yamlPath, relativePath: `agents/${spec.name}.yaml` }, config, localConfig, ledger);
      }

      expect(await fse.readFile(deployed, 'utf-8')).toBe(before);
      expect(await fse.pathExists(path.join(homeDir, '.claude/agents/never.md'))).toBe(false);
      expect(await fse.pathExists(path.join(homeDir, '.claude/agents/plain.md'))).toBe(true);
      expect(ledger.agentModels).toEqual({ ...records, plain: { claude: { step: 'default' } } });
      // Said once for every agent it holds, after the pass; neither reached a tool.
      expect(warnings()).toBe('');
      expect(reportHeldAgents(ledger)).toBe(2);
      expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
      expect(warnings()).toContain(`Held implementer.yaml, never.yaml: ${reason}`);
      expect(warnings()).toContain('Their deployed copies are kept');
    });

    it.each(structural)('skips alias agents on push with a reason on %s, and pushes the rest', async (_case, broken, reason) => {
      await writeAliases(STRONG);
      await pullTo(['claude'], makeSpec({ model: 'strong' }));
      await pullTo(['claude'], makeSpec({ name: 'plain' }));
      await editDeployed('claude', 'implementer', () => {}, 'Edited instructions.');
      await editDeployed('claude', 'plain', () => {}, 'Edited instructions.');
      await writeAliases(broken);

      const byName = Object.fromEntries((await scan(['claude'])).map((item) => [item.name, item]));
      expect(byName['implementer']?.mergedSpec).toBeUndefined();
      expect(byName['implementer']?.skipReason).toContain(`its model cannot be resolved: ${reason}`);
      expect(byName['plain']?.skipReason).toBeUndefined();
      expect(byName['plain']?.mergedSpec?.instructions).toBe('Edited instructions.');
    });

    it('holds a never-deployed agent while the local file cannot be parsed, naming it by path', async () => {
      await fse.outputFile(localFile(), 'aliases: [broken');
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toEqual({});
      expect(warnings()).toContain(`Held implementer.yaml: Invalid model aliases YAML at ${localFile()}`);
    });

    it('holds alias agents while the local file has no top-level aliases key, naming it', async () => {
      await writeAliases(STRONG);
      await fse.outputFile(localFile(), 'alias:\n  strong:\n    claude: sonnet\n');
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toEqual({});
      expect(warnings()).toContain(`Held implementer.yaml: Invalid model aliases file at ${localFile()}: it has no top-level \`aliases:\` key (found \`alias\`)`);
    });

    it.each([
      ['an empty file', '', undefined],
      ['a file with only comments', '# strong: { claude: opus }\n', undefined],
      ['an empty aliases key', 'aliases:\n', undefined],
      ['an unknown key beside aliases', 'version: 2\naliases:\n  strong:\n    claude: sonnet\n', 'sonnet'],
    ])('reads %s, team or local, as a valid aliases file', async (_case, text, model) => {
      await writeAliases(text);
      await fse.outputFile(localFile(), text);
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(warnings()).toBe('');
      expect(files['claude']).toHaveProperty('name', 'implementer');
      expect(files['claude']?.['model']).toBe(model);
    });

    it('holds only alias agents while the local file cannot be parsed: a concrete model is delivered and pushable', async () => {
      await writeAliases(STRONG);
      await pullTo(['claude'], makeSpec({ model: 'strong' }));
      await pullTo(['claude'], makeSpec({ name: 'literal', model: 'opus' }));
      await editDeployed('claude', 'implementer', () => {}, 'Edited instructions.');
      await editDeployed('claude', 'literal', () => {}, 'Edited instructions.');
      await fse.outputFile(localFile(), 'aliases: [broken');

      const byName = Object.fromEntries((await scan(['claude'])).map((item) => [item.name, item]));
      expect(byName['implementer']?.mergedSpec).toBeUndefined();
      expect(byName['implementer']?.skipReason).toContain(`its model cannot be resolved: Invalid model aliases YAML at ${localFile()}`);
      expect(byName['literal']?.skipReason).toBeUndefined();
      expect(byName['literal']?.mergedSpec).toMatchObject({ model: 'opus', instructions: 'Edited instructions.' });

      vi.mocked(log.warn).mockClear();
      const fresh = await pullTo(['claude', 'codex'], makeSpec({ name: 'fresh', model: 'opus' }));
      expect(fresh['claude']).toMatchObject({ model: 'opus' });
      expect(fresh['codex']).toMatchObject({ model: 'opus' });
      const held = await pullTo(['claude'], makeSpec({ name: 'held', model: 'strong' }));
      expect(held['claude']).toEqual({});
      expect(warnings()).not.toContain('fresh.yaml');
      expect(warnings()).toContain(`Held held.yaml: Invalid model aliases YAML at ${localFile()}`);
    });

    it('keeps the root agent a held namespace agent replaces, and the held copy, without a warning', async () => {
      await writeAliases(STRONG);
      const config = teamConfigFor(['claude']);
      await fse.ensureDir(path.join(homeDir, '.claude'));
      const root = path.join(repoPath, 'agents/vr.yaml');
      const namespaced = path.join(repoPath, 'agents/fe/vr.yaml');
      await fse.outputFile(root, serializeAgentYaml(makeSpec({ name: 'vr' })));
      await fse.outputFile(namespaced, serializeAgentYaml(makeSpec({ name: 'vr', model: 'strong' })));
      const deployed = path.join(homeDir, '.claude/agents/vr.md');

      // The root copy is deployed and `fe` becomes active while the file is broken.
      await handler.pullItem({ name: 'vr', type: 'agents', sourcePath: root, relativePath: 'agents/vr.yaml' }, config, localConfig);
      const rootCopy = await fse.readFile(deployed, 'utf-8');
      await writeAliases('aliases: [broken');
      await handler.cleanupInactiveNamespaces(config, localConfig, ['fe']);
      expect(await fse.readFile(deployed, 'utf-8')).toBe(rootCopy);

      // The namespace copy is deployed, then the file breaks.
      await writeAliases(STRONG);
      await handler.pullItem({ name: 'vr', type: 'agents', sourcePath: namespaced, relativePath: 'agents/fe/vr.yaml', namespace: 'fe' }, config, localConfig);
      const heldCopy = await fse.readFile(deployed, 'utf-8');
      await writeAliases('aliases: [broken');
      await handler.cleanupInactiveNamespaces(config, localConfig, ['fe']);
      expect(await fse.readFile(deployed, 'utf-8')).toBe(heldCopy);
      expect(warnings()).not.toMatch(/Kept agent/);
    });

    it('drops an unknown tool key, applies the rest, and warns only when an agent uses the alias', async () => {
      await writeAliases({ aliases: { strong: { claude: 'opus', 'claude-next': 'opus-6' }, fast: { claude: 'haiku' } } });
      const fast = await pullTo(['claude'], makeSpec({ name: 'quick', model: 'fast' }));
      expect(fast['claude']).toMatchObject({ model: 'haiku' });
      expect(warnings()).not.toContain('claude-next');

      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'opus' });
      expect(warnings()).toContain('models/aliases.yaml: alias "strong" maps "claude-next", which is not a tool teamai knows, so that entry is ignored.');
    });

    it('drops an unknown option field, keeps the entry, and warns only for the tools that read it', async () => {
      await writeAliases({ aliases: { strong: {
        claude: [{ model: 'opus', effort: 'high', context: '1m' }],
        codex: { model: 'gpt-6-sol', effort: 'high' },
      } } });
      const codex = await pullTo(['codex'], makeSpec({ model: 'strong' }));
      expect(codex['codex']).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
      expect(warnings()).not.toContain('"context"');

      // tclaude reads the claude entry.
      const files = await pullTo(['tclaude'], makeSpec({ model: 'strong' }));
      expect(files['tclaude']).toMatchObject({ model: 'opus', effort: 'high' });
      expect(files['tclaude']).not.toHaveProperty('context');
      expect(warnings()).toContain('models/aliases.yaml: alias "strong" sets "context" for claude, which teamai does not know');
    });

    it('does not warn about a team entry the member\'s local entry replaces', async () => {
      await writeAliases({ aliases: { strong: { claude: { model: 'opus', context: '1m' }, kiro: { model: 'claude-opus-5', effort: 'high' } } } });
      await fse.outputFile(localFile(), YAML.stringify({ aliases: { strong: { claude: 'sonnet' } } }));
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'sonnet' });
      expect(warnings()).toBe('');
    });

    it('drops an alias named like a native model alias, and warns only when an agent uses that name', async () => {
      await writeAliases({ aliases: { opus: { claude: 'sonnet' }, strong: { claude: 'opus' } } });
      const strong = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(strong['claude']).toMatchObject({ model: 'opus' });
      expect(warnings()).toBe('');

      const files = await pullTo(['claude'], makeSpec({ name: 'literal', model: 'opus' }));
      expect(files['claude']).toMatchObject({ model: 'opus' });
      expect(warnings()).toContain('models/aliases.yaml: alias "opus" has the name of a tool\'s own model alias, so it is ignored');
    });

    it('ignores a gateways key inside an alias without a warning', async () => {
      await writeAliases({ aliases: { strong: { claude: 'opus', gateways: { corp: { claude: 42 } } } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'opus' });
      expect(warnings()).toBe('');
    });

    it('does not warn about a dropped effort for a tool the agent does not reach', async () => {
      await writeAliases({ aliases: { strong: { claude: 'opus', kiro: { model: 'claude-opus-5', effort: 'high' } } } });
      await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(warnings()).toBe('');
    });
  });

  describe('namespaced alias files', () => {
    const warnings = (): string => vi.mocked(log.warn).mock.calls.flat().join('\n');
    const writeNamespaced = (namespace: string, content: unknown): Promise<void> => fse.outputFile(
      path.join(repoPath, `models/${namespace}/aliases.yaml`),
      typeof content === 'string' ? content : YAML.stringify(content),
    );

    beforeEach(async () => {
      await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'), [
        'version: 1',
        'projects:',
        '  - id: checkout',
        '    resources: { models: [checkout] }',
        '  - id: billing',
        '    resources: { models: [billing] }',
        '',
      ].join('\n'));
      localConfig = { ...localConfig, projects: ['checkout'] };
      await writeAliases(STRONG);
    });

    it('replaces the root alias of the same name whole, and warns naming the namespace file', async () => {
      await writeNamespaced('checkout', { aliases: { strong: { claude: 'fable', kiro: { model: 'claude-opus-5', effort: 'high' } } } });
      const ledger = openLedger(undefined, {});
      const spec = makeSpec({ model: 'strong' });
      const yamlPath = path.join(repoPath, 'agents', `${spec.name}.yaml`);
      await fse.writeFile(yamlPath, serializeAgentYaml(spec));
      for (const tool of ['claude', 'codex', 'kiro']) await fse.ensureDir(path.join(homeDir, `.${tool}`));
      await handler.pullItem({ name: spec.name, type: 'agents', sourcePath: yamlPath, relativePath: `agents/${spec.name}.yaml` },
        teamConfigFor(['claude', 'codex', 'kiro']), localConfig, ledger);

      expect(await readDeployed('claude', spec.name)).toMatchObject({ model: 'fable' });
      expect(await readDeployed('claude', spec.name)).not.toHaveProperty('effort');
      expect(await readDeployed('codex', spec.name)).not.toHaveProperty('model');
      expect(await readDeployed('kiro', spec.name)).toMatchObject({ model: 'claude-opus-5' });
      expect(ledger.agentModels['implementer']?.['claude']).toEqual({ step: 'team', model: 'fable', source: 'models/checkout/aliases.yaml', alias: 'strong' });
      expect(ledger.agentModels['implementer']?.['codex']).toEqual({ step: 'default', source: 'models/checkout/aliases.yaml', alias: 'strong' });
      expect(warnings()).toContain('models/checkout/aliases.yaml: alias "strong" sets an effort for kiro');
    });

    it('does not warn about the root alias a namespace alias replaces', async () => {
      await writeAliases({ aliases: { strong: { claude: 'opus', 'claude-next': 'opus-6' } } });
      await writeNamespaced('checkout', { aliases: { strong: { claude: 'fable' } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'fable' });
      expect(warnings()).toBe('');
    });

    it('reads the root alias while the namespace that redefines it is not active', async () => {
      await writeNamespaced('billing', { aliases: { strong: { claude: 'fable' } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
    });

    it('writes no model field for an alias only an inactive namespace defines, and warns once per alias naming the file', async () => {
      await writeNamespaced('billing', { aliases: { auditor: { claude: 'fable' } } });
      const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'auditor' }));
      await pullTo(['claude', 'codex'], makeSpec({ name: 'second', model: 'auditor' }));
      expect(files['claude']).toHaveProperty('name', 'implementer');
      expect(files['claude']).not.toHaveProperty('model');
      expect(files['codex']).not.toHaveProperty('model');
      const lines = vi.mocked(log.warn).mock.calls.map((args) => String(args[0]));
      expect(lines).toEqual([
        '[agents] Model alias "auditor" is defined only in models/billing/aliases.yaml, whose namespace "billing" your roles and projects '
          + 'do not list in resources.models, so agents with model: auditor get no model field here and each tool uses its default model. '
          + 'If the alias should apply to you, add `models: [billing]` to the resources of your role in manifest/roles.yaml or of your '
          + 'project in manifest/projects.yaml. If "auditor" is meant as a concrete model, rename the alias.',
      ]);
    });

    it('warns when an inactive namespace\'s alias takes a concrete model id from agents of another namespace', async () => {
      await writeNamespaced('billing', { aliases: { 'gpt-5-codex': { codex: 'gpt-5-codex-billing' } } });
      await writeNamespaced('ops', { aliases: { 'gpt-5-codex': { codex: 'gpt-5-codex-ops' } } });
      await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'), [
        'version: 1',
        'projects:',
        '  - id: checkout',
        '    resources: { models: [checkout] }',
        '  - id: billing',
        '    resources: { models: [billing] }',
        '  - id: ops',
        '    resources: { models: [ops] }',
        '',
      ].join('\n'));
      const files = await pullTo(['codex'], makeSpec({ model: 'gpt-5-codex' }));
      expect(files['codex']).not.toHaveProperty('model');
      expect(warnings()).toContain('Model alias "gpt-5-codex" is defined only in models/billing/aliases.yaml and models/ops/aliases.yaml, '
        + 'whose namespaces "billing" and "ops" your roles and projects do not list in resources.models, so agents with model: gpt-5-codex '
        + 'get no model field here and each tool uses its default model. If the alias should apply to you, add `models: [billing]` '
        + 'or `models: [ops]`');
      expect(warnings()).toContain('If "gpt-5-codex" is meant as a concrete model, rename the alias.');
    });

    it('says nothing about an inactive-only alias where the agent is not delivered, the local entry maps it, or an extras model skips it', async () => {
      await writeNamespaced('billing', { aliases: { auditor: { claude: 'fable' } } });
      await pullTo(['claude'], makeSpec({ name: 'elsewhere', model: 'auditor', targets: ['codex'] }));
      await pullTo(['claude'], makeSpec({ name: 'pinned', model: 'auditor', tool_extras: { claude: { model: 'sonnet' } } }));
      await fse.outputFile(path.join(homeDir, '.teamai/models/aliases.yaml'), YAML.stringify({ aliases: { auditor: { claude: 'sonnet' } } }));
      await pullTo(['claude'], makeSpec({ model: 'auditor' }));
      expect(warnings()).toBe('');
    });

    it('holds agents with a model while two active namespaces define the same alias, naming both files', async () => {
      await pullTo(['claude'], makeSpec({ model: 'strong' }));
      const deployed = path.join(homeDir, '.claude/agents/implementer.md');
      const before = await fse.readFile(deployed, 'utf-8');
      await writeNamespaced('checkout', { aliases: { strong: { claude: 'fable' } } });
      await writeNamespaced('billing', { aliases: { strong: { claude: 'haiku' } } });
      localConfig = { ...localConfig, projects: ['checkout', 'billing'] };

      await pullTo(['claude'], makeSpec({ model: 'strong', instructions: 'Changed.' }));
      expect(await fse.readFile(deployed, 'utf-8')).toBe(before);
      expect(warnings()).toContain('Held implementer.yaml: Model alias "strong" is defined in both models/checkout/aliases.yaml '
        + 'and models/billing/aliases.yaml, and both namespaces are active here');
      const never = await pullTo(['claude'], makeSpec({ name: 'never', model: 'opus' }));
      expect(never['claude']).toEqual({});
    });

    it('holds agents with a model while a namespace file that is not active is broken, naming it', async () => {
      await writeNamespaced('billing', 'aliases: [broken');
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toEqual({});
      expect(warnings()).toContain('Held implementer.yaml: Invalid model aliases YAML at models/billing/aliases.yaml');
    });

    it('keeps the member\'s local entry for an alias only a namespace defines', async () => {
      await writeNamespaced('billing', { aliases: { auditor: { claude: 'fable' } } });
      await fse.outputFile(path.join(homeDir, '.teamai/models/aliases.yaml'), YAML.stringify({ aliases: { auditor: { claude: 'sonnet' } } }));
      const files = await pullTo(['claude'], makeSpec({ model: 'auditor' }));
      expect(files['claude']).toMatchObject({ model: 'sonnet' });
    });

    it('points push drift at the namespace file the alias comes from', async () => {
      await writeNamespaced('checkout', { aliases: { strong: { codex: 'gpt-6-luna' } } });
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude', 'codex'], spec);
      await editDeployed('codex', spec.name, (fields) => { fields['model'] = 'gpt-5'; });
      await editDeployed('claude', spec.name, (fields) => { fields['model'] = 'sonnet'; });

      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.skipReason).toContain('gives codex model "gpt-6-luna" from the team\'s models/checkout/aliases.yaml.');
      expect(candidate.skipReason).toContain('for the whole team, change strong.codex in models/checkout/aliases.yaml.');
      expect(candidate.skipReason).toContain('as no aliases file maps strong.claude.');
      expect(candidate.skipReason).toContain('for the whole team, map strong.claude in models/checkout/aliases.yaml.');
    });
  });
});
