import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withoutRefusal } from '../benchmark/team-without.js';
import type { LocalConfig } from '../types.js';
import type { TeamSelection } from '../workflow/clone.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SKILL = (name: string): string => `---\nname: ${name}\ndescription: Helps with ${name}.\n---\nUse ${name}.\n`;
const ROLES = ['version: 1', 'roles:', ...['dev', 'ops'].flatMap((id) => [
  `  - id: ${id}`, '    resources:', `      knowledge: [${id}]`, `      skills: [${id}]`, `      agents: [${id}]`, `      docs: [${id}]`,
]), ''].join('\n');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A member of role dev, which receives the dev namespaces and not the ops ones, and of tag quality, in a git team whose
 * commit holds rule commits, which tag quality keeps, and rules design and dev/notes, which only tag ux would, rule review
 * shared and again in dev, a text file in rules, claudemd file team shared and again in dev and in ops, a text file in claudemd, agent runner in ops, CLAUDE.md, shared
 * skills release and lint, which tag quality brings, and solo, which no tag
 * brings, skill release again in dev and in ops, skill deploy in dev, skills runbook and lint in ops, a README in dev and in lint, agent reviewer shared and again in dev,
 * agent planner shared only, rule style in ops, docs shared and under api and in namespace ops, and hooks shared and in
 * dev; and that commit, and the run's selection. With `role` null, the member holds no role, so every namespace reaches
 * them; `additional`, the member's other roles; without `tags`, the team has no tags.yaml; `subscribed`, the tags the
 * member subscribes; `excluded`, the skills the member excludes.
 */
function team({ role = 'dev' as string | null, additional = [] as string[], tags = true, subscribed = ['quality'], excluded = [] as string[] } = {}): { config: LocalConfig; revision: string; selection: TeamSelection } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-without-'));
  dirs.push(root);
  const repo = path.join(root, 'team');
  const files = {
    'teamai.yaml': 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: git\n',
    'manifest/roles.yaml': ROLES,
    ...(tags ? { 'tags.yaml': 'skills:\n  lint: [quality]\n  release: [quality]\nrules:\n  commits: [quality]\n  design: [ux]\n  dev/notes: [ux]\n' } : {}),
    'CLAUDE.md': 'Be kind.\n',
    'rules/commits.md': 'Small commits.\n',
    'rules/ops/style.md': 'Ops style.\n',
    'rules/design.md': 'Design.\n',
    'rules/dev/notes.md': 'Dev notes.\n',
    'rules/review.md': 'Review.\n',
    'rules/dev/review.md': 'Dev review.\n',
    'claudemd/team.md': 'Be brief.\n',
    'claudemd/dev/team.md': 'Be brief, dev.\n',
    'skills/release/SKILL.md': SKILL('release'),
    'skills/lint/SKILL.md': SKILL('lint'),
    'skills/lint/README.md': 'How to lint.\n',
    'skills/solo/SKILL.md': SKILL('solo'),
    'skills/dev/release/SKILL.md': SKILL('release'),
    'skills/dev/deploy/SKILL.md': SKILL('deploy'),
    'skills/ops/runbook/SKILL.md': SKILL('runbook'),
    'skills/ops/lint/SKILL.md': SKILL('lint'),
    'skills/ops/release/SKILL.md': SKILL('release'),
    'skills/dev/README.md': 'The dev skills.\n',
    'rules/notes.txt': 'Not a rule.\n',
    'agents/ops/runner.md': '---\nname: runner\ndescription: Runs.\n---\nRun.\n',
    'claudemd/ops/team.md': 'Be brief, ops.\n',
    'claudemd/notes.txt': 'Not team instructions.\n',
    'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n',
    'agents/dev/reviewer.yaml': 'name: reviewer\ndescription: Reviews for dev.\nprompt: Review.\n',
    'agents/planner.md': '---\nname: planner\ndescription: Plans.\n---\nPlan.\n',
    'docs/guide.md': 'Shared guide.\n',
    'docs/api/guide.md': 'Shared api guide.\n',
    'docs/ops/guide.md': 'Ops guide.\n',
    'hooks/hooks.yaml': 'hooks: []\n',
    'hooks/dev/hooks.yaml': 'hooks: []\n',
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed');
  return {
    config: {
      repo: { localPath: repo, remote: 'https://github.com/acme/team.git', kind: 'git' },
      username: 'tester', scope: 'project', ...(role !== null ? { primaryRole: role } : {}), additionalRoles: additional, projects: [], ...(subscribed.length > 0 ? { subscribedTags: subscribed } : {}), projectRoot: root, dataHome: path.join(root, 'data'),
    },
    revision: git(repo, 'rev-parse', 'HEAD'),
    selection: { ...(role !== null ? { primaryRole: role } : {}), additionalRoles: additional, projects: [], ...(subscribed.length > 0 ? { subscribedTags: subscribed } : {}), excludedSkills: excluded },
  };
}

