import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { legacyProjectSlug, projectDataHome, projectsRootDir } from '../utils/partition.js';
import { resolveEntriesFor } from '../namespaced-entries.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { mcpEntryReader } from '../resources/mcp.js';
import { mcpRelocated } from '../mcp-reconcile.js';
import { buildRolePullContext, deliveredSkillSources, resolveDesiredAgents, resolveDesiredRules, resolveDesiredSkills } from '../resources/desired.js';
import { readTeamSkillIndex, resolveDestination, withSkillFrontmatter } from '../resources/skills.js';
import { contentHash } from '../resources/delivered-copies.js';
import { deliveredLearningsNamespaces, findAncestorWorkspaces, formatProjectsManifestWarning, readWorkspaceChildren, safeDeliveredLearningsNamespaces, syncWorkspaceInstructionExcludes } from '../workspace-children.js';

const TEAM = 'https://git.example.com/team/team.git';
const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: TEAM, provider: 'git', reviewers: [] });

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: GIT_ENV });
}

function projectConfig(selection: Partial<LocalConfig> = {}, remote = TEAM): Record<string, unknown> {
  return {
    repo: { localPath: '/nonexistent/team-repo', remote },
    username: 'test',
    scope: 'project',
    ...selection,
  };
}

/** A repo set up with teamai: its config in the machine partition its path names. */
function repoChild(dir: string, selection: Partial<LocalConfig> = {}, remote = TEAM): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  const partition = projectDataHome(fs.realpathSync(dir));
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(path.join(partition, 'config.yaml'), YAML.stringify(projectConfig(selection, remote)));
}

/** A plain folder set up with teamai: its config in `<dir>/.teamai`. */
function folderChild(dir: string, selection: Partial<LocalConfig> = {}): void {
  fs.mkdirSync(path.join(dir, '.teamai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.teamai', 'config.yaml'), YAML.stringify(projectConfig(selection)));
}

let base: string;
let ws: string;
let workspace: LocalConfig;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ws-children-')));
  ws = path.join(base, 'ws');
  folderChild(ws);
  workspace = {
    ...(projectConfig() as LocalConfig),
    additionalRoles: [],
    projectRoot: ws,
    dataHome: path.join(ws, '.teamai'),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  resetWarnOnce();
  fs.rmSync(base, { recursive: true, force: true });
});

const childPaths = (config: LocalConfig): string[] => (config.children?.children ?? []).map((child) => child.path);

