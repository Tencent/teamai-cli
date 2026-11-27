import { describe, expect, it } from 'vitest';
import { judgeRemote, parseReapArgs, reportRemote, vercelSignIn } from './reap.js';
import type { WorldTies } from './leftovers.js';

const SELF: WorldTies = { runId: '20261112T120000-aaaaaa', paths: [], journals: ['0123456789abcdef'], runs: ['r00000000000000aa'] };
const OTHER: WorldTies = { runId: '20261112T110000-bbbbbb', paths: [], journals: ['fedcba9876543210'], runs: [] };

// The shape `Sandbox.list(...).toArray()` answers in @vercel/sandbox 3.x, trimmed to what reap reads.
const LISTED = [
  { name: 'teamai-0123456789abcdef-r00000000000000aa-a00000001', status: 'running', tags: { 'teamai-run': 'r00000000000000aa', 'teamai-attempt': 'a00000001' }, persistent: false, createdAt: 1, updatedAt: 2 },
  { name: 'teamai-fedcba9876543210-r00000000000000bb-a00000001', status: 'stopped', tags: { 'teamai-run': 'r00000000000000bb' } },
  { name: 'teamai-1111111111111111-warm-42-abc', status: 'pending' },
  { name: 'teamai-2222222222222222-r00000000000000aa-a00000002', status: 'running', tags: { 'teamai-run': 'r00000000000000aa' } },
  { name: 'someone-else', status: 'running' },
];

describe('reap', () => {
  it('takes an optional run, --delete and vercel:<name> words, and refuses anything else', () => {
    expect(parseReapArgs(['20261112T120000-aaaaaa', '--delete', 'vercel:teamai-x'])).toEqual({ ok: true, run: '20261112T120000-aaaaaa', isDeleting: true, named: ['teamai-x'] });
    expect(parseReapArgs([])).toEqual({ ok: true, run: undefined, isDeleting: false, named: [] });
    expect(parseReapArgs(['docker:x'])).toMatchObject({ ok: false });
    // reap lists only names teamai gives, so one outside them would never be found.
    expect(parseReapArgs(['--delete', 'vercel:my-box'])).toEqual({ ok: false, message: 'reap lists only the sandboxes whose names start with teamai-, so it cannot find vercel:my-box. Delete it from Vercel itself.' });
  });

  it("judges each teamai sandbox by its journal or its run's tag, and only this world's own or a named one may be deleted", () => {
    const judged = judgeRemote({ listed: LISTED, self: SELF, others: [OTHER], named: ['teamai-1111111111111111-warm-42-abc'] });

    expect(judged.map((one) => [one.name, one.attribution.kind, one.isAlive, one.isDeletable])).toEqual([
      ['teamai-0123456789abcdef-r00000000000000aa-a00000001', 'own', true, true],
      ['teamai-fedcba9876543210-r00000000000000bb-a00000001', 'other_world', false, false],
      ['teamai-1111111111111111-warm-42-abc', 'ambiguous', true, true],
      ['teamai-2222222222222222-r00000000000000aa-a00000002', 'own', true, true],
    ]);
  });

  it('exits 1 while any teamai sandbox it lists is alive, whoever it may belong to, and names whose each one is', () => {
    expect(reportRemote(judgeRemote({ listed: LISTED, self: undefined, others: [OTHER], named: [] }))).toEqual({
      lines: [
        "ALIVE vercel:teamai-0123456789abcdef-r00000000000000aa-a00000001 (teamai's, tied to no world here)",
        "ended vercel:teamai-fedcba9876543210-r00000000000000bb-a00000001 (world 20261112T110000-bbbbbb's)",
        "ALIVE vercel:teamai-1111111111111111-warm-42-abc (teamai's, tied to no world here)",
        "ALIVE vercel:teamai-2222222222222222-r00000000000000aa-a00000002 (teamai's, tied to no world here)",
      ],
      exitCode: 1,
    });
    expect(reportRemote(judgeRemote({ listed: LISTED, self: SELF, others: [], named: ['someone-else'] })).lines.at(-1)).toBe('ALIVE vercel:someone-else (named here)');
    expect(reportRemote(judgeRemote({ listed: LISTED.slice(1, 2), self: undefined, others: [OTHER], named: [] })).exitCode).toBe(0);
  });

  it('reads a Vercel sign-in from a token with its team and project, or an OIDC token, and names the variables when there is none', () => {
    expect(vercelSignIn({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team', VERCEL_PROJECT_ID: 'p' })).toEqual({ ok: true, credentials: { token: 't', teamId: 'team', projectId: 'p' } });
    expect(vercelSignIn({ VERCEL_OIDC_TOKEN: 'o' })).toEqual({ ok: true, credentials: {} });
    expect(vercelSignIn({ VERCEL_TOKEN: 't' })).toEqual({ ok: false, missing: 'VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID, or VERCEL_OIDC_TOKEN' });
  });
});
