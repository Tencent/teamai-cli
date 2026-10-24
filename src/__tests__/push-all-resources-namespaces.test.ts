import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  declaredNamespaceFor,
  isAtSharedRoot,
  isPlaceableType,
  NAMESPACE_AXIS,
  PLACEABLE_TYPES,
  placedResourcePath,
  resolveProjectNamespace,
  withNamespace,
} from '../push-namespaces.js';
import type { ProjectsManifest } from '../projects.js';
import { getStatePath, type LocalConfig, type ResourceItem } from '../types.js';
import { scanRepoResourceForPush, pushRepoResourceItem } from '../resources/repo-resource.js';
import { getHandler } from '../resources/index.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { reconcilePlacementRecords, toPendingItems } from '../utils/pending-push.js';

const dirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-all-ns-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('all 14 placeable resource types and namespace axis mapping', () => {
  it('covers all 14 distributed resource types in PLACEABLE_TYPES', () => {
    const expected = [
      'skills',
      'rules',
      'agents',
      'docs',
      'env',
      'hooks',
      'mcp',
      'models',
      'claudemd',
      'learnings',
      'wiki',
      'workflows',
      'prompts',
      'scorers',
    ];
    expect([...PLACEABLE_TYPES].sort()).toEqual(expected.sort());
    for (const t of expected) {
      expect(isPlaceableType(t)).toBe(true);
    }
  });

  it('maps each placeable type to a valid manifest axis', () => {
    expect(NAMESPACE_AXIS.skills).toBe('skills');
    expect(NAMESPACE_AXIS.rules).toBe('knowledge');
    expect(NAMESPACE_AXIS.agents).toBe('agents');
    expect(NAMESPACE_AXIS.docs).toBe('docs');
    expect(NAMESPACE_AXIS.env).toBe('env');
    expect(NAMESPACE_AXIS.hooks).toBe('hooks');
    expect(NAMESPACE_AXIS.mcp).toBe('mcp');
    expect(NAMESPACE_AXIS.models).toBe('models');
    expect(NAMESPACE_AXIS.claudemd).toBe('knowledge');
    expect(NAMESPACE_AXIS.learnings).toBe('learnings');
    expect(NAMESPACE_AXIS.wiki).toBe('wiki');
    expect(NAMESPACE_AXIS.workflows).toBe('workflows');
    expect(NAMESPACE_AXIS.prompts).toBe('prompts');
    expect(NAMESPACE_AXIS.scorers).toBe('scorers');
  });
});

