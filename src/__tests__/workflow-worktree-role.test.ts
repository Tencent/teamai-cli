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
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { knownSecrets, resolveWorkflowEnv } from '../env-resolution.js';
import { detectProjectConfig, resolveConfigForDir } from '../config.js';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { launchHoldsCheckout } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { resolveAnchors } from '../utils/git.js';
import { resolvePartitionDir } from '../utils/partition.js';
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
  vi.unstubAllEnvs();
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
 * review with a skill each and the `rules` given, and a started run of `yaml` with `inputs`, whose steps run on the
 * first tool. With `base`, the run's base commit holds those team repo files, by path inside it, instead.
 */
async function roleWorkspace(yaml: string, options: { tools: readonly string[]; rules?: Record<string, string>; inputs?: unknown; base?: Record<string, string> }): Promise<{ config: LocalConfig; workspace: string; runId: string }> {
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
  await syncScorersThenWorkflows(config);
  if (options.base !== undefined) {
    for (const [file, text] of Object.entries(options.base)) fs.writeFileSync(path.join(knowledge, file), text);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qam', 'team files'], workspace);
  }
  const started = await startRun(config, 'build', options.inputs ?? {}, { secrets: await knownSecrets(config), checkout: workspace, base: { ref: 'main', commit: git(['rev-parse', 'HEAD'], workspace) } });
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

  it("records for each for_each item an external driver prepared and reported the role teamai delivered into the item's copy, not the team the report names", async () => {
    const { config, runId } = await roleWorkspace(`schemaVersion: v1alpha1
name: build
description: Review each part of the change as the role that knows it.
inputs:
  parts: [{ path: string, role: string }]
steps:
  - id: review
    for_each: inputs.parts
    role: "{{ item.role }}"
    workspace: new
    prompt: Review the change to {{ item.path }}.
`, { tools: ['claude'], inputs: { parts: [{ path: 'web/', role: 'frontend' }, { path: 'api/', role: 'review' }] } });
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });
    const driver = { kind: 'external', machine: 'ci', workspace: '/work', can: { workspace: ['read-only' as const, 'new' as const, 'continue' as const], role: true } };
    const Leased = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), role: z.string() }) }) });
    // What the driver says it ran on: the member's selection, at a revision teamai did not deliver.
    const reported = { tool: { name: 'claude' }, team: { revision: 'f'.repeat(40), localChanges: false, selection: { scope: 'project' as const, primaryRole: 'frontend', additionalRoles: [] } } };

    const leased: Array<{ step: string; role: string }> = [];
    for (let at = 0; at < 2; at += 1) {
      const { lease } = Leased.parse(await client.next(runId, { driver, running: [] }, { prepare: true })).data;
      leased.push({ step: lease.step, role: lease.role });
      await client.report(runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, tool: 'claude', session: `s${at}`, agent: reported });
    }

    expect(leased).toEqual([{ step: 'review[0]', role: 'frontend' }, { step: 'review[1]', role: 'review' }]);
    const run = await readRun(config, RunIdSchema.parse(runId));
    if (typeof run !== 'object') throw new Error(`run ${run}`);
    const recorded = Object.fromEntries(['review[0]', 'review[1]'].map((id) => {
      const step = run.steps.find((state) => state.id === id);
      const team = step && 'agent' in step ? step.agent?.team : undefined;
      return [id, { stepRole: team?.selection?.stepRole, reportedRevision: team?.revision === reported.team.revision }];
    }));
    expect(recorded).toEqual({ 'review[0]': { stepRole: 'frontend', reportedRevision: false }, 'review[1]': { stepRole: 'review', reportedRevision: false } });
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
    role: review
    workspace: new
    workflow:
      steps:
        - id: first
          workspace: continue
          prompt: Review the change.
        - id: second
          needs: [first]
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

  it("leaves no empty folder of the role's delivery in a copy kept after the step failed, and keeps the one the step made", async () => {
    const { config, workspace, runId } = await roleWorkspace(REVIEW_IN_COPY, { tools: ['claude'] });
    let copy = '';

    const done = await runLocalDriver(config, runId, workspace, {
      adapter: {
        ...fakeTool(async () => undefined),
        async run(_tool, input) {
          copy = input.cwd;
          fs.mkdirSync(path.join(input.cwd, '.claude', 'skills', 'step-made'), { recursive: true });
          return { started: true, exitCode: 1 };
        },
      },
    });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(fs.existsSync(copy)).toBe(true);
    const empty = fs.readdirSync(copy, { recursive: true, encoding: 'utf8' })
      .filter((entry) => !entry.split(path.sep).includes('.git'))
      .filter((entry) => fs.lstatSync(path.join(copy, entry)).isDirectory() && fs.readdirSync(path.join(copy, entry)).length === 0);
    expect(empty).toEqual([path.join('.claude', 'skills', 'step-made')]);
  });

  it.each([
    ['names claude as its tool', REVIEW_IN_COPY.replace('    role: review\n', '    role: review\n    tool: claude\n')],
    ['names no tool and launches claude, the run\'s default', REVIEW_IN_COPY],
  ])("keeps the role out of the member's Hermes skills, which Hermes takes from the member's home, while a step that %s runs with it", async (_label, yaml) => {
    const hermesSkills = path.join(os.homedir(), '.hermes', 'skills');
    fs.mkdirSync(path.join(hermesSkills, 'mine'), { recursive: true });
    fs.writeFileSync(path.join(hermesSkills, 'mine', 'SKILL.md'), '---\nname: mine\ndescription: The member\'s own.\n---\nMine.\n');
    const { config, workspace, runId } = await roleWorkspace(yaml, { tools: ['claude', 'hermes'] });
    // The driver offers a step that names its tool only a tool on PATH; the fake tool stands in for the session.
    const bin = path.join(path.dirname(workspace), 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const snapshot = (): Record<string, string> => Object.fromEntries(fs.readdirSync(hermesSkills, { recursive: true, encoding: 'utf8' })
      .filter((entry) => fs.statSync(path.join(hermesSkills, entry)).isFile())
      .sort()
      .map((entry) => [entry, fs.readFileSync(path.join(hermesSkills, entry), 'utf8')]));
    const before = snapshot();
    const seen: { during?: Record<string, string>; copySkills?: string[] } = {};

    const done = await runLocalDriver(config, runId, workspace, {
      adapter: fakeTool(async (input) => {
        seen.during = snapshot();
        seen.copySkills = fs.readdirSync(path.join(input.cwd, '.claude', 'skills')).sort();
      }),
    });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(Object.keys(before)).toContain(path.join('fe-only', 'SKILL.md'));
    expect(seen).toEqual({ during: before, copySkills: expect.arrayContaining(['rv-only']) });
    expect(seen.copySkills).not.toContain('fe-only');
    expect(snapshot()).toEqual(before);
  });

  it("runs a command step that continues the copy for a member whose Hermes takes skills from their home, as a command launches no tool", async () => {
    const yaml = `schemaVersion: v1alpha1
name: build
description: Review the change, then run the tests in the same copy.
steps:
  - id: change
    role: review
    workspace: new
    workflow:
      steps:
        - id: look
          workspace: continue
          prompt: Review the change.
        - id: check
          needs: [look]
          workspace: continue
          command: echo checked
`;
    const { config, workspace, runId } = await roleWorkspace(yaml, { tools: ['claude', 'hermes'] });

    const done = await runLocalDriver(config, runId, workspace, { adapter: fakeTool(async () => undefined) });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it("fails the step before anything is delivered when the team's teamai.yaml cannot be loaded, as where the copy's knowledge lands is then unknown", async () => {
    const { config, workspace, runId } = await roleWorkspace(REVIEW_IN_COPY, { tools: ['claude'], base: { 'teamai.yaml': 'team: [unclosed\n' } });
    const ran: string[] = [];

    const done = await runLocalDriver(config, runId, workspace, { adapter: fakeTool(async (input) => { ran.push(input.prompt); }) });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(ran).toEqual([]);
    const run = await readRun(config, RunIdSchema.parse(runId));
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'review')).toMatchObject({
      status: 'failed', failure: { code: 'role_unavailable', message: expect.stringContaining('teamai.yaml in the team repo is missing or does not parse') },
    });
  });

  it("says the team's manifest/roles.yaml cannot be read, rather than that it declares no role, when it does not parse", async () => {
    const { config, workspace, runId } = await roleWorkspace(REVIEW_IN_COPY, { tools: ['claude'], base: { 'manifest/roles.yaml': 'roles: [unclosed\n' } });

    const done = await runLocalDriver(config, runId, workspace, { adapter: fakeTool(async () => undefined) });

    expect(done, JSON.stringify(done)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, RunIdSchema.parse(runId));
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'review')).toMatchObject({
      status: 'failed', failure: { code: 'role_unavailable', message: expect.stringMatching(/^Role review was not delivered into the copy for step "review": manifest\/roles\.yaml in the team repo cannot be read \(.+\)\. Fix it, push it and run teamai pull, then retry the step\.$/) },
    });
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
