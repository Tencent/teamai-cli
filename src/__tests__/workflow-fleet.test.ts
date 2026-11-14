import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { leaseNext, startRun } from '../workflow/engine.js';
import { answerCancel, answerQuestion, cancelAttempt, claimAttempt, expireClaim, finishAttempt, lastGoneWork, leaveOffer, leaseEnv, leaseValues, listOpenAttempts, listRecords, markOffered, offerAttempt, offersAmong, readAttemptRecord, readOfferedMarker, recordProgress, woken, type FleetRecord, type HeldAttempt } from '../workflow/fleet/record.js';
import { startGroupedCommand } from '../workflow/shell-command.js';
import { publishRun } from '../workflow/handoff.js';
import { definitionHash } from '../workflow/snapshot.js';
import { attemptDir, AttemptIdSchema, installOwner, readRun, RunIdSchema, runFilePath, runScratchDir, takeRunLock, type AttemptId, type RunId } from '../workflow/store.js';
import { memberPlace, takeFleetAttempt, type MemberPlace } from '../workflow/fleet/member.js';
import { homeEnvOf, type OpenedDriver, type OpenedRuntime } from '../workflow/runtimes/sources.js';
import { CANCEL_WRITE_MS, cancelFleetAttempt, fleetStepRuntime, shadowedFleetEntries } from '../workflow/fleet/owner.js';
import { RuntimeOptionsSchema, WAKE_COMMAND, type PlaceView } from '@teamai/runtime-protocol';
import { hostStepRuntime } from '../workflow/runtimes/host.js';
import { newOpId, type StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { DriverCan } from '../workflow/requirements.js';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import { TOY_RUNTIME } from './helpers/toy-runtime.js';
import type { OpId } from '@teamai/runtime-protocol';
import { attemptRuntimePath, attemptToolHome } from '../workflow/runtimes/attempt.js';
import { holdLoginFrom, loginHolder } from '../workflow/runtimes/login.js';
import { readableReportsWorktree, reportsBranch, updateReports } from '../utils/reports-branch.js';
import { acquireLock, releaseLock } from '../update.js';
import { REPORTS_LOCK_FILENAME } from '../types.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { dirs, git, receiveHook, start, startIn, team, WORKSPACES, type Member } from './helpers/workflow-handoff-fixture.js';
import { fakeAgent, type FakeAgent } from '@teamai/tool-testing/fake-agent';
import { claudeFake } from '@teamai/tool-claude/testing';
import os from 'node:os';
import { openSessionArchive } from '../session-flow/archive.js';
import { log } from '@teamai/shared/log';
import { sessionArchiveRoot } from '../session-flow/session-cmd-shared.js';
import { getRepoIdentity, SyncManager } from '../session-flow/sync.js';
import { getDataHome } from '../types.js';
import { sweepLeftovers } from '../workflow/leftovers.js';
import { entriesUnder } from '@teamai/shared/entries-under';
import { scratchHostRuntime } from './helpers/host-runtime.js';

/** A member that runs every step here, as `--driver local` does. */
const HERE: MemberPlace = { command: { kind: 'here' }, prompt: { kind: 'here' } };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const RUN = RunIdSchema.parse('r0123abcd');
const ATTEMPT = AttemptIdSchema.parse('a0123abcd');
const LEASE: { kind: 'command'; step: string; command: string; env: Record<string, string> } = { kind: 'command', step: 'build', command: 'npm run build', env: { MODE: 'ci' } };

async function offer(owner: Member, input: { secrets?: Record<string, string>; lease?: typeof LEASE; start?: string } = {}) {
  return offerAttempt(owner.config, {
    run: RUN, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(owner.config),
    start: input.start ?? 'f'.repeat(40), staleAfterMs: 60_000, lease: input.lease ?? LEASE, secrets: input.secrets ?? {},
    definition: { name: 'build', sourceHash: 'a'.repeat(64), definitionHash: 'b'.repeat(64) }, values: {},
  });
}

describe('fleet attempts on teamai-reports', () => {
  it('lets one of two members claim an offer, and tells the other the attempt moved', async () => {
    const acme = team();
    const [alice, bob, carol] = [await acme.member('alice'), await acme.member('bob'), await acme.member('carol')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);

    const [first, second] = [await claimAttempt(bob.config, offered.value, await installOwner(bob.config)), await claimAttempt(carol.config, offered.value, await installOwner(carol.config))];

    expect(first).toMatchObject({ ok: true, value: { state: 'claimed', member: { user: 'bob' } } });
    expect(second).toMatchObject({ ok: false, error: { code: 'state_moved' } });
    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toMatchObject({ ok: true, value: { state: 'claimed', member: { user: 'bob' } } });
  });

  it('reads a record a newer teamai wrote in a format of its own as one to upgrade for, and offers it to no member here', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, version: 3, teamai: '9.1.0', shape: 'new' }));

      return { value: undefined, write: { files: [rel], message: 'a newer record' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toEqual({ ok: false, error: {
      code: 'fleet_record_newer',
      message: `The record of attempt ${ATTEMPT} of run ${RUN} on teamai-reports was written by teamai 9.1.0, in a format this teamai cannot read. Upgrade teamai to 9.1.0 or later.`,
    } });
    expect(offersAmong(await listRecords(bob.config), { pool: 'default', repository: 'github.com/acme/business' })).toEqual([]);
  });

  it('warns once per pass of a member about a record a newer teamai wrote, which it skips', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, version: 3, teamai: '9.1.0', shape: 'new' }));

      return { value: undefined, write: { files: [rel], message: 'a newer record' } };
    });
    await readableReportsWorktree(bob.config);
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});

    try {
      expect(await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE })).toEqual({ data: { idle: { offered: 0 } } });
      expect(warned.mock.calls.filter(([line]) => String(line).startsWith('Skipped an attempt:'))).toEqual([[`Skipped an attempt: The record of attempt ${ATTEMPT} of run ${RUN} on teamai-reports was written by teamai 9.1.0, in a format this teamai cannot read. Upgrade teamai to 9.1.0 or later.`]]);
    } finally {
      warned.mockRestore();
    }
  });

  it('writes the teamai version that wrote a record into it', async () => {
    const acme = team();
    const offered = await offer(await acme.member('alice'));

    expect(offered).toMatchObject({ ok: true, value: { version: 2, teamai: expect.stringMatching(/^\d+\.\d+\.\d+/) } });
  });

  it('names the kind of step a lease runs, and reads no lease whose kind its fields do not match', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    await readableReportsWorktree(bob.config);
    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toMatchObject({ ok: true, value: { lease: { kind: 'command', step: 'build', command: 'npm run build' } } });
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, lease: { ...offered.value.lease, kind: 'prompt' } }));

      return { value: undefined, write: { files: [rel], message: 'a lease of another kind' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toMatchObject({ ok: false, error: { code: 'fleet_record_unreadable' } });
  });

  it('takes a record that holds a field its format does not name, at the top, nested or in a list, and keeps one outside a list when it writes the record again', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    const newer = { hint: 'a note for people', lease: { ...offered.value.lease, workflow: true }, owner: { ...offered.value.owner, host: 'ci-7' } };
    const left = [{ member: { id: 'm1', user: 'carol', host: 'ci-8' }, why: 'no gpu', at: '2026-11-12T00:00:00.000Z', seen: 2 }];
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, teamai: '9.1.0', ...newer, left }));

      return { value: undefined, write: { files: [rel], message: 'a record with fields of a newer teamai' } };
    });
    await readableReportsWorktree(bob.config);

    const [taken] = offersAmong(await listRecords(bob.config), { pool: 'default', repository: 'github.com/acme/business' });
    if (taken === undefined) throw new Error('bob read no offer');
    const claimed = await claimAttempt(bob.config, taken, await installOwner(bob.config));

    expect(claimed).toMatchObject({ ok: true });
    const published: unknown = JSON.parse(fs.readFileSync(path.join(await readableReportsWorktree(alice.config), rel), 'utf8'));
    expect(published).toMatchObject({ state: 'claimed', ...newer, left: [{ member: { id: 'm1', user: 'carol' }, why: 'no gpu' }] });
  });

  // A prompt lease's `limits` is a field this teamai knows, but not on a command lease, which would run without it.
  it.each([['sandbox', 'strict'], ['limits', { turns: 3 }]])('refuses a record that names a field this teamai does not know among those its reader must understand, naming the teamai that wrote it: lease.%s', async (field, value) => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, teamai: '9.1.0', critical: ['lease.command', `lease.${field}`], lease: { ...offered.value.lease, [field]: value } }));

      return { value: undefined, write: { files: [rel], message: 'a record with a field its reader must understand' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toEqual({ ok: false, error: {
      code: 'fleet_record_newer',
      message: `The record of attempt ${ATTEMPT} of run ${RUN} on teamai-reports was written by teamai 9.1.0, and needs "lease.${field}", which this teamai does not know. Upgrade teamai to 9.1.0 or later.`,
    } });
    expect(offersAmong(await listRecords(bob.config), { pool: 'default', repository: 'github.com/acme/business' })).toEqual([]);
  });

  it('reads a record whose fields its reader must understand are all ones this teamai knows', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, critical: ['lease.command', 'left.why', 'result.failure.code'] }));

      return { value: undefined, write: { files: [rel], message: 'a record whose critical fields are known' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toMatchObject({ ok: true, value: { state: 'offered', critical: ['lease.command', 'left.why', 'result.failure.code'] } });
  });

  it('reads no record whose definition holds a key it does not name: a definition is pinned content', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, definition: { ...offered.value.definition, variant: 'b' } }));

      return { value: undefined, write: { files: [rel], message: 'a definition with a key of its own' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toMatchObject({ ok: false, error: { code: 'fleet_record_unreadable' } });
  });

  it('reads a record an older teamai wrote in the format before this one as one its writer, owner or member, upgrades for', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, version: 1, teamai: '0.21.0' }));

      return { value: undefined, write: { files: [rel], message: 'an older record' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toEqual({ ok: false, error: {
      code: 'fleet_record_unreadable',
      message: `The record of attempt ${ATTEMPT} of run ${RUN} on teamai-reports was written by teamai 0.21.0, in an older format this teamai does not read. Upgrade the teamai 0.21.0 that wrote it, on the owner's or a member's machine.`,
    } });
    expect(offersAmong(await listRecords(bob.config), { pool: 'default', repository: 'github.com/acme/business' })).toEqual([]);
  });

  it('lists only the offers of the pool and repository asked for, and no claimed one', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    await readableReportsWorktree(bob.config);

    expect(offersAmong(await listRecords(bob.config), { pool: 'default', repository: 'github.com/acme/business' })).toMatchObject([{ attempt: ATTEMPT }]);
    expect(offersAmong(await listRecords(bob.config), { pool: 'gpu', repository: 'github.com/acme/business' })).toEqual([]);
    expect(offersAmong(await listRecords(bob.config), { pool: 'default', repository: 'github.com/acme/other' })).toEqual([]);
  });

  it('keeps a member that went quiet from writing once the owner gave its claim up', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);

    expect(await expireClaim(alice.config, claimed.value)).toMatchObject({ ok: true, value: { state: 'expired' } });
    expect(await recordProgress(bob.config, claimed.value, 'e'.repeat(40))).toMatchObject({ ok: false, error: { code: 'state_moved' } });
    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toMatchObject({ ok: true, value: { state: 'expired', pushed: 'f'.repeat(40) } });
  });

  it('keeps a finished step\'s result when its stderr names a path of the member\'s machine, and leaves that stderr out', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);

    await finishAttempt(bob.config, claimed.value, { exitCode: 0, stderr: 'warning: cache at /home/bob/.cache/build is stale', to: 'e'.repeat(40), outputs: { built: true } }, {});

    const finished = await readAttemptRecord(alice.config, RUN, ATTEMPT);
    expect(finished).toMatchObject({ ok: true, value: { state: 'finished', result: { exitCode: 0, to: 'e'.repeat(40), outputs: { built: true } } } });
    expect(JSON.stringify(finished)).not.toContain('/home/bob');
  });

  it('keeps a prompt step\'s failure code and usage when its message names a path of the member\'s machine, and leaves that message out', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);

    await finishAttempt(bob.config, claimed.value, { exitCode: 1, stderr: '', tool: 'claude', tokens: { input: 10, output: 2 }, failure: { code: 'tool_failed', message: 'claude could not read /home/bob/.claude/settings.json' } }, {});

    const finished = await readAttemptRecord(alice.config, RUN, ATTEMPT);
    expect(finished).toMatchObject({ ok: true, value: { state: 'finished', result: { exitCode: 1, tool: 'claude', tokens: { input: 10, output: 2 }, failure: { code: 'tool_failed' } } } });
    expect(JSON.stringify(finished)).not.toContain('/home/bob');
  });

  it('lists the attempts out for a business repository, with who claimed each and when it last wrote, and none that ended', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    await readableReportsWorktree(alice.config);

    expect(await listOpenAttempts(alice.config, 'github.com/acme/business')).toEqual([
      expect.objectContaining({ run: RUN, attempt: ATTEMPT, state: 'claimed', pool: 'default', lease: expect.objectContaining({ step: 'build' }), member: expect.objectContaining({ user: 'bob' }), claimedAt: expect.any(String), progressAt: expect.any(String) }),
    ]);
    expect(await listOpenAttempts(alice.config, 'github.com/acme/other')).toEqual([]);

    await finishAttempt(bob.config, claimed.value, { exitCode: 0, stderr: '' }, {});
    await readableReportsWorktree(alice.config);

    expect(await listOpenAttempts(alice.config, 'github.com/acme/business')).toEqual([]);
  });

  it('leaves an offer for another member while this machine already drives its run', async () => {
    const acme = team({ mark: MARK });
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const started = await startRun(alice.config, 'mark', { mark: 'made.txt' }, { secrets: {} });
    if (!('data' in started)) throw new Error(started.error.message);
    const run = RunIdSchema.parse(String(started.data.run));
    const state = await readRun(alice.config, run);
    if (state === 'missing' || state === 'corrupt') throw new Error(`run ${run} is ${state}`);
    const offered = await offerAttempt(alice.config, {
      run, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(alice.config), start: git(alice.checkout, 'rev-parse', 'HEAD'), staleAfterMs: 60_000, secrets: {},
      lease: { kind: 'command', step: 'write', command: 'echo written > "$MARK"', env: { MARK: 'made.txt' } },
      definition: { name: state.name, sourceHash: state.sourceHash, definitionHash: definitionHash(state.definition, state.workflows), teamRevision: state.teamRevision, origin: state.origin },
      values: { inputs: { mark: 'made.txt' } },
    });
    if (!offered.ok) throw new Error(offered.error.message);
    await readableReportsWorktree(bob.config);
    const member = await installOwner(bob.config);

    const taken = await takeRunLock(bob.config, run, async () => takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member, secrets: {}, place: HERE }), { waitMs: 0 });

    expect(taken).toMatchObject({ kind: 'held', value: { data: { idle: { offered: 1 } } } });
    expect(await readAttemptRecord(alice.config, run, ATTEMPT)).toMatchObject({ ok: true, value: { state: 'offered' } });
  });

  it('reads no record whose start is a name git would resolve rather than a commit id', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    await offer(alice, { start: 'stash@{0}' });

    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toMatchObject({ ok: false, error: { code: 'fleet_record_unreadable' } });
  });

  it('offers a command that names absolute paths, as shell commands do', async () => {
    const acme = team();
    const alice = await acme.member('alice');

    expect(await offer(alice, { lease: { ...LEASE, command: 'npm test 2>/dev/null && cp out /tmp/out' } })).toMatchObject({ ok: true, value: { state: 'offered' } });
  });

  it('offers no lease that carries a secret of the owner, and writes nothing', async () => {
    const acme = team();
    const alice = await acme.member('alice');

    const refused = await offer(alice, { lease: { ...LEASE, env: { TOKEN: 'swordfish-value-1234' } }, secrets: { TOKEN: 'swordfish-value-1234' } });

    expect(refused).toMatchObject({ ok: false, error: { code: 'fleet_unpublishable' } });
    expect(refused.ok ? '' : refused.error.message).not.toContain('swordfish');
    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toEqual({ ok: true, value: 'absent' });
  });
});

