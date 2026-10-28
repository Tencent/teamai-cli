import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  setStderrOnly: vi.fn(() => false),
}));

import { loadLocalConfigForScope, refreshRoleAssignment, saveLocalConfigForScope } from '../config.js';
import { log } from '../utils/logger.js';

function writeConfig(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(value));
}

describe('member settings overlay', () => {
  let home: string;
  let projectRoot: string;
  let projectConfig: string;
  let machineConfig: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-member-settings-'));
    projectRoot = path.join(home, 'workspace');
    projectConfig = path.join(projectRoot, '.teamai', 'config.yaml');
    machineConfig = path.join(home, '.teamai', 'config.yaml');
    fs.mkdirSync(projectRoot, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('overlays machine settings below workspace settings and merges nested workflow maps', async () => {
    writeConfig(machineConfig, {
      recallEnabled: false,
      codexTrustEnabled: false,
      autoCompactTokens: 120000,
      updatePolicy: 'skip',
      workflows: { tools: { default: 'codex', review: 'codex' }, max_parallel: 2 },
    });
    writeConfig(projectConfig, {
      repo: { localPath: path.join(home, 'team-repo'), remote: 'https://example.test/team.git' },
      username: 'member',
      scope: 'project',
      projectRoot,
      recallEnabled: true,
      workflows: { tools: { review: 'claude' } },
    });

    const loaded = await loadLocalConfigForScope('project', projectRoot);

    expect(loaded).toMatchObject({
      scope: 'project',
      recallEnabled: true,
      codexTrustEnabled: false,
      autoCompactTokens: 120000,
      updatePolicy: 'skip',
      workflows: { tools: { default: 'codex', review: 'claude' }, max_parallel: 2 },
    });
  });

  it('does not persist machine-only values when saving a workspace config', async () => {
    writeConfig(machineConfig, {
      recallEnabled: false,
      codexTrustEnabled: false,
      workflows: { tools: { default: 'codex' }, max_parallel: 2 },
    });
    writeConfig(projectConfig, {
      repo: { localPath: path.join(home, 'team-repo'), remote: 'https://example.test/team.git' },
      username: 'member',
      scope: 'project',
      projectRoot,
      workflows: { tools: { review: 'claude' } },
    });

    const loaded = await loadLocalConfigForScope('project', projectRoot);
    expect(loaded).not.toBeNull();
    await saveLocalConfigForScope(loaded!, 'project', projectRoot);

    const saved = YAML.parse(fs.readFileSync(projectConfig, 'utf8')) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('recallEnabled');
    expect(saved).not.toHaveProperty('codexTrustEnabled');
    expect(saved).toMatchObject({ workflows: { tools: { review: 'claude' } } });
    expect((saved.workflows as Record<string, unknown>).tools).not.toHaveProperty('default');
    expect((saved.workflows as Record<string, unknown>).max_parallel).toBeUndefined();
  });

  it('fails closed when a workflow policy value has the wrong type', async () => {
    writeConfig(machineConfig, {
      workflows: { allow: { network: 'false', env: 'not-a-list' } },
    });
    writeConfig(projectConfig, {
      repo: { localPath: path.join(home, 'team-repo'), remote: 'https://example.test/team.git' },
      username: 'member',
      scope: 'project',
      projectRoot,
    });

    const loaded = await loadLocalConfigForScope('project', projectRoot);

    expect(loaded?.workflows?.allow).toEqual({ network: false, env: [] });
    expect(vi.mocked(log.warn).mock.calls.flat().join('\\n')).toContain('Ignoring network');
    expect(vi.mocked(log.warn).mock.calls.flat().join('\\n')).toContain('Ignoring env');
  });

  it('keeps valid machine settings when a sibling setting has the wrong type', async () => {
    writeConfig(machineConfig, {
      recallEnabled: 'yes',
      codexTrustEnabled: false,
      workflows: { tools: { default: 'codex', broken: 42 } },
    });
    writeConfig(projectConfig, {
      repo: { localPath: path.join(home, 'team-repo'), remote: 'https://example.test/team.git' },
      username: 'member',
      scope: 'project',
      projectRoot,
    });

    const loaded = await loadLocalConfigForScope('project', projectRoot);

    expect(loaded?.recallEnabled).toBeUndefined();
    expect(loaded?.codexTrustEnabled).toBe(false);
    expect(loaded?.workflows?.tools).toEqual({ default: 'codex' });
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it('keeps a local setting when refresh resolves the same config object', async () => {
    writeConfig(projectConfig, {
      repo: { localPath: path.join(home, 'team-repo'), remote: 'https://example.test/team.git' },
      username: 'member',
      scope: 'project',
      projectRoot,
      recallEnabled: false,
    });

    const loaded = await loadLocalConfigForScope('project', projectRoot);
    expect(loaded).not.toBeNull();
    await refreshRoleAssignment(loaded!);

    expect(loaded?.recallEnabled).toBe(false);
  });
});