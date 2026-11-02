/**
 * A prompt step with `workspace: new` or `continue` and a team role runs in a worktree copy whose own pull delivered
 * that role, whichever tool runs it: a session started there keeps the delivery, and a preparation whose pull did not
 * deliver fails the step rather than run it with what the copy held.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { knownSecrets, resolveWorkflowEnv } from '../env-resolution.js';
import { detectProjectConfig, resolveConfigForDir } from '../config.js';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { launchHoldsCheckout } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { resolveAnchors } from '../utils/git.js';
import { resolvePartitionDir } from '../utils/partition.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import type { LocalToolAdapter, LocalToolRun } from '../workflow/drivers/local/local-tool-adapter.js';
import { startRun } from '../workflow/engine.js';
import { canFor } from '../workflow/drivers/skill/skill-driver.js';
import { inProcessClient } from '../workflow/protocol.js';
import { readRun, RunIdSchema } from '../workflow/store.js';

/** Whether the next pull finds the team's sync lock held past its wait, when a test decides it: else it runs. */
const pullLock = vi.hoisted(() => ({ held: false }));
vi.mock('../pull.js', async (original) => {
  const actual = await original<typeof import('../pull.js')>();
  return {
    ...actual,
    pull: async (...args: Parameters<typeof actual.pull>) => {
      const [, result] = args;
      if (!pullLock.held) return actual.pull(...args);
      if (result) Object.assign(result, { completed: false, delivery: 'skipped' });
    },
  };
});

_setDriverPollMs(20);

const dirs: string[] = [];

afterEach(() => {
  pullLock.held = false;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROLES = `version: 1
roles:
  - id: frontend
    resources: { knowledge: [frontend], skills: [frontend] }
  - id: review
    resources: { knowledge: [review], skills: [review] }
`;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A self-mode project whose member has role frontend, delivering to `tools`, its team declaring roles frontend and
 * review with a skill each and the `rules` given, and a started run of `yaml`, whose steps run on the first tool.
 */
async function roleWorkspace(yaml: string, options: { tools: readonly string[]; rules?: Record<string, string> }): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-worktree-role-')));
  dirs.push(root);
  const workspace = path.join(root, 'workspace');
  const knowledge = path.join(workspace, '.teamai');
  const files: Record<string, string> = {
    'teamai.yaml': 'team: workspace\nmode: self\nrepo: https://git.example.com/team/workspace.git\nprovider: git\n',
    '.gitignore': 'config.yaml\nstate.json\n',
    'manifest/roles.yaml': ROLES,
    'skills/frontend/fe-only/SKILL.md': '---\nname: fe-only\ndescription: Frontend only.\n---\nBuild the UI.\n',
    'skills/review/rv-only/SKILL.md': '---\nname: rv-only\ndescription: Review only.\n---\nReview the change.\n',
    'workflows/build.yaml': yaml,
    ...Object.fromEntries(Object.entries(options.rules ?? {}).map(([file, text]) => [`rules/${file}`, text])),
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
    fs.writeFileSync(path.join(knowledge, file), text);
  }
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'clean\n');
  git(['init', '-q', '-b', 'main'], workspace);
  git(['add', '-A'], workspace);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace);
  const anchors = await resolveAnchors(workspace);
  if (!anchors) throw new Error('the workspace has no git anchors');
  const partition = await resolvePartitionDir(anchors.projectAnchor);
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(path.join(partition, 'config.yaml'), [
    'repo:',
    `  localPath: ${knowledge}`,
    '  remote: https://git.example.com/team/workspace.git',
    '  kind: self',
    `  businessRepoRoot: ${workspace}`,
    'username: tester',
    'updatePolicy: auto',
    'scope: project',
    `projectRoot: ${workspace}`,
    'primaryRole: frontend',
    `enabledAgents: [${options.tools.join(', ')}]`,
    '',
  ].join('\n'));
  const { pull } = await import('../pull.js');
  await pull({ silent: true, cwd: workspace });
  const config = await detectProjectConfig(workspace);
  if (!config) throw new Error('project config was not found');
  config.workflows = { tools: { default: options.tools[0] ?? 'claude' }, max_parallel: 1 };
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config), checkout: workspace, base: { ref: 'main', commit: git(['rev-parse', 'HEAD'], workspace) } });
  if ('error' in started) throw new Error(started.error.message);
  return { config, workspace, runId: String(started.data.run) };
}

/** A tool that runs `look` on each launch in place of a session, and does nothing else. */
function fakeTool(look: (input: LocalToolRun) => Promise<void>): LocalToolAdapter {
  return {
    async runInteractive() {
      return { started: false, exitCode: 1, failure: { code: 'tool_failed', message: 'interactive is not used' } };
    },
    async run(_tool, input) {
      await look(input);
      return { started: true, exitCode: 0 };
    },
  };
}

/** The `instructions` entries of the project's OpenCode config in `dir`, or none without one. */
function opencodeInstructions(dir: string): string[] {
  const file = path.join(dir, '.opencode', 'opencode.json');
  if (!fs.existsSync(file)) return [];
  return z.object({ instructions: z.array(z.string()).default([]) }).parse(JSON.parse(fs.readFileSync(file, 'utf8'))).instructions;
}

const REVIEW_IN_COPY = `schemaVersion: v1alpha1
name: build
description: Review in a copy of its own.
steps:
  - id: review
    role: review
    workspace: new
    prompt: Review the change.
`;

