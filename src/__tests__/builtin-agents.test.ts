import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { deployBuiltinAgents, BUILTIN_AGENT_NAMES, builtinAgentsReplacedByTeam } from '../builtin-agents.js';
import { contentHash, openLedger } from '../resources/delivered-copies.js';
import { recordDelivery } from './helpers/delivered-checkout.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';

function buildTeamConfig(toolPaths: TeamaiConfig['toolPaths']): TeamaiConfig {
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
    toolPaths,
  } as TeamaiConfig;
}

/** Pull deploys the recall agent only while recall is on. */
function recallOn(toolPaths: TeamaiConfig['toolPaths']): TeamaiConfig {
  const config = buildTeamConfig(toolPaths);

  return { ...config, sharing: { ...config.sharing, recall: { enabled: true } } };
}

describe('deployBuiltinAgents', () => {
  let tmpDir: string;
  let homeDir: string;
  let builtinAgentsDir: string;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-builtin-agents-test-'));
    homeDir = path.join(tmpDir, 'home');
    // Per import.meta.url resolution in builtin-agents.ts, the built-in dir is
    // resolved as `<dist>/../agents`. The compiled module lives in dist/, but
    // when running the source under vitest the URL points to src/, so we
    // populate <repo>/agents/ alongside src/ to match the resolution.
    // We use the actual repo path so both code paths succeed.
    builtinAgentsDir = path.join(process.cwd(), 'agents');

    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'agents'));
    // Cursor has no agents dir — should be silently skipped

    vi.stubEnv('HOME', homeDir);

    localConfig = {
      repo: { localPath: path.join(tmpDir, 'team-repo'), remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('BUILTIN_AGENT_NAMES contains teamai-recall', () => {
    expect(BUILTIN_AGENT_NAMES.has('teamai-recall')).toBe(true);
  });

  it('deploys built-in agent files to every installed tool with agents path', async () => {
    // Sanity: built-in dir must contain teamai-recall.md (added in Task 3)
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) {
      // Skip the test gracefully when the package has not been built / agents
      // dir not present in the test workspace.
      console.warn(`Skipping: built-in agents dir not found at ${builtinAgentsDir}`);
      return;
    }

    const teamConfig = buildTeamConfig({
      claude: { agents: '.claude/agents' },
      codebuddy: { agents: '.codebuddy/agents' },
      cursor: { skills: '.cursor/skills' }, // No agents — skipped
    });

    const deployed = await deployBuiltinAgents(teamConfig, localConfig);

    // Two installed tools × at least one built-in agent file
    expect(deployed).toBeGreaterThanOrEqual(2);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/agents/teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/agents/teamai-recall.md'))).toBe(false);
  });

  it('deploys only teamai\'s agents from the package directory, never its README files', async () => {
    const toolsMissingAgents = new Set<string>();
    await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig, { toolsMissingAgents });

    expect([
      fs.existsSync(path.join(builtinAgentsDir, 'README.md')),
      (await fse.readdir(path.join(homeDir, '.claude', 'agents'))).sort(),
      [...toolsMissingAgents],
      vi.mocked(log.warn).mock.calls.map(([message]) => String(message)),
    ]).toEqual([true, ['teamai-recall.md'], [], []]);
  });

  it('overwrites stale local copies with the CLI-built-in version', async () => {
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) return; // Same skip guard

    const localPath = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await fse.writeFile(localPath, '# stale outdated copy');

    const teamConfig = buildTeamConfig({
      claude: { agents: '.claude/agents' },
    });

    await deployBuiltinAgents(teamConfig, localConfig);

    const written = await fse.readFile(localPath, 'utf8');
    expect(written).not.toBe('# stale outdated copy');
    expect(written).toContain('teamai-recall');
  });

  it('leaves the team copy alone when the team repo ships an agent of the built-in name', async () => {
    const teamAgent = '---\nname: teamai-recall\ndescription: Team recall\n---\n\nSearch our wiki first.\n';
    await fse.outputFile(path.join(localConfig.repo.localPath, 'agents', 'teamai-recall.md'), teamAgent);
    const localPath = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await fse.writeFile(localPath, '# the team copy pull delivered');

    const deployed = await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig);

    expect(deployed).toBe(0);
    expect(await fse.readFile(localPath, 'utf8')).toBe('# the team copy pull delivered');
  });

  it('deploys the built-in where the team agent replaces it but its copy is missing, which the next full sync replaces', async () => {
    // A pull that keeps its revision (recall turned back on by an environment variable, an inherited scope)
    // does not deliver the team copy again: the member still gets a recall agent.
    await fse.outputFile(path.join(localConfig.repo.localPath, 'agents', 'teamai-recall.md'), '---\nname: teamai-recall\ndescription: Team recall\n---\n');
    const copy = path.join(homeDir, '.claude/agents/teamai-recall.md');

    await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig, { record: { kind: 'fast-path', delivered: {} } });

    expect(await fse.readFile(copy, 'utf8')).toContain('knowledge retrieval agent');
  });

  it('leaves the team copy alone when an agents/<namespace> of the team repo ships the built-in name', async () => {
    await fse.outputFile(
      path.join(localConfig.repo.localPath, 'agents', 'fe', 'teamai-recall.yaml'),
      'name: teamai-recall\ndescription: Frontend recall\ninstructions: Search the design system first.\n',
    );
    const localPath = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await fse.writeFile(localPath, '# the fe copy pull delivered');

    await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig);

    expect(await fse.readFile(localPath, 'utf8')).toBe('# the fe copy pull delivered');
  });

  it('deploys the built-in where the team teamai-recall does not reach: another tool, or a file that does not parse', async () => {
    await fse.outputFile(
      path.join(localConfig.repo.localPath, 'agents', 'teamai-recall.yaml'),
      'name: teamai-recall\ndescription: Codex-only recall\ninstructions: Search the wiki.\ntargets: [codex]\n',
    );
    await fse.outputFile(path.join(localConfig.repo.localPath, 'agents', 'fe', 'teamai-recall.yaml'), 'name: [unclosed\n');

    await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig);

    expect(await fse.readFile(path.join(homeDir, '.claude/agents/teamai-recall.md'), 'utf8')).toContain('knowledge retrieval agent');
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringMatching(/^\[agents\] agents\/fe\/teamai-recall\.yaml cannot be delivered \([\s\S]+\), so teamai's teamai-recall stays in effect$/),
    ]);
  });

  it('deploys the built-in where the team teamai-recall is not delivered: its model cannot be resolved on a new install', async () => {
    await fse.outputFile(
      path.join(localConfig.repo.localPath, 'agents', 'teamai-recall.yaml'),
      'name: teamai-recall\ndescription: Our recall\ninstructions: Search the wiki.\nmodel: strong\n',
    );
    // An aliases file that does not parse holds every agent with a `model`.
    await fse.outputFile(path.join(localConfig.repo.localPath, 'models/aliases.yaml'), 'aliases: 5\n');

    await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig);

    expect(await fse.readFile(path.join(homeDir, '.claude/agents/teamai-recall.md'), 'utf8')).toContain('knowledge retrieval agent');
  });

  it('counts a team teamai-recall held for its model only where its copy still is', async () => {
    await fse.outputFile(
      path.join(localConfig.repo.localPath, 'agents', 'teamai-recall.yaml'),
      'name: teamai-recall\ndescription: Our recall\ninstructions: Search the wiki.\nmodel: strong\n',
    );
    // An aliases file that does not parse holds the agent; the record says what an earlier pull rendered it with.
    await fse.outputFile(path.join(localConfig.repo.localPath, 'models/aliases.yaml'), 'aliases: 5\n');
    const copy = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await recordDelivery(localConfig, {
      rev: 'abc123', targets: ['claude'], agentModels: { 'teamai-recall': { claude: { step: 'strong', model: 'opus', alias: 'strong' } } },
    });
    const config = recallOn({ claude: { agents: '.claude/agents' } });

    await fse.writeFile(copy, '# the held team copy');
    await deployBuiltinAgents(config, localConfig);
    expect(await fse.readFile(copy, 'utf8')).toBe('# the held team copy');

    await fse.remove(copy);
    await deployBuiltinAgents(config, localConfig);
    expect(await fse.readFile(copy, 'utf8')).toContain('knowledge retrieval agent');
  });

  it('leaves the team copy in a directory two tools share when the team agent targets only one of them', async () => {
    await fse.outputFile(
      path.join(localConfig.repo.localPath, 'agents', 'teamai-recall.yaml'),
      'name: teamai-recall\ndescription: Our recall\ninstructions: Search the wiki.\ntargets: [claude]\n',
    );
    const shared = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await fse.writeFile(shared, '# the team copy pull delivered');

    await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' }, codebuddy: { agents: '.claude/agents' } }), localConfig);

    expect(await fse.readFile(shared, 'utf8')).toBe('# the team copy pull delivered');
  });

  it('deploys the built-in to a new member while the team agents collide, and keeps an installed team copy', async () => {
    const reviewer = (ns: string) => `name: reviewer\ndescription: ${ns} reviewer\ninstructions: Review.\n`;
    await fse.outputFile(path.join(localConfig.repo.localPath, 'agents', 'fe', 'reviewer.yaml'), reviewer('fe'));
    await fse.outputFile(path.join(localConfig.repo.localPath, 'agents', 'be', 'reviewer.yaml'), reviewer('be'));
    await fse.outputFile(
      path.join(localConfig.repo.localPath, 'agents', 'teamai-recall.yaml'),
      'name: teamai-recall\ndescription: Our recall\ninstructions: Search the wiki.\n',
    );
    const copy = path.join(homeDir, '.claude/agents/teamai-recall.md');
    const config = recallOn({ claude: { agents: '.claude/agents' } });

    await deployBuiltinAgents(config, localConfig);
    expect(await fse.readFile(copy, 'utf8')).toContain('knowledge retrieval agent');

    await fse.writeFile(copy, '# the team copy an earlier pull delivered');
    await deployBuiltinAgents(config, localConfig);
    expect(await fse.readFile(copy, 'utf8')).toBe('# the team copy an earlier pull delivered');
  });

  it('counts a team teamai-recall as replacing the built-in while recall is off', async () => {
    await fse.outputFile(path.join(localConfig.repo.localPath, 'agents', 'teamai-recall.md'), '---\nname: teamai-recall\ndescription: Team recall\n---\n');

    const replaced = await builtinAgentsReplacedByTeam(buildTeamConfig({ claude: { agents: '.claude/agents' } }), localConfig);

    expect([...replaced.get('teamai-recall') ?? []]).toEqual([path.join(homeDir, '.claude/agents/teamai-recall.md')]);
  });

  it('keeps a team teamai-recall the member edited once the team no longer replaces the built-in', async () => {
    const localPath = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await fse.writeFile(localPath, '# the team copy, edited by the member');
    const ledger = openLedger({ [localPath]: contentHash('# the team copy as pull delivered it') });

    const deployed = await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig, { record: { kind: 'full-sync', ledger } });

    expect(deployed).toBe(0);
    expect(await fse.readFile(localPath, 'utf8')).toBe('# the team copy, edited by the member');
    expect(ledger.hashes[localPath]).toBe(contentHash('# the team copy as pull delivered it'));
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toEqual([
      `Kept ${localPath}: it holds your edit of the team's teamai-recall agent, which no longer reaches this directory. Delete it to get teamai's teamai-recall back.`,
    ]);
  });

  it('replaces an unedited team teamai-recall with the built-in and takes it off the record', async () => {
    const localPath = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await fse.writeFile(localPath, '# the team copy as pull delivered it');
    const ledger = openLedger({ [localPath]: contentHash('# the team copy as pull delivered it') });

    await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig, { record: { kind: 'full-sync', ledger } });

    expect(await fse.readFile(localPath, 'utf8')).toContain('knowledge retrieval agent');
    expect(ledger.hashes[localPath]).toBeUndefined();
  });

  it('leaves a recorded team teamai-recall to the next full sync on the fast path', async () => {
    const localPath = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await fse.writeFile(localPath, '# the team copy as pull delivered it');

    await deployBuiltinAgents(recallOn({ claude: { agents: '.claude/agents' } }), localConfig, {
      record: { kind: 'fast-path', delivered: { [localPath]: contentHash('# the team copy as pull delivered it') } },
    });

    expect(await fse.readFile(localPath, 'utf8')).toBe('# the team copy as pull delivered it');
  });

  it('renders the recall agent in OpenCode native format', async () => {
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) return; // Same skip guard

    await fse.ensureDir(path.join(homeDir, '.config', 'opencode', 'agents'));
    const teamConfig = buildTeamConfig({
      opencode: {
        agents: '.opencode/agents',
        userScope: { agents: '.config/opencode/agents' },
      },
    });

    await deployBuiltinAgents(teamConfig, localConfig);

    const written = await fse.readFile(
      path.join(homeDir, '.config', 'opencode', 'agents', 'teamai-recall.md'),
      'utf8',
    );
    expect(written).toContain('mode: subagent');
    expect(written).not.toMatch(/^name:/m);
    expect(written).not.toMatch(/^tools:/m);
  });

  it('the deployed recall agent marks every recall it runs and asks for no referenced-doc-ids', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));
    const teamConfig = buildTeamConfig({ claude: { agents: '.claude/agents' }, codex: { agents: '.codex/agents' } });

    await deployBuiltinAgents(teamConfig, localConfig);

    for (const file of [path.join(homeDir, '.claude', 'agents', 'teamai-recall.md'), path.join(homeDir, '.codex', 'agents', 'teamai-recall.toml')]) {
      const written = await fse.readFile(file, 'utf8');
      // An invocation passes a query ("…" or <…>); prose that names the command does not.
      const invocations = [...written.matchAll(/teamai recall[^`\n]*/g)].map((m) => m[0]).filter((c) => /["<]/.test(c));
      expect(invocations.length).toBeGreaterThanOrEqual(4);
      for (const command of invocations) expect(command, file).toContain('--caller teamai-recall');
      expect(written).not.toContain('referenced-doc-ids');
    }
  });

  it('skips targets without a native agent renderer and warns how to proceed', async () => {
    await fse.ensureDir(path.join(homeDir, '.unknown-tool', 'agents'));
    const teamConfig = buildTeamConfig({
      'unknown-tool': { agents: '.unknown-tool/agents' },
    });

    const deployed = await deployBuiltinAgents(teamConfig, localConfig);

    expect(deployed).toBe(0);
    expect(await fse.pathExists(
      path.join(homeDir, '.unknown-tool', 'agents', 'teamai-recall.md'),
    )).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(
      'unsupported agent format; disable this target or add a native renderer',
    ));
  });

  it('returns 0 and does not throw when no tools are installed', async () => {
    // Wipe all installed tool roots
    await fse.remove(path.join(homeDir, '.claude'));
    await fse.remove(path.join(homeDir, '.codebuddy'));

    const teamConfig = buildTeamConfig({
      claude: { agents: '.claude/agents' },
      codebuddy: { agents: '.codebuddy/agents' },
    });

    const deployed = await deployBuiltinAgents(teamConfig, localConfig);
    expect(deployed).toBe(0);
  });

  it('silently skips when the built-in agents directory does not exist', async () => {
    // Point HOME at a fresh dir; even if the package agents/ dir exists in
    // workspace, no tool roots are present, so deployment count is 0.
    const teamConfig = buildTeamConfig({});
    const deployed = await deployBuiltinAgents(teamConfig, localConfig);
    expect(deployed).toBe(0);
  });

  it('removes a stale same-stem sibling when re-rendering to a different extension', async () => {
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) return;

    // Upgrade residue: an old .md copy left beside the new .toml render for
    // Codex (the exact scenario reported in the PR review).
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));
    const staleMd = path.join(homeDir, '.codex', 'agents', 'teamai-recall.md');
    await fse.writeFile(staleMd, '# stale invalid-for-codex copy');

    const teamConfig = buildTeamConfig({ codex: { agents: '.codex/agents' } });

    const deployed = await deployBuiltinAgents(teamConfig, localConfig);
    expect(deployed).toBeGreaterThanOrEqual(1);

    const tomlPath = path.join(homeDir, '.codex', 'agents', 'teamai-recall.toml');
    expect(await fse.pathExists(tomlPath)).toBe(true);
    expect(await fse.pathExists(staleMd)).toBe(false);
  });

  it('removes a stale .toml sibling when re-rendering back to .md (claude)', async () => {
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) return;

    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    const staleToml = path.join(homeDir, '.claude', 'agents', 'teamai-recall.toml');
    await fse.writeFile(staleToml, '[not valid frontmatter]');

    const teamConfig = buildTeamConfig({ claude: { agents: '.claude/agents' } });

    await deployBuiltinAgents(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude', 'agents', 'teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(staleToml)).toBe(false);
  });

  it('does not copy builtin agents into an installed tool outside the whitelist', async () => {
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) return;

    const teamConfig = buildTeamConfig({
      claude: { agents: '.claude/agents' },
      codebuddy: { agents: '.codebuddy/agents' },
    });
    const deployed = await deployBuiltinAgents(teamConfig, {
      ...localConfig,
      enabledAgents: ['claude'],
    });

    expect(deployed).toBeGreaterThanOrEqual(1);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/agents/teamai-recall.md'))).toBe(false);
  });

  it('still deploys to every installed tool when enabledAgents is unset', async () => {
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) return;

    const teamConfig = buildTeamConfig({
      claude: { agents: '.claude/agents' },
      codebuddy: { agents: '.codebuddy/agents' },
    });
    const deployed = await deployBuiltinAgents(teamConfig, localConfig);

    expect(deployed).toBeGreaterThanOrEqual(2);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/agents/teamai-recall.md'))).toBe(true);
  });
});
