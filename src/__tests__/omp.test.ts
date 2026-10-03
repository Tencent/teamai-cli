import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_AGENTS } from '../known-agents.js';
import { resolveMcpTargets } from '../mcp-reconcile.js';
import {
  agentFileExtensionForTool,
  ALL_SUPPORTED_TOOLS,
} from '../resources/agent-format.js';
import { AgentsHandler } from '../resources/agents.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { ruleFileExtensionForTool, usesMdcRules } from '../resources/rule-format.js';
import { RulesHandler } from '../resources/rules.js';
import { checkoutKey } from '../pull.js';
import { openLedger, recordDelivered, type DeliveredHashes } from '../resources/delivered-copies.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { TeamaiConfigSchema, scopedToolPaths } from '../types.js';
import type { LocalConfig, ResourceItem } from '../types.js';

describe('OMP (Oh My Pi) support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships OMP resource paths for user and project scopes', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.omp).toEqual({
      skills: '.omp/skills',
      rules: '.omp/rules',
      claudemd: '.omp/AGENTS.md',
      agents: '.omp/agents',
      mcp: '.omp/agent/mcp.json',
      mcpProject: '.omp/mcp.json',
      userScope: {
        skills: '.omp/agent/skills',
        rules: '.omp/agent/rules',
        claudemd: '.omp/agent/AGENTS.md',
        agents: '.omp/agent/agents',
      },
    });

    // User scope splices the agent-dir prefix (~/.omp/agent/...) over the
    // project-scope paths (.omp/...), matching OMP's native layout.
    const scoped = scopedToolPaths(config, { scope: 'user' });
    expect(scoped.omp).toMatchObject({
      skills: '.omp/agent/skills',
      rules: '.omp/agent/rules',
      claudemd: '.omp/agent/AGENTS.md',
      agents: '.omp/agent/agents',
    });
  });

  it('registers OMP for discovery and native Markdown resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'omp')).toMatchObject({
      displayName: 'Oh My Pi',
      skillsPath: '.omp/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('omp');
    expect(agentFileExtensionForTool('omp')).toBe('.md');
    expect(ruleFileExtensionForTool('omp')).toBe('.md');
    expect(usesMdcRules('omp')).toBe(false);
  });

  it('uses the mcpServers JSON format in the OMP agent dir', () => {
    expect(detectMcpFormat('omp')).toBe('claude');
  });

  it('resolves the installed OMP agent dir as an MCP target', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-test-'));
    try {
      await fse.ensureDir(path.join(home, '.omp', 'agent', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      expect(await resolveMcpTargets(config, localConfig)).toContainEqual({
        tool: 'omp',
        format: 'claude',
        file: path.join(home, '.omp', 'agent', 'mcp.json'),
        projectScope: false,
      });
    } finally {
      await fse.remove(home);
    }
  });
});

