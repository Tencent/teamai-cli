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
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import type { LocalConfig } from '../types.js';

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

  it('refuses a role the manifest does not declare rather than deliver the member\'s knowledge or everything', async () => {
    await expect(resolveResourceNamespaces(memberOf(teamRepo(), { primaryRole: undefined, projects: [], stepRole: 'auditor' })))
      .rejects.toThrow('This workflow copy runs with role "auditor", which manifest/roles.yaml does not declare (it declares frontend, review), so nothing is delivered for it. Add the role to manifest/roles.yaml, or run the step with a role it declares.');
  });

  it("indexes and contributes the copy's learnings in the role's namespace, with the member's projects", async () => {
    const namespaces = await resolveActiveLearningsNamespaces(memberOf(teamRepo(), { stepRole: 'review' }));

    expect(namespaces).toEqual(['rv-notes']);
  });
});
