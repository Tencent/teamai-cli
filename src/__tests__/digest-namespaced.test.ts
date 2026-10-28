import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

describe('digest — namespaced learnings support', () => {
  let tmpDir: string;
  let learningsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-digest-test-'));
    learningsDir = path.join(tmpDir, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes namespaced learnings in total and recent counts when active namespaces are passed', async () => {
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(learningsDir, 'k8s'), { recursive: true });
    fs.mkdirSync(path.join(learningsDir, 'secret-ns'), { recursive: true });

    // Root learning
    const rootFile = path.join(learningsDir, `teamai-${today}-root.md`);
    fs.writeFileSync(rootFile, matter.stringify('Root body', { title: 'Root Learning' }));

    // Namespaced k8s learning
    const nsFile = path.join(learningsDir, 'k8s', `teamai-${today}-helm.md`);
    fs.writeFileSync(nsFile, matter.stringify('Helm body', { title: 'Helm Values' }));

    // Another namespace (inactive)
    const secretFile = path.join(learningsDir, 'secret-ns', `teamai-${today}-secret.md`);
    fs.writeFileSync(secretFile, matter.stringify('Secret body', { title: 'Secret Note' }));

    // Internal getRecentLearnings function test via listLearningFiles
    const { listLearningFiles } = await import('../utils/learnings-roots.js');

    // Without namespaces: only root
    const rootOnly = await listLearningFiles([learningsDir]);
    expect(rootOnly).toHaveLength(1);
    expect(rootOnly[0].file).toBe(`teamai-${today}-root.md`);

    // With active namespaces: root + k8s, excluding secret-ns
    const withNs = await listLearningFiles([learningsDir], ['k8s']);
    expect(withNs.map((f) => f.file).sort()).toEqual([
      path.join('k8s', `teamai-${today}-helm.md`),
      `teamai-${today}-root.md`,
    ].sort());
  });

  it('includes namespaces selected by workspace children in safeDeliveredLearningsNamespaces', async () => {
    const { safeDeliveredLearningsNamespaces } = await import('../workspace-children.js');
    const manifestDir = path.join(tmpDir, 'manifest');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: infra',
      '    resources:',
      '      learnings:',
      '        - k8s',
    ].join('\n'));

    const config: any = {
      scope: 'project',
      projectRoot: tmpDir,
      repo: { localPath: tmpDir, kind: 'git' },
      projects: [],
      children: {
        children: [
          {
            path: 'svc-a',
            root: path.join(tmpDir, 'svc-a'),
            anchor: 'anchor-a',
            selection: { projects: ['infra'], additionalRoles: [], excludedSkills: [] },
          },
        ],
        leftOut: [],
        roots: [],
        fingerprint: 'fp',
      },
    };

    const namespaces = await safeDeliveredLearningsNamespaces(config, 'digest');
    expect(namespaces).toEqual(['k8s']);
  });
});