describe('readWorkspaceChildren', () => {
  it('reads the repos set up with teamai inside a plain-folder workspace', async () => {
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    fs.mkdirSync(path.join(ws, 'docs'));

    const read = await readWorkspaceChildren(workspace);

    expect(childPaths(read)).toEqual(['svc-a']);
    expect(read.children?.children[0]?.selection.projects).toEqual(['svc-a']);
  });

  it('walks plain folders three levels down and stops at any repo', async () => {
    repoChild(path.join(ws, 'backend', 'svc-b'));
    repoChild(path.join(ws, 'platform', 'infra', 'svc-c'));
    repoChild(path.join(ws, 'archive', '2024', 'old', 'svc-d'));
    repoChild(path.join(ws, 'svc-a'));
    repoChild(path.join(ws, 'svc-a', 'nested'));
    fs.mkdirSync(path.join(ws, 'tools'));
    git(path.join(ws, 'tools'), 'init', '-q');
    repoChild(path.join(ws, 'tools', 'inside'));

    expect(childPaths(await readWorkspaceChildren(workspace))).toEqual(['backend/svc-b', 'platform/infra/svc-c', 'svc-a']);
  });

  it('never enters a dot folder or node_modules', async () => {
    repoChild(path.join(ws, '.cache', 'svc-x'));
    repoChild(path.join(ws, 'node_modules', 'svc-y'));

    expect((await readWorkspaceChildren(workspace)).children).toBeUndefined();
  });

  it('counts a plain folder with its own config and walks on through it', async () => {
    folderChild(path.join(ws, 'backend'), { projects: ['backend'] });
    repoChild(path.join(ws, 'backend', 'svc-b'));

    expect(childPaths(await readWorkspaceChildren(workspace))).toEqual(['backend', 'backend/svc-b']);
  });

  it('in a workspace that is a git repo, counts only repos', async () => {
    const meta = path.join(base, 'meta');
    repoChild(meta);
    folderChild(path.join(meta, 'scripts'));
    repoChild(path.join(meta, 'svc-a'));
    const metaConfig: LocalConfig = { ...workspace, projectRoot: meta, dataHome: projectDataHome(fs.realpathSync(meta)) };

    expect(childPaths(await readWorkspaceChildren(metaConfig))).toEqual(['svc-a']);
  });

  it('leaves out a child of another team repo and names why', async () => {
    repoChild(path.join(ws, 'svc-a'));
    repoChild(path.join(ws, 'other'), {}, 'https://git.example.com/other/team.git');

    const read = await readWorkspaceChildren(workspace);

    expect(childPaths(read)).toEqual(['svc-a']);
    expect(read.children?.leftOut).toEqual([
      { path: 'other', reason: 'it uses another team repo (https://git.example.com/other/team.git)' },
    ]);
  });

  it('counts a child once per anchor and reads a worktree whose main checkout is outside', async () => {
    const svcA = path.join(ws, 'svc-a');
    repoChild(svcA, { projects: ['svc-a'] });
    git(svcA, 'commit', '--allow-empty', '-q', '-m', 'init');
    git(svcA, 'worktree', 'add', '-q', path.join(ws, 'svc-a-feature'));
    const outside = path.join(base, 'svc-c');
    repoChild(outside, { projects: ['svc-c'] });
    git(outside, 'commit', '--allow-empty', '-q', '-m', 'init');
    git(outside, 'worktree', 'add', '-q', path.join(ws, 'svc-c-wt'));

    const read = await readWorkspaceChildren(workspace);

    expect(childPaths(read)).toEqual(['svc-a', 'svc-c-wt']);
    expect(read.children?.children.map((child) => child.selection.projects)).toEqual([['svc-a'], ['svc-c']]);
  });

  it('reads the children of the main checkout from a linked worktree of the workspace', async () => {
    const meta = path.join(base, 'meta');
    repoChild(meta, { projects: ['platform'] });
    git(meta, 'commit', '--allow-empty', '-q', '-m', 'init');
    repoChild(path.join(meta, 'svc-a'));
    const worktree = path.join(base, 'meta-feature');
    git(meta, 'worktree', 'add', '-q', worktree);
    const dataHome = projectDataHome(fs.realpathSync(meta));

    expect(childPaths(await readWorkspaceChildren({ ...workspace, projectRoot: worktree, dataHome }))).toEqual(['svc-a']);
  });

  it('keeps the workspace hooks out of a child in the linked worktree it runs from, not only in the main checkout', async () => {
    const meta = path.join(base, 'meta');
    repoChild(meta, { projects: ['platform'] });
    git(meta, 'commit', '--allow-empty', '-q', '-m', 'init');
    repoChild(path.join(meta, 'svc-a'));
    const worktree = path.join(base, 'meta-feature');
    git(meta, 'worktree', 'add', '-q', worktree);
    const dataHome = projectDataHome(fs.realpathSync(meta));

    const read = await readWorkspaceChildren({ ...workspace, projectRoot: worktree, dataHome });

    expect(read.children?.roots).toEqual([path.join(meta, 'svc-a'), path.join(worktree, 'svc-a')]);
  });

  it('reads a child whose partition still has its legacy name, without renaming it', async () => {
    const svcA = path.join(ws, 'svc-a');
    repoChild(svcA, { projects: ['svc-a'] });
    const anchor = fs.realpathSync(svcA);
    const legacy = path.join(projectsRootDir(), legacyProjectSlug(anchor));
    fs.renameSync(projectDataHome(anchor), legacy);

    const read = await readWorkspaceChildren(workspace);

    expect(childPaths(read)).toEqual(['svc-a']);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(projectDataHome(anchor))).toBe(false);
  });

  it('returns the config untouched when nothing under it is set up', async () => {
    fs.mkdirSync(path.join(ws, 'docs'));
    repoChild(path.join(base, 'elsewhere'));

    expect(await readWorkspaceChildren(workspace)).toBe(workspace);
  });

  it('changes its fingerprint when a child changes its selection', async () => {
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    const before = (await readWorkspaceChildren(workspace)).children?.fingerprint;
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a', 'payments'] });
    const after = (await readWorkspaceChildren(workspace)).children?.fingerprint;

    expect(before).toBeDefined();
    expect(after).not.toBe(before);
  });
});

