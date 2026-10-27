import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import matter from 'gray-matter';
import os from 'node:os';
import path from 'node:path';
import { AgentsHandler } from '../resources/agents.js';
import { log } from '../utils/logger.js';
import { LocalConfigSchema, TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

/** Trae's subagent frontmatter rules (docs.trae.ai/ide/subagents): the name it loads, and only its own model ids. */
const TRAE_NAME = /^[A-Za-z](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

const AGENT = 'reviewer';
const AGENT_YAML = `name: ${AGENT}
description: Review team changes
instructions: Review the requested change and report defects.
model: claude-sonnet-4.6
tools: [Read, Grep, Glob]
`;

describe('Trae subagents', () => {
  let sandbox: string;
  let teamRepo: string;
  let projectRoot: string;
  let teamConfig: TeamaiConfig;
  let item: { name: string; type: 'agents'; sourcePath: string; relativePath: string };

  beforeEach(async () => {
    sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-trae-agents-'));
    const home = path.join(sandbox, 'home');
    teamRepo = path.join(sandbox, 'team-repo');
    projectRoot = path.join(sandbox, 'project');
    await fse.ensureDir(path.join(teamRepo, 'agents'));
    await fse.ensureDir(projectRoot);
    await fse.writeFile(path.join(teamRepo, 'agents', `${AGENT}.yaml`), AGENT_YAML);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    teamConfig = TeamaiConfigSchema.parse({ team: 'trae-agents-test', repo: 'fixture', provider: 'git' });
    item = { name: AGENT, type: 'agents', sourcePath: path.join(teamRepo, 'agents', `${AGENT}.yaml`), relativePath: `agents/${AGENT}.yaml` };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(sandbox);
  });

  const configFor = (tool: string, scope: 'user' | 'project', tools: readonly string[] = [tool]): LocalConfig => LocalConfigSchema.parse({
    repo: { localPath: teamRepo, remote: 'fixture' },
    username: 'tester',
    scope,
    ...(scope === 'project' ? { projectRoot } : {}),
    enabledAgents: tools,
    additionalRoles: [],
  });

  for (const tool of ['trae', 'trae-cn']) {
    it(`${tool}: a project's team agent lands in .trae/agents with frontmatter Trae loads`, async () => {
      await new AgentsHandler().pullItem(item, teamConfig, configFor(tool, 'project'));

      const file = path.join(projectRoot, '.trae', 'agents', `${AGENT}.md`);
      const content = await fse.readFile(file, 'utf8');
      expect(content.startsWith('---\n')).toBe(true);
      const { data, content: body } = matter(content);
      expect(data).toEqual({ name: AGENT, description: 'Review team changes', tools: 'Read, Grep, Glob' });
      expect(data['name']).toMatch(TRAE_NAME);
      expect(body.trim()).toBe('Review the requested change and report defects.');
    });
  }

  it('trae-cn: a model the team gives the edition in tool_extras is written in ~/.trae-cn/agents', async () => {
    await fse.writeFile(item.sourcePath, `${AGENT_YAML}tool_extras:\n  trae-cn:\n    model: kimi-k2.5\n`);
    await new AgentsHandler().pullItem(item, teamConfig, configFor('trae-cn', 'user'));

    const { data } = matter(await fse.readFile(path.join(sandbox, 'home', '.trae-cn', 'agents', `${AGENT}.md`), 'utf8'));
    expect(data['model']).toBe('kimi-k2.5');
  });

  it('both editions in a project share one .trae/agents file without an edition\'s model, and a second pull leaves it alone', async () => {
    await fse.writeFile(item.sourcePath, `${AGENT_YAML}tool_extras:\n  trae-cn:\n    model: kimi-k2.5\n`);
    const config = configFor('trae', 'project', ['trae', 'trae-cn']);
    const file = path.join(projectRoot, '.trae', 'agents', `${AGENT}.md`);

    await new AgentsHandler().pullItem(item, teamConfig, config);
    const first = await fse.readFile(file, 'utf8');
    await new AgentsHandler().pullItem(item, teamConfig, config);

    expect(matter(first).data).toEqual({ name: AGENT, description: 'Review team changes', tools: 'Read, Grep, Glob' });
    expect(await fse.readFile(file, 'utf8')).toBe(first);
  });

  it('keeps an agent the team gives no tools without tools, since Trae gives every tool to one with no tools field', async () => {
    await fse.writeFile(item.sourcePath, AGENT_YAML.replace('tools: [Read, Grep, Glob]', 'tools: []'));
    await new AgentsHandler().pullItem(item, teamConfig, configFor('trae-cn', 'project'));

    const { data } = matter(await fse.readFile(path.join(projectRoot, '.trae', 'agents', `${AGENT}.md`), 'utf8'));
    expect(data['tools']).toBe('');
  });

  it('trae-cn: a user-scope team agent lands in ~/.trae-cn/agents', async () => {
    await new AgentsHandler().pullItem(item, teamConfig, configFor('trae-cn', 'user'));

    const { data } = matter(await fse.readFile(path.join(sandbox, 'home', '.trae-cn', 'agents', `${AGENT}.md`), 'utf8'));
    expect(data).toEqual({ name: AGENT, description: 'Review team changes', tools: 'Read, Grep, Glob' });
  });

  it('skips a team agent whose name Trae ignores for trae and trae-cn, saying why, and writes it for other tools', async () => {
    const name = 'code_reviewer';
    await fse.writeFile(path.join(teamRepo, 'agents', `${name}.yaml`), AGENT_YAML.replace(`name: ${AGENT}`, `name: ${name}`));
    const underscored = { ...item, name, sourcePath: path.join(teamRepo, 'agents', `${name}.yaml`), relativePath: `agents/${name}.yaml` };
    const config = { ...configFor('trae', 'project'), enabledAgents: ['trae', 'trae-cn', 'claude'] } as LocalConfig;
    await fse.ensureDir(path.join(projectRoot, '.claude'));

    await new AgentsHandler().pullItem(underscored, teamConfig, config);

    expect(await fse.pathExists(path.join(projectRoot, '.trae', 'agents', `${name}.md`))).toBe(false);
    expect(await fse.pathExists(path.join(projectRoot, '.claude', 'agents', `${name}.md`))).toBe(true);
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => message);
    expect(warnings).toContain(`[agents] Skipped ${name} for trae: Trae loads a subagent only when its name starts with a letter, holds only letters, digits and -, ends with a letter or digit, and is at most 50 characters.`);
    expect(warnings).toContain(`[agents] Skipped ${name} for trae-cn: Trae loads a subagent only when its name starts with a letter, holds only letters, digits and -, ends with a letter or digit, and is at most 50 characters.`);
  });

  it('trae: a user-scope pull writes no agent, since where Trae reads them is unknown', async () => {
    await new AgentsHandler().pullItem(item, teamConfig, configFor('trae', 'user'));

    expect(await fse.pathExists(path.join(sandbox, 'home', '.trae', 'agents', `${AGENT}.md`))).toBe(false);
    expect(await fse.pathExists(path.join(sandbox, 'home', '.trae-cn', 'agents', `${AGENT}.md`))).toBe(false);
  });
});