describe('isAtSharedRoot and withNamespace across all resource types', () => {
  it('detects shared root for items without namespace segments', () => {
    const sampleItems: Array<{ type: (typeof PLACEABLE_TYPES)[number]; path: string; shared: boolean }> = [
      { type: 'docs', path: 'docs/guide.md', shared: true },
      { type: 'docs', path: 'docs/team-a/guide.md', shared: true },
      { type: 'workflows', path: 'workflows/ci.yaml', shared: true },
      { type: 'workflows', path: 'workflows/team-a/ci.yaml', shared: false },
      { type: 'prompts', path: 'prompts/review.md', shared: true },
      // An undeclared prompts/ directory is shared content, like docs/ and
      // wiki/: a workflow resolves a nested prompt below the root when no
      // namespace holds it.
      { type: 'prompts', path: 'prompts/team-a/review.md', shared: true },
      { type: 'prompts', path: 'prompts/topic/note.md', shared: true },
      // A scorer is scorers/<name>.md (frontmatter plus a prompt), never .py:
      // review --branch fails any other file under scorers/ but README.md.
      { type: 'scorers', path: 'scorers/accuracy.md', shared: true },
      { type: 'scorers', path: 'scorers/team-a/accuracy.md', shared: false },
      { type: 'models', path: 'models/config.json', shared: true },
      { type: 'models', path: 'models/team-a/config.json', shared: false },
      { type: 'wiki', path: 'wiki/home.md', shared: true },
      { type: 'wiki', path: 'wiki/team-a/home.md', shared: true },
      { type: 'hooks', path: 'hooks/pre-commit.json', shared: true },
      { type: 'hooks', path: 'hooks/team-a/pre-commit.json', shared: false },
      { type: 'mcp', path: 'mcp/servers.json', shared: true },
      { type: 'mcp', path: 'mcp/team-a/servers.json', shared: false },
      { type: 'env', path: 'env/default.env', shared: true },
      { type: 'env', path: 'env/team-a/default.env', shared: false },
    ];

    for (const { type, path: relPath, shared } of sampleItems) {
      const item: ResourceItem = {
        name: path.basename(relPath),
        type,
        sourcePath: `/local/${relPath}`,
        relativePath: relPath,
      };
      expect(isAtSharedRoot(item)).toBe(shared);
    }

    expect(isAtSharedRoot({
      name: 'guide.md',
      type: 'docs',
      sourcePath: '/local/docs/team-a/guide.md',
      relativePath: 'docs/team-a/guide.md',
      namespace: 'team-a',
    })).toBe(false);

    const nestedDoc: ResourceItem = {
      name: 'guide.md',
      type: 'docs',
      sourcePath: '/local/docs/team-a/guides/guide.md',
      relativePath: 'docs/team-a/guides/guide.md',
    };
    expect(declaredNamespaceFor(nestedDoc, ['team-a'])).toBe('team-a');
    expect(declaredNamespaceFor(nestedDoc, ['other-team'])).toBeUndefined();

    // prompts follow the same rule: only a declared first segment is a namespace.
    const nestedPrompt: ResourceItem = {
      name: 'topic/note.md',
      type: 'prompts',
      sourcePath: '/local/prompts/topic/note.md',
      relativePath: 'prompts/topic/note.md',
    };
    expect(isAtSharedRoot(nestedPrompt)).toBe(true);
    expect(declaredNamespaceFor(nestedPrompt, ['ops'])).toBeUndefined();

    const namespacedPrompt: ResourceItem = {
      name: 'note.md',
      type: 'prompts',
      sourcePath: '/local/prompts/ops/note.md',
      relativePath: 'prompts/ops/note.md',
    };
    expect(declaredNamespaceFor(namespacedPrompt, ['ops'])).toBe('ops');
  });

  it('correctly inserts namespace segments for various resource formats', () => {
    expect(withNamespace('docs/readme.md', 'core')).toBe('docs/core/readme.md');
    expect(withNamespace('workflows/build.yaml', 'ci')).toBe('workflows/ci/build.yaml');
    expect(withNamespace('prompts/codegen.txt', 'ai')).toBe('prompts/ai/codegen.txt');
    expect(withNamespace('scorers/metric.md', 'eval')).toBe('scorers/eval/metric.md');
    expect(withNamespace('models/deepseek.json', 'llm')).toBe('models/llm/deepseek.json');
    expect(withNamespace('wiki/architecture.md', 'docs')).toBe('wiki/docs/architecture.md');
    expect(withNamespace('hooks/pre-push.sh', 'git')).toBe('hooks/git/pre-push.sh');
    expect(withNamespace('mcp/postgres.json', 'db')).toBe('mcp/db/postgres.json');
    expect(withNamespace('env/prod.env', 'infra')).toBe('env/infra/prod.env');
  });
});