/** A team repo with three projects that each list their own namespaces, plus a shared `payments` group. */
function teamRepo(): string {
  const repo = path.join(base, 'team');
  fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 't', repo: TEAM, provider: 'git', reviewers: [] }));
  const project = (id: string, extra: string[] = []): Record<string, unknown> => ({
    id,
    resources: { skills: [id, ...extra], knowledge: [id], learnings: [id], docs: [id, ...extra] },
  });
  fs.writeFileSync(path.join(repo, 'manifest', 'projects.yaml'), YAML.stringify({
    version: 1,
    projects: [project('svc-a', ['payments']), project('svc-b', ['payments']), project('platform')],
  }));
  return repo;
}

function skill(repo: string, namespace: string | null, name: string, body = `# ${name}\n`): void {
  const dir = path.join(repo, 'skills', ...(namespace ? [namespace] : []), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n${body}`);
}

describe('delivered selection of a workspace with children', () => {
  let repo: string;

  beforeEach(() => {
    repo = teamRepo();
    workspace = { ...workspace, repo: { ...workspace.repo, localPath: repo } };
  });

  it('activates the namespaces of its own selection and of every child', async () => {
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });

    const resolved = await resolveResourceNamespaces(await readWorkspaceChildren({ ...workspace, projects: ['platform'] }));

    expect(resolved?.activeNamespaces.skills).toEqual(['platform', 'svc-a', 'payments', 'svc-b']);
    expect(resolved?.inactiveDocsNamespaces).toEqual([]);
  });

  it('leaves out only the unknown project of a child, and names it', async () => {
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a', 'gone'] });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const resolved = await resolveResourceNamespaces(await readWorkspaceChildren(workspace));

    expect(resolved?.activeNamespaces.skills).toEqual(['svc-a', 'payments']);
    expect(warn.mock.calls.flat().join('\n')).toContain('Workspace child svc-a selects project "gone"');
  });

  it('reads the learnings of its own projects and of every child, an unknown project of one child aside', async () => {
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b', 'gone'] });
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const namespaces = await deliveredLearningsNamespaces(await readWorkspaceChildren({ ...workspace, projects: ['platform'] }));

    expect(namespaces).toEqual(['platform', 'svc-a', 'svc-b']);
  });

  it('safeDeliveredLearningsNamespaces logs a warning and falls back to empty array when resolution fails', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // Write an invalid manifest that throws on parse
    fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'manifest', 'projects.yaml'), 'invalid: [yaml: unclosed');

    const result = await safeDeliveredLearningsNamespaces({ ...workspace, projects: ['infra'] }, 'digest');
    expect(result).toEqual([]);
    expect(warn.mock.calls.flat().join('\n')).toContain('digest read the shared learnings only:');
    expect(warn.mock.calls.flat().join('\n')).toContain('stay out of digest until manifest/projects.yaml is fixed');
  });

  it('formatProjectsManifestWarning produces matching warnings for recall and maintenance', () => {
    const config = { ...workspace, projects: ['infra'] };
    const err = new Error('invalid YAML');

    const digestWarn = formatProjectsManifestWarning('digest', err, config);
    expect(digestWarn).toBe(
      'digest read the shared learnings only: invalid YAML. ' +
      'The learnings of project infra stay out of digest until manifest/projects.yaml is fixed; `teamai doctor` shows the problem.'
    );

    const recallWarn = formatProjectsManifestWarning('Recall', err, config, {
      verb: 'indexed',
      extraHeldBack: 'docs, rules and skills',
      targetName: 'recall',
      rebuildAction: '`teamai pull` rebuilds the index',
    });
    expect(recallWarn).toBe(
      'Recall indexed the shared learnings only: invalid YAML. ' +
      'The learnings of project infra, and docs, rules and skills, stay out of recall until manifest/projects.yaml is fixed and `teamai pull` rebuilds the index; `teamai doctor` shows the problem.'
    );

    const emptyProjectsWarn = formatProjectsManifestWarning('digest', err, { ...workspace, projects: [] });
    expect(emptyProjectsWarn).toBe('digest read the shared learnings only: invalid YAML.');
  });

  it("delivers each child's skills after that child's exclusions and tags, and its own exclusions on top", async () => {
    skill(repo, 'svc-a', 'a-tool');
    skill(repo, 'svc-a', 'a-excluded');
    skill(repo, 'svc-b', 'b-tool');
    skill(repo, 'svc-b', 'b-mine-excluded');
    skill(repo, null, 'tagged');
    fs.writeFileSync(path.join(repo, 'tags.yaml'), YAML.stringify({ skills: { tagged: ['infra'] } }));
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'], excludedSkills: ['a-excluded'], subscribedTags: ['infra'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });
    const delivered = await readWorkspaceChildren({ ...workspace, excludedSkills: ['b-mine-excluded'] });

    const desired = await resolveDesiredSkills(teamConfig, delivered, await buildRolePullContext(delivered));

    expect(desired.kind === 'resolved' && desired.items.map((item) => item.name).sort()).toEqual(['a-tool', 'b-tool', 'tagged']);
  });

  it('delivers one skill two children share once, and holds back only a name whose copies differ', async () => {
    skill(repo, 'svc-a', 'same');
    skill(repo, 'svc-b', 'same');
    skill(repo, 'svc-a', 'differs', 'version a\n');
    skill(repo, 'svc-b', 'differs', 'version b\n');
    skill(repo, 'svc-b', 'b-tool');
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const delivered = await readWorkspaceChildren(workspace);

    const desired = await resolveDesiredSkills(teamConfig, delivered, await buildRolePullContext(delivered));

    expect(desired.kind).toBe('resolved');
    if (desired.kind !== 'resolved') return;
    expect(desired.items.map((item) => item.relativePath).sort()).toEqual(['skills/svc-a/same', 'skills/svc-b/b-tool']);
    expect(desired.held).toEqual(['differs']);
    expect(warn.mock.calls.flat().join('\n')).toContain('Skill "differs" differs between skills/svc-a/differs and skills/svc-b/differs');
  });

  it('does not hold back a name the workspace excludes, so pull can take its copy out', async () => {
    skill(repo, 'svc-a', 'differs', 'version a\n');
    skill(repo, 'svc-b', 'differs', 'version b\n');
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const delivered = await readWorkspaceChildren({ ...workspace, excludedSkills: ['differs'] });

    const desired = await resolveDesiredSkills(teamConfig, delivered, await buildRolePullContext(delivered));

    expect(desired.kind === 'resolved' && desired.held).toEqual([]);
  });

  it('does not say it keeps a copy of a held skill the workspace excludes', async () => {
    skill(repo, 'svc-a', 'differs', 'version a\n');
    skill(repo, 'svc-b', 'differs', 'version b\n');
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const delivered = await readWorkspaceChildren({ ...workspace, excludedSkills: ['differs'] });

    await resolveDesiredSkills(teamConfig, delivered, await buildRolePullContext(delivered));

    expect(warn.mock.calls.flat().join('\n')).not.toContain('Skill "differs" differs');
  });

  it('names every child source of a skill it excludes, and none for a scope without children', async () => {
    skill(repo, 'svc-a', 'differs', 'version a\n');
    skill(repo, 'svc-b', 'differs', 'version b\n');
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const alone = await readWorkspaceChildren(workspace);
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });
    const delivered = await readWorkspaceChildren({ ...workspace, excludedSkills: ['differs'] });

    const withChildren = await resolveDesiredSkills(teamConfig, delivered, await buildRolePullContext(delivered));
    const withoutChildren = await resolveDesiredSkills(teamConfig, alone, await buildRolePullContext(alone));

    expect(withChildren.kind === 'resolved' && [...withChildren.memberSources.get('differs') ?? []].sort())
      .toEqual([path.join(repo, 'skills', 'svc-a', 'differs'), path.join(repo, 'skills', 'svc-b', 'differs')]);
    expect(withoutChildren.kind === 'resolved' && withoutChildren.memberSources.size).toBe(0);
  });

  it('delivers the rules of every member, keeping a root rule another member still receives', async () => {
    const rule = (relative: string): void => {
      fs.mkdirSync(path.dirname(path.join(repo, 'rules', relative)), { recursive: true });
      fs.writeFileSync(path.join(repo, 'rules', relative), `# ${relative}\n`);
    };
    rule('style.md');
    rule('svc-a/style.md');
    rule('svc-b/api.md');
    rule('platform/ops.md');
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });
    const delivered = await readWorkspaceChildren(workspace);

    const desired = await resolveDesiredRules(teamConfig, delivered, await buildRolePullContext(delivered));

    expect(desired.items.map((item) => item.relativePath).sort()).toEqual(['rules/style.md', 'rules/svc-a/style.md', 'rules/svc-b/api.md']);
    expect(desired.replaced).toEqual([]);
  });

  it('delivers agents two members share once, and holds back only a stem whose copies differ', async () => {
    const agent = (namespace: string, stem: string, description: string): void => {
      fs.mkdirSync(path.join(repo, 'agents', namespace), { recursive: true });
      fs.writeFileSync(path.join(repo, 'agents', namespace, `${stem}.yaml`), YAML.stringify({ name: stem, description, prompt: 'p' }));
    };
    const manifest = YAML.parse(fs.readFileSync(path.join(repo, 'manifest', 'projects.yaml'), 'utf8'));
    for (const project of manifest.projects) project.resources.agents = [project.id];
    fs.writeFileSync(path.join(repo, 'manifest', 'projects.yaml'), YAML.stringify(manifest));
    agent('svc-a', 'reviewer', 'same');
    agent('svc-b', 'reviewer', 'same');
    agent('svc-a', 'planner', 'a');
    agent('svc-b', 'planner', 'b');
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const delivered = await readWorkspaceChildren(workspace);

    const desired = await resolveDesiredAgents(teamConfig, delivered, await buildRolePullContext(delivered));

    expect(desired.kind === 'resolved' && desired.items.map((item) => item.relativePath)).toEqual(['agents/svc-a/reviewer.yaml']);
  });

  it('delivers an MCP server once, holds back one whose definitions differ, and keeps one some child that delivers it does not exclude', async () => {
    const manifest = YAML.parse(fs.readFileSync(path.join(repo, 'manifest', 'projects.yaml'), 'utf8'));
    for (const project of manifest.projects) project.resources.mcp = [project.id];
    fs.writeFileSync(path.join(repo, 'manifest', 'projects.yaml'), YAML.stringify(manifest));
    const servers = (namespace: string, lines: string[]): void => {
      fs.mkdirSync(path.join(repo, 'mcp', namespace), { recursive: true });
      fs.writeFileSync(path.join(repo, 'mcp', namespace, 'mcp.yaml'), ['servers:', ...lines, ''].join('\n'));
    };
    servers('svc-a', [
      '  - { name: db, transport: http, url: https://db.example.com }',
      '  - { name: cache, transport: http, url: https://cache-a.example.com }',
      '  - { name: a-only, transport: http, url: https://a.example.com }',
      '  - { name: shared, transport: http, url: https://shared.example.com }',
    ]);
    servers('svc-b', [
      '  - { name: db, transport: http, url: https://db.example.com }',
      '  - { name: cache, transport: http, url: https://cache-b.example.com }',
      '  - { name: shared, transport: http, url: https://shared.example.com }',
    ]);
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'], excludedSkills: ['a-only', 'shared'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });

    const resolution = await resolveEntriesFor(mcpEntryReader, await readWorkspaceChildren(workspace));

    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(resolution.entries.map((entry) => `${entry.name} ${entry.source}`)).toEqual([
      'db mcp/svc-a/mcp.yaml',
      'shared mcp/svc-b/mcp.yaml',
    ]);
    expect(resolution.held).toEqual(['cache']);
    expect(resolution.notices.map((notice) => notice.message).join('\n'))
      .toContain('server "cache" differs between mcp/svc-a/mcp.yaml and mcp/svc-b/mcp.yaml');
  });

  it('neither holds back nor names an MCP server the workspace excludes', async () => {
    const manifest = YAML.parse(fs.readFileSync(path.join(repo, 'manifest', 'projects.yaml'), 'utf8'));
    for (const project of manifest.projects) project.resources.mcp = [project.id];
    fs.writeFileSync(path.join(repo, 'manifest', 'projects.yaml'), YAML.stringify(manifest));
    for (const [namespace, url] of [['svc-a', 'https://cache-a.example.com'], ['svc-b', 'https://cache-b.example.com']]) {
      fs.mkdirSync(path.join(repo, 'mcp', namespace), { recursive: true });
      fs.writeFileSync(path.join(repo, 'mcp', namespace, 'mcp.yaml'), `servers:\n  - { name: cache, transport: http, url: ${url} }\n`);
    }
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });

    const resolution = await resolveEntriesFor(mcpEntryReader, await readWorkspaceChildren({ ...workspace, excludedSkills: ['cache'] }));

    expect(resolution.kind === 'resolved' && resolution.notices.map((notice) => notice.message).join('\n'))
      .not.toContain('server "cache" differs');
    expect(resolution.kind === 'resolved' && resolution.held).toEqual([]);
  });
});