describe('withoutRefusal', () => {
  it.each([
    ['a rule, CLAUDE.md, a shared skill no namespace shadows, and a skill in a namespace the member receives', ['CLAUDE.md', 'rules/commits.md', 'skills/dev/deploy', 'skills/lint']],
    ['a shared skill with the version its namespace delivers in its place', ['skills/dev/release', 'skills/release']],
    ['a shared skill with the whole namespace that delivers it in its place', ['skills/dev', 'skills/release']],
    ['a file inside a skill', ['skills/lint/SKILL.md']],
    ['a file inside a skill the member gets, which it then gets without that file', ['skills/lint/README.md']],
    ['a page in a docs directory no role or project declares', ['docs/api/guide.md']],
    ['a shared hooks file, whose entries a namespace adds to rather than replaces', ['hooks/hooks.yaml']],
    ['a shared agent no namespace the member receives has a version of', ['agents/planner.md']],
  ])('lets an arm run without %s', async (_case, paths) => {
    const { config, revision, selection } = team();

    expect(await withoutRefusal(config, { arm: 'ablated', paths, revision, selection })).toBeUndefined();
  });

  it.each([
    ['a path the revision does not have', ['rules/commits.md', 'skills/nope'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/nope, which team revision {r} does not have. Fix the arm\'s team, push it, run teamai pull, and start again.'],
    ['teamai.yaml', ['teamai.yaml'], 'arm_team_unresolved',
      'Arm "ablated" runs without teamai.yaml, which teamai pull reads to install the team, so no trial could run. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a skill in a namespace the member does not receive', ['skills/ops/runbook'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/ops/runbook, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a skill in a namespace the member does not receive, named as a shared skill the member gets', ['skills/ops/lint'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/ops/lint, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a namespace the member does not receive', ['skills/ops'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/ops, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a shared skill no tag the member subscribes delivers to its role', ['skills/solo'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/solo, a shared skill, which the arm\'s roles or projects receive only through a subscribed tag, and none brings it, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a shared skill a namespace the member receives delivers in its place', ['skills/release'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/release, but its namespace dev delivers skills/dev/release in its place; list skills/dev/release too.'],
    ['a shared agent a namespace the member receives delivers in its place, in another format', ['agents/reviewer.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without agents/reviewer.md, but its namespace dev delivers agents/dev/reviewer.yaml in its place; list agents/dev/reviewer.yaml too.'],
    ['a shared rule a namespace the member receives delivers in its place', ['rules/review.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without rules/review.md, but its namespace dev delivers rules/dev/review.md in its place; list rules/dev/review.md too.'],
    ['a shared claudemd file a namespace the member receives delivers in its place', ['claudemd/team.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without claudemd/team.md, but its namespace dev delivers claudemd/dev/team.md in its place; list claudemd/dev/team.md too.'],
    ['an entry inside a shared hooks file, named after the file', ['hooks/hooks.yaml#lint'], 'arm_team_unresolved',
      'Arm "ablated" runs without hooks/hooks.yaml#lint, which team revision {r} does not have. Fix the arm\'s team, push it, run teamai pull, and start again.'],
    ['an entry inside a shared hooks file, as a path below the file', ['hooks/hooks.yaml/lint'], 'arm_team_unresolved',
      'Arm "ablated" runs without hooks/hooks.yaml/lint, which team revision {r} does not have. Fix the arm\'s team, push it, run teamai pull, and start again.'],
    ['a rule tagged only with tags the member does not subscribe', ['rules/design.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without rules/design.md, a rule tagged only with tags the member does not subscribe, so pull leaves it out already and leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a rule of a namespace the member receives, tagged only with tags the member does not subscribe', ['rules/dev/notes.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without rules/dev/notes.md, a rule tagged only with tags the member does not subscribe, so pull leaves it out already and leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a rule namespace the member does not receive', ['rules/ops'], 'arm_team_unresolved',
      'Arm "ablated" runs without rules/ops, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['an agent in a namespace the member does not receive', ['agents/ops/runner.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without agents/ops/runner.md, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a claudemd file in a namespace the member does not receive', ['claudemd/ops/team.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without claudemd/ops/team.md, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a file in a skill namespace that is no skill', ['skills/dev/README.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/dev/README.md, and teamai pull delivers the same team assets at team revision {r} with or without it, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a file in rules that is no rule', ['rules/notes.txt'], 'arm_team_unresolved',
      'Arm "ablated" runs without rules/notes.txt, and teamai pull delivers the same team assets at team revision {r} with or without it, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a rule in a namespace the member does not receive', ['rules/ops/style.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without rules/ops/style.md, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a page in a docs namespace a role declares and the member does not receive', ['docs/ops/guide.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without docs/ops/guide.md, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
  ])('refuses an arm without %s', async (_case, paths, code, message) => {
    const { config, revision, selection } = team();

    expect(await withoutRefusal(config, { arm: 'ablated', paths, revision, selection })).toEqual({ code, message: message.replace('{r}', revision.slice(0, 7)) });
  });

  it('lets a member with no role or project run without a skill of any namespace and a shared doc or skill', async () => {
    const { config, revision, selection } = team({ role: null });

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['docs/guide.md', 'skills/ops/runbook', 'skills/solo'], revision, selection })).toBeUndefined();
  });

  it.each([
    ['a skill the member excludes', { excluded: ['solo'] }, ['skills/solo'],
      'Arm "ablated" runs without skills/solo, skill solo, which the member excludes, so pull leaves it out already and leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a rule tagged only with tags the member does not subscribe', {}, ['rules/design.md'],
      'Arm "ablated" runs without rules/design.md, a rule tagged only with tags the member does not subscribe, so pull leaves it out already and leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a file in claudemd that pull does not read', {}, ['claudemd/notes.txt'],
      'Arm "ablated" runs without claudemd/notes.txt, and teamai pull delivers the same team assets at team revision {r} with or without it, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
  ])('refuses a member with no role or project an arm without %s', async (_case, options, paths, message) => {
    const { config, revision, selection } = team({ role: null, ...options });

    expect(await withoutRefusal(config, { arm: 'ablated', paths, revision, selection })).toEqual({ code: 'arm_team_unresolved', message: message.replace('{r}', revision.slice(0, 7)) });
  });

  it('refuses an arm without an agent when pull delivers no agents, as two of one name reach a member with no role or project', async () => {
    const { config, revision, selection } = team({ role: null });

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['agents/planner.md'], revision, selection })).toEqual({
      code: 'arm_team_unresolved',
      message: `Arm "ablated" runs without agents/planner.md, and teamai pull delivers no agents at team revision ${revision.slice(0, 7)} with or without it: Duplicate agent "reviewer" found in active namespaces "(root)" and "dev" (agents/reviewer.md and agents/dev/reviewer.yaml). Fix that in the team repo, push it, run teamai pull, and start again.`,
    });
  });

  it('refuses an arm without a skill when pull delivers no skills, as two of one name reach the member from two namespaces', async () => {
    const { config, revision, selection } = team({ additional: ['ops'] });

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['skills/solo'], revision, selection })).toEqual({
      code: 'arm_team_unresolved',
      message: `Arm "ablated" runs without skills/solo, and teamai pull delivers no skills at team revision ${revision.slice(0, 7)} with or without it: Duplicate skill "release" found in active namespaces "dev" and "ops" (skills/dev/release and skills/ops/release). Fix that in the team repo, push it, run teamai pull, and start again.`,
    });
  });

  it('refuses an arm without a skill the member excludes, which pull leaves out already', async () => {
    const { config, revision, selection } = team({ excluded: ['lint'] });

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['skills/lint'], revision, selection })).toEqual({
      code: 'arm_team_unresolved',
      message: 'Arm "ablated" runs without skills/lint, skill lint, which the member excludes, so pull leaves it out already and leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.',
    });
  });

  it('lets a member who subscribes no tag run without a tagged rule, which pull then delivers', async () => {
    const { config, revision, selection } = team({ subscribed: [] });

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['rules/design.md'], revision, selection })).toBeUndefined();
  });

  it('lets an arm run without a namespaced skill in a team with no tags.yaml', async () => {
    const { config, revision, selection } = team({ tags: false });

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['skills/dev/deploy'], revision, selection })).toBeUndefined();
  });

  it('refuses an arm whose revision the team repo cannot read', async () => {
    const { config, selection } = team();

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['CLAUDE.md'], revision: 'f'.repeat(40), selection })).toEqual({
      code: 'arm_team_unreadable',
      message: expect.stringMatching(/^Arm "ablated" runs without CLAUDE\.md, and git could not list team revision fffffff at .+: .+\. Repair the team repo, or run teamai pull, and start again\.$/),
    });
  });
});