/** A command whose env reads an input: the member renders the env from the input's value, with its own copy of the step. */
const MARK = `schemaVersion: v1alpha1
name: mark
description: Writes the file an input names.
inputs: { mark: string }
steps:
  - id: write
    workspace: new
    env:
      MARK: "{{ inputs.mark }}"
    command: echo written > "$MARK"
`;

/**
 * Alice starts workflow `mark` and offers its step with `forge` applied to the offer; Bob, with the team's workflows,
 * takes it. Answers what Bob's take answered, and the record Alice reads then.
 */
async function takeForged(forge: (forged: Pick<Parameters<typeof offerAttempt>[1], 'lease' | 'definition' | 'values'>, run: RunId) => void, before?: (members: { alice: Member; bob: Member }) => Promise<void>, workflow: string | { folder: Record<string, string> } = MARK, place: MemberPlace = HERE, inputs: Record<string, string> = {}) {
  const acme = typeof workflow === 'string' ? team({ mark: workflow }) : team({}, Object.fromEntries(Object.entries(workflow.folder).map(([file, text]) => [`workflows/mark/${file}`, text])));
  const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
  await before?.({ alice, bob });
  const started = await startRun(alice.config, 'mark', { mark: 'made.txt', ...inputs }, { secrets: {} });
  if (!('data' in started)) throw new Error(started.error.message);
  const run = RunIdSchema.parse(String(started.data.run));
  const state = await readRun(alice.config, run);
  if (state === 'missing' || state === 'corrupt') throw new Error(`run ${run} is ${state}`);
  const startCommit = git(alice.checkout, 'rev-parse', 'HEAD');
  git(alice.checkout, 'push', '-q', 'origin', `HEAD:refs/heads/teamai/attempts/${run}/${ATTEMPT}`);
  const forged: Pick<Parameters<typeof offerAttempt>[1], 'lease' | 'definition' | 'values'> = {
    lease: { kind: 'command', step: 'write', command: 'echo written > "$MARK"', env: { MARK: 'made.txt' } },
    definition: { name: state.name, sourceHash: state.sourceHash, definitionHash: definitionHash(state.definition, state.workflows), teamRevision: state.teamRevision, origin: state.origin },
    values: { inputs: { mark: 'made.txt' } },
  };
  forge(forged, run);
  const offered = await offerAttempt(alice.config, {
    run, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(alice.config),
    start: startCommit, staleAfterMs: 60_000, secrets: {}, ...forged,
  });
  if (!offered.ok) throw new Error(offered.error.message);
  await readableReportsWorktree(bob.config);

  const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place });
  const record = await readAttemptRecord(alice.config, run, ATTEMPT);

  return { taken, record: record.ok && record.value !== 'absent' ? record.value : undefined, alice, bob };
}

/** A step that runs a workflow written inline, whose one step reads the run's `mark` input and nothing else of it. */
const INLINE_MARK = `schemaVersion: v1alpha1
name: mark
description: Writes a mark from a workflow written inline.
inputs: { mark: string, note: string }
steps:
  - id: write
    workspace: new
    workflow:
      steps:
        - id: put
          workspace: continue
          env:
            MARK: "{{ inputs.mark }}"
          command: echo written > "$MARK"
`;

/** A prompt step whose prompt reads an input: the member renders it from the input's value, with its own copy of the step. */
const PROMPTED = `schemaVersion: v1alpha1
name: mark
description: Asks for the file an input names.
inputs: { mark: string }
steps:
  - id: write
    workspace: new
    prompt: "Write {{ inputs.mark }}."
    output:
      ok: boolean
`;

describe('a member taking a prompt attempt', () => {
  const agents: FakeAgent[] = [];

  afterEach(async () => {
    const left = (await Promise.all(agents.splice(0).map((agent) => agent.stopLeft()))).flat();
    vi.unstubAllEnvs();
    expect(left, 'fake agents left running').toEqual([]);
  });

  /** Claude as its recorded call prints it, on PATH, answering `answer`; the member's default tool is Claude. */
  function claudeOnPath(answer: string, before?: string): FakeAgent {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-claude-'));
    dirs.push(root);
    vi.stubEnv('HOME', path.join(root, 'home'));
    const agent = fakeAgent(claudeFake, { bin: path.join(root, 'bin'), answer, ...(before !== undefined && { before }) });
    vi.stubEnv('PATH', `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`);
    agents.push(agent);

    return agent;
  }

  const useClaude = async ({ bob }: { bob: Member }): Promise<void> => {
    bob.config.workflows = { tools: { default: 'claude' } };
  };

  it('runs the prompt the team\'s workflow defines for the step with its own tool, rendered from the offer\'s values, and writes what the tool answered', async () => {
    const claude = claudeOnPath('{"ok":true}');

    const { taken, record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, useClaude, PROMPTED);

    expect(claude.calls()).toEqual([expect.objectContaining({ args: expect.arrayContaining([expect.stringContaining('Write made.txt.')]), cwd: expect.stringMatching(/work$/) })]);
    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0, outputs: { ok: true }, tool: 'claude' } });
  });

  it('writes usage_limited, with what its tool said, when its tool stops on its usage limit', async () => {
    claudeOnPath('{"ok":true}', `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm (Europe/Madrid)" }) + '\\n'); process.exit(1);`);

    const { record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, useClaude, PROMPTED);

    expect(record).toMatchObject({ state: 'finished', result: { tool: 'claude', failure: { code: 'usage_limited', message: expect.stringContaining('claude hit its usage limit: You\'ve hit your limit · resets 3pm (Europe/Madrid)') } } });
  });

  it('runs a prompt on a runtime of its driver that runs each tool on the attempt\'s tool home, in that home', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'toy-tool-home-'));
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true }, conversations: false }, prompt_tool_home: true }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);
    const opened: OpenedDriver = {
      driver: { name: 'bobs', definition: { schemaVersion: 'v1alpha1', name: 'bobs', runtimes: [] }, source: 'personal', location: 'bobs.yaml', config: (await team().member('bob')).config }, asked: 'bobs',
      runtimes: [{ kind: 'external', use: 'toy', runtime, can: ready.can, launchesAgents: true, ...(ready.runsOnToolHome && { runsOnToolHome: true }), engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }],
    };
    const place = memberPlace(opened);
    if ('refused' in place) throw new Error(place.refused);

    try {
      const { record, bob } = await takeForged((forged) => {
        forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
      }, useClaude, PROMPTED, place);

      expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0, outputs: { ok: true } } });
      const views = fs.readdirSync(path.join(state, 'views'));
      expect(views).toHaveLength(1);
      const run = RunIdSchema.parse(record?.run);
      expect(JSON.parse(fs.readFileSync(path.join(state, 'views', views[0] ?? ''), 'utf8'))).toMatchObject({ toolHome: { CLAUDE_CONFIG_DIR: attemptToolHome(bob.config, run, ATTEMPT, 'claude') } });
    } finally {
      await runtime.dispose();
    }
  });

  // The member gives its nested run only what its own copy of the inline workflow reads of the run's inputs.
  it('refuses an inline workflow step whose offer starts its nested run with inputs its own copy of the workflow does not read', async () => {
    const { taken, record } = await takeForged((forged) => {
      forged.lease = { kind: 'workflow', step: 'write', inputs: { mark: 'made.txt', note: 'planted' }, env: {} };
      forged.values = { inputs: { mark: 'made.txt', note: 'planted' } };
    }, undefined, INLINE_MARK, { ...HERE, workflow: { kind: 'here' } }, { note: 'planted' });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 1 } } });
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 1, stderr: expect.stringContaining('the offer\'s inputs differ from what workflow "mark" renders from the offer\'s values for step "write"') } });
  });

  it('runs an inline workflow step of a workflow folder in a nested run that reads the folder\'s files', async () => {
    const folder = { 'WORKFLOW.yaml': INLINE_MARK.replace('echo written > "$MARK"', 'cp "$TEAMAI_WORKFLOW_DIR/mark.txt" "$MARK"'), 'mark.txt': 'written\n' };
    const { taken, record, alice } = await takeForged((forged) => {
      forged.lease = { kind: 'workflow', step: 'write', inputs: { mark: 'made.txt' }, env: {} };
      forged.values = { inputs: { mark: 'made.txt' } };
    }, undefined, { folder }, { ...HERE, workflow: { kind: 'here' } }, { note: 'kept' });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    const to = record?.state === 'finished' ? record.result.to ?? '' : '';
    git(alice.checkout, 'fetch', '-q', 'origin', to);
    expect(git(alice.checkout, 'show', `${to}:made.txt`)).toBe('written');
  });

  it('runs on the tool\'s own default model when the step\'s model renders empty, as the owner\'s driver would, not on the defaults\' model', async () => {
    const claude = claudeOnPath('{"ok":true}');
    const modelled = PROMPTED.replace('inputs: { mark: string }', 'inputs: { mark: string, model: string }\ndefaults: { model: opus }').replace('    prompt: "Write', '    model: "{{ inputs.model }}"\n    prompt: "Write');

    const { record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
      forged.values = { inputs: { mark: 'made.txt', model: '' } };
    }, useClaude, modelled, HERE, { model: '' });

    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0 } });
    expect(claude.calls()).toHaveLength(1);
    expect(claude.calls()[0]?.args).not.toContain('--model');
  });

  it('archives the session its tool ran, so the owner continues it from the team session archive', async () => {
    claudeOnPath('{"ok":true}');

    const { record, alice } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, useClaude, PROMPTED);

    const session = record?.state === 'finished' ? record.result.session : undefined;
    expect(session).toEqual(expect.any(String));
    await readableReportsWorktree(alice.config);
    const archive = openSessionArchive(alice.config);
    const restored = await archive.restore({ platform: 'claude-code', sessionId: session ?? '' }, { platform: 'claude-code', cwd: alice.checkout });
    await archive.close();
    expect(restored).toEqual({ status: 'restored', sessionId: expect.any(String) });
  });

  it('archives beside the session the evidence the step left in its attempt\'s out/ directory, masked', async () => {
    const token = `ghp_${'Z9y8X7w6V5'.repeat(4)}`;
    claudeOnPath('{"ok":true}', `fs.writeFileSync(path.join(path.dirname(process.env.TEAMAI_WORKFLOW_RESULT), 'check.log'), 'checked with ${token}');`);

    const { record, alice } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, useClaude, PROMPTED);

    const session = record?.state === 'finished' ? record.result.session : undefined;
    await readableReportsWorktree(alice.config);
    const archive = new SyncManager(sessionArchiveRoot(alice.config) ?? '');
    const identity = getRepoIdentity(alice.checkout);
    const entry = archive.findArchived(identity, { platform: 'claude-code', sessionId: session ?? '' });
    expect(entry).toBeDefined();
    const evidence = archive.loadEvidence(identity, entry?.sessionName ?? '', entry?.author);
    expect(JSON.stringify(evidence)).not.toContain(token);
    expect(evidence?.files).toEqual([expect.objectContaining({ kind: 'text', path: 'check.log', text: expect.stringMatching(/^checked with <REDACTED:/) })]);
  });

  it('archives the session from the Claude root the member\'s checkout records, though the step ran in a clone of it', async () => {
    claudeOnPath('{"ok":true}');
    // A relocated root teamai records is one under the member's home.
    const relocated = path.join(process.env.HOME ?? '', '.claude-relocated');
    fs.mkdirSync(relocated, { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', relocated);

    const { record, alice } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, async (members) => {
      await useClaude(members);
      // As `teamai init` in a workspace records a relocated Claude Code: in the checkout's own config.
      fs.mkdirSync(path.join(members.bob.checkout, '.teamai'), { recursive: true });
      fs.writeFileSync(path.join(members.bob.checkout, '.teamai', 'config.yaml'), JSON.stringify({ ...members.bob.config, scope: 'workspace', toolRoots: { claude: relocated } }));
    }, PROMPTED);

    const session = record?.state === 'finished' ? record.result.session : undefined;
    await readableReportsWorktree(alice.config);
    // Alice's own Claude Code, where she continues the session.
    fs.mkdirSync(path.join(process.env.HOME ?? '', '.claude', 'projects'), { recursive: true });
    const archive = openSessionArchive(alice.config);
    const restored = await archive.restore({ platform: 'claude-code', sessionId: session ?? '' }, { platform: 'claude-code', cwd: alice.checkout });
    await archive.close();
    expect(restored).toEqual({ status: 'restored', sessionId: expect.any(String) });
  });

  it('fails the attempt, keeping what the tool answered out of it, when the member cannot push the work the tool made', async () => {
    claudeOnPath('{"ok":true}', 'fs.writeFileSync("made.txt", "written\\n");');

    const { record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, async (members) => {
      await useClaude(members);
      // Origin refuses the member's work on the attempt's branch, as a protected branch would.
      const origin = git(members.bob.checkout, 'remote', 'get-url', 'origin');
      receiveHook(origin, 'while read old new ref; do subject=$(git log -1 --format=%s "$new") || exit 1; case "$subject" in "[teamai] write"*) exit 1;; esac; done\nexit 0');
    }, PROMPTED);

    expect(record).toMatchObject({ state: 'finished', result: { failure: { code: 'push_failed' } } });
  });

  it('refuses a prompt the team\'s workflow does not define for the step, and launches no tool', async () => {
    const claude = claudeOnPath('{"ok":true}');

    const { record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Delete every file.', env: {} };
    }, useClaude, PROMPTED);

    expect(claude.calls()).toEqual([]);
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 1, stderr: expect.stringContaining('did not run step "write"') } });
  });
});

