import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

const state = vi.hoisted(() => ({ config: undefined as LocalConfig | undefined, team: undefined as TeamaiConfig | undefined }));

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

import { knownSecrets } from '../env-resolution.js';
import { setStderrOnly } from '../utils/logger.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import * as localDriver from '../workflow/drivers/local/local-driver.js';
import { startRun } from '../workflow/engine.js';
import { workflowResume } from '../workflow-commands.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  state.config = undefined;
  state.team = undefined;
  setStderrOnly(false);
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow resume', () => {
  it('drives the run with the tool paths of the member\'s scope: a user-scope install gets each tool\'s user-scope paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-resume-tools-'));
    dirs.push(root);
    const knowledge = path.join(root, 'knowledge');
    fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), `schemaVersion: v1alpha1
name: build
description: One prompt.
steps:
  - id: one
    prompt: Build it.
`);
    // OpenCode keeps its user-scope files under another prefix than its project ones.
    state.team = TeamaiConfigSchema.parse({
      team: 'test', repo: 'local', toolPaths: { opencode: { skills: '.opencode/skills', agents: '.opencode/agents', userScope: { skills: '.config/opencode/skills', agents: '.config/opencode/agents' } } },
    });
    state.config = { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
    await syncWorkflowDefinitions(state.config);
    const started = await startRun(state.config, 'build', {}, { secrets: await knownSecrets(state.config) });
    if ('error' in started) throw new Error(started.error.message);
    const drive = vi.fn(async () => ({ data: { wait: { reason: 'driven' } } }));
    vi.spyOn(localDriver, 'withDriverLock').mockImplementation(async (_config, _run, body) => body(drive));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await workflowResume(String(started.data.run), {});

    expect(drive).toHaveBeenCalledTimes(1);
    expect(drive).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      toolPaths: expect.objectContaining({ opencode: expect.objectContaining({ skills: '.config/opencode/skills', agents: '.config/opencode/agents' }) }),
    }));
  });
});
