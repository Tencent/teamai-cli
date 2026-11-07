/**
 * The session-start MR hint offers teamai-import-from-mr, and describe proposes, to the session it offered, the MRs the
 * hint listed and the run `teamai import --from-mr` starts.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeMrHintOutput } from '../mr-hint.js';
import { skillHarness } from './helpers/skill-harness.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SESSION = '7c1e-session';
const SESSION_CALL = { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' }, session: SESSION, tool: 'claude' } as const;
const PR7 = 'https://github.com/acme/app/pull/7';
const PR8 = 'https://github.com/acme/app/pull/8';

/** A member's checkout of acme/app, whose `gh` lists PRs 7 and 8 as merged today. */
async function memberOfAcme(teamFiles: Record<string, string> = {}) {
  const harness = await skillHarness({}, { teamFiles });
  roots.push(harness.root);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: harness.work });
  const bin = path.join(harness.root, 'bin');
  fs.mkdirSync(bin);
  const merged = JSON.stringify([7, 8].map((number) => ({ number, title: `Change ${number}`, url: `https://github.com/acme/app/pull/${number}`, mergedAt: new Date().toISOString() })));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr list" ] && echo '${merged}'\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('TEAMAI_MR_HINT_CWD', harness.work);
  vi.stubEnv('TEAMAI_MR_HINT_DISABLED', '');

  return harness;
}

type Harness = Awaited<ReturnType<typeof memberOfAcme>>;

/** The hint the SessionStart hook gives session `sessionId`, launched by `launchedBy` when given. */
async function hint(harness: Harness, sessionId: string, launchedBy?: string): Promise<string> {
  const output = await computeMrHintOutput('en', harness.config, { sessionId, cwd: harness.work, run: { runMode: 'attended', ...(launchedBy ? { launchedBy } : {}) } });

  return JSON.parse(output ?? 'null').hookSpecificOutput.additionalContext;
}

async function proposedInputs(harness: Harness, caller: Parameters<Harness['call']>[1] = SESSION_CALL): Promise<unknown[]> {
  const described = await harness.call({ kind: 'describe', name: 'teamai-import-from-mr' }, caller);
  if (!('data' in described) || !('describe' in described.data) || described.data.describe.ask.kind !== 'ask') throw new Error(JSON.stringify(described));

  return described.data.describe.ask.question.inputs;
}

describe('the session-start MR hint and describe of teamai-import-from-mr', () => {
  it('offers the workflow, and describe proposes the MRs it listed and the run that publishes what the person accepts', async () => {
    const harness = await memberOfAcme();

    expect(await hint(harness, SESSION)).toBe([
      '[teamai:mr-hint] Found 2 recently merged MR(s) not yet imported into the team knowledge base.',
      '',
      'After this task, offer the user to turn these MRs into learnings with the teamai-import-from-mr workflow. Its describe proposes these MRs:',
      '',
      `- Change 7 (merged: ${new Date().toISOString().slice(0, 10)}) ${PR7}`,
      `- Change 8 (merged: ${new Date().toISOString().slice(0, 10)}) ${PR8}`,
      '',
      '  teamai workflow start --describe teamai-import-from-mr --driver skill',
    ].join('\n'));
    expect(await proposedInputs(harness)).toEqual([
      { name: 'mrs', type: { type: 'array', items: { type: 'string' } }, value: [PR7, PR8], why: 'The merged MRs the session-start hint listed in this session.' },
      { name: 'all', type: { type: 'boolean' }, value: false, why: 'Ask the person to accept, edit or skip each draft. true publishes every draft unasked.' },
      { name: 'publish', type: { type: 'boolean' }, value: true, why: 'Publish the drafts the person accepts to the team repository. false writes and pushes nothing, so the drafts are only the run\'s outputs.' },
      { name: 'dir', type: { type: 'string' }, value: harness.config.repo.localPath, why: 'The team repository the learnings are published to.' },
      { name: 'output', type: { type: 'boolean' }, value: false, why: 'Publish into the team repository. true writes each draft into dir as a file instead.' },
      { name: 'discussions', type: { type: 'boolean' }, value: true, why: 'Read each MR\'s review threads, which carry what the review decided.' },
      { name: 'language', type: { type: 'enum', values: ['en', 'zh'] }, value: 'zh', why: 'teamai.yaml sets no language, so the learnings are written in zh, as teamai import --from-mr writes them.' },
    ]);
  });

  it('proposes no MRs to a session the hint offered none, and the language teamai.yaml sets', async () => {
    const harness = await memberOfAcme({ 'teamai.yaml': 'team: t\nrepo: r\nlanguage: en\n' });
    await hint(harness, 'another-session');

    const [mrs, ...rest] = await proposedInputs(harness);

    expect(mrs).toEqual({ name: 'mrs', type: { type: 'array', items: { type: 'string' } }, why: 'No value: the session-start hint listed no merged MR in this session. Give the MR or PR URLs.' });
    expect(rest.at(-1)).toEqual({ name: 'language', type: { type: 'enum', values: ['en', 'zh'] }, value: 'en', why: 'The language teamai.yaml sets, which the learnings are written in.' });
    expect(await proposedInputs(harness, { session: undefined })).toContainEqual({ name: 'mrs', type: { type: 'array', items: { type: 'string' } }, why: 'No agent session found: give the MR or PR URLs.' });
  });

  it('keeps proposing to a session the MRs it was offered after another session of the repository is offered newer ones', async () => {
    const harness = await memberOfAcme();
    await hint(harness, SESSION);
    const merged = JSON.stringify([7, 8, 9].map((number) => ({ number, title: `Change ${number}`, url: `https://github.com/acme/app/pull/${number}`, mergedAt: new Date().toISOString() })));
    fs.writeFileSync(path.join(harness.root, 'bin', 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr list" ] && echo '${merged}'\n`, { mode: 0o755 });
    await hint(harness, 'another-session');

    expect((await proposedInputs(harness))[0]).toMatchObject({ name: 'mrs', value: [PR7, PR8] });
    expect((await proposedInputs(harness, { ...SESSION_CALL, session: 'another-session' }))[0]).toMatchObject({ name: 'mrs', value: ['https://github.com/acme/app/pull/9'] });
  });

  it('reads the offer a cache of one offered session holds', async () => {
    const harness = await memberOfAcme();
    await hint(harness, 'another-session');
    const cache = path.join(harness.root, 'home', '.teamai', 'sessions', 'mr-hint-acme_app.json');
    const written = JSON.parse(fs.readFileSync(cache, 'utf-8'));
    fs.writeFileSync(cache, JSON.stringify({ ...written, offered: { session: SESSION, urls: [PR8] } }));

    expect((await proposedInputs(harness))[0]).toMatchObject({ name: 'mrs', value: [PR8] });
  });

  it('names the command, and offers no run, in a session teamai launched', async () => {
    const harness = await memberOfAcme();

    const text = await hint(harness, SESSION, 'workflow');

    expect(text).toContain(`  teamai import --from-mr ${PR7} ${PR8}`);
    expect(text).not.toContain('teamai-import-from-mr');
    expect((await proposedInputs(harness))[0]).toMatchObject({ name: 'mrs', why: 'No value: the session-start hint listed no merged MR in this session. Give the MR or PR URLs.' });
  });
});