describe('pushing an edit of a copy several children delivered', () => {
  it('goes only to the team skills its members deliver, not to an equal root skill', async () => {
    const repo = teamRepo();
    const text = '---\nname: same\ndescription: fixture\n---\nThe same skill.\n';
    for (const namespace of ['', 'svc-a', 'svc-b']) {
      fs.mkdirSync(path.join(repo, 'skills', namespace, 'same'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'skills', namespace, 'same', 'SKILL.md'), text);
    }
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'seed');
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
    repoChild(path.join(ws, 'svc-b'), { projects: ['svc-b'] });
    const delivered = await readWorkspaceChildren({ ...workspace, repo: { ...workspace.repo, localPath: repo } });
    const dest = path.join(ws, '.claude', 'skills', 'same');

    const destination = await resolveDestination({
      name: 'same', dest, team: await readTeamSkillIndex(repo, ['svc-a', 'svc-b']), pending: [], repoPath: repo,
      delivered: { [path.join(dest, 'SKILL.md')]: contentHash(withSkillFrontmatter(text, 'same')) },
      deliveredSources: (await deliveredSkillSources(teamConfig, delivered)) ?? undefined,
    });

    expect(destination.kind === 'shared' && destination.teamSkills.map((copy) => copy.namespace)).toEqual(['svc-a', 'svc-b']);
  });
});