describe('a prompt step that runs with a role in a worktree copy', () => {
  it('is held from the skill driver, which cannot give a step a role, and from a driver that makes its own copy, which teamai delivers no role into', async () => {
    const { config, runId } = await roleWorkspace(REVIEW_IN_COPY, { tools: ['claude'] });
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
    const external = { kind: 'external', machine: 'ci', workspace: '/work', can: { workspace: ['read-only' as const, 'new' as const, 'continue' as const], role: true } };

    const skill = await client.next(runId, { driver: { kind: 'skill', machine: 'session', workspace: '/work', can: canFor('h1') }, running: [] });
    const own = await client.next(runId, { driver: external, running: [] });
    const prepared = await client.next(runId, { driver: external, running: [] }, { prepare: true });

    expect(skill).toMatchObject({ data: { wait: { held: [{ step: 'review', missing: expect.arrayContaining(['role']) }] } } });
    expect(own).toMatchObject({ data: { wait: { held: [{ step: 'review', missing: ['prepare'] }] } } });
    expect(prepared).toMatchObject({ data: { lease: { step: 'review', role: 'review' } } });
  });

  it('starts its session in a copy that holds the delivery, so the session start runs no pull there', async () => {
    const { config, workspace, runId } = await roleWorkspace(REVIEW_IN_COPY, { tools: ['claude'] });
    const seen: { role?: string; holds?: boolean } = {};

    const done = await runLocalDriver(config, runId, workspace, {
      adapter: fakeTool(async (input) => {
        const own = await resolveConfigForDir(input.cwd);
        seen.role = own?.stepRole;
        seen.holds = own && input.launch ? await launchHoldsCheckout(own, input.launch) : false;
      }),
    });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(seen).toEqual({ role: 'review', holds: true });
  });

  it('fails a step whose preparation pull was skipped in a copy an earlier step left with the same role, rather than run it with what the copy held', async () => {
    const { config, workspace, runId } = await roleWorkspace(`schemaVersion: v1alpha1
name: build
description: Review twice in one copy.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: first
          role: review
          workspace: continue
          prompt: Review the change.
        - id: second
          needs: [first]
          role: review
          workspace: continue
          prompt: Review it again.
`, { tools: ['claude'] });
    const ran: string[] = [];

    const done = await runLocalDriver(config, runId, workspace, {
      adapter: fakeTool(async (input) => {
        ran.push(input.prompt);
        pullLock.held = true;
      }),
    });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(ran).toEqual([expect.stringContaining('Review the change.')]);
    const run = await readRun(config, RunIdSchema.parse(runId));
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'change.second')).toMatchObject({
      status: 'failed', failure: { code: 'role_unavailable', message: expect.stringContaining('its pull was skipped') },
    });
  });

  it("gives a Codex session in the copy the role's rules through its team-rules hook, and not the member's", async () => {
    const { config, workspace, runId } = await roleWorkspace(REVIEW_IN_COPY, {
      tools: ['codex'],
      rules: { 'frontend/frontend.md': 'FRONTEND-RULE-SENTINEL: use the design system.\n', 'review/review.md': 'REVIEW-RULE-SENTINEL: read every changed line.\n' },
    });
    const teamRules = buildHandlerRegistry().find((entry) => entry.handler.name === 'team-rules')?.handler;
    let context: string | null | undefined;

    const done = await runLocalDriver(config, runId, workspace, {
      adapter: fakeTool(async (input) => {
        context = await teamRules?.execute({ hook_event_name: 'SessionStart', source: 'startup', cwd: input.cwd }, 'codex', await resolveConfigForDir(input.cwd));
      }),
    });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(context).toContain('REVIEW-RULE-SENTINEL');
    expect(context).not.toContain('FRONTEND-RULE-SENTINEL');
  });

  it("lists the role's rules in the copy's OpenCode instructions while the step runs, and commits none of it", async () => {
    const { config, workspace, runId } = await roleWorkspace(REVIEW_IN_COPY, {
      tools: ['opencode'],
      rules: { 'review/review.md': 'REVIEW-RULE-SENTINEL: read every changed line.\n' },
    });
    const seen: { member?: string[]; copy?: string[]; rules?: string[] } = {};

    const done = await runLocalDriver(config, runId, workspace, {
      adapter: fakeTool(async (input) => {
        seen.member = opencodeInstructions(workspace);
        seen.copy = opencodeInstructions(input.cwd);
        const rules = path.join(input.cwd, '.opencode', 'rules');
        seen.rules = fs.existsSync(rules) ? fs.readdirSync(rules, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.md')) : [];
        fs.writeFileSync(path.join(input.cwd, 'review.md'), 'Looks right.\n');
      }),
    });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(seen).toEqual({ member: [], copy: ['.opencode/rules/**/*.md'], rules: [path.join('review', 'review.md')] });
    const branch = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/'], workspace);
    expect(git(['diff', '--name-only', 'main', branch], workspace).split('\n')).toEqual(['review.md']);
  });

  it.each([['with a role', REVIEW_IN_COPY], ['without one', REVIEW_IN_COPY.replace('    role: review\n', '')]])(
    "commits only the step's edit %s, though the copy's pull rewrites the self-mode .teamai/.gitignore the branch holds",
    async (_label, yaml) => {
      const { config, workspace, runId } = await roleWorkspace(yaml, { tools: ['claude'] });
      const committed = git(['show', 'HEAD:.teamai/.gitignore'], workspace);
      let rewritten: boolean | undefined;

      const done = await runLocalDriver(config, runId, workspace, {
        adapter: fakeTool(async (input) => {
          rewritten = fs.readFileSync(path.join(input.cwd, '.teamai', '.gitignore'), 'utf8').trim() !== committed;
          fs.writeFileSync(path.join(input.cwd, 'review.md'), 'Looks right.\n');
        }),
      });

      expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(rewritten).toBe(true);
      const branch = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/'], workspace);
      expect(git(['diff', '--name-only', 'main', branch], workspace).split('\n')).toEqual(['review.md']);
    },
  );
});
