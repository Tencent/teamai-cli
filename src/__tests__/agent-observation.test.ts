import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isNameShaped,
  observeLaunch,
  parseReportedAgent,
  readRecordedAgent,
  settleObservation,
  type ReportedAgent,
} from '../agent-observation.js';
import { getCurrentVersion } from '../package-info.js';
import type { LocalConfig } from '../types.js';
import { commitFile, fakeClaude, git, initRepo, recordDelivery } from './helpers/delivered-checkout.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const FULL = 'a'.repeat(40);

describe('settleObservation (#1176)', () => {
  const complete: ReportedAgent = {
    tool: { version: '2.1.301' },
    model: { requested: 'claude-opus-4-1', alias: 'opus' },
    team: { revision: FULL, localChanges: false },
    project: { commit: 'b'.repeat(40), dirty: false },
  };
  const settle = (agent: ReportedAgent | undefined, overrides: Partial<Parameters<typeof settleObservation>[0]> = {}) =>
    settleObservation({ agent, tool: 'claude', driver: { kind: 'local' }, ...overrides }, 'reviewer');

  it('stamps what the engine owns and derives tool.name and model.reported from the flat report', () => {
    const settled = settle({ ...complete, definition: { applied: 'main' } }, { model: 'claude-opus-4-1-20250805' });

    expect(settled).toMatchObject({
      v: 1,
      definition: { name: 'reviewer', applied: 'main' },
      tool: { name: 'claude', version: '2.1.301' },
      model: { requested: 'claude-opus-4-1', reported: 'claude-opus-4-1-20250805', alias: 'opus' },
      teamai: getCurrentVersion(),
      driver: 'local',
    });
    expect(settled?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is undefined without a reported agent or a name-shaped tool', () => {
    expect(settle(undefined)).toBeUndefined();
    expect(settle(complete, { tool: '/usr/local/bin/claude' })).toBeUndefined();
  });

  it('has no definition on a step without agent:', () => {
    const settled = settleObservation({ agent: { ...complete, definition: { applied: 'main' } }, tool: 'claude', driver: { kind: 'local' } }, undefined);

    expect(settled).not.toHaveProperty('definition');
  });

  it('drops values not shaped like a name and ignores engine-owned keys a driver sends', () => {
    const settled = settle(parseReportedAgent({
      ...complete,
      tool: { version: '/usr/bin/claude' },
      model: { requested: 'see https://example.com' },
      effort: { requested: 'high effort please', reported: 'high' },
      team: { revision: 'not-a-commit', localChanges: false },
      teamai: '0.0.1',
      driver: 'spoofed',
      definition: { name: 'spoofed', applied: 'prompt' },
      fingerprint: 'f'.repeat(64),
    }) as ReportedAgent);

    expect(settled).toEqual({
      v: 1,
      definition: { name: 'reviewer', applied: 'prompt' },
      tool: { name: 'claude' },
      effort: { reported: 'high' },
      project: { commit: 'b'.repeat(40), dirty: false },
      teamai: getCurrentVersion(),
      driver: 'local',
    });
  });

  it('takes the tool and the reported model from the agent a driver sends without the flat fields, and the flat ones first', () => {
    const nested = parseReportedAgent({ ...complete, tool: { name: 'codex', version: '0.46.0' }, model: { reported: 'gpt-5' } }) as ReportedAgent;

    expect(settle(nested, { tool: undefined })).toMatchObject({ tool: { name: 'codex', version: '0.46.0' }, model: { reported: 'gpt-5' } });
    const flat = settle(nested, { tool: 'claude', model: 'claude-opus-4-1' });
    expect(flat?.tool).toEqual({ name: 'claude' });
    expect(flat?.model).toMatchObject({ reported: 'claude-opus-4-1' });
  });

  it('keeps a model with a provider prefix, and no tool, version or effort that holds a path', () => {
    const settled = settle({ ...complete, tool: { version: 'home/alice/bin/claude' }, effort: { requested: 'team/high' } },
      { model: 'anthropic/claude-sonnet-4.6@2026' });

    expect(settled).toMatchObject({ tool: { name: 'claude' }, model: { reported: 'anthropic/claude-sonnet-4.6@2026' } });
    expect(settled?.tool).not.toHaveProperty('version');
    expect(settled).not.toHaveProperty('effort');
    expect(settle(complete, { tool: 'bin/claude' })).toBeUndefined();
  });

  it('fingerprints equal parts alike, whatever their key order', () => {
    const reordered: ReportedAgent = {
      project: { dirty: true, commit: 'c'.repeat(40) },
      team: { localChanges: false, revision: FULL },
      model: { alias: 'opus', requested: 'claude-opus-4-1' },
      tool: { version: '2.1.301' },
    };

    expect(settle(reordered, { driver: { kind: 'other' } })?.fingerprint).toBe(settle(complete)?.fingerprint);
  });

  it('fingerprints a different model differently, and a requested model unlike the same reported one', () => {
    const base = settle(complete)?.fingerprint;

    expect(settle({ ...complete, model: { requested: 'claude-sonnet-4-5', alias: 'opus' } })?.fingerprint).not.toBe(base);
    expect(settle({ ...complete, model: undefined }, { model: 'claude-opus-4-1' })?.fingerprint)
      .not.toBe(settle({ ...complete, model: { requested: 'claude-opus-4-1' } })?.fingerprint);
  });

  it('writes no fingerprint without a model, a team, or with local changes', () => {
    expect(settle({ ...complete, model: { alias: 'opus' } })).not.toHaveProperty('fingerprint');
    expect(settle({ ...complete, team: undefined })).not.toHaveProperty('fingerprint');
    expect(settle({ ...complete, team: { revision: FULL, localChanges: true } })).not.toHaveProperty('fingerprint');
  });
});

describe('parseReportedAgent (#1176)', () => {
  it('rejects a wrong JSON type with the field it names', () => {
    expect(parseReportedAgent('reviewer')).toBe('agent must be an object');
    expect(parseReportedAgent({ tool: { version: 2 } })).toBe('agent.tool.version must be a string');
    expect(parseReportedAgent({ team: { revision: FULL, localChanges: 'no' } })).toBe('agent.team.localChanges must be a boolean');
  });
});

describe('readRecordedAgent (#1176)', () => {
  it('reads an older string agent as its definition', () => {
    expect(readRecordedAgent('reviewer')).toEqual({ definition: { name: 'reviewer' } });
  });

  it('reads an observation as it is, and anything else as nothing', () => {
    const observation = settleObservation({ agent: {}, tool: 'claude', driver: { kind: 'local' } }, 'reviewer');

    expect(readRecordedAgent(observation)).toEqual(observation);
    expect(readRecordedAgent({ definition: { name: 'reviewer' } })).toEqual({ definition: { name: 'reviewer' } });
    expect(readRecordedAgent({ v: 2, tool: { name: 'claude' } })).toBeUndefined();
    expect(readRecordedAgent(7)).toBeUndefined();
  });
});

describe('isNameShaped', () => {
  it('accepts model names and rejects paths, URLs and text', () => {
    expect(isNameShaped('anthropic/claude-sonnet-4.6@2026')).toBe(true);
    expect(isNameShaped('2.1.301')).toBe(true);
    for (const value of ['/usr/bin/claude', 'C:\\claude', 'https://x', '../x', 'two words', '']) {
      expect(isNameShaped(value)).toBe(false);
    }
  });
});

describe('observeLaunch (#1176)', () => {
  function checkout(): { config: LocalConfig; root: string; project: string; rev: string; skill: string; agent: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-observe-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const team = path.join(root, 'team');
    const project = path.join(root, 'project');
    initRepo(team);
    initRepo(project);
    const rev = commitFile(team, 'agents/reviewer.yaml');
    commitFile(project, 'README.md');
    const skill = path.join(project, '.claude', 'skills', 'review', 'SKILL.md');
    const agent = path.join(project, '.claude', 'agents', 'reviewer.md');
    for (const file of [skill, agent]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${path.basename(file)}\n`);
    }
    const config: LocalConfig = {
      repo: { localPath: team, remote: 'local', kind: 'git' },
      username: 'tester',
      scope: 'project',
      additionalRoles: [],
      projectRoot: project,
      dataHome: path.join(root, 'data'),
    };
    return { config, root, project, rev, skill, agent };
  }

  const agentModels = { reviewer: { claude: { step: 'alias', model: 'claude-opus-4-1', effort: 'high', alias: 'opus' } } };

  it('observes a complete delivery, the requested model, the tool version and the project head, and no effort from the agent file', async () => {
    const { config, root, project, rev, skill, agent } = checkout();
    cleanups.push(fakeClaude(root, '2.1.301'));
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill, agent], agentModels });

    expect(await observeLaunch({
      config, tool: 'claude', cwd: project,
      definition: { stem: 'reviewer', file: agent },
    })).toEqual({
      tool: { version: '2.1.301' },
      model: { requested: 'claude-opus-4-1', alias: 'opus' },
      team: { revision: rev, localChanges: false },
      project: { commit: git(project, 'rev-parse', 'HEAD'), dirty: false },
    });
  });

  it('reports local changes after a delivered file is edited', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
    fs.appendFileSync(skill, 'edited\n');

    expect((await observeLaunch({ config, tool: 'claude', cwd: project })).team).toEqual({ revision: rev, localChanges: true });
  });

  it('requests no model after the deployed agent file is edited', async () => {
    const { config, project, rev, agent } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [agent], agentModels });
    fs.writeFileSync(agent, 'model: another\n');

    const observed = await observeLaunch({ config, tool: 'claude', cwd: project, definition: { stem: 'reviewer', file: agent } });

    expect(observed).not.toHaveProperty('model');
    expect(observed).not.toHaveProperty('effort');
  });

  it('requests the model the launch passes on argv for a definition', async () => {
    const { config, project, rev, agent } = checkout();
    const codexModels = { reviewer: { codex: { step: 'alias', model: 'gpt-5', alias: 'smart', effort: 'high' } } };
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['codex'], files: [agent], agentModels: codexModels });
    const launch = { config, tool: 'codex', cwd: project };

    expect(await observeLaunch({ ...launch, definition: { stem: 'reviewer', file: agent, model: 'gpt-5' } }))
      .toMatchObject({ model: { requested: 'gpt-5', alias: 'smart' } });
    const edited = await observeLaunch({ ...launch, definition: { stem: 'reviewer', file: agent, model: 'gpt-4' } });
    expect(edited.model).toEqual({ requested: 'gpt-4' });
    expect(edited).not.toHaveProperty('effort');
  });

  it('names no team for a record whose push base is another commit', async () => {
    const { config, project, rev } = checkout();
    const later = commitFile(config.repo.localPath, 'agents/other.yaml');
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], pushBaseRevs: [later] });

    expect(await observeLaunch({ config, tool: 'claude', cwd: project })).not.toHaveProperty('team');
  });

  it('never reports claude\'s version under another tool\'s name', async () => {
    const { config, root, project } = checkout();
    cleanups.push(fakeClaude(root, '2.1.301'));

    expect(await observeLaunch({ config, tool: 'tclaude', cwd: project })).not.toHaveProperty('tool');
  });

  it('leaves out what it cannot observe outside a checkout', async () => {
    const { config, root } = checkout();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);

    expect(await observeLaunch({ config, tool: 'tclaude', cwd: outside })).toEqual({});
  });
});
