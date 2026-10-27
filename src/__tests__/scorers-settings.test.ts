import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalConfigSchema, type LocalConfig } from '../types.js';
import { scopeScoring } from '../scorers/settings.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROLES = 'version: 1\nroles:\n'
  + '  - id: dev\n    resources: { knowledge: [], skills: [] }\n'
  + '  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops] }\n'
  + '  - id: sre\n    resources: { knowledge: [], skills: [], scorers: [sre] }\n';

function teamRepo(files: Record<string, string>, member: Partial<LocalConfig> = {}): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scoring-settings-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  for (const [file, content] of Object.entries({ 'manifest/roles.yaml': ROLES, ...files })) {
    fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
    fs.writeFileSync(path.join(knowledge, file), content);
  }
  return { repo: { localPath: knowledge, remote: 'local' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'), ...member };
}

const MACHINE = { source: 'config.yaml scoring.isolation', value: undefined };
const both = (policy: string, key: string) => ({ attended: { policy, source: { kind: 'setting', key } }, unattended: { policy, source: { kind: 'setting', key } } });
const SESSIONS_DEFAULT = { policies: { attended: { policy: 'off', source: { kind: 'default' } }, unattended: { policy: 'auto', source: { kind: 'default' } } }, dailyLimit: 10 };

describe('scopeScoring isolation', () => {
  it('reads the root file, and an active namespace file in its place; an inactive one is not read', async () => {
    const files = { 'scorers/scoring.yaml': 'isolation: best-effort\n', 'scorers/ops/scoring.yaml': 'isolation: verified\n' };

    expect(await scopeScoring(teamRepo(files, { primaryRole: 'dev' }))).toEqual({
      ok: true, batch: undefined, problems: [], isolation: [{ source: 'scorers/scoring.yaml isolation', value: 'best-effort' }, MACHINE], sessions: SESSIONS_DEFAULT,
    });
    expect(await scopeScoring(teamRepo(files, { primaryRole: 'ops' }))).toEqual({
      ok: true, batch: undefined, problems: [], isolation: [{ source: 'scorers/ops/scoring.yaml isolation', value: 'verified' }, MACHINE], sessions: SESSIONS_DEFAULT,
    });
  });

  it('keeps the isolation of every active namespace, so the strictest wins', async () => {
    const files = { 'scorers/ops/scoring.yaml': 'isolation: verified\n', 'scorers/sre/scoring.yaml': 'isolation: best-effort\n' };

    expect(await scopeScoring(teamRepo(files, { primaryRole: 'ops', additionalRoles: ['sre'] }))).toMatchObject({
      ok: true,
      isolation: [{ source: 'scorers/ops/scoring.yaml isolation', value: 'verified' }, { source: 'scorers/sre/scoring.yaml isolation', value: 'best-effort' }, MACHINE],
    });
  });

  it('fails on an active file it cannot parse, naming it, and ignores an inactive one', async () => {
    const files = { 'scorers/ops/scoring.yaml': 'isolation: [verified\n' };

    expect(await scopeScoring(teamRepo(files, { primaryRole: 'ops' }))).toEqual({
      ok: false, reason: expect.stringMatching(/^scorers\/ops\/scoring\.yaml is not valid YAML: .+\. Scoring is off in this scope until the team repo fixes it\.$/),
    });
    expect(await scopeScoring(teamRepo(files, { primaryRole: 'dev' }))).toMatchObject({ ok: true });
  });

  it('drops a key it does not know, with a problem that names the file', async () => {
    expect(await scopeScoring(teamRepo({ 'scorers/scoring.yaml': 'isolation: verified\nsampling: 50\n' }))).toMatchObject({
      ok: true, problems: ['scorers/scoring.yaml: "sampling" is not a scoring setting (batch, isolation, sessions, daily_limit), so it is ignored'],
    });
  });
});

describe('scopeScoring batch', () => {
  const files = { 'scorers/scoring.yaml': 'batch: true\n', 'scorers/ops/scoring.yaml': 'batch: false\n' };

  it('takes an active namespace batch over the root one', async () => {
    expect(await scopeScoring(teamRepo(files, { primaryRole: 'dev' }))).toMatchObject({ ok: true, batch: true });
    expect(await scopeScoring(teamRepo(files, { primaryRole: 'ops' }))).toMatchObject({ ok: true, batch: false });
  });

  it('fails when two active namespaces set batch differently, and not when they agree', async () => {
    const both = { primaryRole: 'ops', additionalRoles: ['sre'] };

    expect(await scopeScoring(teamRepo({ ...files, 'scorers/sre/scoring.yaml': 'batch: true\n' }, both))).toEqual({
      ok: false,
      reason: 'batch is false in scorers/ops/scoring.yaml and true in scorers/sre/scoring.yaml, and both namespaces are active here, so nothing '
        + 'says which one you should receive. Remove batch from one of the files, or stop declaring one of the namespaces for your roles and '
        + 'projects. Scoring is off in this scope until the team repo fixes it.',
    });
    expect(await scopeScoring(teamRepo({ ...files, 'scorers/sre/scoring.yaml': 'batch: false\n' }, both))).toMatchObject({ ok: true, batch: false });
  });

  it('ignores a batch that is not true or false, with a problem', async () => {
    expect(await scopeScoring(teamRepo({ 'scorers/scoring.yaml': 'batch: yes please\n' }))).toMatchObject({
      ok: true, batch: undefined, problems: ['scorers/scoring.yaml: batch is "yes please", not true or false, so it is ignored'],
    });
  });
});

describe('scopeScoring sessions', () => {
  /** `config.yaml` `scoring`, read as teamai reads the file. */
  const member = (scoring: Record<string, unknown>): Partial<LocalConfig> => ({ scoring: LocalConfigSchema.shape.scoring.parse(scoring) });

  it('scores no attended session and every unattended one when nothing sets sessions', async () => {
    expect(await scopeScoring(teamRepo({}))).toMatchObject({
      ok: true,
      problems: [],
      sessions: { policies: { attended: { policy: 'off', source: { kind: 'default' } }, unattended: { policy: 'auto', source: { kind: 'default' } } }, dailyLimit: 10 },
    });
  });

  it.each([
    ['sessions: true takes the built-in daily limit', { sessions: true }, { policies: both('auto', 'config.yaml scoring.sessions'), dailyLimit: 10 }],
    ['daily_limit sets how many sessions a day may lease', { sessions: true, daily_limit: 3 }, { policies: both('auto', 'config.yaml scoring.sessions'), dailyLimit: 3 }],
    ['daily_limit: 0 turns session scoring off', { sessions: true, daily_limit: 0 }, { policies: both('off', 'config.yaml scoring.daily_limit'), dailyLimit: 0 }],
  ])('%s', async (_, scoring, sessions) => {
    expect(await scopeScoring(teamRepo({}, member(scoring)))).toMatchObject({ ok: true, problems: [], sessions });
  });

  it('lets a member mapping override the team one mode at a time, and reports a mode value it cannot use', async () => {
    const files = { 'scorers/scoring.yaml': 'sessions: true\n' };
    expect(await scopeScoring(teamRepo(files, member({ sessions: { attended: 'ask', unattended: 'yes' } })))).toMatchObject({
      problems: ['config.yaml scoring.sessions.unattended is "yes", not off, ask or auto, so it is ignored'],
      sessions: { policies: { attended: { policy: 'ask', source: { kind: 'setting', key: 'config.yaml scoring.sessions.attended' } }, unattended: { policy: 'auto', source: { kind: 'setting', key: 'scorers/scoring.yaml sessions' } } } },
    });
  });

  it('reports a daily_limit that is not a whole number of 0 or more, and keeps the built-in one', async () => {
    expect(await scopeScoring(teamRepo({}, member({ sessions: true, daily_limit: -2 })))).toMatchObject({
      ok: true,
      problems: ['config.yaml scoring.daily_limit is -2, not a whole number of 0 or more, so it is ignored'],
      sessions: { policies: both('auto', 'config.yaml scoring.sessions'), dailyLimit: 10 },
    });
  });
});

describe('scopeScoring team session defaults', () => {
  const ops = { primaryRole: 'ops', additionalRoles: ['sre'] };

  it('takes sessions and daily_limit from scorers/scoring.yaml when the member sets neither', async () => {
    expect(await scopeScoring(teamRepo({ 'scorers/scoring.yaml': 'sessions: true\ndaily_limit: 4\n' }))).toMatchObject({
      problems: [], sessions: { policies: both('auto', 'scorers/scoring.yaml sessions'), dailyLimit: 4 },
    });
  });

  it('lets an active namespace file override the root file, with the lowest limit of them all', async () => {
    const files = { 'scorers/scoring.yaml': 'sessions: true\ndaily_limit: 4\n', 'scorers/ops/scoring.yaml': 'daily_limit: 2\n', 'scorers/sre/scoring.yaml': 'daily_limit: 3\n' };
    expect(await scopeScoring(teamRepo(files, ops))).toMatchObject({ sessions: { policies: both('auto', 'scorers/scoring.yaml sessions'), dailyLimit: 2 } });
  });

  it('turns sessions off when any active namespace file sets sessions: false', async () => {
    const files = { 'scorers/ops/scoring.yaml': 'sessions: true\n', 'scorers/sre/scoring.yaml': 'sessions: false\n' };
    expect(await scopeScoring(teamRepo(files, ops))).toMatchObject({ sessions: { policies: both('off', 'scorers/sre/scoring.yaml sessions') } });
  });

  it('lets the member override the team', async () => {
    const files = { 'scorers/scoring.yaml': 'sessions: true\n', 'scorers/ops/scoring.yaml': 'daily_limit: 2\n' };
    expect(await scopeScoring(teamRepo(files, { primaryRole: 'ops', scoring: { sessions: false } }))).toMatchObject({
      sessions: { policies: both('off', 'config.yaml scoring.sessions') },
    });
    expect(await scopeScoring(teamRepo(files, { primaryRole: 'ops', scoring: { daily_limit: 5 } }))).toMatchObject({ sessions: { policies: both('auto', 'scorers/scoring.yaml sessions'), dailyLimit: 5 } });
  });

  it('resolves each mode on its own: a partial mapping leaves the other mode to the next level', async () => {
    const files = { 'scorers/scoring.yaml': 'sessions: { attended: ask }\n', 'scorers/ops/scoring.yaml': 'sessions: { unattended: off }\n' };
    expect(await scopeScoring(teamRepo(files, { primaryRole: 'ops' }))).toMatchObject({
      problems: [],
      sessions: { policies: { attended: { policy: 'ask', source: { kind: 'setting', key: 'scorers/scoring.yaml sessions.attended' } }, unattended: { policy: 'off', source: { kind: 'setting', key: 'scorers/ops/scoring.yaml sessions.unattended' } } } },
    });
  });

  it('takes the most restrictive policy of the active namespace files, mode by mode', async () => {
    const files = {
      'scorers/scoring.yaml': 'sessions: false\n',
      'scorers/ops/scoring.yaml': 'sessions: { attended: auto, unattended: ask }\n',
      'scorers/sre/scoring.yaml': 'sessions: { attended: ask, unattended: auto }\n',
    };
    expect(await scopeScoring(teamRepo(files, ops))).toMatchObject({
      sessions: { policies: { attended: { policy: 'ask', source: { kind: 'setting', key: 'scorers/sre/scoring.yaml sessions.attended' } }, unattended: { policy: 'ask', source: { kind: 'setting', key: 'scorers/ops/scoring.yaml sessions.unattended' } } } },
    });
  });

  it('reports a team value it cannot use, and ignores it', async () => {
    expect(await scopeScoring(teamRepo({ 'scorers/scoring.yaml': 'sessions: yes please\ndaily_limit: many\n' }))).toMatchObject({
      problems: [
        'scorers/scoring.yaml sessions is "yes please", not true, false or a mapping of attended and unattended to off, ask or auto, so it is ignored',
        'scorers/scoring.yaml: daily_limit is "many", not a whole number of 0 or more, so it is ignored',
      ],
      sessions: SESSIONS_DEFAULT,
    });
  });
});
