import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn(), fail: vi.fn() })),
}));
vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  createGit: vi.fn(() => ({ clone: vi.fn() })),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

import { DEFAULT_TOOL_PATHS, type LocalConfig, type TeamaiConfig } from '../types.js';
import { pullSources } from '../source.js';

const producer = 'https://source.test/moved-home/skills.git';
let root: string;
let home: string;
let config: LocalConfig;

beforeEach(async () => {
  root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-source-moved-home-')));
  home = path.join(root, 'home');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  config = {
    repo: { localPath: path.join(root, 'team'), remote: 'https://source.test/team/repo.git' },
    username: 'tester', updatePolicy: 'skip', additionalRoles: [], scope: 'user',
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(root);
});

async function publish(marker: string): Promise<void> {
  const repo = path.join(home, '.teamai/source-repos', createHash('sha256').update(producer).digest('hex'), 'repo');
  await fse.outputFile(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'source', repo: producer, publicSkills: ['foo'] }));
  await fse.outputFile(path.join(repo, 'skills', 'foo', 'SKILL.md'), `# ${marker}\n`);
}

it.each([
  { tool: 'opencode', variable: 'XDG_CONFIG_HOME', value: 'xdg', skills: 'xdg/opencode/skills' },
  { tool: 'pi', variable: 'PI_CODING_AGENT_DIR', value: 'pi-agent', skills: 'pi-agent/skills' },
  { tool: 'codebuddy', variable: 'CODEBUDDY_CONFIG_DIR', value: 'codebuddy', skills: 'codebuddy/skills' },
] as const)('updates a source skill in a $tool home $variable moves outside HOME', async ({ tool, variable, value, skills }) => {
  vi.stubEnv(variable, path.join(root, value));
  const team: TeamaiConfig = {
    team: 'test', description: '', repo: config.repo.remote, provider: 'git', reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
    sources: [{ name: 'current', repo: producer }],
    toolPaths: { [tool]: DEFAULT_TOOL_PATHS[tool] },
  };
  await fse.outputFile(path.join(config.repo.localPath, 'teamai.yaml'), YAML.stringify(team));
  await fse.ensureDir(path.dirname(path.join(root, skills)));
  const skill = path.join(root, skills, 'foo', 'SKILL.md');

  await publish('First');
  await pullSources(config, { force: true });
  expect(await fse.readFile(skill, 'utf8')).toBe('# First\n');

  await publish('Second');
  await pullSources(config, { force: true });
  expect(await fse.readFile(skill, 'utf8')).toBe('# Second\n');
});
