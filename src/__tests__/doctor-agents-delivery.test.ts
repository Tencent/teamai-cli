import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

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
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { AgentsHandler } from '../resources/agents.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The agents half of the delivery check (#624). Unlike skills, the desired set
 * is a relation: `targets:` decides which tools owe a copy, and each tool's
 * render decides the extension — so the expected path cannot be derived from
 * the agent's name.
 */
describe('doctor — agents delivered on disk', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  const CLAUDE_AGENTS = '.claude/agents';
  const CODEX_AGENTS = '.codex/agents';

  async function writeTeamAgent(name: string, spec: string): Promise<void> {
    const file = path.join(repoPath, 'agents', `${name}.yaml`);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, spec);
  }

  function specFor(name: string, targets?: string[]): string {
    const targetLine = targets ? `targets: [${targets.join(', ')}]\n` : '';
    return `name: ${name}\ndescription: does ${name} things\n${targetLine}instructions: |\n  Do the thing.\n`;
  }

  /**
   * Deliver one agent to one tool the way `pullItem` does: the handler's own
   * render at the handler's own path. Writing a placeholder instead would make
   * every fixture a copy rendered from no spec at all.
   */
  async function deliver(tool: string, name: string): Promise<void> {
    const handler = new AgentsHandler();
    const item = (await handler.scanTeamForPull(teamConfig, localConfig)).find((i) => i.name === name);
    if (!item) throw new Error(`no team agent named ${name}`);
    const target = (await handler.deliveryTargets(teamConfig, localConfig, item))
      .find((t) => t.tool === tool);
    if (!target) throw new Error(`${name} does not render for ${tool}`);
    await fse.ensureDir(path.dirname(target.dest));
    await fse.writeFile(target.dest, target.content ?? '');
  }

  async function checks(): Promise<Check[]> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return buildChecks(ctx);
  }

  async function agentsCheck(tool: string): Promise<Check> {
    const check = (await checks()).find((c) => c.name === `Agents delivered to ${tool}`);
    if (!check) throw new Error(`no agents delivery check for ${tool}`);
    return check;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agents-delivery-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await writeTeamAgent('reviewer', specFor('reviewer'));
    await fse.ensureDir(path.join(homeDir, CLAUDE_AGENTS));
    await fse.ensureDir(path.join(homeDir, CODEX_AGENTS));

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
        claude: { agents: CLAUDE_AGENTS },
        codex: { agents: CODEX_AGENTS },
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

  it('expects each tool its own render extension', async () => {
    await deliver('claude', 'reviewer');
    await deliver('codex', 'reviewer');

    expect(await (await agentsCheck('claude')).check()).toBe(true);
    expect(await (await agentsCheck('codex')).check()).toBe(true);
  });

  it('fails when the tool-native render is missing, naming its directory', async () => {
    await deliver('claude', 'reviewer');

    const codex = await agentsCheck('codex');
    expect(await codex.check()).toBe(false);
    expect(codex.fix).toContain('not delivered: reviewer');
    expect(codex.fix).toContain(path.join(homeDir, CODEX_AGENTS));

    expect(await (await agentsCheck('claude')).check()).toBe(true);
  });

  it('does not ask a tool the spec does not target', async () => {
    await writeTeamAgent('claude-only', specFor('claude-only', ['claude']));
    await deliver('claude', 'reviewer');
    await deliver('claude', 'claude-only');
    await deliver('codex', 'reviewer');

    expect(await (await agentsCheck('codex')).check()).toBe(true);
    expect(await (await agentsCheck('claude')).check()).toBe(true);
  });

  it('asks only LEGACY_MD_TOOLS for a legacy .md agent', async () => {
    const legacy = path.join(repoPath, 'agents', 'old-hand.md');
    await fse.writeFile(legacy, '# old hand\n');
    await deliver('claude', 'reviewer');
    await deliver('claude', 'old-hand');
    await deliver('codex', 'reviewer');

    // codex is not a legacy .md tool, so it is owed nothing for old-hand.
    expect(await (await agentsCheck('codex')).check()).toBe(true);
    expect(await (await agentsCheck('claude')).check()).toBe(true);
  });

  it('fails when the delivered copy was rendered from an older spec', async () => {
    await deliver('claude', 'reviewer');
    await deliver('codex', 'reviewer');
    await writeTeamAgent('reviewer', specFor('reviewer').replace('Do the thing.', 'Do it differently.'));

    const claude = await agentsCheck('claude');
    expect(await claude.check()).toBe(false);
    expect(claude.fix).toContain('delivered from an older spec: reviewer');
    expect(await (await agentsCheck('codex')).check()).toBe(false);
  });

  it('reports an agent whose spec renders for no installed tool', async () => {
    await writeTeamAgent('broken', 'name: broken\n  bad: [indent\n');
    await deliver('claude', 'reviewer');
    await deliver('codex', 'reviewer');

    const check = (await checks()).find((c) => c.name === 'Every team agent reaches a tool');
    if (!check) throw new Error('expected the unreachable-agent check');
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('broken');
  });

  it('reports the unreachable agents even when no agent reaches any tool', async () => {
    // The tools are installed and every agent is malformed, so there is no
    // per-tool check to hang the failure on. Taking the deliveries as proof a
    // tool was there left this passing (#624 review).
    await fse.remove(path.join(repoPath, 'agents', 'reviewer.yaml'));
    await writeTeamAgent('broken', 'name: broken\n  bad: [indent\n');

    const built = await checks();
    expect(built.filter((c) => c.name.startsWith('Agents delivered to'))).toEqual([]);

    const check = built.find((c) => c.name === 'Every team agent reaches a tool');
    if (!check) throw new Error('expected the unreachable-agent check');
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('broken');
  });

  it('stays silent about unreachable agents when no tool receives agents at all', async () => {
    teamConfig.toolPaths = {};
    await writeTeamAgent('broken', 'name: broken\n  bad: [indent\n');

    const names = (await checks()).map((c) => c.name);
    expect(names).not.toContain('Every team agent reaches a tool');
  });

  it('emits no check for a tool the member disabled', async () => {
    localConfig.disabledAgents = ['codex'];
    await deliver('claude', 'reviewer');

    const names = (await checks()).map((c) => c.name);
    expect(names).toContain('Agents delivered to claude');
    expect(names).not.toContain('Agents delivered to codex');
  });

  it('emits no check at all when the team repo ships no agents', async () => {
    await fse.remove(path.join(repoPath, 'agents'));

    const names = (await checks()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith('Agents delivered to'))).toEqual([]);
  });

  it('never writes to the tool directory it inspects', async () => {
    await deliver('claude', 'reviewer');

    const before = (await fse.readdir(path.join(homeDir, CODEX_AGENTS))).sort();
    await (await agentsCheck('codex')).check();
    const after = (await fse.readdir(path.join(homeDir, CODEX_AGENTS))).sort();

    expect(after).toEqual(before);
  });
});