describe('a command in a workspace with children', () => {
  beforeEach(() => {
    const repo = teamRepo();
    fs.writeFileSync(path.join(ws, '.teamai', 'config.yaml'), YAML.stringify({ ...projectConfig(), repo: { localPath: repo, remote: TEAM } }));
    repoChild(path.join(ws, 'svc-a'), { projects: ['svc-a'] });
  });

  it('gets the workspace with its children from the config it detects', async () => {
    const { autoDetectInit } = await import('../config.js');

    const { localConfig } = await autoDetectInit(ws, { dryRun: true });

    expect(childPaths(localConfig)).toEqual(['svc-a']);
  });

  it('but the share gate a Stop hook asks does not walk the workspace', async () => {
    const { detectTeam } = await import('../skill-content.js');

    const team = await detectTeam(ws);

    expect(team.kind === 'team' && team.init.localConfig.children).toBeUndefined();
  });
});

describe('MCP servers in a workspace with children', () => {
  it('go to the local scope of Claude and CodeBuddy, so a session in a child does not load them', async () => {
    repoChild(path.join(ws, 'svc-a'));
    fs.mkdirSync(path.join(ws, '.claude'));
    const team = TeamaiConfigSchema.parse({ team: 't', repo: TEAM, provider: 'git' });
    const withChildren = await readWorkspaceChildren({ ...workspace, enabledAgents: undefined });

    expect(await mcpRelocated(team, withChildren, 'claude')).toBe(true);
    expect(await mcpRelocated(team, withChildren, 'codebuddy')).toBe(true);
    expect(await mcpRelocated(team, workspace, 'claude')).toBe(false);
  });
});