describe('OMP rules directory is user-owned', () => {
  it('preserves personal rules across repeated pulls (same policy as JoyCode)', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-rules-'));
    try {
      const homeDir = path.join(tmp, 'home');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules', 'notes.md'), 'Personal rule.');
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules/nested/private.md'), 'Personal nested rule.');
      await fse.writeFile(path.join(repoPath, 'rules', 'team.md'), 'Team rule.');
      vi.stubEnv('HOME', homeDir);

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test', repo: 'test/repo',
        toolPaths: { omp: { skills: '.omp/skills', rules: '.omp/agent/rules' } },
      });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      const handler = new RulesHandler();
      await handler.pullAllRules(teamConfig, localConfig);
      await handler.pullAllRules(teamConfig, localConfig);

      expect(await fse.readFile(path.join(homeDir, '.omp/agent/rules/notes.md'), 'utf8')).toBe('Personal rule.');
      expect(await fse.readFile(path.join(homeDir, '.omp/agent/rules/nested/private.md'), 'utf8')).toBe('Personal nested rule.');
      // OMP's own render of the team rule (#946).
      expect(await fse.readFile(path.join(homeDir, '.omp/agent/rules/team.md'), 'utf8')).toBe('---\nalwaysApply: true\n---\n\nTeam rule.\n');
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(tmp);
    }
  });

  it('still removes a rule the team explicitly tombstoned', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-rules-t-'));
    try {
      const homeDir = path.join(tmp, 'home');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules', 'gone.md'), 'Former team rule.');
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules', 'personal.md'), 'Personal rule.');
      await fse.writeFile(path.join(repoPath, 'rules', 'keep.md'), 'Current team rule.');
      await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'gone\n');
      vi.stubEnv('HOME', homeDir);

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test', repo: 'test/repo',
        toolPaths: { omp: { skills: '.omp/skills', rules: '.omp/agent/rules' } },
      });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      await new RulesHandler().pullAllRules(teamConfig, localConfig);

      expect(await fse.pathExists(path.join(homeDir, '.omp/agent/rules/gone.md'))).toBe(false);
      expect(await fse.readFile(path.join(homeDir, '.omp/agent/rules/personal.md'), 'utf8')).toBe('Personal rule.');
      expect(await fse.pathExists(path.join(homeDir, '.omp/agent/rules/keep.md'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(tmp);
    }
  });

  it('never offers personal rules as teamai push candidates', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-rules-p-'));
    try {
      const homeDir = path.join(tmp, 'home');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.writeFile(path.join(repoPath, 'rules', 'team.md'), 'Team rule.');
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules', 'personal.md'), 'Personal rule.');
      vi.stubEnv('HOME', homeDir);

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test', repo: 'test/repo',
        toolPaths: { omp: { skills: '.omp/skills', rules: '.omp/agent/rules' } },
      });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      const handler = new RulesHandler();
      await handler.pullAllRules(teamConfig, localConfig);
      // Personal rule stays local-only; a locally edited team rule is still a
      // legitimate "modified" push candidate from the shared dir.
      await fse.writeFile(path.join(homeDir, '.omp/agent/rules', 'team.md'), 'Edited team rule.');

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      expect(items.find((i) => i.name === 'personal')).toBeUndefined();
      expect(items.find((i) => i.name === 'team')).toMatchObject({ status: 'modified' });
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(tmp);
    }
  });
});

describe('OMP receives legacy markdown team agents', () => {
  it('copies agents/<name>.md verbatim into the omp agents dir', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-agents-'));
    try {
      const homeDir = path.join(tmp, 'home');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(repoPath, 'agents'));
      await fse.ensureDir(path.join(homeDir, '.omp', 'agent'));
      const source = path.join(repoPath, 'agents', 'legacy-helper.md');
      await fse.writeFile(source, '---\nname: legacy-helper\ndescription: Legacy fixture agent\n---\n\nBody.\n');
      vi.stubEnv('HOME', homeDir);

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test', repo: 'test/repo',
        toolPaths: { omp: { skills: '.omp/skills', agents: '.omp/agent/agents' } },
      });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      await new AgentsHandler().pullItem({
        name: 'legacy-helper',
        type: 'agents',
        sourcePath: source,
        relativePath: 'agents/legacy-helper.md',
      } as ResourceItem, teamConfig, localConfig);

      expect(await fse.readFile(path.join(homeDir, '.omp/agent/agents/legacy-helper.md'), 'utf8'))
        .toContain('Legacy fixture agent');
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(tmp);
    }
  });
});