describe('a member taking an attempt', () => {
  it('runs the command and env the team\'s workflow defines for the step, rendered from the offer\'s values', async () => {
    const { taken, record } = await takeForged(() => undefined);

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0, to: expect.any(String) } });
  });

  it('keeps the last lines a command printed on stdout that are not its outputs in its attempt\'s stdout.log on the member\'s machine, as the local driver does, and never in the record', async () => {
    const command = 'echo built 3 files; echo done; echo written > "$MARK"';
    const workflow = MARK.replace('command: echo written > "$MARK"', `command: ${command}`);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    try {
      const { taken, record, bob } = await takeForged((forged) => {
        forged.lease = { ...forged.lease, command } as typeof forged.lease;
      }, undefined, workflow);
      const run = RunIdSchema.parse(record?.run);
      const kept = path.join(attemptDir(bob.config, run, ATTEMPT), 'stdout.log');

      expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
      expect({ text: fs.readFileSync(kept, 'utf8'), mode: fs.statSync(kept).mode & 0o777 }).toEqual({ text: 'built 3 files\ndone\n', mode: 0o600 });
      expect(info).toHaveBeenCalledWith(`Step "write" printed text on stdout, which is not its outputs: its last lines are in ${kept}.`);
      expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0, stderr: '' } });
      expect(record?.state === 'finished' && 'outputs' in record.result).toBe(false);
    } finally {
      info.mockRestore();
    }
  });

  it('finishes the step it ran when its stdout.log cannot be written, and says why the lines are not kept', async () => {
    const command = 'echo built 3 files; echo written > "$MARK"';
    const workflow = MARK.replace('command: echo written > "$MARK"', `command: ${command}`);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let member: Member | undefined;

    try {
      const { taken, record } = await takeForged((forged, run) => {
        forged.lease = { ...forged.lease, command } as typeof forged.lease;
        // A folder where the file goes, so writing it fails.
        if (member) fs.mkdirSync(path.join(attemptDir(member.config, run, ATTEMPT), 'stdout.log'), { recursive: true });
      }, async ({ bob }) => { member = bob; }, workflow);

      expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
      expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0 } });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Could not keep the lines attempt a0123abcd printed on stdout in .*stdout\.log: .*EISDIR.*\. The step's result stands; only those lines are not kept\.$/));
    } finally {
      warn.mockRestore();
    }
  });

  it('gives the command a run folder of its own, the attempt\'s marker and the member\'s run mode, and leaves the run\'s folder an owner on the same home keeps', async () => {
    vi.stubEnv('TEAMAI_MODE', 'unattended');
    const seen = 'printf "%s\\n" "$TEAMAI_WORKFLOW_ATTEMPT" "$TEAMAI_MODE" "$TEAMAI_RUN_DIR" > seen.txt; test -d "$TEAMAI_RUN_DIR" && echo made > "$TEAMAI_RUN_DIR/handed.txt"';
    const workflow = `schemaVersion: v1alpha1
name: mark
description: Writes what its env holds.
inputs: { mark: string }
steps:
  - id: write
    workspace: new
    command: '${seen}'
`;

    let members: { alice: Member; bob: Member } | undefined;
    let ownerLeft = '';
    const { record, alice } = await takeForged((forged, run) => {
      forged.lease = { kind: 'command', step: 'write', command: seen, env: {} };
      // The member's home holds the run's folder with what an earlier step left there, as when its owner runs on that home.
      if (members === undefined) throw new Error('the members are made before the offer is forged');
      ownerLeft = path.join(runScratchDir(members.bob.config, run), 'earlier.txt');
      fs.mkdirSync(path.dirname(ownerLeft), { recursive: true });
      fs.writeFileSync(ownerLeft, 'left by an earlier step');
    }, async (both) => { members = both; }, workflow);

    vi.unstubAllEnvs();
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0 } });
    const to = record?.state === 'finished' ? record.result.to ?? '' : '';
    git(alice.checkout, 'fetch', '-q', 'origin', to);
    const [attempt, mode, runDir] = git(alice.checkout, 'show', `${to}:seen.txt`).split('\n');
    expect(attempt).toMatch(new RegExp(`^r[0-9a-f]+/${ATTEMPT}$`));
    expect(mode).toBe('unattended');
    expect(runDir).not.toBe(path.dirname(ownerLeft));
    // The folder served this attempt alone, and is gone once it ended; the run's folder keeps what was in it.
    expect(fs.existsSync(runDir ?? '')).toBe(false);
    expect(fs.readFileSync(ownerLeft, 'utf8')).toBe('left by an earlier step');
  });

  it('runs the step on the step runtime of the member\'s own driver, with the step\'s env and the attempt\'s marker alone, and pushes what it wrote there', async () => {
    const local = scratchHostRuntime();
    const execs: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
    const runtime: StepRuntime<DriverCan> = { ...local, exec: (request, events, kind) => {
      execs.push({ argv: request.argv, env: request.env, cwd: request.cwd });

      return local.exec(request, events, kind);
    } };

    const { taken, record, alice } = await takeForged(() => undefined, undefined, MARK, { command: { kind: 'runtime', driver: 'bobs', use: 'box', runtime } });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    expect(execs).toEqual([{ argv: expect.arrayContaining(['echo written > "$MARK"']), env: { MARK: 'made.txt', TEAMAI_WORKFLOW_ATTEMPT: expect.stringMatching(new RegExp(`/${ATTEMPT}$`)), TEAMAI_MODE: expect.any(String), TEAMAI_RUN_DIR: expect.stringMatching(new RegExp(`/attempts/${ATTEMPT}/run$`)) }, cwd: expect.stringMatching(/work$/) }]);
    const to = record?.state === 'finished' ? record.result.to ?? '' : '';
    git(alice.checkout, 'fetch', '-q', 'origin', to);
    expect(git(alice.checkout, 'show', `${to}:made.txt`)).toBe('written');
  });

  it('ends the claim with the step, the cause and the retry command when the step runtime fails the command instead of answering', async () => {
    const local = scratchHostRuntime();
    const runtime: StepRuntime<DriverCan> = { ...local, exec: () => Promise.reject(new Error('the box went away')) };

    let forgedRun: RunId | undefined;
    const { taken, record, bob } = await takeForged((_forged, run) => { forgedRun = run; }, undefined, MARK, { command: { kind: 'runtime', driver: 'bobs', use: 'box', runtime } });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 1 } } });
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 1 } });
    const stderr = record?.state === 'finished' ? record.result.stderr : '';
    expect(stderr).toContain('step "write"');
    expect(stderr).toContain('the box went away');
    expect(stderr).toMatch(/teamai workflow retry r[0-9a-f]+ write/);
    // The place the command opened closes too, so the retry is the only one open.
    expect(forgedRun).toBeDefined();
    expect(JSON.parse(fs.readFileSync(attemptRuntimePath(bob.config, forgedRun ?? RunIdSchema.parse('r0'), ATTEMPT), 'utf8'))).toMatchObject({ phase: 'closed' });
  });

  it('refuses an offer whose command is not the one the team\'s workflow defines for the step, and runs nothing', async () => {
    const { taken, record } = await takeForged((forged) => { forged.lease = { ...forged.lease, kind: 'command', command: 'echo forged > forged.txt' }; });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 1 } } });
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 1 } });
    expect(record?.state === 'finished' && record.result.to).toBeFalsy();
    expect(record?.state === 'finished' ? record.result.stderr : '').toMatch(/step "write".*command.*teamai pull/s);
  });

  it('leaves an offer whose definition hash is not the one of the team\'s workflow for another member, and runs nothing', async () => {
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { taken, record } = await takeForged((forged) => { forged.definition.definitionHash = 'f'.repeat(64); });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(record).toMatchObject({ state: 'offered' });
    expect(infos).toHaveBeenCalledWith(expect.stringMatching(/^Left attempt .* for another member: it finds no definition of the run here: Run .* runs workflow "mark"/s));
  });
  it('leaves an offer whose workflow comes from a team commit only a branch besides the default one holds, and runs nothing', async () => {
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    // Anyone who can write the record can push such a branch, teamai-reports among them.
    const { taken, record, bob } = await takeForged((forged) => { forged.lease = { ...forged.lease, kind: 'command', command: 'echo forged > forged.txt' }; }, async ({ alice: { config } }) => {
      const clone = config.repo.localPath;
      git(clone, 'checkout', '-q', '-b', 'side');
      fs.writeFileSync(path.join(clone, 'workflows', 'mark.yaml'), MARK.replace('echo written > "$MARK"', 'echo forged > forged.txt'));
      git(clone, 'commit', '-qam', 'side');
      git(clone, 'push', '-q', 'origin', 'side');
      await syncScorersThenWorkflows(config);
    });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(record).toMatchObject({ state: 'offered' });
    expect(fs.existsSync(path.join(bob.checkout, 'forged.txt'))).toBe(false);
    expect(infos).toHaveBeenCalledWith(expect.stringMatching(/^Left attempt .* for another member: it finds no definition of the run here: .*Merge it to the default branch/s));
  });
  it('pushes the work to every push URL its checkout names for origin, as git push origin does', async () => {
    const mirrors: string[] = [];
    const { taken, record } = await takeForged(() => undefined, async ({ bob }) => {
      const origin = git(bob.checkout, 'remote', 'get-url', 'origin');
      const mirror = path.join(path.dirname(origin), 'mirror.git');
      git(path.dirname(origin), 'init', '-q', '--bare', mirror);
      mirrors.push(origin, mirror);
      git(bob.checkout, 'config', 'remote.origin.pushurl', origin);
      git(bob.checkout, 'config', '--add', 'remote.origin.pushurl', mirror);
      // git push origin applies no pushInsteadOf to a push URL the remote names.
      git(bob.checkout, 'config', `url.${path.join(path.dirname(origin), 'nowhere.git')}.pushInsteadOf`, origin);
    });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    const to = record?.state === 'finished' ? record.result.to : undefined;
    expect(to).toEqual(expect.any(String));
    for (const remote of mirrors) expect(git(remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/teamai/attempts')).toBe(to);
  });

  it('runs a step of a workflow folder with the folder\'s files, which it keeps in its own data home', async () => {
    const folder = { 'WORKFLOW.yaml': MARK.replace('echo written > "$MARK"', 'cp "$TEAMAI_WORKFLOW_DIR/mark.txt" "$MARK"'), 'mark.txt': 'written\n' };
    const { taken, record, alice } = await takeForged((forged) => { forged.lease = { ...forged.lease, kind: 'command', command: 'cp "$TEAMAI_WORKFLOW_DIR/mark.txt" "$MARK"' }; }, undefined, { folder });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    const to = record?.state === 'finished' ? record.result.to ?? '' : '';
    git(alice.checkout, 'fetch', '-q', 'origin', to);
    expect(git(alice.checkout, 'show', `${to}:made.txt`)).toBe('written');
  });

  it.each([
    ['however long the step has run', false],
    ['even when it cannot read which folders the step reads', true],
  ])('keeps the folder of a step it holds through a sweep, %s', async (_case, isNoteUnreadable) => {
    const gate = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fleet-gate-')));
    const command = `while [ ! -f ${path.join(gate, 'go')} ]; do sleep 0.05; done; cp "$TEAMAI_WORKFLOW_DIR/mark.txt" "$MARK"`;
    const folder = { 'WORKFLOW.yaml': MARK.replace('echo written > "$MARK"', command), 'mark.txt': 'written\n' };
    let bob: Member | undefined;
    const taking = takeForged((forged) => { forged.lease = { ...forged.lease, kind: 'command', command }; }, async (members) => { bob = members.bob; }, { folder });
    const stored = (): string => (bob ? path.join(getDataHome(bob.config), 'workflows', 'folders') : '');
    const folders = (): string[] => (fs.existsSync(stored()) ? fs.readdirSync(stored()).filter((name) => /^[0-9a-f]{64}$/.test(name)) : []);
    // The step has started once its folder is written, and the gate keeps it running while it ages and a sweep runs.
    while (folders().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!bob) throw new Error('Bob took no step');
    // The team changes the workflow while the step runs, so Bob's cache no longer names the folder the step reads.
    fs.writeFileSync(path.join(bob.config.repo.localPath, 'workflows', 'mark', 'mark.txt'), 'changed\n');
    await syncScorersThenWorkflows(bob.config);
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of folders()) fs.utimesSync(path.join(stored(), name), longAgo, longAgo);
    if (isNoteUnreadable) {
      const runs = path.join(getDataHome(bob.config), 'workflows', 'runs');
      const notes = entriesUnder(runs).map(({ relative }) => relative).filter((file) => path.basename(file) === 'fleet-folders.json');
      expect(notes).toHaveLength(1);
      const note = path.join(runs, notes[0] ?? '');
      fs.rmSync(note);
      fs.mkdirSync(note);
    }
    await sweepLeftovers(bob.config, null, { now: Date.now(), checkout: bob.checkout });
    fs.writeFileSync(path.join(gate, 'go'), '');

    const { taken } = await taking;
    fs.rmSync(gate, { recursive: true, force: true });
    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
  });

  // A runtime that runs the step elsewhere, such as a sandbox, makes only what the place names reachable there.
  it('names the workflow folder among the read-only paths of the place it opens on its own step runtime', async () => {
    const local = scratchHostRuntime();
    const views: PlaceView[] = [];
    const runtime: StepRuntime<DriverCan> = { ...local, open: (request, events) => {
      if (request.view) views.push(request.view);

      return local.open(request, events);
    } };
    const folder = { 'WORKFLOW.yaml': MARK.replace('echo written > "$MARK"', 'cp "$TEAMAI_WORKFLOW_DIR/mark.txt" "$MARK"'), 'mark.txt': 'written\n' };

    const { taken } = await takeForged((forged) => { forged.lease = { ...forged.lease, kind: 'command', command: 'cp "$TEAMAI_WORKFLOW_DIR/mark.txt" "$MARK"' }; }, undefined, { folder }, { command: { kind: 'runtime', driver: 'bobs', use: 'box', runtime } });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    expect(views).toEqual([expect.objectContaining({ readonly: expect.arrayContaining([expect.stringMatching(/[\\/]workflows[\\/]folders[\\/][0-9a-f]{64}$/)]) })]);
  });

  it('refuses a step of a workflow a from step admitted, naming that step, and runs nothing', async () => {
    const planned = `schemaVersion: v1alpha1
name: mark
description: Runs the workflow a step writes.
inputs: { mark: string }
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow }
  - id: run
    needs: [plan]
    workflow: { from: plan }
`;
    const { taken, record } = await takeForged((forged) => { forged.lease.step = 'run.write'; }, undefined, planned);

    expect(taken).toMatchObject({ data: { ran: { step: 'run.write', exit_code: 1 } } });
    expect(record?.state === 'finished' && record.result.to).toBeFalsy();
    expect(record?.state === 'finished' ? record.result.stderr : '').toContain('step "run" runs the workflow step "plan" wrote');
  });
});

