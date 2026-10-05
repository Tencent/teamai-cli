/**
 * `recall()` wires a project's inactive wiki namespaces into the codebase
 * knowledge query (#912), the same way docs are already scoped: a codebase
 * slug under `teamwiki/evidence/code/<slug>/` that this directory's active
 * project does not select must not reach `queryCodeKnowledge`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn(),
  requireInit: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
}));

vi.mock('../code-knowledge-recall.js', () => ({
  queryCodeKnowledge: vi.fn().mockResolvedValue([]),
}));

vi.mock('../votes.js', () => ({
  incrementRecalled: vi.fn().mockResolvedValue(undefined),
}));

import { recall } from '../recall.js';
import { detectProjectConfig } from '../config.js';
import { queryCodeKnowledge } from '../code-knowledge-recall.js';
import type { LocalConfig } from '../types.js';

describe('recall: scopes codebase knowledge by the active project\'s wiki namespaces (#912)', () => {
  let tmpDir: string;
  let projectRoot: string;
  let teamRepo: string;
  let writeSpy: { mockRestore: () => void };

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-wiki-'));
    projectRoot = path.join(tmpDir, 'proj');
    teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
    await fse.ensureDir(teamRepo);
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));

    await fse.outputFile(
      path.join(teamRepo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n'
      + '  - id: svc-a\n    name: Svc A\n    resources: { wiki: [svc-a, payments] }\n'
      + '  - id: svc-b\n    name: Svc B\n    resources: { wiki: [svc-b, payments] }\n',
    );
    // hasWiki only checks the directory exists; queryCodeKnowledge itself is mocked.
    await fse.ensureDir(path.join(teamRepo, 'teamwiki'));

    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.mocked(queryCodeKnowledge).mockClear();
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  function projectConfig(projects: string[]): LocalConfig {
    return {
      repo: { localPath: teamRepo, remote: 'https://example.test/acme/team.git' },
      username: 'tester',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
      projects,
    };
  }

  it('withholds a project-declared wiki namespace this directory did not activate', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig(['svc-a']));

    await recall('narwhal', { dryRun: true });

    const call = vi.mocked(queryCodeKnowledge).mock.calls[0]?.[1];
    expect(call?.withheldCodebases?.sort()).toEqual(['svc-b']);
  });

  it('does not withhold a namespace the active project selects, even when another project also declares it', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig(['svc-a']));

    await recall('narwhal', { dryRun: true });

    const call = vi.mocked(queryCodeKnowledge).mock.calls[0]?.[1];
    expect(call?.withheldCodebases).not.toContain('payments');
  });

  it('passes no withheld namespaces when the directory has no projects manifest, as before', async () => {
    await fse.remove(path.join(teamRepo, 'manifest', 'projects.yaml'));
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig([]));

    await recall('narwhal', { dryRun: true });

    const call = vi.mocked(queryCodeKnowledge).mock.calls[0]?.[1];
    expect(call?.withheldCodebases).toEqual([]);
  });

  it('skips code recall instead of rejecting the whole call when the projects manifest is unreadable (#912 review round 2)', async () => {
    await fse.outputFile(path.join(teamRepo, 'manifest', 'projects.yaml'), '{ not: valid: yaml');
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig(['svc-a']));

    await expect(recall('narwhal', { dryRun: true })).resolves.not.toThrow();
    expect(queryCodeKnowledge).not.toHaveBeenCalled();
  });
});
