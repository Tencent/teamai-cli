import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { deployWorkflowSkills } from '../workflow/discovery/workflow-skills.js';
import { readGenerated } from '../workflow/discovery/generated-marker.js';

const workflow = (name: string, invoke: string, extra = '') => `schemaVersion: v1alpha1
name: ${name}
description: Lint the change.
invoke: ${invoke}
${extra}steps:
  - id: lint
    command: node -e "process.exit(0)"
`;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function team(workflows: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-skills-')));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const repo = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(repo, 'workflows', `${name}.yaml`), yaml);
  const localConfig: LocalConfig = { repo: { localPath: repo, remote: 'local' }, username: 'test', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
  const teamConfig: TeamaiConfig = {
    team: 'test', description: '', repo: 'local', provider: 'git', reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
    toolPaths: { claude: { skills: '.claude/skills' } },
  };
  await syncWorkflowDefinitions(localConfig);
  const skill = (name: string) => path.join(home, '.claude', 'skills', `workflow-${name}`, 'SKILL.md');
  return { deploy: () => deployWorkflowSkills({ teamConfig, localConfig }), skill };
}

describe('generated workflow skills', () => {
  it('writes a signed skill for each invoke: allow workflow, and none for ask or deny', async () => {
    const { deploy, skill } = await team({
      check: workflow('check', 'allow', 'alias: lint\n'), gated: workflow('gated', 'ask'), private: workflow('private', 'deny'),
    });
    await deploy();
    const written = fs.readFileSync(skill('check'), 'utf8');
    expect(written).toContain('name: workflow-check\n');
    expect(written).toContain('description: "Lint the change. Alias: lint. A team workflow: prefer it over doing the task ad hoc."\n');
    expect(written).toContain('allowed-tools: Bash(teamai workflow start check --driver skill:*), Bash(teamai workflow start lint --driver skill:*), Bash(npx teamai-cli workflow start check --driver skill:*), Bash(npx teamai-cli workflow start lint --driver skill:*)\n');
    expect(written).toContain('Run `teamai skill get workflow` and follow it for the workflow `check`.');
    expect(readGenerated(written)).toEqual({ kind: 'ours', name: 'check', edited: false });
    expect([fs.existsSync(skill('gated')), fs.existsSync(skill('private'))]).toEqual([false, false]);
    await deploy();
    expect(fs.readFileSync(skill('check'), 'utf8')).toBe(written);
  });

  it('leaves a same-named skill without the marker, and an edited generated one, as they are', async () => {
    const { deploy, skill } = await team({ check: workflow('check', 'allow'), build: workflow('build', 'allow') });
    fs.mkdirSync(path.dirname(skill('check')), { recursive: true });
    fs.writeFileSync(skill('check'), '---\nname: workflow-check\ndescription: Our own.\n---\nMine.\n');
    await deploy();
    const edited = fs.readFileSync(skill('build'), 'utf8').replace('the person need not confirm', 'ask the person first');
    fs.writeFileSync(skill('build'), edited);
    expect(readGenerated(edited)).toEqual({ kind: 'ours', name: 'build', edited: true });
    await deploy();
    expect(fs.readFileSync(skill('check'), 'utf8')).toBe('---\nname: workflow-check\ndescription: Our own.\n---\nMine.\n');
    expect(fs.readFileSync(skill('build'), 'utf8')).toBe(edited);
  });
});