describe('publishing a run with an attempt out on a fleet pool', () => {
  it('is refused, naming the step, the pool and the command that waits for it', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const next = await leaseNext(alice.config, runId, alice.driver);
    if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
    const { attempt, step } = next.data.lease as { attempt: string; step: string };
    await markOffered(alice.config, RunIdSchema.parse(runId), AttemptIdSchema.parse(attempt), 'build');

    const refused = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    expect(refused).toMatchObject({ ok: false, error: { code: 'fleet_attempts_out', step } });
    expect(refused.ok ? '' : refused.error.message).toContain(`fleet pool build`);
    expect(refused.ok ? '' : refused.error.message).toContain(`teamai workflow resume ${runId}`);
  });
});

/** A command that marks that it started, then runs until it is stopped, writing work as it goes. */
const SLOW = `schemaVersion: v1alpha1
name: slow
description: Works until stopped.
steps:
  - id: work
    workspace: new
    command: echo begun > begun.txt; sleep 60
`;

/** A command that goes on from what the attempt's ref holds: it fails unless the work an earlier run left is there. */
const AGAIN = `schemaVersion: v1alpha1
name: slow
description: Goes on from earlier work.
steps:
  - id: work
    workspace: new
    command: test -f left.txt && echo again > again.txt
`;

/**
 * Alice starts workflow `slow`, defined as `definition` with command `command`, and offers its step with `staleAfterMs`;
 * answers both members, the run and the offer.
 */
async function offerSlow(staleAfterMs: number, { definition = SLOW, command = 'echo begun > begun.txt; sleep 60' } = {}) {
  const acme = team({ slow: definition });
  const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
  const started = await startRun(alice.config, 'slow', {}, { secrets: {} });
  if (!('data' in started)) throw new Error(started.error.message);
  const run = RunIdSchema.parse(String(started.data.run));
  const state = await readRun(alice.config, run);
  if (state === 'missing' || state === 'corrupt') throw new Error(`run ${run} is ${state}`);
  const startCommit = git(alice.checkout, 'rev-parse', 'HEAD');
  git(alice.checkout, 'push', '-q', 'origin', `HEAD:refs/heads/teamai/attempts/${run}/${ATTEMPT}`);
  const offered = await offerAttempt(alice.config, {
    run, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(alice.config), start: startCommit, staleAfterMs, secrets: {},
    lease: { kind: 'command', step: 'work', command, env: {} },
    definition: { name: state.name, sourceHash: state.sourceHash, definitionHash: definitionHash(state.definition, state.workflows), teamRevision: state.teamRevision, origin: state.origin },
    values: {},
  });
  if (!offered.ok) throw new Error(offered.error.message);
  await markOffered(alice.config, run, ATTEMPT, 'default');
  await readableReportsWorktree(bob.config);

  return { alice, bob, run, startCommit, offered: offered.value };
}

async function recordOf(member: Member, run: ReturnType<typeof RunIdSchema.parse>) {
  const read = await readAttemptRecord(member.config, run, ATTEMPT);

  return read.ok && read.value !== 'absent' ? read.value : undefined;
}

async function eventually<T>(read: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;

  for (;;) {
    const value = await read();

    if (value !== undefined) return value;

    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('cancelling an attempt through its record', () => {
  it('withdraws an offer no member claimed, which no member then takes', async () => {
    const { bob, run, offered, alice } = await offerSlow(60_000);

    expect(await cancelAttempt(alice.config, offered)).toMatchObject({ ok: true, value: { state: 'withdrawn' } });
    await readableReportsWorktree(bob.config);
    expect(await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE }))
      .toEqual({ data: { idle: { offered: 0 } } });
    expect(await recordOf(alice, run)).toMatchObject({ state: 'withdrawn' });
  });

  it('stops the member\'s step, which pushes its work and answers cancelled', async () => {
    const { alice, bob, run, startCommit } = await offerSlow(3_000);
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });
    // The member's first beat pushed the file the step wrote.
    const running = await eventually(async () => {
      const record = await recordOf(alice, run);

      return record?.state === 'claimed' && record.pushed !== startCommit ? record : undefined;
    });

    expect(await cancelAttempt(alice.config, running)).toMatchObject({ ok: true, value: { state: 'cancelling' } });

    expect(await taking).toEqual({ data: { cancelled: { run, attempt: ATTEMPT, step: 'work' } } });
    const cancelled = await recordOf(alice, run);
    expect(cancelled).toMatchObject({ state: 'cancelled', member: { id: (await installOwner(bob.config)).id } });
    if (cancelled?.state !== 'cancelled') return;
    git(alice.checkout, 'fetch', '-q', 'origin', `refs/heads/teamai/attempts/${run}/${ATTEMPT}`);
    expect(git(alice.checkout, 'show', `${cancelled.pushed}:begun.txt`)).toBe('begun');
    await readableReportsWorktree(alice.config);
    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toEqual({ attempt: ATTEMPT, pushed: cancelled.pushed });
  }, 60_000);

  it('goes on with its step when teamai-reports cannot be read for a moment after another write landed over its own', async () => {
    const { alice, bob, run, startCommit } = await offerSlow(3_000, { definition: SLOW.replace('sleep 60', 'sleep 6'), command: 'echo begun > begun.txt; sleep 6' });
    // A git on PATH that, while `cut` exists, fails each read of teamai-reports from the team clone, as a moment
    // origin cannot be reached does; the member's writes go through its reports checkout and still land.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fleet-git-'));
    onTestFinished(() => { fs.rmSync(bin, { recursive: true, force: true }); });
    const cut = path.join(bin, 'cut');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ -f '${cut}' ] && [ "$(pwd -P)" = '${fs.realpathSync(bob.config.repo.localPath)}' ]; then case " $* " in *" ls-remote "*) echo 'fatal: unable to access origin' >&2; exit 128;; esac; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });
    const running = await eventually(async () => {
      const record = await recordOf(alice, run);

      return record?.state === 'claimed' && record.pushed !== startCommit ? record : undefined;
    });

    fs.writeFileSync(cut, '');
    // Another write over the member's own, so its next beat is refused and it reads the record again.
    expect(await recordProgress(bob.config, running, running.pushed)).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    fs.rmSync(cut);

    expect(await taking).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
    expect(await recordOf(alice, run)).toMatchObject({ state: 'finished', result: { exitCode: 0 } });
  }, 60_000);

  it('stops its step when its record on teamai-reports is one a newer teamai wrote, which no later read of it parses', async () => {
    const { alice, bob, run, startCommit } = await offerSlow(3_000, { definition: SLOW.replace('sleep 60', 'sleep 20'), command: 'echo begun > begun.txt; sleep 20' });
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });
    const running = await eventually(async () => {
      const record = await recordOf(alice, run);

      return record?.state === 'claimed' && record.pushed !== startCommit ? record : undefined;
    });
    const rel = `workflows/attempts/${run}/${ATTEMPT}`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, `${rel}.json`), JSON.stringify({ ...running, write: 'newer', teamai: '9.1.0', critical: ['lease.command', 'lease.fresh'], lease: { ...running.lease, fresh: true } }));

      return { value: undefined, write: { files: [`${rel}.json`], message: 'a record a newer teamai wrote' } };
    });

    expect(await taking).toMatchObject({ error: { code: 'state_moved', message: expect.stringContaining('teamai 9.1.0') } });
  }, 60_000);

  it('runs nothing on the member\'s step runtime when the cancel comes while its place there opens', async () => {
    const { alice, bob, run } = await offerSlow(3_000);
    let execs = 0;
    let open = (): void => {};
    const opening = new Promise<void>((resolve) => { open = resolve; });
    const local = scratchHostRuntime();
    const runtime: StepRuntime<DriverCan> = {
      ...local,
      open: async (request, onAccepted) => {
        await opening;

        return local.open(request, onAccepted);
      },
      exec: async (request, events, kind) => {
        execs += 1;

        return local.exec(request, events, kind);
      },
    };
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: { command: { kind: 'runtime', driver: 'bobs', use: 'box', runtime } } });
    const claimed = await eventually(async () => {
      const record = await recordOf(alice, run);

      return record?.state === 'claimed' ? record : undefined;
    });

    expect(await cancelAttempt(alice.config, claimed)).toMatchObject({ ok: true, value: { state: 'cancelling' } });
    // The member reads the cancel within a beat, a second at this stale_after, and stops the step while its place opens.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    open();

    expect(await taking).toEqual({ data: { cancelled: { run, attempt: ATTEMPT, step: 'work' } } });
    expect(execs).toBe(0);
  }, 60_000);

  it('writes no question of a gate that holds a secret value to teamai-reports', async () => {
    const { bob, offered } = await offerSlow(60_000);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const question = { step: 'keep', kind: 'approve' as const, message: 'Ship with token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB?', options: ['yes', 'no'], required: false };

    expect(await recordProgress(bob.config, claimed.value, 'e'.repeat(40), { question, secrets: {} })).toMatchObject({ ok: false, error: { code: 'fleet_unpublishable' } });
    expect(await readAttemptRecord(bob.config, offered.run, offered.attempt)).toMatchObject({ ok: true, value: { state: 'claimed' } });
  });

  it('writes no answer to a gate whose note holds a secret value to teamai-reports, as publishing the run would not', async () => {
    const { alice, bob, offered } = await offerSlow(60_000);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const question = { step: 'keep', kind: 'approve' as const, message: 'Ship it?', options: ['yes', 'no'], required: false };
    const asking = await recordProgress(bob.config, claimed.value, 'e'.repeat(40), { question, secrets: {} });
    if (!asking.ok || asking.value.state !== 'asking') throw new Error('the member did not ask');

    expect(await answerQuestion(alice.config, asking.value, { choice: 'yes', note: 'Deploy with ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }, {})).toMatchObject({ ok: false, error: { code: 'fleet_unpublishable' } });
    expect(await readAttemptRecord(alice.config, offered.run, offered.attempt)).toMatchObject({ ok: true, value: { state: 'asking' } });
  });

  it('writes an answer with a plain note though the member\'s question names a value the owner holds as a secret', async () => {
    const { alice, bob, offered } = await offerSlow(60_000);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const question = { step: 'keep', kind: 'approve' as const, message: 'Ship to stage-eu-west-71b9?', options: ['yes', 'no'], required: false };
    const asking = await recordProgress(bob.config, claimed.value, 'e'.repeat(40), { question, secrets: {} });
    if (!asking.ok || asking.value.state !== 'asking') throw new Error('the member did not ask');

    expect(await answerQuestion(alice.config, asking.value, { choice: 'yes' }, { STAGE: 'stage-eu-west-71b9' })).toMatchObject({ ok: true, value: { state: 'answered' } });
  });

  it('goes on from the work a member pushed before a cancel it never answered', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const progressed = await recordProgress(bob.config, claimed.value, 'e'.repeat(40));
    if (!progressed.ok) throw new Error(progressed.error.message);

    expect(await cancelAttempt(alice.config, progressed.value)).toMatchObject({ ok: true, value: { state: 'cancelling' } });
    await readableReportsWorktree(alice.config);
    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toEqual({ attempt: ATTEMPT, pushed: 'e'.repeat(40) });
  });
});