describe('resolveProjectNamespace behavior across newly added axes', () => {
  const manifest: ProjectsManifest = {
    version: 1,
    projects: [
      {
        id: 'infra-project',
        name: 'Infrastructure',
        description: 'Infra project description',
        resources: {
          docs: ['infra-docs'],
          workflows: ['infra-wf'],
          prompts: ['infra-prompts'],
          scorers: ['infra-scorers'],
          env: ['infra-env'],
          hooks: ['infra-hooks'],
          mcp: ['infra-mcp'],
          models: ['infra-models'],
          knowledge: ['infra-know'],
          skills: ['infra-skills'],
          learnings: ['infra-learnings'],
          wiki: ['infra-wiki'],
          agents: ['infra-agents'],
        },
      },
      {
        id: 'empty-project',
        name: 'Empty',
        description: 'Empty project description',
        resources: {
          knowledge: [],
          skills: [],
          learnings: [],
          agents: [],
        },
      },
      {
        id: 'multi-docs-project',
        name: 'Multi Docs',
        description: 'Multi docs description',
        resources: {
          knowledge: [],
          skills: [],
          learnings: [],
          agents: [],
          docs: ['docs-a', 'docs-b'],
        },
      },
    ],
  };

  it('resolves namespace when single namespace declared on axis', () => {
    expect(resolveProjectNamespace(manifest, 'infra-project', 'docs')).toEqual({
      ok: true,
      namespace: 'infra-docs',
    });
    expect(resolveProjectNamespace(manifest, 'infra-project', 'workflows')).toEqual({
      ok: true,
      namespace: 'infra-wf',
    });
    expect(resolveProjectNamespace(manifest, 'infra-project', 'prompts')).toEqual({
      ok: true,
      namespace: 'infra-prompts',
    });
    expect(resolveProjectNamespace(manifest, 'infra-project', 'scorers')).toEqual({
      ok: true,
      namespace: 'infra-scorers',
    });
  });

  it('fails with clear error when axis has no namespaces declared', () => {
    const res = resolveProjectNamespace(manifest, 'empty-project', 'workflows');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain('workflows');
      expect(res.message).toContain('empty-project');
    }
  });

  it('fails with clear error when axis has multiple namespaces declared', () => {
    const res = resolveProjectNamespace(manifest, 'multi-docs-project', 'docs');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain('docs');
      expect(res.message).toContain('docs-a, docs-b');
      expect(res.message).toContain('--role');
    }
  });
});

describe('placedResourcePath lookup for rules and agents', () => {
  it('looks up destination correctly when recorded', () => {
    const ruleRecords = {
      'my-rule': 'rules/eng/my-rule.md',
    };
    const agentRecords = {
      'my-agent': 'agents/eng/my-agent.yaml',
    };
    expect(placedResourcePath(ruleRecords, 'rules', 'my-rule')).toBe('rules/eng/my-rule.md');
    expect(placedResourcePath(agentRecords, 'agents', 'my-agent')).toBe('agents/eng/my-agent.yaml');
  });

  it('rejects malicious or escaping destinations', () => {
    const records = {
      'my-rule': 'rules/../../etc/passwd',
      'other-rule': 'other/ci/my-rule.md',
    };
    expect(placedResourcePath(records, 'rules', 'my-rule')).toBeNull();
    expect(placedResourcePath(records, 'rules', 'other-rule')).toBeNull();
  });
});

describe('repo resource handler push and scan', () => {
  it('handlers are registered for all new distributed resource types in getHandler()', () => {
    const types = [
      'docs',
      'hooks',
      'mcp',
      'models',
      'claudemd',
      'learnings',
      'wiki',
      'workflows',
      'prompts',
      'scorers',
    ] as const;

    for (const t of types) {
      const handler = getHandler(t);
      expect(handler).toBeDefined();
      expect(typeof handler.scanLocalForPush).toBe('function');
      expect(typeof handler.pushItem).toBe('function');
    }
  });

  it('scanRepoResourceForPush and pushRepoResourceItem work with self-mode structure', async () => {
    const root = makeTmpDir();
    const projectRoot = path.join(root, 'project');
    const repoLocal = path.join(root, 'team-repo');

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(repoLocal, { recursive: true });

    const localConfig: LocalConfig = {
      repo: { localPath: repoLocal, remote: 'local', kind: 'self' },
      username: 'alice',
      scope: 'project',
      projectRoot,
      additionalRoles: [],
    };

    // Create a new workflow in project .teamai/workflows/ops/test.yaml
    const activeDir = path.join(projectRoot, '.teamai', 'workflows', 'ops');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'test.yaml'), 'name: test\n');

    const scanned = await scanRepoResourceForPush('workflows', 'workflows', {} as any, localConfig);
    expect(scanned.length).toBe(1);
    expect(scanned[0].name).toBe('ops/test.yaml');
    expect(scanned[0].relativePath).toBe('workflows/ops/test.yaml');
    expect(scanned[0].status).toBe('new');

    // Now push it
    await pushRepoResourceItem(scanned[0], localConfig);
    const destFile = path.join(repoLocal, 'workflows', 'ops', 'test.yaml');
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf8')).toBe('name: test\n');
  });
});

