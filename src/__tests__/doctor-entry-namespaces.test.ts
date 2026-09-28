import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

import { buildEntryResolutionChecks, buildEntryScopeKeyCheck, entryNamespaceNotes } from '../doctor-delivery.js';
import type { DoctorContext } from '../doctor.js';
import type { LocalConfig } from '../types.js';

/**
 * What `doctor` says about env, hooks and MCP by namespace (#707): overrides
 * and legacy repeats are notes, and the per-entry keys the namespace files
 * replace are one informational check whose fix names every target file.
 */
describe('doctor — env, hooks and MCP namespaces', () => {
  let repoPath: string;

  function ctx(over: Partial<Pick<LocalConfig, 'primaryRole' | 'projects'>> = {}): DoctorContext {
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' }, username: 't', scope: 'user', additionalRoles: [], ...over,
    };
    return { localConfig, teamConfig: null, toolPaths: {}, hookToolPaths: {}, baseDir: repoPath };
  }

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-doctor-entry-ns-'));
  });
  afterEach(async () => {
    await fse.remove(repoPath);
  });

  it('lists each override as a note naming both files', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { env: [checkout] }\n');
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - key: API_BASE\n    value: a\n  - key: LOG\n    value: debug\n');
    await fse.outputFile(path.join(repoPath, 'env', 'checkout', 'env.yaml'), 'variables:\n  - key: API_BASE\n    value: b\n');

    expect(await entryNamespaceNotes(ctx({ projects: ['checkout'] }))).toEqual([
      'env: 2 received here (1 root, 1 checkout)',
      'env: "API_BASE" from env/checkout/env.yaml replaces env/env.yaml',
    ]);
    expect(await entryNamespaceNotes(ctx())).toEqual([]);
  });

  it('lists a model profile override as a note', async () => {
    const catalog = (url: string): string => [
      'profiles:',
      `  - { id: gw, name: Gateway, base_url: '${url}', api_key: '\${API_KEY}', model_groups: [{ protocols: [anthropic], models: [m] }] }`,
      '',
    ].join('\n');
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { models: [checkout] }\n');
    await fse.outputFile(path.join(repoPath, 'models', 'models.yaml'), catalog('https://gw.company.test'));
    await fse.outputFile(path.join(repoPath, 'models', 'checkout', 'models.yaml'), catalog('https://gw.checkout.test'));

    expect(await entryNamespaceNotes(ctx({ projects: ['checkout'] }))).toEqual([
      'models: 1 received here (1 checkout)',
      'models: "gw" from models/checkout/models.yaml replaces models/models.yaml',
    ]);
  });

  it('lists a name the root file repeats in legacy mode, where it is not an error', async () => {
    await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - { name: db, transport: http, url: https://a.example.com }',
      '  - { name: db, transport: http, url: https://b.example.com }',
      '',
    ].join('\n'));

    expect(await entryNamespaceNotes(ctx()))
      .toEqual(['mcp: "db" is defined more than once in mcp/mcp.yaml (legacy mode does not check this; keep one of them)']);
  });

  it('reports per-entry roles: and projects: in one informational check naming every target file', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: frontend',
      '    resources: { knowledge: [], skills: [], hooks: [fe] }',
      '  - id: devops',
      '    resources: { knowledge: [], skills: [] }',
      '',
    ].join('\n'));
    await fse.outputFile(path.join(repoPath, 'hooks', 'hooks.yaml'), [
      'hooks:',
      '  - { id: lint, description: x, event: Stop, command: echo, roles: [frontend, devops] }',
      '',
    ].join('\n'));
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - { key: A, value: b, projects: [checkout] }\n');

    const [check] = await buildEntryScopeKeyCheck(ctx({ primaryRole: 'frontend' }));
    if (!check) throw new Error('expected the scope-key check');
    expect(check.informational).toBe(true);
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('hooks/hooks.yaml: hook "lint" is scoped with per-entry `roles:`, which is deprecated');
    expect(check.fix).toContain('Copy it into each of hooks/fe/hooks.yaml, hooks/devops/hooks.yaml (declare hooks: [devops] for role devops in manifest/roles.yaml)');
    expect(check.fix).toContain('env/env.yaml: variable "A" is scoped with per-entry `projects:`');
  });

  it('names an entry with a key its schema does not know in the same check (#822)', async () => {
    await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - { name: db, transport: http, url: https://a.example.com, role: [frontend] }',
      '',
    ].join('\n'));

    const [check] = await buildEntryScopeKeyCheck(ctx());
    if (!check) throw new Error('expected the scope-key check');
    expect(check.fix).toContain('mcp/mcp.yaml: server "db" has unknown key `role:`, so this entry is not delivered');
  });

  it('adds no check when no entry carries a per-entry key', async () => {
    await fse.outputFile(path.join(repoPath, 'hooks', 'hooks.yaml'), 'hooks:\n  - { id: lint, description: x, event: Stop, command: echo }\n');
    expect(await buildEntryScopeKeyCheck(ctx())).toEqual([]);
  });

  // `teamai status` sends a member to doctor when hooks or model profiles do
  // not resolve; doctor must then say why, as it does for env and MCP.
  it('fails a check naming both files when two active namespaces define one hook', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { hooks: [a, b] }\n');
    const hook = 'hooks:\n  - { id: lint, description: x, event: Stop, command: echo }\n';
    await fse.outputFile(path.join(repoPath, 'hooks', 'a', 'hooks.yaml'), hook);
    await fse.outputFile(path.join(repoPath, 'hooks', 'b', 'hooks.yaml'), hook);

    const checks = await buildEntryResolutionChecks(ctx({ projects: ['checkout'] }));

    expect(checks.map((check) => check.name)).toEqual(['Team hooks can be resolved']);
    const [check] = checks;
    if (!check) throw new Error('expected the hooks check');
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('hooks/a/hooks.yaml and hooks/b/hooks.yaml');
  });

  it('fails a check when a model profiles file does not parse', async () => {
    await fse.outputFile(path.join(repoPath, 'models', 'models.yaml'), 'profiles: [unclosed\n');

    const checks = await buildEntryResolutionChecks(ctx());

    expect(checks.map((check) => check.name)).toEqual(['Team model profiles can be resolved']);
    expect(checks[0]?.fix).toContain('models/models.yaml');
  });

  // #875: the secrets file is its own set, named as such, and a broken one fails a check.
  it('fails a check naming the secrets file when it does not parse', async () => {
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - { key: A, value: x }\n');
    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: [\n');

    const checks = await buildEntryResolutionChecks(ctx());

    expect(checks.map((check) => check.name)).toEqual(['Team secrets can be resolved']);
    expect(await checks[0]?.check()).toBe(false);
    expect(checks[0]?.fix).toMatch(/^env\/secrets\.yaml is not valid YAML: .*Team secrets were not resolved this run/s);
  });

  it('lists a secret override as a secrets note', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { env: [checkout] }\n');
    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - { key: GITHUB_TOKEN }\n');
    await fse.outputFile(path.join(repoPath, 'env', 'checkout', 'secrets.yaml'), 'secrets:\n  - { key: GITHUB_TOKEN }\n');

    expect(await entryNamespaceNotes(ctx({ projects: ['checkout'] }))).toEqual([
      'secrets: 1 received here (1 checkout)',
      'secrets: "GITHUB_TOKEN" from env/checkout/secrets.yaml replaces env/secrets.yaml',
    ]);
  });

  it('names env/secrets.yaml for a key it repeats in legacy mode', async () => {
    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - { key: A }\n  - { key: A }\n');

    expect(await entryNamespaceNotes(ctx()))
      .toEqual(['secrets: "A" is defined more than once in env/secrets.yaml (legacy mode does not check this; keep one of them)']);
  });

  it('adds no resolution check when hooks and model profiles resolve', async () => {
    await fse.outputFile(path.join(repoPath, 'hooks', 'hooks.yaml'), 'hooks:\n  - { id: lint, description: x, event: Stop, command: echo }\n');
    expect(await buildEntryResolutionChecks(ctx())).toEqual([]);
  });
});