describe('a restarted member', () => {
  it('finishes with the work its killed run pushed when the step adds nothing to it', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN.replace('test -f left.txt && echo again > again.txt', 'test -f left.txt'), command: 'test -f left.txt' });
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const ref = `refs/heads/teamai/attempts/${run}/${ATTEMPT}`;
    git(bob.checkout, 'fetch', '-q', 'origin', ref);
    const work = path.join(path.dirname(bob.checkout), 'bob-left');
    git(bob.checkout, 'worktree', 'add', '-q', '--detach', work, 'FETCH_HEAD');
    fs.writeFileSync(path.join(work, 'left.txt'), 'kept\n');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'left');
    git(work, 'push', '-q', 'origin', `HEAD:${ref}`);
    const left = git(work, 'rev-parse', 'HEAD');
    git(bob.checkout, 'worktree', 'remove', '--force', work);
    await readableReportsWorktree(bob.config);

    await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    expect(await recordOf(alice, run)).toMatchObject({ state: 'finished', result: { exitCode: 0, to: left } });
  });

  it('writes back and frees the Codex login the judge of its killed run refreshed, before it finishes the claim', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN.replace('test -f left.txt && echo again > again.txt', 'echo again > again.txt'), command: 'echo again > again.txt' });
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const daily = path.join(path.dirname(bob.checkout), 'bob-codex');
    // Codex rotates its refresh token on a refresh and refuses the old one after (refresh_token_reused).
    const login = (refresh: string): string => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'acct-1', refresh_token: refresh } });
    fs.mkdirSync(daily);
    fs.writeFileSync(path.join(daily, 'auth.json'), login('refresh-1'), { mode: 0o600 });
    const toolHome = attemptToolHome(bob.config, run, ATTEMPT, 'codex');
    expect((await holdLoginFrom({ tool: 'codex', executable: 'codex', from: daily, toolHome, run, attempt: ATTEMPT, signal: new AbortController().signal })).ok).toBe(true);
    fs.writeFileSync(path.join(toolHome, 'auth.json'), login('refresh-2'));
    await readableReportsWorktree(bob.config);

    await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    expect({ daily: JSON.parse(fs.readFileSync(path.join(daily, 'auth.json'), 'utf8')).tokens.refresh_token, holder: await loginHolder('codex'), state: (await recordOf(alice, run))?.state })
      .toEqual({ daily: 'refresh-2', holder: undefined, state: 'finished' });
  }, 60_000);

  it('stops the command it left running, and finishes the claim it held from the work it pushed', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN, command: 'test -f left.txt && echo again > again.txt' });
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    // What a member killed mid-step left: its work so far on the attempt's ref, and the step's command still running.
    const ref = `refs/heads/teamai/attempts/${run}/${ATTEMPT}`;
    git(bob.checkout, 'fetch', '-q', 'origin', ref);
    const work = path.join(path.dirname(bob.checkout), 'bob-left');
    git(bob.checkout, 'worktree', 'add', '-q', '--detach', work, 'FETCH_HEAD');
    fs.writeFileSync(path.join(work, 'left.txt'), 'kept\n');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'left');
    git(work, 'push', '-q', 'origin', `HEAD:${ref}`);
    git(bob.checkout, 'worktree', 'remove', '--force', work);
    fs.mkdirSync(attemptDir(bob.config, run, ATTEMPT), { recursive: true });
    const left = startGroupedCommand({ command: 'sleep 60', cwd: bob.checkout, env: process.env, detached: true, group: attemptDir(bob.config, run, ATTEMPT) });
    let isLeftRunning = true;
    void left.exit.then(() => { isLeftRunning = false; });
    await readableReportsWorktree(bob.config);

    try {
      const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

      expect(isLeftRunning).toBe(false);
      expect(taken).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
      const finished = await recordOf(alice, run);
      expect(finished).toMatchObject({ state: 'finished', result: { exitCode: 0, to: expect.any(String) } });
      if (finished?.state !== 'finished' || finished.result.to === undefined) return;
      git(alice.checkout, 'fetch', '-q', 'origin', ref);
      expect(git(alice.checkout, 'show', `${finished.result.to}:left.txt`)).toBe('kept');
      expect(git(alice.checkout, 'show', `${finished.result.to}:again.txt`)).toBe('again');
    } finally {
      await left.stop();
    }
  }, 60_000);

  it('leaves an offer of a run whose record its own data home holds, and what the owner keeps of the attempt', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN.replace('test -f left.txt && echo again > again.txt', 'echo again > again.txt'), command: 'echo again > again.txt' });
    // The run's owner shares this member's data home: the run's record and the attempt's runtime record are the owner's.
    fs.mkdirSync(path.dirname(runFilePath(bob.config, run)), { recursive: true });
    fs.copyFileSync(runFilePath(alice.config, run), runFilePath(bob.config, run));
    const runtime = attemptRuntimePath(bob.config, run, offered.attempt);
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.writeFileSync(runtime, '{"phase":"open"}');

    for (let pass = 0; pass < 2; pass++) {
      expect(await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE })).toEqual({ data: { idle: { offered: 0 } } });
    }

    expect(await recordOf(alice, run)).toMatchObject({ state: 'offered' });
    expect(fs.readFileSync(runtime, 'utf8')).toBe('{"phase":"open"}');
  }, 60_000);

  it('removes what it kept of an attempt once its record ended, at its next take', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN.replace('test -f left.txt && echo again > again.txt', 'echo again > again.txt'), command: 'echo again > again.txt' });
    await readableReportsWorktree(bob.config);
    const take = async () => takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    expect(await take()).toMatchObject({ data: { ran: { run, attempt: offered.attempt } } });
    expect(await recordOf(alice, run)).toMatchObject({ state: 'finished' });
    expect(fs.existsSync(attemptDir(bob.config, run, offered.attempt))).toBe(true);
    // A group no stop here can tell ended, as a pid namespace that changed since leaves: an ended attempt runs nothing
    // again, so it refuses nothing, but keeps the record of what may still run.
    const unconfirmed = path.join(attemptDir(bob.config, run, offered.attempt), 'group-424242.json');
    fs.writeFileSync(unconfirmed, JSON.stringify({ pid: 424242, spawnedAt: Date.now(), pidNamespace: 'pid:[1]' }));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    expect(await take()).toEqual({ data: { idle: { offered: 0 } } });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('the claim is kept'));
    expect(fs.existsSync(unconfirmed)).toBe(true);

    // What the member kept, such as the log a failure pointed the person to, stays as the run's own leftovers do.
    fs.rmSync(unconfirmed);
    expect(await take()).toEqual({ data: { idle: { offered: 0 } } });
    expect(fs.existsSync(attemptDir(bob.config, run, offered.attempt))).toBe(true);

    bob.config.workflows = { tools: {}, ...bob.config.workflows, retention: '1s' };
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    // The run's record reached this data home after the claim, as a takeover into it brings it: the attempt's folder is
    // the record's, which its own retention ends.
    fs.copyFileSync(runFilePath(alice.config, run), runFilePath(bob.config, run));
    expect(await take()).toEqual({ data: { idle: { offered: 0 } } });
    expect(fs.existsSync(attemptDir(bob.config, run, offered.attempt))).toBe(true);
    fs.rmSync(runFilePath(bob.config, run));
    expect(await take()).toEqual({ data: { idle: { offered: 0 } } });
    expect(fs.existsSync(attemptDir(bob.config, run, offered.attempt))).toBe(false);
  }, 60_000);

  it('keeps the claim and runs nothing of the step again when it cannot confirm the command its killed run left ended', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN.replace('test -f left.txt && echo again > again.txt', 'echo again > again.txt'), command: 'echo again > again.txt' });
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    // A group another pid namespace started, as a member in a container restarted over the same data home leaves: no stop
    // here can reach it or tell it ended.
    fs.mkdirSync(attemptDir(bob.config, run, ATTEMPT), { recursive: true });
    fs.writeFileSync(path.join(attemptDir(bob.config, run, ATTEMPT), 'group-424242.json'), JSON.stringify({ pid: 424242, spawnedAt: Date.now(), pidNamespace: 'pid:[1]' }));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await readableReportsWorktree(bob.config);

    const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`Left attempt ${ATTEMPT} of run ${run}, which this member claimed before: .*process 424242.*teamai workflow resume --next --pool default`)));
    expect(await recordOf(alice, run)).toMatchObject({ state: 'claimed' });
  }, 60_000);

  it('runs the step again on its step runtime, once the place its killed run left there is closed', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN, command: 'test -f left.txt && echo again > again.txt' });
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const ref = `refs/heads/teamai/attempts/${run}/${ATTEMPT}`;
    git(bob.checkout, 'fetch', '-q', 'origin', ref);
    const work = path.join(path.dirname(bob.checkout), 'bob-left');
    git(bob.checkout, 'worktree', 'add', '-q', '--detach', work, 'FETCH_HEAD');
    fs.writeFileSync(path.join(work, 'left.txt'), 'kept\n');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'left');
    git(work, 'push', '-q', 'origin', `HEAD:${ref}`);
    git(bob.checkout, 'worktree', 'remove', '--force', work);
    // What the killed run left on the runtime, once stopped: a closed place, and the exec it had sent there, whose id the
    // runtime answers with how that exec ended, as an id sent again reconnects to its exec.
    const stoppedExec = newOpId();
    const local = scratchHostRuntime();
    const runtime: StepRuntime<DriverCan> = { ...local, exec: async (request, events, kind) => (request.op === stoppedExec ? { kind: 'cancelled' } : local.exec(request, events, kind)) };
    fs.mkdirSync(attemptDir(bob.config, run, ATTEMPT), { recursive: true });
    fs.writeFileSync(attemptRuntimePath(bob.config, run, ATTEMPT), JSON.stringify({ runtime: runtime.name, driver: 'bobs', phase: 'closed', open: { op: newOpId(), handle: 'h-left' }, exec: { op: stoppedExec } }));
    await readableReportsWorktree(bob.config);

    const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: { command: { kind: 'runtime', driver: 'bobs', use: 'box', runtime } } });

    expect(taken).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
    const finished = await recordOf(alice, run);
    if (finished?.state !== 'finished' || finished.result.to === undefined) throw new Error(`not finished: ${JSON.stringify(finished)}`);
    git(alice.checkout, 'fetch', '-q', 'origin', ref);
    expect(git(alice.checkout, 'show', `${finished.result.to}:again.txt`)).toBe('again');
  }, 60_000);
});

/** A step that writes git config where it runs, as a hostile or careless step can. */
const PLANT = `schemaVersion: v1alpha1
name: slow
description: Writes git config.
steps:
  - id: work
    workspace: new
    command: git config teamai.planted yes && echo planted > planted.txt
`;

describe('a member\'s own checkout', () => {
  it('keeps no git config the step wrote where it ran', async () => {
    const { bob, run } = await offerSlow(60_000, { definition: PLANT, command: 'git config teamai.planted yes && echo planted > planted.txt' });

    const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    expect(taken).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
    expect(fs.readFileSync(path.join(bob.checkout, '.git', 'config'), 'utf8')).not.toContain('planted');
  });

  it('gives the step the origin its checkout names, as the checkout would', async () => {
    const { alice, bob, run } = await offerSlow(60_000, { definition: PLANT.replace('git config teamai.planted yes && echo planted > planted.txt', 'git remote get-url origin > origin.txt'), command: 'git remote get-url origin > origin.txt' });

    await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    const finished = await recordOf(alice, run);
    const to = finished?.state === 'finished' ? finished.result.to : undefined;
    git(alice.checkout, 'fetch', '-q', 'origin', `refs/heads/teamai/attempts/${run}/${ATTEMPT}`);
    expect(git(alice.checkout, 'show', `${to ?? 'missing'}:origin.txt`)).toBe(git(bob.checkout, 'remote', 'get-url', 'origin'));
  });
});