describe('findAncestorWorkspaces', () => {
  it('finds every set-up folder above a child that a workspace walk would pass through', async () => {
    folderChild(path.join(ws, 'backend'));
    repoChild(path.join(ws, 'backend', 'svc-b'));
    repoChild(path.join(ws, 'svc-a'));
    repoChild(path.join(ws, 'archive', '2024', 'old', 'svc-d'));
    fs.mkdirSync(path.join(ws, '.idea', 'x'), { recursive: true });

    expect(await findAncestorWorkspaces(path.join(ws, 'svc-a'))).toEqual([ws]);
    expect(await findAncestorWorkspaces(path.join(ws, 'backend', 'svc-b'))).toEqual([path.join(ws, 'backend'), ws]);
    expect(await findAncestorWorkspaces(path.join(ws, 'archive', '2024', 'old', 'svc-d'))).toEqual([]);
    expect(await findAncestorWorkspaces(path.join(ws, '.idea'))).toEqual([]);
  });

  it('finds a workspace that is a git repo, and stops above any repo', async () => {
    const meta = path.join(base, 'meta');
    repoChild(meta);
    repoChild(path.join(meta, 'svc-a'));
    repoChild(path.join(meta, 'svc-a', 'vendor', 'lib'));

    expect(await findAncestorWorkspaces(path.join(meta, 'svc-a'))).toEqual([meta]);
    expect(await findAncestorWorkspaces(path.join(meta, 'svc-a', 'vendor', 'lib'))).toEqual([path.join(meta, 'svc-a')]);
  });

  it('finds the workspace of a linked worktree kept inside its main checkout', async () => {
    const svcA = path.join(ws, 'svc-a');
    repoChild(svcA);
    git(svcA, 'commit', '--allow-empty', '-q', '-m', 'init');
    git(svcA, 'worktree', 'add', '-q', path.join(svcA, 'wt-feature'));

    expect(await findAncestorWorkspaces(path.join(svcA, 'wt-feature'))).toEqual([ws]);
  });

  it('finds a workspace that is a linked worktree or a submodule, whose config is in its anchor\'s partition', async () => {
    const meta = path.join(base, 'meta');
    repoChild(meta);
    git(meta, 'commit', '--allow-empty', '-q', '-m', 'init');
    const metaWt = path.join(base, 'meta-wt');
    git(meta, 'worktree', 'add', '-q', metaWt);
    repoChild(path.join(metaWt, 'svc-a'));

    const sub = path.join(base, 'super', 'sub');
    const subGitDir = path.join(base, 'super', '.git', 'modules', 'sub');
    fs.mkdirSync(subGitDir, { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    const subPartition = projectDataHome(fs.realpathSync(subGitDir));
    fs.mkdirSync(subPartition, { recursive: true });
    fs.writeFileSync(path.join(subPartition, 'config.yaml'), YAML.stringify(projectConfig()));
    repoChild(path.join(sub, 'svc-b'));

    expect(await findAncestorWorkspaces(path.join(metaWt, 'svc-a'))).toEqual([metaWt]);
    expect(await findAncestorWorkspaces(path.join(sub, 'svc-b'))).toEqual([sub]);
  });

  it('finds a git workspace whose config is still in the checkout\'s .teamai, as detection reads it', async () => {
    const legacy = path.join(base, 'legacy');
    fs.mkdirSync(legacy);
    git(legacy, 'init', '-q');
    folderChild(legacy);
    repoChild(path.join(legacy, 'svc-a'));

    expect(await findAncestorWorkspaces(path.join(legacy, 'svc-a'))).toEqual([legacy]);
  });
});

describe('syncWorkspaceInstructionExcludes', () => {
  it('excludes the workspace instructions in a child, keeps the member\'s own excludes, and takes its own back', async () => {
    const child = path.join(ws, 'svc-a');
    repoChild(child);
    const settings = path.join(child, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings));
    fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, claudeMdExcludes: ['/elsewhere/CLAUDE.md'] }));

    const written = await syncWorkspaceInstructionExcludes({ projectRoot: child, settingsFile: settings, previous: [] });

    const ours = [`${ws}/CLAUDE.md`, `${ws}/.claude/CLAUDE.md`, `${ws}/AGENTS.md`, `${ws}/.claude/rules/**`];
    expect(written).toEqual(ours);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      claudeMdExcludes: ['/elsewhere/CLAUDE.md', ...ours],
    });

    fs.rmSync(path.join(ws, '.teamai'), { recursive: true });
    expect(await syncWorkspaceInstructionExcludes({ projectRoot: child, settingsFile: settings, previous: written })).toEqual([]);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).claudeMdExcludes).toEqual(['/elsewhere/CLAUDE.md']);
  });

  it('takes back every entry it owns when withdrawing, and keeps owning them when the file is not JSON', async () => {
    const child = path.join(ws, 'svc-a');
    repoChild(child);
    const settings = path.join(child, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings));
    const owned = [`${ws}/CLAUDE.md`, `${ws}/AGENTS.md`];
    fs.writeFileSync(settings, JSON.stringify({ claudeMdExcludes: ['/elsewhere/CLAUDE.md', ...owned] }));

    expect(await syncWorkspaceInstructionExcludes({ projectRoot: child, settingsFile: settings, previous: owned, withdraw: true })).toEqual([]);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).claudeMdExcludes).toEqual(['/elsewhere/CLAUDE.md']);

    fs.writeFileSync(settings, '{ not json');
    expect(await syncWorkspaceInstructionExcludes({ projectRoot: child, settingsFile: settings, previous: owned, withdraw: true })).toEqual(owned);
  });

  it('does not take ownership of an exclude the member already had, so withdrawing keeps it', async () => {
    const child = path.join(ws, 'svc-a');
    repoChild(child);
    const settings = path.join(child, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings));
    fs.writeFileSync(settings, JSON.stringify({ claudeMdExcludes: [`${ws}/CLAUDE.md`] }));

    const owned = await syncWorkspaceInstructionExcludes({ projectRoot: child, settingsFile: settings, previous: [] });

    expect(owned).toEqual([`${ws}/.claude/CLAUDE.md`, `${ws}/AGENTS.md`, `${ws}/.claude/rules/**`]);
    expect(await syncWorkspaceInstructionExcludes({ projectRoot: child, settingsFile: settings, previous: owned })).toEqual(owned);
    await syncWorkspaceInstructionExcludes({ projectRoot: child, settingsFile: settings, previous: owned, withdraw: true });
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).claudeMdExcludes).toEqual([`${ws}/CLAUDE.md`]);
  });

  it('writes nothing in a repo that is not inside a workspace', async () => {
    const lone = path.join(base, 'lone');
    repoChild(lone);
    const settings = path.join(lone, '.claude', 'settings.local.json');

    expect(await syncWorkspaceInstructionExcludes({ projectRoot: lone, settingsFile: settings, previous: [] })).toEqual([]);
    expect(fs.existsSync(settings)).toBe(false);
  });
});
