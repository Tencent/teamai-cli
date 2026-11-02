/**
 * A workflow copy that runs with a team role (`stepRole`) knows what that role knows, and executes what the member may
 * execute: its skills, rules, agents, docs, wiki and learnings come from the role and the member's projects, while its
 * hooks, MCP, env and models, and the workflows, prompts, scorers and benchmarks it can find, stay the member's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveActiveLearningsNamespaces } from '../projects.js';
import { buildRolePullContext, resolveDesiredRules } from '../resources/desired.js';
import { resolveEntriesFor, type EntryReader } from '../namespaced-entries.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { envEntryReader } from '../resources/env.js';
import { mcpEntryReader } from '../resources/mcp.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { loadCachedWorkflow, syncWorkflowDefinitions } from '../workflow/cache.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROLES = `version: 1
roles:
  - id: frontend
    resources: { knowledge: [frontend], skills: [frontend], agents: [frontend], docs: [fe-docs], learnings: [fe-notes], hooks: [frontend], mcp: [frontend], env: [frontend], models: [frontend], workflows: [frontend] }
  - id: review
    resources: { knowledge: [review], skills: [review], agents: [review], docs: [rv-docs], learnings: [rv-notes], hooks: [rv-hook], mcp: [rv-mcp], env: [rv-env], models: [rv-models], workflows: [rv-flows] }
`;
const PROJECTS = `version: 1
projects:
  - id: app
    name: App
    resources: { knowledge: [], skills: [app] }
`;

function teamRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-role-ns-'));
  dirs.push(repo);
  fs.mkdirSync(path.join(repo, 'manifest'));
  fs.writeFileSync(path.join(repo, 'manifest', 'roles.yaml'), ROLES);
  fs.writeFileSync(path.join(repo, 'manifest', 'projects.yaml'), PROJECTS);
  return repo;
}

function memberOf(repo: string, overrides: Partial<LocalConfig>): LocalConfig {
  return { repo: { localPath: repo, remote: 'https://github.com/acme/team.git' }, username: 'member', scope: 'project', primaryRole: 'frontend', additionalRoles: [], projects: ['app'], ...overrides };
}

describe('the namespaces of a copy that runs with a team role', () => {
  it("takes knowledge from the copy's role and the member's projects, and channels and discovery from the member", async () => {
    const resolved = await resolveResourceNamespaces(memberOf(teamRepo(), { stepRole: 'review' }));

    expect(resolved?.activeNamespaces).toMatchObject({
      knowledge: ['review'], skills: ['review', 'app'], agents: ['review'], docs: ['rv-docs'], learnings: ['rv-notes'],
      hooks: ['frontend'], mcp: ['frontend'], env: ['frontend'], models: ['frontend'], workflows: ['frontend'],
    });
  });

  it('finds every namespace of the discovery of a member with nothing to filter by, as that member does', async () => {
    const repo = teamRepo();
    fs.rmSync(path.join(repo, 'manifest', 'projects.yaml'));
    // On disk, each type has the two roles' namespaces and one that no role declares.
    for (const type of ['workflows', 'prompts', 'scorers']) {
      for (const namespace of ['frontend', 'rv-flows', 'shared-tools']) fs.mkdirSync(path.join(repo, type, namespace), { recursive: true });
    }
    const member = memberOf(repo, { primaryRole: undefined, projects: [] });
    expect(await resolveResourceNamespaces(member)).toBeNull();

    const resolved = await resolveResourceNamespaces({ ...member, stepRole: 'review' });

    const every = ['frontend', 'rv-flows', 'shared-tools'];
    expect(resolved?.activeNamespaces).toMatchObject({
      knowledge: ['review'], skills: ['review'], agents: ['review'], docs: ['rv-docs'], learnings: ['rv-notes'],
      workflows: every, prompts: every, scorers: every,
    });
    expect(resolved?.inactivePromptsNamespaces).toEqual([]);
    expect(resolved?.inactiveScorersNamespaces).toEqual([]);
  });

  it("gives such a member's copy the env and MCP servers that member gets, the shared ones only", async () => {
    const repo = teamRepo();
    fs.rmSync(path.join(repo, 'manifest', 'projects.yaml'));
    fs.mkdirSync(path.join(repo, 'env', 'rv-env'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'env', 'env.yaml'), 'variables: [{ key: SHARED, value: shared }]\n');
    fs.writeFileSync(path.join(repo, 'env', 'rv-env', 'env.yaml'), 'variables: [{ key: ONLY_REVIEW, value: review }]\n');
    fs.mkdirSync(path.join(repo, 'mcp', 'rv-mcp'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'mcp', 'mcp.yaml'), 'servers: [{ name: shared, description: Shared, transport: stdio, command: shared }]\n');
    fs.writeFileSync(path.join(repo, 'mcp', 'rv-mcp', 'mcp.yaml'), 'servers: [{ name: review-only, description: Review only, transport: stdio, command: review-only }]\n');
    const member = memberOf(repo, { primaryRole: undefined, projects: [] });
    const names = async <E>(reader: EntryReader<E>, config: LocalConfig): Promise<string[]> => {
      const resolution = await resolveEntriesFor(reader, config);
      return resolution.kind === 'resolved' ? resolution.entries.map((entry) => entry.name) : [`not resolved: ${resolution.kind}`];
    };

    for (const reader of [envEntryReader, mcpEntryReader] as const) {
      const delivered = await names<unknown>(reader, member);
      expect(delivered).toEqual(reader === envEntryReader ? ['SHARED'] : ['shared']);
      expect(await names<unknown>(reader, { ...member, stepRole: 'review' })).toEqual(delivered);
    }
  });

  it("leaves the workflows such a member finds as they were when a copy of theirs pulls with a role", async () => {
    const repo = teamRepo();
    fs.rmSync(path.join(repo, 'manifest', 'projects.yaml'));
    for (const namespace of ['frontend', 'rv-flows']) {
      fs.mkdirSync(path.join(repo, 'workflows', namespace), { recursive: true });
      fs.writeFileSync(path.join(repo, 'workflows', namespace, `${namespace}.yaml`), `schemaVersion: v1alpha1\nname: ${namespace}\ndescription: Run ${namespace}.\nsteps:\n  - id: check\n    command: echo okay\n`);
    }
    // Not self mode: the workflow cache is the data home's, shared by every checkout of this member.
    const member = memberOf(repo, { primaryRole: undefined, projects: [], projectRoot: repo, dataHome: path.join(repo, '.data') });
    expect((await syncWorkflowDefinitions(member)).cached.toSorted()).toEqual(['frontend', 'rv-flows']);

    const inCopy = await syncWorkflowDefinitions({ ...member, projectRoot: path.join(repo, 'copy'), stepRole: 'review' });

    expect(inCopy.cached.toSorted()).toEqual(['frontend', 'rv-flows']);
    expect((await loadCachedWorkflow(member, 'frontend'))?.source).toBe('team');
  });

  it('refuses a role the manifest does not declare rather than deliver the member\'s knowledge or everything', async () => {
    await expect(resolveResourceNamespaces(memberOf(teamRepo(), { primaryRole: undefined, projects: [], stepRole: 'auditor' })))
      .rejects.toThrow('This workflow copy runs with role "auditor", which manifest/roles.yaml does not declare (it declares frontend, review), so nothing is delivered for it. Add the role to manifest/roles.yaml, or run the step with a role it declares.');
  });

  it("indexes and contributes the copy's learnings in the role's namespace, with the member's projects", async () => {
    const namespaces = await resolveActiveLearningsNamespaces(memberOf(teamRepo(), { stepRole: 'review' }));

    expect(namespaces).toEqual(['rv-notes']);
  });

  it("refuses the learnings of a role the manifest does not declare rather than give the copy the shared ones", async () => {
    await expect(resolveActiveLearningsNamespaces(memberOf(teamRepo(), { stepRole: 'auditor' })))
      .rejects.toThrow('This workflow copy runs with role "auditor", which manifest/roles.yaml does not declare (it declares frontend, review), so nothing is delivered for it. Add the role to manifest/roles.yaml, or run the step with a role it declares.');
  });
});

describe('the rules a copy that runs with a team role gets', () => {
  it("takes the role's rules and a rule tagged outside the member's subscription, which only the member's checkout leaves out", async () => {
    const repo = teamRepo();
    for (const [file, text] of [['review/review.md', 'Read every changed line.\n'], ['frontend/frontend.md', 'Use the design system.\n'], ['server-only.md', 'Log every request.\n']]) {
      fs.mkdirSync(path.dirname(path.join(repo, 'rules', file)), { recursive: true });
      fs.writeFileSync(path.join(repo, 'rules', file), text);
    }
    fs.writeFileSync(path.join(repo, 'tags.yaml'), 'rules:\n  server-only: [server]\n');
    const team: TeamaiConfig = {
      team: 'acme', description: '', repo: 'https://github.com/acme/team.git', provider: 'github', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    };
    const rulesOf = async (member: LocalConfig): Promise<string[]> => {
      const config = { ...member, projectRoot: repo, dataHome: path.join(repo, '.data') };
      return (await resolveDesiredRules(team, config, await buildRolePullContext(config))).items.map((rule) => rule.name).sort();
    };

    const inCopy = await rulesOf(memberOf(repo, { subscribedTags: ['ui'], stepRole: 'review' }));
    const inMember = await rulesOf(memberOf(repo, { subscribedTags: ['ui'] }));

    expect(inCopy).toEqual(['review/review', 'server-only']);
    expect(inMember).toEqual(['frontend/frontend']);
  });
});
