/**
 * Real CLI: a `for_each` review whose items name the role that should review their part, `role: "{{ item.role }}"`.
 * Each item opens a copy of its own, which gets its own role's delivery rather than the member's (spec), and the run
 * records each item's role. An item
 * naming a role the team does not declare fails before its tool is launched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, TEAM_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const ROLES = `version: 1
roles:
  - id: frontend
    resources: { knowledge: [frontend], skills: [frontend] }
  - id: review
    resources: { knowledge: [review], skills: [review] }
  - id: spec
    resources: { knowledge: [spec], skills: [spec] }
`;
const TEAM = {
  'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: git\nsharing:\n  gitExclude: { enabled: false }\n`,
  'manifest/roles.yaml': ROLES,
  'skills/frontend/fe-only/SKILL.md': '---\nname: fe-only\ndescription: Frontend only.\n---\nReview the UI.\n',
  'skills/review/rv-only/SKILL.md': '---\nname: rv-only\ndescription: Review only.\n---\nReview the change.\n',
  'skills/spec/sp-only/SKILL.md': '---\nname: sp-only\ndescription: Spec only.\n---\nWrite the spec.\n',
  'workflows/review-parts.yaml': `schemaVersion: v1alpha1
name: review-parts
description: Review each part of the change as the role that knows it.
inputs:
  parts: [{ path: string, role: string }]
steps:
  - id: review
    for_each: inputs.parts
    role: "{{ item.role }}"
    workspace: new
    tool: claude
    model: { name: claude-review-1 }
    prompt: Review the change to {{ item.path }}.
`,
};

const RunSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string(), agent: z.unknown().optional(), failure: z.unknown().optional() }).passthrough()) });

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** Each launch's delivered role skills: the frontend and review roles', and that of the member's own role, spec. */
function skillsOf(fixture: BenchmarkFixture): Array<{ 'fe-only': boolean; 'rv-only': boolean; 'sp-only': boolean }> {
  return fixture.toolLaunches().map((launch) => ({
    'fe-only': launch.paths.includes('.claude/skills/fe-only/SKILL.md'),
    'rv-only': launch.paths.includes('.claude/skills/rv-only/SKILL.md'),
    'sp-only': launch.paths.includes('.claude/skills/sp-only/SKILL.md'),
  })).toSorted((left, right) => Number(left['rv-only']) - Number(right['rv-only']));
}

describe('a for_each review whose items name the role that reviews their part', () => {
  it('runs each item in a copy of its own, delivered and recorded for the role its item names', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, tools: ['claude'], role: 'spec', team: TEAM });
    fixtures.push(fixture);
    const parts = [{ path: 'web/', role: 'frontend' }, { path: 'api/', role: 'review' }];

    const ran = await fixture.teamai(['workflow', 'start', 'review-parts', '--driver', 'local', '--inputs', JSON.stringify({ parts })]);

    expect(ran.code, said(ran)).toBe(0);
    expect(envelope(ran).data?.done).toMatchObject({ outcome: 'succeeded' });
    expect(skillsOf(fixture)).toEqual([{ 'fe-only': true, 'rv-only': false, 'sp-only': false }, { 'fe-only': false, 'rv-only': true, 'sp-only': false }]);
    expect(new Set(fixture.toolLaunches().map((launch) => launch.cwd)).size).toBe(2);
    const run = z.string().parse(z.object({ run: z.string() }).passthrough().parse(envelope(ran).data?.done).run);
    const steps = RunSchema.parse(fixture.runFile(run)).steps;
    expect(steps.find((step) => step.id === 'review[0]')).toMatchObject({ status: 'succeeded', agent: { team: { selection: { primaryRole: 'spec', stepRole: 'frontend' } } } });
    expect(steps.find((step) => step.id === 'review[1]')).toMatchObject({ status: 'succeeded', agent: { team: { selection: { primaryRole: 'spec', stepRole: 'review' } } } });
  }, 240_000);

  it('fails an item naming a role the team does not declare before its tool is launched', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, tools: ['claude'], role: 'spec', team: TEAM });
    fixtures.push(fixture);
    const parts = [{ path: 'web/', role: 'frontend' }, { path: 'api/', role: 'reviewer' }];

    const ran = await fixture.teamai(['workflow', 'start', 'review-parts', '--driver', 'local', '--inputs', JSON.stringify({ parts })]);

    expect(envelope(ran).data?.done, said(ran)).toMatchObject({ outcome: 'failed' });
    expect(skillsOf(fixture)).toEqual([{ 'fe-only': true, 'rv-only': false, 'sp-only': false }]);
    const run = z.string().parse(z.object({ run: z.string() }).passthrough().parse(envelope(ran).data?.done).run);
    const steps = RunSchema.parse(fixture.runFile(run)).steps;
    expect(steps.find((step) => step.id === 'review[1]')).toMatchObject({ status: 'failed', failure: {
      code: 'role_unavailable',
      message: expect.stringContaining('Role reviewer was not delivered into the copy for step "review[1]": manifest/roles.yaml in the team repo does not declare it (it declares frontend, review, spec)'),
    } });
  }, 240_000);
});