describe('OMP gets its own rule render, namespaced rules flat (#946)', () => {
  let tmp: string;
  let homeDir: string;
  let repoPath: string;
  let projectRoot: string;
  let localConfig: LocalConfig;
  const handler = new RulesHandler();
  const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

  const SCOPED = '---\npaths:\n  - "src/**"\n---\n\nUse named exports.\n';
  const OMP_SCOPED = '---\ndescription: "Team rule for files matching src/**"\nglobs: ["src/**"]\n---\n\nUse named exports.\n';
  const NS = 'Namespaced rule.\n';
  const OMP_NS = '---\nalwaysApply: true\n---\n\nNamespaced rule.\n';
  const userRules = () => path.join(homeDir, '.omp/agent/rules');

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-render-'));
    homeDir = path.join(tmp, 'home');
    repoPath = path.join(tmp, 'repo');
    projectRoot = path.join(tmp, 'project');
    await fse.outputFile(path.join(repoPath, 'rules', 'scoped.md'), SCOPED);
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.md'), NS);
    await fse.ensureDir(userRules());
    await fse.ensureDir(path.join(homeDir, '.claude/rules'));
    vi.stubEnv('HOME', homeDir);
    resetWarnOnce();
    localConfig = {
      repo: { localPath: repoPath, remote: 'test/repo' },
      username: 'test',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['omp', 'claude'],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fse.remove(tmp);
  });

  it('writes the OMP render to ~/.omp/agent/rules, a namespaced rule at the top level', async () => {
    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(userRules(), 'scoped.md'), 'utf8')).toBe(OMP_SCOPED);
    expect(await fse.readFile(path.join(userRules(), 'fe.style.md'), 'utf8')).toBe(OMP_NS);
    expect(await fse.pathExists(path.join(userRules(), 'fe'))).toBe(false);
    // Claude reads its rules directory recursively, so its copy stays nested.
    expect(await fse.readFile(path.join(homeDir, '.claude/rules/fe/style.md'), 'utf8')).toBe(NS);
  });

  it('writes the same to .omp/rules in project scope', async () => {
    await fse.ensureDir(path.join(projectRoot, '.omp'));
    localConfig.scope = 'project';
    localConfig.projectRoot = projectRoot;

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(projectRoot, '.omp/rules/scoped.md'), 'utf8')).toBe(OMP_SCOPED);
    expect(await fse.readFile(path.join(projectRoot, '.omp/rules/fe.style.md'), 'utf8')).toBe(OMP_NS);
  });

  it('keeps the flat copy on the next pull, which has it on record', async () => {
    const first = openLedger({});
    await handler.pullAllRules(teamConfig, localConfig, undefined, [], first);

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], openLedger(first.hashes));

    expect(await fse.readFile(path.join(userRules(), 'fe.style.md'), 'utf8')).toBe(OMP_NS);
  });

  it('a clean pull leaves nothing to push', async () => {
    await handler.pullAllRules(teamConfig, localConfig);

    expect(await handler.scanLocalForPush(teamConfig, localConfig)).toEqual([]);
  });

  it('pushes an edit of a flat copy into rules/<ns>/<name>.md, without the OMP frontmatter', async () => {
    // As a pull does: the delivery record proves the flat copy is teamai's (#946).
    const ledger = openLedger({});
    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);
    await saveStateForScope({
      ...await loadStateForScope(localConfig),
      lastPullByWorkspace: { [await checkoutKey(homeDir)]: { rev: 'r1', targets: [], delivered: ledger.hashes } },
    }, localConfig);
    // Only the OMP copy is edited; Claude's stays as delivered.
    const copy = path.join(userRules(), 'fe.style.md');
    await fse.writeFile(copy, OMP_NS.replace('Namespaced rule.', 'Edited namespaced rule.'));

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items).toMatchObject([
      { name: 'fe/style', status: 'modified', sourcePath: copy, relativePath: 'rules/fe/style.md', namespace: 'fe' },
    ]);
    await handler.pushItem(items[0], teamConfig, localConfig);

    expect(await fse.readFile(path.join(repoPath, 'rules', 'fe', 'style.md'), 'utf8')).toBe('Edited namespaced rule.\n');
  });

  it('reclaims the nested copy an older teamai delivered, and keeps one the member edited', async () => {
    // What an older teamai wrote: the team rules verbatim, namespaced ones nested.
    const nested = path.join(userRules(), 'fe', 'style.md');
    const editedNested = path.join(userRules(), 'be', 'api.md');
    await fse.outputFile(path.join(repoPath, 'rules', 'be', 'api.md'), 'Backend rule.\n');
    await fse.outputFile(nested, NS);
    await fse.outputFile(editedNested, 'Backend rule.\n');
    const previous: DeliveredHashes = {};
    await recordDelivered(previous, nested);
    await recordDelivered(previous, editedNested);
    await fse.writeFile(editedNested, 'My own backend wording.\n');
    const ledger = openLedger(previous);

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);

    expect(await fse.pathExists(path.join(userRules(), 'fe'))).toBe(false);
    expect(ledger.hashes[nested]).toBeUndefined();
    expect(await fse.readFile(editedNested, 'utf8')).toBe('My own backend wording.\n');
    expect(await fse.readFile(path.join(userRules(), 'fe.style.md'), 'utf8')).toBe(OMP_NS);
    expect(await fse.readFile(path.join(userRules(), 'be.api.md'), 'utf8')).toBe('---\nalwaysApply: true\n---\n\nBackend rule.\n');
  });

  it('does not own a flat copy on record that the member edited since (#946)', async () => {
    await handler.pullAllRules(teamConfig, localConfig);
    const flat = path.join(userRules(), 'fe.style.md');
    const previous: DeliveredHashes = {};
    await recordDelivered(previous, flat);
    await fse.writeFile(flat, OMP_NS.replace('Namespaced rule.', 'My own wording.'));

    const copies = await handler.ownedFlatCopies(teamConfig, localConfig, await handler.scanTeamForPull(teamConfig, localConfig), previous);

    expect(copies).toEqual({ owned: [], edited: [{ tool: 'omp', file: flat }] });
  });

  it('removes the flat copy when the namespaced rule is removed', async () => {
    await handler.pullAllRules(teamConfig, localConfig);

    const removed = await handler.removeItem('fe/style', teamConfig, localConfig);

    expect(removed).toContain(path.join(userRules(), 'fe.style.md'));
    expect(await fse.pathExists(path.join(userRules(), 'fe.style.md'))).toBe(false);
  });

  it('leaves a namespaced rule out when a root rule has its flat name, and names both', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'fe.style.md'), 'Root rule.\n');
    const warn = vi.spyOn(log, 'warn');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(userRules(), 'fe.style.md'), 'utf8')).toBe('---\nalwaysApply: true\n---\n\nRoot rule.\n');
    expect(warn.mock.calls.map(([message]) => String(message))).toContain(
      'Skipped rule fe/style for omp: omp reads only the top level of its rules directory, where its file would be '
      + 'fe.style.md, which is the root rule fe.style. Rename one of them in the team repo.',
    );
  });

  it('writes neither of two namespaced rules with the same flat name, and says why', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'fe.style', 'x.md'), 'Other.\n');
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.x.md'), 'One.\n');
    const warn = vi.spyOn(log, 'warn');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(userRules(), 'fe.style.x.md'))).toBe(false);
    expect(warn.mock.calls.map(([message]) => String(message))).toContain(
      'Skipped rules fe.style/x and fe/style.x for omp: omp reads only the top level of its rules directory, where '
      + 'both would be fe.style.x.md, so neither is written. Rename one of them in the team repo.',
    );
  });

  it('judges a flat-name clash only among the rules this member receives', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'fe.style', 'x.md'), 'Inactive namespace.\n');
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.x.md'), 'Active namespace.\n');
    await fse.outputFile(path.join(repoPath, 'manifest', 'roles.yaml'), [
      'version: 1', 'roles:', '  - id: dev', '    resources:', '      knowledge: [fe]', '      skills: []',
      '      learnings: []', '      agents: []', '',
    ].join('\n'));
    localConfig.primaryRole = 'dev';
    const { buildRolePullContext, resolveDesiredRules } = await import('../resources/desired.js');
    const { items } = await resolveDesiredRules(teamConfig, localConfig, await buildRolePullContext(localConfig));

    await handler.pullAllRules(teamConfig, localConfig, items);

    expect(await fse.readFile(path.join(userRules(), 'fe.style.x.md'), 'utf8')).toBe('---\nalwaysApply: true\n---\n\nActive namespace.\n');
  });

  it('pushes the author\'s root copy of a rule they placed in a namespace, and leaves no flat copy beside it', async () => {
    const state = await loadStateForScope(localConfig);
    state.placedRules = { style: 'rules/fe/style.md' };
    await saveStateForScope(state, localConfig);
    // A flat copy an earlier pull wrote before the placement was recorded.
    await fse.outputFile(path.join(userRules(), 'fe.style.md'), OMP_NS);

    await handler.pullAllRules(teamConfig, localConfig);

    const authorCopy = path.join(userRules(), 'style.md');
    expect(await fse.readFile(authorCopy, 'utf8')).toBe(OMP_NS);
    expect(await fse.pathExists(path.join(userRules(), 'fe.style.md'))).toBe(false);
    await fse.writeFile(authorCopy, OMP_NS.replace('Namespaced rule.', 'Edited by the author.'));
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.filter((item) => item.sourcePath === authorCopy)).toMatchObject([
      { name: 'style', relativePath: 'rules/fe/style.md', status: 'modified' },
    ]);
  });

  it('keeps a file of the author\'s own that has the flat name of a rule they placed in a namespace (#946)', async () => {
    const state = await loadStateForScope(localConfig);
    state.placedRules = { style: 'rules/fe/style.md' };
    await saveStateForScope(state, localConfig);
    // Not on record and not the render: the member wrote it.
    const own = path.join(userRules(), 'fe.style.md');
    await fse.outputFile(own, 'My own frontend notes.\n');

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], openLedger({}));

    expect(await fse.readFile(path.join(userRules(), 'style.md'), 'utf8')).toBe(OMP_NS);
    expect(await fse.readFile(own, 'utf8')).toBe('My own frontend notes.\n');
  });

  it('reclaims an unrecorded nested copy an older teamai wrote verbatim, on a machine with no delivery record', async () => {
    const nested = path.join(userRules(), 'fe', 'style.md');
    await fse.outputFile(nested, NS);

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], openLedger(undefined));

    expect(await fse.pathExists(nested)).toBe(false);
    expect(await fse.readFile(path.join(userRules(), 'fe.style.md'), 'utf8')).toBe(OMP_NS);
  });

  it('keeps an edited nested copy and says OMP does not read it', async () => {
    const nested = path.join(userRules(), 'fe', 'style.md');
    await fse.outputFile(nested, 'My own wording.\n');
    const warn = vi.spyOn(log, 'warn');

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], openLedger({}));

    expect(await fse.readFile(nested, 'utf8')).toBe('My own wording.\n');
    expect(warn.mock.calls.map(([message]) => String(message))).toContain(
      `Kept ${nested}: omp reads only the top level of its rules directory, so it does not read this copy of fe/style, `
      + `which teamai now delivers as ${path.join(userRules(), 'fe.style.md')}. To keep your edit, copy it into that `
      + 'file and share it with `teamai push`; then delete this one.',
    );
  });

  it("does not overwrite a member's own file that has a namespaced rule's flat name", async () => {
    const mine = path.join(userRules(), 'fe.style.md');
    await fse.outputFile(mine, 'My own dotted rule.\n');
    const warn = vi.spyOn(log, 'warn');

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], openLedger({}));

    expect(await fse.readFile(mine, 'utf8')).toBe('My own dotted rule.\n');
    expect(warn.mock.calls.map(([message]) => String(message))).toContain(
      `Kept ${mine}: teamai did not write it, and it is where omp would read team rule fe/style. `
      + 'Rename your file, then run `teamai pull --force`.',
    );
  });

  it("removes a tombstoned rule's flat copy only on record, not a member's own file of that name", async () => {
    await fse.outputFile(path.join(repoPath, 'rules', '.removed'), 'be/api\nfe/old\n');
    const recorded = path.join(userRules(), 'fe.old.md');
    const mine = path.join(userRules(), 'be.api.md');
    await fse.outputFile(recorded, '---\nalwaysApply: true\n---\n\nOld.\n');
    await fse.outputFile(mine, 'My own dotted rule.\n');
    const previous: DeliveredHashes = {};
    await recordDelivered(previous, recorded);

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], openLedger(previous));

    expect(await fse.pathExists(recorded)).toBe(false);
    expect(await fse.readFile(mine, 'utf8')).toBe('My own dotted rule.\n');
  });
});