describe('the values an offer carries', () => {
  it('carries only the fields of an input, a step\'s outputs and the item that the env reads', () => {
    const read = leaseValues(
      { id: 'build', env: { TARGET: '{{ inputs.config.target }}', SHA: '{{ steps.plan.outputs.commit.sha }}', NAME: '{{ item.name }}' } },
      {
        inputs: { config: { target: 'web', cache: '/Users/alice/.cache/build' }, unread: 'x' },
        steps: { plan: { outputs: { commit: { sha: 'abc', log: '/Users/alice/plan.log' }, notes: 'long' } } },
        run: { id: 'r0123abcd' },
        item: { name: 'one', path: '/Users/alice/one' },
      },
    );

    expect(read).toEqual({ values: { inputs: { config: { target: 'web' } }, outputs: { plan: { commit: { sha: 'abc' } } }, item: { name: 'one' } } });
  });

  it('carries an item whose field the env reads is missing, so the member renders the env as the owner did', () => {
    const step = { id: 'part', env: { PART: '{{ item.name }}' } };
    const read = leaseValues(step, { inputs: {}, steps: {}, run: { id: 'r0123abcd' }, item: { path: '/Users/alice/one' } });
    if (!('values' in read)) throw new Error(read.error);

    // As the owner renders it, from the whole item.
    expect(leaseEnv(step, read.values, RUN)).toEqual(leaseEnv(step, { item: { path: '/Users/alice/one' } }, RUN));
  });

  it('carries nothing for a field an input does not have, even one every object inherits', () => {
    expect(leaseValues({ id: 'build', env: { KIND: '{{ inputs.constructor }}' } }, { inputs: { target: 'web' }, steps: {}, run: { id: 'r0123abcd' } }))
      .toEqual({ values: {} });
  });
});

/** A command that works for a few seconds, writing a file before and after. */
const BRIEF = SLOW.replace('echo begun > begun.txt; sleep 60', 'echo begun > begun.txt; sleep 4; echo done > done.txt');
const BRIEF_COMMAND = 'echo begun > begun.txt; sleep 4; echo done > done.txt';
const OTHER = AttemptIdSchema.parse('a4567cdef');

describe('a member\'s claim among writes it did not see land', () => {
  it('goes on running when a write of its own claim landed though it could not tell', async () => {
    const { alice, bob, run, startCommit } = await offerSlow(3_000, { definition: BRIEF, command: BRIEF_COMMAND });
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });
    const claimed = await eventually(async () => {
      const record = await recordOf(alice, run);

      return record?.state === 'claimed' ? record : undefined;
    });

    // The member's own progress write, which landed while the member read that it failed.
    expect(await recordProgress(bob.config, claimed, startCommit)).toMatchObject({ ok: true });

    expect(await taking).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
  }, 60_000);

  it('saves again once a push to one of its push URLs failed, from the work the others took', async () => {
    let mirror = '';
    const { alice, bob, run } = await offerSlow(3_000, { definition: BRIEF, command: BRIEF_COMMAND });
    const origin = git(bob.checkout, 'remote', 'get-url', 'origin');
    mirror = path.join(path.dirname(origin), 'mirror.git');
    git(path.dirname(origin), 'init', '-q', '--bare', mirror);
    git(bob.checkout, 'config', 'remote.origin.pushurl', origin);
    git(bob.checkout, 'config', '--add', 'remote.origin.pushurl', mirror);
    // The mirror takes no object until the first save reached origin.
    const objects = path.join(mirror, 'objects');
    fs.chmodSync(objects, 0o555);
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });
    const ref = `refs/heads/teamai/attempts/${run}/${ATTEMPT}`;
    const startTip = git(origin, 'rev-parse', ref);

    try {
      await eventually(async () => (git(origin, 'rev-parse', ref) === startTip ? undefined : true));
    } finally {
      fs.chmodSync(objects, 0o755);
    }

    expect(await taking).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
    const finished = await recordOf(alice, run);
    const to = finished?.state === 'finished' ? finished.result.to : undefined;
    expect(git(origin, 'show', `${to}:done.txt`)).toBe('done');
    expect(git(mirror, 'rev-parse', ref)).toBe(to);
  }, 60_000);

  it('takes an offer although a record it never claimed names it as the claimer', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: BRIEF, command: BRIEF_COMMAND });
    // A claim naming Bob of an attempt whose ref origin does not hold, which Bob never wrote.
    const other = await offerAttempt(alice.config, { ...offered, attempt: OTHER, secrets: {} });
    if (!other.ok) throw new Error(other.error.message);
    expect(await claimAttempt(alice.config, other.value, await installOwner(bob.config))).toMatchObject({ ok: true });
    await readableReportsWorktree(bob.config);

    expect(await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE }))
      .toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
  }, 60_000);
});

describe('the gone work a retry goes on from', () => {
  it('is never that of an attempt this install did not offer, whatever owner its record names', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000);
    // A record of an attempt Alice never offered, naming her as its owner.
    const forged = await offerAttempt(bob.config, { ...offered, attempt: OTHER, secrets: {} });
    if (!forged.ok) throw new Error(forged.error.message);
    const claimed = await claimAttempt(bob.config, forged.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const progressed = await recordProgress(bob.config, claimed.value, 'e'.repeat(40));
    if (!progressed.ok) throw new Error(progressed.error.message);
    expect(await expireClaim(bob.config, progressed.value)).toMatchObject({ ok: true });
    await readableReportsWorktree(alice.config);

    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toBeUndefined();
    await markOffered(alice.config, run, OTHER, 'default');
    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toEqual({ attempt: OTHER, pushed: 'e'.repeat(40) });
  });

  it('is the last one the owner gave up by its own clock, whatever time a member wrote', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000);
    const member = await installOwner(bob.config);
    const claimed = await claimAttempt(bob.config, offered, member);
    if (!claimed.ok) throw new Error(claimed.error.message);
    const cancelling = await cancelAttempt(alice.config, (await recordProgress(bob.config, claimed.value, 'd'.repeat(40))).ok ? (await recordOf(alice, run)) as typeof claimed.value : claimed.value);
    if (!cancelling.ok || cancelling.value.state !== 'cancelling') throw new Error('not cancelling');
    // The member's clock runs a year ahead when it answers.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 365 * 24 * 3600_000 });
    try {
      expect(await answerCancel(bob.config, cancelling.value, 'd'.repeat(40))).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
    const later = await offerAttempt(alice.config, { ...offered, attempt: OTHER, secrets: {} });
    if (!later.ok) throw new Error(later.error.message);
    const reclaimed = await claimAttempt(bob.config, later.value, member);
    if (!reclaimed.ok) throw new Error(reclaimed.error.message);
    const moved = await recordProgress(bob.config, reclaimed.value, 'e'.repeat(40));
    if (!moved.ok) throw new Error(moved.error.message);
    expect(await expireClaim(alice.config, moved.value)).toMatchObject({ ok: true });
    await markOffered(alice.config, run, OTHER, 'default');
    await readableReportsWorktree(alice.config);

    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toEqual({ attempt: OTHER, pushed: 'e'.repeat(40) });
  });
});

describe('fleet entries of one driver definition', () => {
  const fleet = (options: Record<string, unknown>) => ({ use: 'fleet', options: RuntimeOptionsSchema.parse(options) });

  it('names a fleet entry an earlier one takes every step from, and only that one', () => {
    expect(shadowedFleetEntries([
      fleet({ pool: 'default' }),
      fleet({ pool: 'e2e', can: { network: true } }),
      { use: 'local' },
      fleet({ pool: 'spare' }),
      // A member cannot reach a confined step's directory, so the fleet offers no confined offer an entry promises.
      fleet({ pool: 'jail', can: { confined: [{ level: 'best-effort', tools: ['claude'] }] } }),
    ])).toEqual([
      'The fleet entry for pool "spare" never gets a step: the fleet entry for pool "default" before it offers everything it does, and takes each step first. The two offer the same, so the first takes every step: remove one, or make them offer different things.',
      'The fleet entry for pool "jail" never gets a step: the fleet entry for pool "default" before it offers everything it does, and takes each step first. The two offer the same, so the first takes every step: remove one, or make them offer different things.',
    ]);
  });

  it('names no labelled entry after one without its labels, and an entry an earlier one with every label of it covers', () => {
    expect(shadowedFleetEntries([fleet({ pool: 'default' }), fleet({ pool: 'e2e', labels: ['computer-use'] })])).toEqual([]);
    expect(shadowedFleetEntries([fleet({ pool: 'e2e', labels: ['computer-use', 'gpu'] }), fleet({ pool: 'gpu', labels: ['gpu'] })])).toEqual([
      'The fleet entry for pool "gpu" never gets a step: the fleet entry for pool "e2e" before it offers everything it does, and takes each step first. Put the fleet entry for pool "gpu", which offers less, before the one for pool "e2e".',
    ]);
  });

  it('advises the order that gives each entry steps: the entry that offers less goes first', () => {
    const offersMore = fleet({ pool: 'e2e', labels: ['computer-use', 'gpu'] });
    const offersLess = fleet({ pool: 'gpu', labels: ['gpu'] });

    expect(shadowedFleetEntries([offersMore, offersLess])[0]).toContain('Put the fleet entry for pool "gpu", which offers less, before the one for pool "e2e".');
    expect(shadowedFleetEntries([offersLess, offersMore])).toEqual([]);
  });

  it('declares the labels its entry lists, so a step that requires them goes to its pool', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runtime = fleetStepRuntime({ config: alice.config, masks: {} });

    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { pool: 'e2e', labels: ['computer-use'] }, mode: 'unattended', checkout: alice.checkout })).toMatchObject({ ok: true, can: { labels: ['computer-use'] } });
    await runtime.dispose();
  });

  it('declares no person at its tools, whatever its entry promises, so no interactive step goes to the fleet', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runtime = fleetStepRuntime({ config: alice.config, masks: {} });
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { pool: 'e2e', can: { hitl: true, network: true } }, mode: 'unattended', checkout: alice.checkout });

    expect(ready).toMatchObject({ ok: true, can: { network: true } });
    expect(ready.ok && ready.can).not.toHaveProperty('hitl');
    await runtime.dispose();
  });

  it('declares no confined offer, whatever its entry promises, so a confined step runs on the driver\'s next runtime', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runtime = fleetStepRuntime({ config: alice.config, masks: {} });
    // The confined directory lives under this machine's $TEAMAI_RUN_DIR, which no commit a member fetches carries.
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { pool: 'e2e', can: { network: true, confined: [{ level: 'best-effort', tools: ['codex'] }] } }, mode: 'unattended', checkout: alice.checkout });

    expect(ready).toMatchObject({ ok: true, can: { network: true } });
    expect(ready.ok && ready.can).not.toHaveProperty('confined');
    await runtime.dispose();
  });

  it('names a specific fleet entry a general one before it covers', () => {
    expect(shadowedFleetEntries([fleet({ pool: 'any', can: { network: true, isolation: 'sandbox' } }), fleet({ pool: 'box', can: { isolation: 'worktree' } })])).toEqual([
      'The fleet entry for pool "box" never gets a step: the fleet entry for pool "any" before it offers everything it does, and takes each step first. Put the fleet entry for pool "box", which offers less, before the one for pool "any".',
    ]);
  });

  it('names no entry after one that runs no command, since an entry that says nothing of exec runs commands', () => {
    expect(shadowedFleetEntries([fleet({ pool: 'prompts', can: { exec: false } }), fleet({ pool: 'default' })])).toEqual([]);
  });

  it('names a shadowed fleet entry that also sets the options teamai takes for itself', () => {
    expect(shadowedFleetEntries([fleet({ pool: 'default' }), fleet({ pool: 'spare', max_parallel: 2, credentials: { GH_TOKEN: 'env:GH_TOKEN' } })])).toEqual([
      'The fleet entry for pool "spare" never gets a step: the fleet entry for pool "default" before it offers everything it does, and takes each step first. The two offer the same, so the first takes every step: remove one, or make them offer different things.',
    ]);
  });
});

describe('where a member runs an attempt', () => {
  /** A member's own driver `name` whose runtimes offer `cans` in order, `local` for the local runtime. */
  async function driverOf(cans: Array<'local' | { use: string; can: Record<string, boolean> }>): Promise<OpenedDriver> {
    const acme = team();
    const { config } = await acme.member('bob');
    const runtime = hostStepRuntime({ config });
    const runtimes = cans.map((entry): OpenedRuntime => (entry === 'local'
      ? { kind: 'tools', use: 'tools', engine: { logins: [] } }
      : { kind: 'external', use: entry.use, runtime, can: entry.can, launchesAgents: false, engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }));
    const [first, ...rest] = runtimes;
    if (!first) throw new Error('no runtime');

    return { driver: { name: 'bobs', definition: { schemaVersion: 'v1alpha1', name: 'bobs', runtimes: [] }, source: 'personal', location: 'bobs.yaml', config }, asked: 'bobs', runtimes: [first, ...rest] };
  }

  it('runs on the first runtime of its driver that runs commands, one that does not say it runs none included', async () => {
    expect(memberPlace(await driverOf([{ use: 'box', can: {} }, 'local']))).toMatchObject({ command: { kind: 'runtime', use: 'box', driver: 'bobs' } });
  });

  it('passes over a runtime that runs no command and its own fleet, and runs here when local comes next', async () => {
    expect(memberPlace(await driverOf([{ use: 'judge', can: { exec: false } }, { use: 'fleet', can: {} }, 'local']))).toMatchObject({ command: { kind: 'here' } });
  });

  it('runs a prompt step on the first runtime of its driver that runs prompts, and a command on the first that runs commands', async () => {
    expect(memberPlace(await driverOf([{ use: 'judge', can: { exec: false } }, { use: 'box', can: { prompt: false } }, 'local']))).toMatchObject({
      command: { kind: 'runtime', use: 'box' },
      prompt: { kind: 'runtime', use: 'judge' },
    });
  });

  it('takes no prompt step on a driver whose runtimes run none, and still takes command steps there', async () => {
    const place = memberPlace(await driverOf([{ use: 'box', can: { prompt: false } }]));

    expect(place).toMatchObject({ command: { kind: 'runtime', use: 'box' } });
    expect(place).not.toHaveProperty('prompt');
  });

  it('refuses a driver whose runtimes run neither commands nor prompts', async () => {
    expect(memberPlace(await driverOf([{ use: 'box', can: { exec: false, prompt: false } }]))).toMatchObject({ refused: expect.stringContaining('no runtime that runs command or prompt steps') });
  });
});

