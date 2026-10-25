import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { deployWorkflowSkills, shadowedWorkflowSkills } from '../workflow/discovery/workflow-skills.js';
import { readGenerated } from '../workflow/discovery/generated-marker.js';
import { log } from '../utils/logger.js';
import { createDeliveryRecorder, type DeliveryRecorder } from '../git-exclude-delivered.js';
import { isTeamaiSkillCopy } from '../resources/delivered-copies.js';
import { skillOrigin } from '../resources/skills.js';

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function team(workflows: Record<string, string>, tools: TeamaiConfig['toolPaths'] = { claude: { skills: '.claude/skills' } }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-skills-')));
  roots.push(root);
  const home = path.join(root, 'home');
  for (const tool of Object.values(tools)) fs.mkdirSync(path.join(home, path.dirname(tool.skills ?? '')), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const repo = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(repo, 'workflows', `${name}.yaml`), yaml);
  const localConfig: LocalConfig = { repo: { localPath: repo, remote: 'local' }, username: 'test', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
  const teamConfig: TeamaiConfig = {
    team: 'test', description: '', repo: 'local', provider: 'git', reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
    toolPaths: tools,
  };
  await syncWorkflowDefinitions(localConfig);
  const put = async (name: string, yaml: string | null) => {
    const file = path.join(repo, 'workflows', `${name}.yaml`);
    if (yaml === null) fs.rmSync(file);
    else fs.writeFileSync(file, yaml);
    await syncWorkflowDefinitions(localConfig);
  };
  const skill = (name: string) => path.join(home, '.claude', 'skills', `workflow-${name}`, 'SKILL.md');
  const owned = (name: string) => isTeamaiSkillCopy(path.dirname(skill(name)), skillOrigin(repo, `workflow-${name}`));
  return { owned, deploy: (recorder?: DeliveryRecorder) => deployWorkflowSkills({ teamConfig, localConfig, recorder }), skill, home, put, shadowed: () => shadowedWorkflowSkills({ teamConfig, localConfig }) };
}

describe('generated workflow skills', () => {
  it('writes a signed skill for each invoke: allow or ask workflow, and none for deny', async () => {
    const { deploy, skill } = await team({
      check: workflow('check', 'allow', 'alias: lint\n'), gated: workflow('gated', 'ask'), private: workflow('private', 'deny'),
    });
    await deploy();
    const written = fs.readFileSync(skill('check'), 'utf8');
    expect(written).toContain('name: workflow-check\n');
    expect(written).toContain('description: "Lint the change. Alias: lint. A team workflow: prefer it over doing the task ad hoc."\n');
    expect(written).toContain('allowed-tools: Bash(teamai workflow start check --driver skill:*), Bash(teamai workflow start lint --driver skill:*), Bash(npx teamai-cli workflow start check --driver skill:*), Bash(npx teamai-cli workflow start lint --driver skill:*)\n');
    expect(written).toContain('Run `teamai skill get workflow` and follow it for the workflow `check`.');
    expect(written).toContain('You may start it when the task matches; the person need not confirm.');
    expect(readGenerated(written)).toEqual({ kind: 'ours', name: 'check', edited: false });
    const gated = fs.readFileSync(skill('gated'), 'utf8');
    expect(gated).not.toContain('allowed-tools');
    expect(gated).toContain('Propose it when the task matches, and start it only after the person says yes: the describe step of the guide asks them.');
    expect(gated).not.toContain('Your host may ask');
    expect(readGenerated(gated)).toEqual({ kind: 'ours', name: 'gated', edited: false });
    expect(fs.existsSync(skill('private'))).toBe(false);
    await deploy();
    expect(fs.readFileSync(skill('check'), 'utf8')).toBe(written);
    expect(fs.readFileSync(skill('gated'), 'utf8')).toBe(gated);
  });

  it('renders Codex skills without pre-approval, with the host sentence, in one of its two roots', async () => {
    const { deploy, home } = await team({ check: workflow('check', 'allow'), gated: workflow('gated', 'ask') }, { codex: { skills: '.codex/skills' } });
    await deploy();
    const codex = (name: string) => fs.readFileSync(path.join(home, '.codex', 'skills', `workflow-${name}`, 'SKILL.md'), 'utf8');
    expect(codex('check')).not.toContain('allowed-tools');
    expect(codex('check')).toContain('You may start it when the task matches; the person need not confirm.\nYour host may ask the person to approve each command.\n');
    expect(codex('gated')).toContain('start it only after the person says yes');
    expect(codex('gated')).toContain('Your host may ask the person to approve each command.\n');
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'workflow-check'))).toBe(false);
  });

  it('leaves a same-named skill without the marker, and an edited generated one, as they are', async () => {
    const { deploy, skill, shadowed } = await team({ check: workflow('check', 'allow'), build: workflow('build', 'allow') });
    const warn = vi.spyOn(log, 'warn');
    fs.mkdirSync(path.dirname(skill('check')), { recursive: true });
    fs.writeFileSync(skill('check'), '---\nname: workflow-check\ndescription: Our own.\n---\nMine.\n');
    await deploy();
    const edited = fs.readFileSync(skill('build'), 'utf8').replace('the person need not confirm', 'ask the person first');
    fs.writeFileSync(skill('build'), edited);
    expect(readGenerated(edited)).toEqual({ kind: 'ours', name: 'build', edited: true });
    await deploy();
    expect(fs.readFileSync(skill('check'), 'utf8')).toBe('---\nname: workflow-check\ndescription: Our own.\n---\nMine.\n');
    expect(fs.readFileSync(skill('build'), 'utf8')).toBe(edited);
    const shadowedLine = `${path.dirname(skill('check'))} is a skill teamai did not generate, so agents read it in place of the generated skill of workflow check (claude). To receive the generated skill, rename or remove that skill, in the team repository when the team ships it.`;
    expect(await shadowed()).toEqual([shadowedLine]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      shadowedLine,
      `Kept ${skill('build')}: it was generated from workflows/build.yaml and edited since, so teamai pull no longer updates it. Delete it to receive the current one, or remove its teamai-generated metadata to keep it as your own.`,
    ]));
  });

  it('removes an unedited skill once its workflow is gone or denied, and keeps an edited one', async () => {
    const { deploy, skill, put } = await team({ check: workflow('check', 'allow'), gated: workflow('gated', 'ask'), build: workflow('build', 'allow') });
    await deploy();
    const edited = `${fs.readFileSync(skill('build'), 'utf8')}Mine too.\n`;
    fs.writeFileSync(skill('build'), edited);
    const warn = vi.spyOn(log, 'warn');
    await put('check', null);
    await put('gated', workflow('gated', 'deny'));
    await put('build', null);
    await deploy();
    expect([fs.existsSync(path.dirname(skill('check'))), fs.existsSync(path.dirname(skill('gated')))]).toEqual([false, false]);
    expect(fs.readFileSync(skill('build'), 'utf8')).toBe(edited);
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      `Kept ${skill('build')}: it was generated from workflows/build.yaml and edited since, and that workflow no longer offers a skill, so teamai pull left it. Delete it, or remove its teamai-generated metadata to keep it as your own.`,
    );
  });

  it('writes no skill for a workflow without a runnable version, removes the skill of one whose file stopped running, and keeps one whose last valid version runs', async () => {
    const twoSteps = (name: string, needs: string) => `${workflow(name, 'allow')}  - id: test\n${needs}    command: node -e "process.exit(0)"\n`;
    // A step after the first without needs changes what the file means, so its last valid version stops running too.
    const unrunnable = (name: string) => twoSteps(name, '');
    // A need that names no step is only invalid: the last valid version keeps running.
    const invalid = (name: string) => twoSteps(name, '    needs: [ghost]\n');
    const { deploy, skill, put } = await team({ never: unrunnable('never'), dropped: workflow('dropped', 'allow'), kept: workflow('kept', 'allow') });
    await deploy();
    expect(['never', 'dropped', 'kept'].map((name) => fs.existsSync(skill(name)))).toEqual([false, true, true]);
    await put('dropped', unrunnable('dropped'));
    await put('kept', invalid('kept'));
    await deploy();
    expect(['never', 'dropped', 'kept'].map((name) => fs.existsSync(path.dirname(skill(name))))).toEqual([false, false, true]);
  });

  it('keeps one Codex copy, removing an unedited generated one from the other root', async () => {
    const { deploy, home } = await team({ check: workflow('check', 'allow') }, { codex: { skills: '.codex/skills' } });
    await deploy();
    const own = path.join(home, '.codex', 'skills', 'workflow-check');
    const shared = path.join(home, '.agents', 'skills', 'workflow-check');
    fs.cpSync(own, shared, { recursive: true });
    await deploy();
    expect([fs.existsSync(shared), fs.existsSync(own)]).toEqual([true, false]);
  });

  it('reports each skill it wrote or confirmed, so a prune drops its git exclude line', async () => {
    const { deploy, skill, put } = await team({ check: workflow('check', 'allow'), gated: workflow('gated', 'ask') });
    fs.mkdirSync(path.dirname(skill('mine')), { recursive: true });
    fs.writeFileSync(skill('mine'), '---\nname: workflow-mine\ndescription: Mine.\n---\n');
    await put('mine', workflow('mine', 'allow'));
    const first = createDeliveryRecorder();
    await deploy(first);
    const listed = await first.merge(undefined);
    expect(listed).toEqual({ 'workflow-skills': [skill('check'), skill('gated')] });
    const confirmed = createDeliveryRecorder();
    await deploy(confirmed);
    expect(await confirmed.merge(listed)).toEqual(listed);
    await put('gated', null);
    const pruned = createDeliveryRecorder();
    await deploy(pruned);
    expect(await pruned.merge(listed)).toEqual({ 'workflow-skills': [skill('check')] });
  });

  it('never writes or removes through a link', async () => {
    const { deploy, skill, home, put } = await team({ check: workflow('check', 'allow'), build: workflow('build', 'allow') });
    await deploy();
    const elsewhere = path.join(home, 'elsewhere');
    for (const name of ['check', 'build']) {
      fs.cpSync(path.dirname(skill(name)), path.join(elsewhere, name), { recursive: true });
      fs.rmSync(path.dirname(skill(name)), { recursive: true });
      fs.symlinkSync(path.join(elsewhere, name), path.dirname(skill(name)));
    }
    const before = fs.readFileSync(path.join(elsewhere, 'check', 'SKILL.md'), 'utf8');
    await put('check', workflow('check', 'ask'));
    await put('build', null);
    await deploy();
    expect(fs.readFileSync(path.join(elsewhere, 'check', 'SKILL.md'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(elsewhere, 'build', 'SKILL.md'))).toBe(true);
    expect(fs.lstatSync(path.dirname(skill('build'))).isSymbolicLink()).toBe(true);
  });

  it('leaves out an alias that starts another workflow, or none', async () => {
    const { deploy, skill } = await team({
      check: workflow('check', 'allow', 'alias: build\n'), build: workflow('build', 'allow'),
      a: workflow('a', 'ask', 'alias: shared\n'), b: workflow('b', 'ask', 'alias: shared\n'),
    });
    await deploy();
    expect(fs.readFileSync(skill('check'), 'utf8')).toContain('allowed-tools: Bash(teamai workflow start check --driver skill:*), Bash(npx teamai-cli workflow start check --driver skill:*)\n');
    for (const name of ['check', 'a', 'b']) expect(fs.readFileSync(skill(name), 'utf8')).not.toContain('Alias:');
  });

  it('lets a team skill of the same name replace an unedited generated skill, and nothing else of it', async () => {
    const { deploy, skill, owned } = await team({ check: workflow('check', 'allow'), build: workflow('build', 'allow'), lint: workflow('lint', 'allow') });
    await deploy();
    fs.appendFileSync(skill('build'), 'Mine.\n');
    fs.writeFileSync(path.join(path.dirname(skill('lint')), 'notes.md'), 'Mine.\n');
    expect([await owned('check'), await owned('build'), await owned('lint')]).toEqual([true, false, false]);
  });
});