/**
 * Self mode: the author keeps editing the shared-root copy (`.teamai/docs/guide.md`)
 * after push placed it at `docs/ops/guide.md` and the PR merged. The record of
 * that landing says what was delivered, so the scan can tell the author's edit
 * from a teammate's later change to the placed file.
 */
describe('a placed copy the author still edits, against what its push delivered', () => {
  const run = (cwd: string, args: string[]): string => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();

  async function placedCopy(type: 'docs' | 'env', authorPath: string, placedPath: string) {
    const root = makeTmpDir();
    const projectRoot = path.join(root, 'project');
    const repoLocal = path.join(root, 'team-repo');
    const localConfig: LocalConfig = {
      repo: { localPath: repoLocal, remote: 'local', kind: 'self' },
      username: 'alice',
      scope: 'project',
      projectRoot,
      dataHome: path.join(root, 'data'),
      additionalRoles: [],
    };
    const activeFile = path.join(projectRoot, '.teamai', ...authorPath.split('/'));
    const placedFile = path.join(repoLocal, ...placedPath.split('/'));
    const commit = (file: string, content: string | null, message: string): void => {
      if (content === null) fs.rmSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      run(repoLocal, ['add', '-A']);
      run(repoLocal, ['commit', '-q', '-m', message]);
    };
    const scan = () => getHandler(type).scanLocalForPush({} as never, localConfig);
    /** Merge `items` as a push branch built on the current default branch, then reconcile as pull does. */
    const land = async (items: ResourceItem[]): Promise<void> => {
      const base = run(repoLocal, ['rev-parse', 'HEAD']);
      for (const item of items) await getHandler(type).pushItem(item, {} as never, localConfig);
      const pendingItems = await toPendingItems(items, repoLocal);
      run(repoLocal, ['add', '-A']);
      run(repoLocal, ['commit', '-q', '-m', 'merge the push']);
      const state = await loadStateForScope(localConfig);
      state.pendingPushes = [{ branch: 'teamai/push/alice/1', prUrl: null, createdAt: '2026-01-01T00:00:00.000Z', base, items: pendingItems }];
      await reconcilePlacementRecords(repoLocal, state);
      await saveStateForScope(state, localConfig);
    };

    fs.mkdirSync(repoLocal, { recursive: true });
    run(repoLocal, ['init', '-q', '-b', 'main']);
    commit(path.join(repoLocal, 'README.md'), 'team\n', 'seed');
    fs.mkdirSync(path.dirname(activeFile), { recursive: true });
    fs.writeFileSync(activeFile, 'v1\n');
    const [placed] = await scan();
    expect(placed).toMatchObject({ relativePath: authorPath, status: 'new' });
    // What placeNewResources does for --role ops.
    Object.assign(placed, { namespace: 'ops', prePlacementPath: authorPath, relativePath: placedPath });
    await land([placed]);
    expect(fs.readFileSync(placedFile, 'utf8')).toBe('v1\n');
    return { activeFile, placedFile, commit, scan, land, localConfig };
  }

  it('has nothing to push for an unchanged copy', async () => {
    const { scan } = await placedCopy('docs', 'docs/guide.md', 'docs/ops/guide.md');
    expect(await scan()).toEqual([]);
  });

  it('does not push an unchanged copy over a teammate\'s later fix of the placed file', async () => {
    const { placedFile, commit, scan } = await placedCopy('docs', 'docs/guide.md', 'docs/ops/guide.md');
    commit(placedFile, 'v2 (teammate fix)\n', 'teammate fixes the placed file');

    expect(await scan()).toEqual([]);
  });

  it('does not push an unchanged copy over a file someone re-created at the placed path', async () => {
    const { placedFile, commit, scan } = await placedCopy('docs', 'docs/guide.md', 'docs/ops/guide.md');
    commit(placedFile, null, 'team deletes the placed file');
    commit(placedFile, 'somebody else\'s guide\n', 'another member creates the path');

    expect(await scan()).toEqual([]);
  });

  it('sends an edit to the placed file', async () => {
    const { activeFile, scan } = await placedCopy('docs', 'docs/guide.md', 'docs/ops/guide.md');
    fs.writeFileSync(activeFile, 'v2\n');

    const edited = await scan();
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ relativePath: 'docs/ops/guide.md', namespace: 'ops', status: 'modified' });
  });

  it('has nothing to push once the edit it sent has landed', async () => {
    const { activeFile, scan, land } = await placedCopy('docs', 'docs/guide.md', 'docs/ops/guide.md');
    fs.writeFileSync(activeFile, 'v2\n');
    await land(await scan());

    expect(await scan()).toEqual([]);
  });

  it('stops on an edit when the placed file also changed since, naming the file to edit instead', async () => {
    const { activeFile, placedFile, commit, scan } = await placedCopy('docs', 'docs/guide.md', 'docs/ops/guide.md');
    commit(placedFile, 'v2 (teammate fix)\n', 'teammate fixes the placed file');
    fs.writeFileSync(activeFile, 'v1 plus my edit\n');

    await expect(scan()).rejects.toThrow(
      /docs\/ops\/guide\.md changed on the team repo.*Merge your edit into docs\/ops\/guide\.md, keeping the team's change there, then delete docs\/guide\.md/,
    );
  });

  it('treats a placed env file the same way', async () => {
    const { activeFile, placedFile, commit, scan } = await placedCopy('env', 'env/env.yaml', 'env/ops/env.yaml');
    expect(await scan()).toEqual([]);

    commit(placedFile, 'v2 (teammate fix)\n', 'teammate fixes the placed env file');
    expect(await scan()).toEqual([]);

    fs.writeFileSync(activeFile, 'v1 plus my edit\n');
    await expect(scan()).rejects.toThrow(/env\/ops\/env\.yaml/);
  });

  it('reads a record that holds only the path, as earlier builds wrote, as no record', async () => {
    const { scan, localConfig } = await placedCopy('docs', 'docs/guide.md', 'docs/ops/guide.md');
    const statePath = getStatePath(localConfig);
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    raw.placements = { 'docs:docs/guide.md': 'docs/ops/guide.md' };
    fs.writeFileSync(statePath, JSON.stringify(raw));

    // Without the delivered blob an unchanged copy cannot be told from an
    // edit, so it is new again and placement refuses the occupied path.
    expect(await scan()).toMatchObject([{ relativePath: 'docs/guide.md', status: 'new' }]);
  });

  it('compares a root-authored env file against the destination an earlier push placed it at', async () => {
    const root = makeTmpDir();
    const projectRoot = path.join(root, 'project');
    const repoLocal = path.join(root, 'team-repo');
    const localConfig: LocalConfig = {
      repo: { localPath: repoLocal, remote: 'local', kind: 'self' },
      username: 'alice',
      scope: 'project',
      projectRoot,
      dataHome: path.join(root, 'data'),
      additionalRoles: [],
    };

    const activeFile = path.join(projectRoot, '.teamai', 'env', 'env.yaml');
    fs.mkdirSync(path.dirname(activeFile), { recursive: true });
    fs.writeFileSync(activeFile, 'TEAM_TOKEN: one\n');
    const destFile = path.join(repoLocal, 'env', 'ops', 'env.yaml');
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, 'TEAM_TOKEN: one\n');
    const state = await loadStateForScope(localConfig);
    const blob = execFileSync('git', ['hash-object', '--', destFile], { encoding: 'utf8' }).trim();
    state.placements = { 'env:env/env.yaml': { path: 'env/ops/env.yaml', blob } };
    await saveStateForScope(state, localConfig);

    expect(await getHandler('env').scanLocalForPush({} as never, localConfig)).toEqual([]);

    fs.writeFileSync(activeFile, 'TEAM_TOKEN: two\n');
    const edited = await getHandler('env').scanLocalForPush({} as never, localConfig);
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({
      relativePath: 'env/ops/env.yaml',
      namespace: 'ops',
      status: 'modified',
    });
  });
});
