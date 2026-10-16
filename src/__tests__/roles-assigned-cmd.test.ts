import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(),
}));
vi.mock('../scope-selection.js', () => ({ saveScopeSelection: vi.fn() }));

import { rolesList, rolesSet } from '../roles-cmd.js';
import { autoDetectInit } from '../config.js';
import { saveScopeSelection } from '../scope-selection.js';
import { log } from '../utils/logger.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/** `teamai roles set` and `roles list` once the team assigns roles (#1186). */
describe('roles commands with assigned roles', () => {
  let repoDir: string;
  let printed: string[];

  const teamConfig = { team: 'acme', description: '', repo: 'https://gitlab.com/acme/team.git' } as TeamaiConfig;

  function configWith(overrides: Partial<LocalConfig>): LocalConfig {
    return {
      repo: { localPath: repoDir, remote: 'https://gitlab.com/acme/team.git' },
      username: 'alice',
      additionalRoles: [],
      scope: 'user',
      ...overrides,
    } as LocalConfig;
  }

  function assigned(roles: string[]): LocalConfig {
    const [primaryRole, ...additionalRoles] = roles;
    return configWith({
      ...(primaryRole ? { primaryRole } : {}),
      additionalRoles,
      roleAssignment: { source: 'assigned', local: { additionalRoles: [] } },
    });
  }

  function given(localConfig: LocalConfig): void {
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig, teamConfig });
  }

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-assigned-cmd-'));
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    writeFileSync(
      path.join(repoDir, 'manifest', 'roles.yaml'),
      'version: 1\nroles:\n  - id: frontend\n    resources: { knowledge: [], skills: [frontend] }\n  - id: backend\n    resources: { knowledge: [], skills: [backend] }\n',
      'utf-8',
    );
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { printed.push(String(line ?? '')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(saveScopeSelection).mockReset();
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('refuses to set a role, naming the file and the roles held', async () => {
    given(assigned(['frontend']));
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    await rolesSet('backend', {});

    expect(error).toHaveBeenCalledWith(expect.stringContaining('manifest/members.yaml'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Yours: frontend'));
    expect(saveScopeSelection).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('still sets a role when the team assigns none', async () => {
    given(configWith({}));

    await rolesSet('backend', {});

    expect(saveScopeSelection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ primaryRole: 'backend' }),
    );
  });

  it('reports the effective roles and where they come from as JSON', async () => {
    given(assigned(['frontend', 'backend']));

    await rolesList({ json: true });

    expect(JSON.parse(printed.join('\n'))).toEqual({
      roles: ['frontend', 'backend'],
      primaryRole: 'frontend',
      additionalRoles: ['backend'],
      source: 'assigned',
      assignmentFile: 'manifest/members.yaml',
    });
  });

  it('reports a local selection as local, with no assignment file', async () => {
    given(configWith({ primaryRole: 'backend' }));

    await rolesList({ json: true });

    expect(JSON.parse(printed.join('\n'))).toMatchObject({ source: 'local', assignmentFile: null });
  });

  it('reports a member the team assigned no roles as holding none', async () => {
    given(configWith({ roleAssignment: { source: 'default', local: { additionalRoles: [] } } }));

    await rolesList({ json: true });

    expect(JSON.parse(printed.join('\n'))).toMatchObject({ roles: [], primaryRole: null, source: 'default' });
  });

  it('says where the roles come from in the human listing', async () => {
    given(assigned(['frontend']));

    await rolesList();

    expect(printed.join('\n')).toContain('Your primary role: frontend');
    expect(printed.join('\n')).toContain('Roles are assigned in manifest/members.yaml');
  });
});
