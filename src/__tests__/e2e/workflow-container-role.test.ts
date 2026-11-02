/**
 * Real CLI: a `workflow` step with `role: review` and no workspace of its own gives that role to the copy a step inside
 * it opens. Every step continuing that copy runs with the role: the prompt that opens it, a prompt that continues it,
 * and a command check that continues it without a role of its own.
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
`;
/** Exits 0 only in a copy that holds the review role's skill and not the member's. */
const REVIEW_SKILLS_ONLY = `node -e "const fs = require('fs'); process.exit(fs.existsSync('.claude/skills/rv-only/SKILL.md') && !fs.existsSync('.claude/skills/fe-only') ? 0 : 1)"`;
const TEAM = {
  'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: git\nsharing:\n  gitExclude: { enabled: false }\n`,
  'manifest/roles.yaml': ROLES,
  'manifest/members.yaml': 'version: 1\nmembers:\n  member: [frontend]\ndefault: []\n',
  'skills/frontend/fe-only/SKILL.md': '---\nname: fe-only\ndescription: Frontend only.\n---\nBuild the UI.\n',
  'skills/review/rv-only/SKILL.md': '---\nname: rv-only\ndescription: Review only.\n---\nReview the change.\n',
  'workflows/review.yaml': `schemaVersion: v1alpha1
name: review
description: Fix the answer and review it as a reviewer, then check the copy.
steps:
  - id: review
    role: review
    workflow:
      steps:
        - id: change
          workspace: new
          workflow:
            steps:
              - id: fix
                tool: claude
                model: { name: claude-review-1 }
                prompt: Fix the answer.
              - id: look
                needs: [fix]
                workspace: continue
                tool: claude
                model: { name: claude-review-1 }
                prompt: Review the fix.
              - id: lint
                needs: [look]
                workspace: continue
                command: ${JSON.stringify(REVIEW_SKILLS_ONLY)}
`,
};

const RunSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string(), agent: z.unknown().optional() }).passthrough()) });

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe('a workflow step with role: review around the steps of a copy', () => {
  it('runs the prompts that open and continue the copy, and a command check continuing it, with the review role', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, tools: ['claude'], loadsSkill: 'rv-only', team: TEAM });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['workflow', 'start', 'review', '--driver', 'local']);

    expect(ran.code, said(ran)).toBe(0);
    expect(envelope(ran).data?.done).toMatchObject({ outcome: 'succeeded' });
    const launches = fixture.toolLaunches();
    expect(launches.map((launch) => ({
      'rv-only': launch.paths.includes('.claude/skills/rv-only/SKILL.md'),
      'fe-only': launch.paths.some((file) => file.includes('fe-only')),
    }))).toEqual([{ 'rv-only': true, 'fe-only': false }, { 'rv-only': true, 'fe-only': false }]);
    const run = z.string().parse(z.object({ run: z.string() }).passthrough().parse(envelope(ran).data?.done).run);
    const steps = RunSchema.parse(fixture.runFile(run)).steps;
    for (const id of ['review.change.fix', 'review.change.look']) {
      expect(steps.find((step) => step.id === id), id).toMatchObject({
        status: 'succeeded', agent: { team: { selection: { primaryRole: 'frontend', stepRole: 'review' } } },
      });
    }
    expect(steps.find((step) => step.id === 'review.change.lint')).toMatchObject({ status: 'succeeded' });
  }, 240_000);
});
