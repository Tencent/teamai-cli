import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDataHome, TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';
import type { LocalToolRun } from '../workflow/drivers/local/local-tool-adapter.js';

const state = vi.hoisted(() => ({
  config: undefined as LocalConfig | undefined,
  team: undefined as TeamaiConfig | undefined,
  runs: [] as Array<{ agent?: unknown }>,
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    autoDetectInit: vi.fn(async () => {
      if (!state.config || !state.team) throw new Error('teamai is not initialized');
      return { localConfig: state.config, teamConfig: state.team };
    }),
  };
});

vi.mock('../workflow/drivers/local/local-tool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow/drivers/local/local-tool-adapter.js')>();
  const run = async (_tool: string, input: LocalToolRun) => {
    state.runs.push({ agent: input.agent });
    return { started: true as const, exitCode: 0 };
  };
  return { ...actual, createLocalToolAdapter: () => ({ run, runInteractive: run }) };
});

import { knownSecrets } from '../env-resolution.js';
import { resolveProjectDataHome } from '../config.js';
import { setStderrOnly } from '../utils/logger.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';
import { workflowResume, workflowStart } from '../workflow-commands.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  state.config = undefined;
  state.team = undefined;
  state.runs = [];
  setStderrOnly(false);
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

const agent = (instructions: string): string => `---\ndescription: Reviews changes.\nmode: subagent\n---\n\n${instructions}\n`;

/**
 * A user-scope install whose `build` workflow has one OpenCode prompt step with agent `reviewer`, the user-scope copy of
 * that agent, and the checkout the run starts in. With `project`, the checkout has a project install of its own whose
 * copy of the agent is committed, and the step runs in a copy of it.
 */
async function userScopeRun(project: boolean): Promise<{ checkout: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-local-agents-')));
  dirs.push(root);
  const home = path.join(root, 'home');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  fs.mkdirSync(path.join(home, '.config', 'opencode', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'agents', 'reviewer.md'), agent('The user-scope reviewer.'));
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), `schemaVersion: v1alpha1
name: build
description: One reviewed prompt.
steps:
  - id: review
    prompt: Review the change.
    agent: reviewer
${project ? '    workspace: new\n' : ''}`);
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(checkout, 'README.md'), '# fixture\n');
  if (project) {
    fs.mkdirSync(path.join(checkout, '.opencode', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(checkout, '.opencode', 'agents', 'reviewer.md'), agent('The project reviewer.'));
    const partition = await resolveProjectDataHome(checkout);
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'config.yaml'), `repo:\n  localPath: ${JSON.stringify(knowledge)}\n  remote: local\n  kind: self\nusername: tester\nscope: project\nadditionalRoles: []\n`);
  }
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'initial');
  // OpenCode keeps its user-scope files under another prefix than its project ones.
  state.team = TeamaiConfigSchema.parse({
    team: 'test', repo: 'local', toolPaths: { opencode: { skills: '.opencode/skills', agents: '.opencode/agents', userScope: { skills: '.config/opencode/skills', agents: '.config/opencode/agents' } } },
  });
  state.config = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data'),
    workflows: { tools: { default: 'opencode' } },
  };
  await syncWorkflowDefinitions(state.config);
  vi.spyOn(process, 'cwd').mockReturnValue(checkout);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return { checkout };
}

/** Drives `build` as `start --driver local` does, or starts it and continues it as `resume` does, and answers its run. */
async function drive(how: 'start' | 'resume', checkout: string): Promise<unknown> {
  if (!state.config) throw new Error('no install');
  if (how === 'start') await workflowStart('build', { driver: 'local' });
  else {
    const started = await startRun(state.config, 'build', {}, { secrets: await knownSecrets(state.config), checkout });
    if ('error' in started) throw new Error(started.error.message);
    await workflowResume(String(started.data.run), {});
  }
  const [run, ...others] = fs.readdirSync(path.join(getDataHome(state.config), 'workflows', 'runs')).filter((file) => file.endsWith('.json'));
  if (!run || others.length > 0) throw new Error('expected one run');
  return readRun(state.config, run.replace(/\.json$/, ''));
}

describe('the agent of a local-driver prompt step in a user-scope run', () => {
  it.each(['start', 'resume'] as const)('loads from the user-scope agents directory through %s', async (how) => {
    const { checkout } = await userScopeRun(false);

    expect(await drive(how, checkout)).toMatchObject({ status: 'succeeded', steps: [{ id: 'review', status: 'succeeded' }] });
    expect(state.runs).toEqual([{ agent: expect.objectContaining({ instructions: 'The user-scope reviewer.' }) }]);
  });

  it.each(['start', 'resume'] as const)('loads from the project install of the checkout its workspace is in, through %s', async (how) => {
    const { checkout } = await userScopeRun(true);

    expect(await drive(how, checkout)).toMatchObject({ status: 'succeeded', steps: [{ id: 'review', status: 'succeeded' }] });
    expect(state.runs).toEqual([{ agent: expect.objectContaining({ instructions: 'The project reviewer.' }) }]);
  });
});
