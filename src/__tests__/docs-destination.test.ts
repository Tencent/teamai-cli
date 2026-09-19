import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { resolveDocsDestination } from '../resources/docs.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

function teamConfig(localDir: string): TeamaiConfig {
  return { sharing: { docs: { localDir } } } as TeamaiConfig;
}

function localConfig(scope: 'user' | 'project', projectRoot?: string): LocalConfig {
  return { scope, ...(projectRoot ? { projectRoot } : {}) } as LocalConfig;
}

describe('resolveDocsDestination', () => {
  const homeDir = path.join(os.tmpdir(), 'teamai-docs-destination-home');

  beforeEach(() => {
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('anchors a project-relative directory to the workspace root', () => {
    const projectRoot = path.join(os.tmpdir(), 'teamai-docs-project');

    expect(
      resolveDocsDestination(teamConfig('./.teamai/docs'), localConfig('project', projectRoot)),
    ).toBe(path.resolve(projectRoot, '.teamai/docs'));
  });

  it('anchors a user-relative directory to the user home', () => {
    expect(resolveDocsDestination(teamConfig('./.teamai/docs'), localConfig('user'))).toBe(
      path.resolve(homeDir, '.teamai/docs'),
    );
  });

  it('preserves project tilde and absolute destinations', () => {
    const projectRoot = path.join(os.tmpdir(), 'teamai-docs-project');
    const absolute = path.resolve(os.tmpdir(), 'teamai-docs-absolute');

    expect(resolveDocsDestination(teamConfig('~/team-docs'), localConfig('project', projectRoot))).toBe(
      path.join(projectRoot, 'team-docs'),
    );
    expect(resolveDocsDestination(teamConfig(absolute), localConfig('user'))).toBe(absolute);
  });
});