/**
 * Alice starts workflow `slow` and leases its step, which the fleet runtime of her install offers to pool `gpu`, with
 * `wake` as given when there is one. Each runtime it opens goes to `opened`, for the test to dispose.
 */
async function ownerOffering(opened: StepRuntime<DriverCan>[], wake?: () => Promise<{ runtime: StepRuntime<DriverCan>; wakes: boolean }>, { staleAfter = '60s' }: { staleAfter?: string } = {}) {
  const acme = team({ slow: SLOW });
  const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
  const run = RunIdSchema.parse(await startIn(alice, 'slow'));
  const next = await leaseNext(alice.config, run, alice.driver, { can: { workspace: [...WORKSPACES] } });
  if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
  const attempt = AttemptIdSchema.parse((next.data.lease as { attempt: string }).attempt);
  const open = async () => {
    const runtime = fleetStepRuntime({ config: alice.config, masks: {}, ...(wake && { openWake: async () => ({ ok: true as const, ...(await wake()) }) }) });
    opened.push(runtime);
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { stale_after: staleAfter, pool: 'gpu', ...(wake && { wake: { use: 'toy' } }) }, mode: 'unattended', checkout: alice.checkout });
    const place = ready.ok ? await runtime.open({ op: newOpId(), run, attempt, credentials: {} }, async () => undefined) : undefined;
    const exec = (op: OpId) => {
      if (place?.kind !== 'ready') throw new Error('the fleet runtime opened no place');

      return runtime.exec({ op, handle: place.handle, argv: ['sh', '-c', 'echo begun > begun.txt; sleep 60'], env: {}, unset: [], credentials: {}, cwd: alice.checkout }, {}, 'command');
    };

    return { runtime, ready, exec };
  };

  return { alice, bob, run, attempt, open, origin: acme.origin };
}

describe('a cancel the owner cannot write into the attempt\'s record at once', () => {
  const opened: StepRuntime<DriverCan>[] = [];
  const releases: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const release of releases.splice(0)) await release();
    await Promise.all(opened.splice(0).map(async (runtime) => runtime.dispose()));
  });

  /** Takes `member`'s teamai-reports lock, as `workflow cancel` holds it while it publishes the run; the answer gives it back. */
  async function holdReportsLock(member: Member): Promise<() => Promise<void>> {
    const lock = path.join(path.dirname(reportsBranch.dir(member.config)), REPORTS_LOCK_FILENAME);
    await eventually(async () => ((await acquireLock(lock)) ? true : undefined));
    const release = async () => releaseLock(lock);
    releases.push(release);

    return release;
  }

  /** How `end` settled within `ms`, or `waiting`. */
  const within = async <T>(end: Promise<T>, ms: number): Promise<T | 'waiting'> => Promise.race([end, sleep(ms).then(() => 'waiting' as const)]);

  /** This process's clock, moved on so the cancel's deadline is behind it, as the minute it waits would. */
  const passTheDeadline = () => vi.setSystemTime(Date.now() + CANCEL_WRITE_MS + 1_000);

  /** The record of `attempt` as `member` reads it, once it is in state `state`. */
  const recordIn = async (member: Member, run: RunId, attempt: AttemptId, state: FleetRecord['state']) => eventually(async () => {
    await readableReportsWorktree(member.config);
    const read = await readAttemptRecord(member.config, run, attempt);

    return read.ok && read.value !== 'absent' && read.value.state === state ? read.value : undefined;
  }, 60_000);

  it('ends the owner\'s cancel cancel_failed at the deadline while a publish holds teamai-reports past it, and leaves the offer for workflow cancel', async () => {
    const { alice, bob, run, attempt, open } = await ownerOffering(opened);
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    await recordIn(bob, run, attempt, 'offered');
    await holdReportsLock(alice);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const cancelled = runtime.cancel(op);

    expect(await within(ended, 3_000)).toBe('waiting');
    passTheDeadline();
    expect(await within(ended, 15_000)).toMatchObject({ kind: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/another write held teamai-reports.* Run teamai workflow cancel r[0-9a-f]+ again\.$/) } });
    await cancelled;
    expect(await recordIn(bob, run, attempt, 'offered')).toMatchObject({ state: 'offered' });
  }, 60_000);

  it('writes the cancel once a publish that held teamai-reports for 2 s lets it go', async () => {
    const { alice, bob, run, attempt, open } = await ownerOffering(opened);
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    await recordIn(bob, run, attempt, 'offered');
    const release = await holdReportsLock(alice);
    const cancelled = runtime.cancel(op);
    await sleep(2_000);
    await release();

    expect(await within(ended, 15_000)).toMatchObject({ kind: 'cancelled' });
    await cancelled;
    expect(await recordIn(bob, run, attempt, 'withdrawn')).toMatchObject({ state: 'withdrawn' });
  }, 60_000);

  it('ends the owner\'s cancel cancel_failed at the deadline while the member\'s progress keeps the claim fresh and no cancel write lands', async () => {
    const { alice, bob, run, attempt, open, origin } = await ownerOffering(opened, undefined, { staleAfter: '30m' });
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    const offered = await recordIn(bob, run, attempt, 'offered');
    if (offered.state !== 'offered') throw new Error(`no offer: ${offered.state}`);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const beating = new AbortController();

    const beats = (async () => {
      for (let held: HeldAttempt = claimed.value; !beating.signal.aborted;) {
        const beat = await recordProgress(bob.config, held, held.pushed);
        if (!beat.ok) return beat.error.code;
        held = beat.value;
        await sleep(200);
      }

      return 'stopped';
    })();

    await recordIn(alice, run, attempt, 'claimed');
    // origin refuses each cancel, as when the member's progress lands before every one.
    receiveHook(origin, 'while read old new ref; do subjects=$(git log --format=%s "$old..$new") || exit 1; echo "$subjects" | grep -q "^\\[teamai\\] Cancel attempt" && exit 1; done; exit 0');
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const cancelled = runtime.cancel(op);

    expect(await within(ended, 4_000)).toBe('waiting');
    passTheDeadline();
    expect(await within(ended, 15_000)).toMatchObject({ kind: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(`Run teamai workflow cancel ${run} again.`) } });
    await cancelled;
    beating.abort();
    expect(await beats).toBe('stopped');
    receiveHook(origin, 'exit 0');
    expect(await recordIn(alice, run, attempt, 'claimed')).toMatchObject({ member: { user: 'bob' } });
  }, 60_000);

  it('ends the owner\'s cancel cancel_failed at the deadline, not at a shorter stale_after, when origin cannot be read after a cancel write failed', async () => {
    const { bob, run, attempt, open, origin } = await ownerOffering(opened, undefined, { staleAfter: '20s' });
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    await recordIn(bob, run, attempt, 'offered');
    // A push the move below catches mid-way finds no repository for its log: it is refused, not let through.
    receiveHook(origin, 'while read old new ref; do subjects=$(git log --format=%s "$old..$new") || exit 1; echo "$subjects" | grep -q "^\\[teamai\\] Cancel attempt" && exit 1; done; exit 0');
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const cancelled = runtime.cancel(op);
    await sleep(3_000);
    // Origin goes away after the first cancel write was refused.
    const away = `${origin}.away`;
    fs.renameSync(origin, away);
    releases.push(async () => fs.renameSync(away, origin));

    expect(await within(ended, 3_000)).toBe('waiting');
    // Past stale_after, short of the deadline: the cancel still waits for its record.
    vi.setSystemTime(Date.now() + 21_000);
    expect(await within(ended, 3_000)).toBe('waiting');
    passTheDeadline();
    expect(await within(ended, 15_000)).toMatchObject({ kind: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/teamai-reports could not be read .* Run teamai workflow cancel r[0-9a-f]+ again\.$/) } });
    await cancelled;
  }, 60_000);

  /** Moves `origin` away once a push of a cancel landed on it, so every read after that write fails. */
  const goneAfterCancel = (origin: string) => {
    const away = `${origin}.away`;
    fs.writeFileSync(path.join(origin, 'hooks', 'post-receive'), `#!/bin/sh\nwhile read old new ref; do subjects=$(git log --format=%s "$old..$new") || exit 0; echo "$subjects" | grep -q "^\\[teamai\\] Cancel attempt" && mv '${origin}' '${away}'; done; exit 0\n`, { mode: 0o755 });
    releases.push(async () => {
      if (fs.existsSync(away)) fs.renameSync(away, origin);
    });
  };

  it('ends the owner\'s cancel cancelled at the withdraw it wrote, when origin cannot be read after it', async () => {
    const { bob, run, attempt, open, origin } = await ownerOffering(opened, undefined, { staleAfter: '20s' });
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    await recordIn(bob, run, attempt, 'offered');
    goneAfterCancel(origin);
    const cancelled = runtime.cancel(op);

    expect(await within(ended, 15_000)).toMatchObject({ kind: 'cancelled' });
    await cancelled;
    expect(fs.existsSync(origin)).toBe(false);
  }, 60_000);

  it('ends the owner\'s cancel cancel_failed past stale_after, naming the record, when origin cannot be read after the cancel of a claim landed', async () => {
    const { bob, run, attempt, open, origin } = await ownerOffering(opened, undefined, { staleAfter: '20s' });
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    const offered = await recordIn(bob, run, attempt, 'offered');
    if (offered.state !== 'offered') throw new Error(`no offer: ${offered.state}`);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    await recordIn(bob, run, attempt, 'claimed');
    goneAfterCancel(origin);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const cancelled = runtime.cancel(op);
    await eventually(async () => (fs.existsSync(origin) ? undefined : true));

    expect(await within(ended, 3_000)).toBe('waiting');
    vi.setSystemTime(Date.now() + 21_000);
    expect(await within(ended, 15_000)).toMatchObject({ kind: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(new RegExp(`its member bob was asked to stop it, and the record of attempt ${attempt} on teamai-reports could not be read for 20 s since, so whether the member stopped is not known\\. .* The attempt's place and records are kept\\. Once origin can be read, run teamai workflow cancel ${run} again\\.$`)) } });
    await cancelled;
  }, 60_000);

  it('ends the owner\'s cancel cancel_failed past stale_after, naming the record, when the record is no longer on teamai-reports after the cancel of a claim landed', async () => {
    const { bob, run, attempt, open, origin } = await ownerOffering(opened, undefined, { staleAfter: '20s' });
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    const offered = await recordIn(bob, run, attempt, 'offered');
    if (offered.state !== 'offered') throw new Error(`no offer: ${offered.state}`);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    await recordIn(bob, run, attempt, 'claimed');
    // Once the cancel landed, teamai-reports loses the branch, so every read after it finds no record.
    fs.writeFileSync(path.join(origin, 'hooks', 'post-receive'), `#!/bin/sh\nwhile read old new ref; do subjects=$(git log --format=%s "$old..$new") || exit 0; echo "$subjects" | grep -q "^\\[teamai\\] Cancel attempt" && git update-ref -d "$ref"; done; exit 0\n`, { mode: 0o755 });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const cancelled = runtime.cancel(op);
    await eventually(async () => (git(origin, 'branch', '--list', 'teamai-reports') === '' ? true : undefined));

    expect(await within(ended, 3_000)).toBe('waiting');
    vi.setSystemTime(Date.now() + 21_000);
    expect(await within(ended, 15_000)).toMatchObject({ kind: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(new RegExp(`its member bob was asked to stop it, and the record of attempt ${attempt} is no longer on teamai-reports, so whether the member stopped is not known\\. The attempt's place and records are kept\\.`)) } });
    await cancelled;
  }, 60_000);

  it('ends the owner\'s cancel cancel_failed past stale_after, keeping the place, when origin cannot be read before any cancel write', async () => {
    const { bob, run, attempt, open, origin } = await ownerOffering(opened, undefined, { staleAfter: '20s' });
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    await recordIn(bob, run, attempt, 'offered');
    // Origin goes away before the cancel: no read shows the record, so no cancel write is tried.
    const away = `${origin}.away`;
    fs.renameSync(origin, away);
    releases.push(async () => fs.renameSync(away, origin));
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const cancelled = runtime.cancel(op);

    expect(await within(ended, 3_000)).toBe('waiting');
    vi.setSystemTime(Date.now() + 21_000);
    expect(await within(ended, 15_000)).toMatchObject({ kind: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/could not be read for 20 s, so no member was asked to stop it, and a member may still take its offer\. .* The attempt's place and records are kept\. Run teamai workflow cancel r[0-9a-f]+ again\.$/) } });
    await cancelled;
  }, 60_000);

  it('names the held teamai-reports, not the member\'s progress, when a publish holds it past the deadline while the member beats', async () => {
    const { alice, bob, run, attempt, open } = await ownerOffering(opened, undefined, { staleAfter: '30m' });
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    const offered = await recordIn(bob, run, attempt, 'offered');
    if (offered.state !== 'offered') throw new Error(`no offer: ${offered.state}`);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    await recordIn(alice, run, attempt, 'claimed');
    await holdReportsLock(alice);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const cancelled = runtime.cancel(op);
    // The member's progress lands while the owner waits for its lock.
    const beat = await recordProgress(bob.config, claimed.value, claimed.value.pushed);
    if (!beat.ok) throw new Error(beat.error.message);

    expect(await within(ended, 3_000)).toBe('waiting');
    passTheDeadline();
    const failed = await within(ended, 15_000);
    expect(failed).toMatchObject({ kind: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('another write held teamai-reports') } });
    expect(failed).not.toMatchObject({ failure: { message: expect.stringContaining('progress') } });
    // One next step: the cancel's own.
    expect(failed).not.toMatchObject({ failure: { message: expect.stringContaining('Try again.') } });
    await cancelled;
  }, 60_000);

  it('writes the cancel of workflow cancel with no live driver once the publish holding teamai-reports lets it go', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const release = await holdReportsLock(alice);
    const asked = cancelFleetAttempt(alice.config, RUN, ATTEMPT);
    await sleep(2_000);
    await release();

    expect(await asked).toEqual({ ok: true, message: `Withdrew attempt ${ATTEMPT} of run ${RUN}, which no fleet member had taken.` });
    expect(await recordIn(bob, RUN, ATTEMPT, 'withdrawn')).toMatchObject({ state: 'withdrawn' });
  }, 60_000);

  it('says to cancel again when workflow cancel with no live driver cannot write its cancel by the deadline', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    await holdReportsLock(alice);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const asked = cancelFleetAttempt(alice.config, RUN, ATTEMPT);

    expect(await within(asked, 2_000)).toBe('waiting');
    passTheDeadline();
    expect(await within(asked, 15_000)).toEqual({ ok: false, message: expect.stringMatching(new RegExp(`another write held teamai-reports.* Run teamai workflow cancel ${RUN} again\\.$`)) });
  }, 60_000);
});

describe('the reasons members give for leaving an offer', () => {
  const opened: StepRuntime<DriverCan>[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map(async (runtime) => runtime.dispose()));
  });

  const leftOf = async (member: Member) => {
    await readableReportsWorktree(member.config);
    const read = await readAttemptRecord(member.config, RUN, ATTEMPT);
    if (!read.ok || read.value === 'absent' || read.value.state !== 'offered') throw new Error(`no offer: ${JSON.stringify(read)}`);

    return read.value;
  };

  it('writes a reason that names a path of the member\'s machine as one that does not, once', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const member = await installOwner(bob.config);
    const why = `the tool it needs is not in ${bob.checkout}/bin`;

    expect(await leaveOffer(bob.config, offered.value, { member, why, secrets: {} })).toEqual({ ok: true, value: undefined });
    const once = await leftOf(bob);

    expect(once.left).toEqual([{ member, why: expect.not.stringContaining(bob.checkout), at: expect.any(String) }]);
    expect(await leaveOffer(bob.config, once, { member, why, secrets: {} })).toEqual({ ok: true, value: undefined });
    expect((await leftOf(bob)).write).toBe(once.write);
  });

  it('stops rewriting the offer once 16 members left it, for a member it does not list', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    let current = offered.value;

    for (let index = 0; index < 16; index += 1) {
      const said = await leaveOffer(bob.config, current, { member: { id: `member-${index}`, user: `user${index}` }, why: 'it declares no gpu label', secrets: {} });
      if (!said.ok) throw new Error(said.error.message);
      current = await leftOf(bob);
    }

    expect(await leaveOffer(bob.config, current, { member: { id: 'member-16', user: 'user16' }, why: 'it declares no gpu label', secrets: {} })).toEqual({ ok: true, value: undefined });
    const after = await leftOf(bob);

    expect(after.write).toBe(current.write);
    expect(after.left?.map((entry) => entry.member.id)).toEqual(Array.from({ length: 16 }, (_, index) => `member-${index}`));
  });

  it('prints a member\'s reason with the control characters it holds taken out', async () => {
    const warned = vi.spyOn(log, 'warn');
    const { bob, run, attempt, open } = await ownerOffering(opened);
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    const offered = await eventually(async () => {
      await readableReportsWorktree(bob.config);
      const read = await readAttemptRecord(bob.config, run, attempt);

      return read.ok && read.value !== 'absent' && read.value.state === 'offered' ? read.value : undefined;
    });
    const said = await leaveOffer(bob.config, offered, { member: { id: 'member-x', user: 'eve\u001b[2J' }, why: 'it lacks \u001b]52;c;cGFzdGU=\u0007 the gpu label', secrets: {} });
    if (!said.ok) throw new Error(said.error.message);
    const message = await eventually(async () => warned.mock.calls.map(([text]) => String(text)).find((text) => text.includes('the gpu label')));

    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\u0007');
    expect(message).toContain('eve');
    await runtime.cancel(op);
    await ended;
    warned.mockRestore();
  });
});

describe('waking a fleet member for an offer no member claimed', () => {
  const opened: StepRuntime<DriverCan>[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map(async (runtime) => runtime.dispose()));
  });

  /** The toy runtime over stdio, as a definition opens it, waking into `wakeLog` when given one. */
  async function toyWaker(wakeLog?: string): Promise<{ runtime: StepRuntime<DriverCan>; wakes: boolean }> {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    opened.push(runtime);
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state: fs.mkdtempSync(path.join(os.tmpdir(), 'toy-wake-')), ...(wakeLog !== undefined && { wake_log: wakeLog }) }, mode: 'unattended' });
    if (!ready.ok) throw new Error(ready.failure.message);

    return { runtime, wakes: ready.wakes === true };
  }

  const owner = (wake: () => Promise<{ runtime: StepRuntime<DriverCan>; wakes: boolean }>) => ownerOffering(opened, wake);

  /**
   * `member` leaves the offer of `attempt` with a reason of its own, and answers once the owner's wait printed it: the
   * owner read the record, still offered, again since anything the test saw before.
   */
  async function ownerReadAgain(member: Member, { run, attempt }: { run: RunId; attempt: AttemptId }): Promise<void> {
    const warned = vi.spyOn(log, 'warn');
    const why = `it declares no label ${newOpId()}`;
    const offered = await eventually(async () => {
      await readableReportsWorktree(member.config);
      const read = await readAttemptRecord(member.config, run, attempt);

      return read.ok && read.value !== 'absent' && read.value.state === 'offered' ? read.value : undefined;
    });
    const said = await leaveOffer(member.config, offered, { member: await installOwner(member.config), why, secrets: {} });
    if (!said.ok) throw new Error(said.error.message);
    await eventually(async () => (warned.mock.calls.some(([message]) => String(message).includes(why)) ? true : undefined));
  }

  const lines = (file: string): Array<Record<string, unknown>> => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

  it('sends one wake, naming the pool, the business repository and the command that takes the attempt', async () => {
    const wakeLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wake-log-')), 'wakes.jsonl');
    const { alice, bob, run, attempt, open } = await owner(async () => toyWaker(wakeLog));
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);

    const [sent] = await eventually(async () => (lines(wakeLog).length > 0 ? lines(wakeLog) : undefined));
    await ownerReadAgain(bob, { run, attempt });

    expect(lines(wakeLog)).toHaveLength(1);
    const repository = git(alice.checkout, 'remote', 'get-url', 'origin');
    expect(sent).toMatchObject({ type: 'wake', pool: 'gpu', repository });
    // The member's first message: the command that takes one attempt, alone on its first line, then where, and to end after it.
    expect(String(sent?.message).split('\n')[0]).toBe('teamai workflow resume --next --pool gpu');
    // That line is the command WAKE_COMMAND spells, which each runtime's rule for a woken member derives from.
    expect(String(sent?.message).split('\n')[0]).toBe(`${WAKE_COMMAND} --next --pool gpu`);
    expect(String(sent?.message)).toContain(repository);
    expect(String(sent?.message)).toContain('then end');
    // A woken agent that reads a skill first spends its start on it: the command needs none.
    expect(String(sent?.message)).toContain('It needs no skill or file read first');
    // A title the person recognises on the machine woken: the step, the run and the pool.
    expect(String(sent?.title)).toContain('work');
    expect(String(sent?.title)).toContain(run);
    expect(String(sent?.title)).toContain('gpu');
    expect(await readOfferedMarker(alice.config, run, attempt)).toMatchObject({ wake: { op: sent?.op, where: 'toy' } });
    await runtime.cancel(op);
    await ended;
  });

  it('wakes no member again from a restarted owner that sent the wake before', async () => {
    const wakeLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wake-log-')), 'wakes.jsonl');
    const { bob, run, attempt, open } = await owner(async () => toyWaker(wakeLog));
    const op = newOpId();
    const first = await open();
    const ended = first.exec(op);
    await eventually(async () => (lines(wakeLog).length > 0 ? true : undefined));
    await first.runtime.dispose();
    await ended;

    const restarted = await open();
    const again = restarted.exec(op);
    await ownerReadAgain(bob, { run, attempt });

    expect(lines(wakeLog)).toHaveLength(1);
    await restarted.runtime.cancel(op);
    await again;
  });

  it('warns once with the runtime\'s message when it has no machine to wake on, and the offer still waits for a member', async () => {
    const warned = vi.spyOn(log, 'warn');
    const local = scratchHostRuntime();
    const unavailable: StepRuntime<DriverCan> = { ...local, name: 'nowhere', wake: async () => ({ kind: 'failed', failure: { code: 'wake_unavailable', message: 'Link a machine in T3 Code, and add the repository there as a project.' } }) };
    const { alice, bob, run, attempt, open } = await owner(async () => ({ runtime: unavailable, wakes: true }));
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    await eventually(async () => (warned.mock.calls.some(([message]) => String(message).includes('Link a machine')) ? true : undefined));
    await ownerReadAgain(bob, { run, attempt });

    expect(warned.mock.calls.filter(([message]) => String(message).includes('Link a machine'))).toHaveLength(1);
    expect(String(warned.mock.calls.find(([message]) => String(message).includes('Link a machine'))?.[0])).toContain('teamai workflow resume --next --pool gpu');
    const record = await readAttemptRecord(alice.config, run, attempt);

    expect(record.ok && record.value !== 'absent' && record.value.state).toBe('offered');
    await runtime.cancel(op);
    await ended;
    warned.mockRestore();
  });

  it('says nothing of a wake it stopped waiting for when the runtime never confirms the cancel', async () => {
    const warned = vi.spyOn(log, 'warn');
    const local = scratchHostRuntime();
    let unconfirmed: (() => void) | undefined;
    const silent: StepRuntime<DriverCan> = {
      ...local,
      name: 'silent',
      wake: async () => new Promise((resolve) => { unconfirmed = () => resolve({ kind: 'lost', failure: { code: 'runtime_unanswered', message: 'The runtime did not confirm the cancel.' } }); }),
      cancel: async (op) => { unconfirmed?.(); return local.cancel(op); },
    };
    const { open } = await owner(async () => ({ runtime: silent, wakes: true }));
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);
    await eventually(async () => unconfirmed && true);

    await runtime.cancel(op);
    await ended;

    expect(warned.mock.calls.filter(([message]) => String(message).includes('could not wake'))).toEqual([]);
    warned.mockRestore();
  });

  it('keeps what the runtime shows of the member it woke, for the attempt listing', async () => {
    const local = scratchHostRuntime();
    const display = { label: 'T3 thread on studio-mac', url: 't3code://thread/abc' };
    const showing: StepRuntime<DriverCan> = { ...local, name: 'shows', wake: async (_request, events) => { events.onDisplay?.(display); return { kind: 'woken', where: 'studio-mac', display }; } };
    const { alice, run, attempt, open } = await owner(async () => ({ runtime: showing, wakes: true }));
    const { runtime, exec } = await open();
    const op = newOpId();
    const ended = exec(op);

    expect(await eventually(async () => (await readOfferedMarker(alice.config, run, attempt))?.wake?.display)).toEqual(display);
    expect(woken(await readOfferedMarker(alice.config, run, attempt))).toBe('T3 thread on studio-mac (t3code://thread/abc)');
    await runtime.cancel(op);
    await ended;
  });

  it('refuses a wake runtime whose init offers no wake, rather than leaving the offer unwoken', async () => {
    const { open } = await owner(async () => toyWaker());

    expect((await open()).ready).toMatchObject({ ok: false, failure: { code: 'bad_option', key: 'wake' } });
  });

  it('refuses a wake option when this teamai cannot open the runtime it names', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runtime = fleetStepRuntime({ config: alice.config, masks: {} });
    opened.push(runtime);

    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { pool: 'gpu', wake: { use: 't3' } }, mode: 'unattended', checkout: alice.checkout })).toMatchObject({ ok: false, failure: { code: 'bad_option', key: 'wake' } });
  });

  it('opens no wake runtime to stop or close what it ran', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    let asked = 0;
    const runtime = fleetStepRuntime({ config: alice.config, masks: {}, openWake: async () => { asked += 1; return toyWaker().then((waker) => ({ ok: true as const, ...waker })); } });
    opened.push(runtime);

    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { pool: 'gpu', wake: { use: 'toy' } }, mode: 'recover', checkout: alice.checkout })).toMatchObject({ ok: true });
    expect(asked).toBe(0);
  });
});
