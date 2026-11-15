import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { journal } from '../../../packages/runtime-sandbox/src/journal.js';
import { sandboxJournalRoot } from '../../../packages/runtime-sandbox/src/journal-root.js';
import { cleanupPlan, type LeftoverContext } from '../leftovers.js';
import { startObserver } from '../observer.js';
import type { World } from '../world.js';
import { places, readPlacements } from './places.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A closed record of attempt a0123abcd of run r0123abcd, written where teamai keeps it, whose sandbox profile ran on `provider`. */
function closedRecord(provider: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
  roots.push(root);
  const file = path.join(root, 'runs', 'r0123abcd', 'attempts', 'a0123abcd', 'runtime.json');
  const origin = { layer: 'personal', location: 'drivers/box.yaml', revision: 'r' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    runtime: 'sandbox', driver: 'box', phase: 'closed', open: { op: 'op-0123abcd', handle: 'h' },
    sources: [{ runtime: 'teamai-sandbox', ...origin, sandbox: { profile: 'mac', ...origin, location: 'sandboxes/mac.yaml', provider, enforces: {} } }],
  }));

  return file;
}

/** A world of its own, with what an observer needs to start in it. */
function sandboxWorld(): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-world-'));
  roots.push(dir);
  const at = (name: string): string => path.join(dir, name);

  return {
    runId: RUN, dir, project: at('project'), team: at('team.git'), home: at('home'), tmp: at('tmp'), logs: at('logs'), bin: at('bin'),
    build: { commit: 'c', dirty: false, version: '0', tarball: 't', sha256: 's', node: 'v24' },
    createdAt: '2026-11-12T12:00:00.000Z', baseline: { teamRefs: {}, checkoutStatus: [] }, env: { VERIFY_WORLD_CANARY: 'c4n4ry0123456789' }, members: [],
  };
}

async function contextOf(files: string[], world: World = sandboxWorld()): Promise<LeftoverContext> {
  return { world, self: { runId: RUN, paths: [], journals: [], runs: [] }, others: [], records: { files, runs: ['r0123abcd'], runtimeJournals: 0, placements: await readPlacements(files) } };
}

/** docker as the observer asks it: up, listing `containers` of `world`'s journal, and every exec printing one plain environment. */
function dockerListing(world: World, containers: readonly string[]) {
  const owner = journal(sandboxJournalRoot(world.home)).owner;

  const printed = (stdout: string) => ({ kind: 'ran', stdout }) as const;

  return ([command = '', verb = '']: readonly string[]) => {
    if (command !== 'docker') return Promise.resolve({ kind: 'missing' } as const);

    if (verb === 'info') return Promise.resolve(printed('29.0.0\n'));

    if (verb === 'ps') return Promise.resolve(printed(containers.map((name) => `c0ffee\t${name}\t${owner}\n`).join('')));

    return Promise.resolve(printed('PATH=/usr/bin\0HOME=/root\0\0'));
  };
}

const RUN = '20261112T120000-aaaaaa';

/** A world whose HOME and member bob's HOME are under `root`, and a T3 attempt record of run r1 in `home`, at `phase`. */
function openT3Record(root: string, home: string, phase: string): string {
  const file = path.join(home, '.teamai', 'runs', 'r1', 'attempts', 'a1', 'runtime.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, phase === 'garbled' ? '{' : JSON.stringify({ runtime: 't3', driver: 'teamai-t3', phase, open: { op: 'op-0123abcd', handle: 'thread-1' } }));

  return file;
}

function worldWithBob(): { root: string; context: (files: string[]) => Promise<LeftoverContext> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
  roots.push(root);
  const world = { runId: RUN, home: path.join(root, 'home'), members: [{ name: 'bob', home: path.join(root, 'members', 'bob', 'home') }] } as World;

  return { root, context: async (files) => ({ world, self: { runId: RUN, paths: [], journals: [], runs: [] }, others: [], records: { files, runs: ['r1'], runtimeJournals: 0, placements: await readPlacements(files) } }) };
}

describe('cleanup while an attempt place is still open', () => {
  it('refuses, naming the place and the command that closes it from the install whose record it is', async () => {
    const { root, context } = worldWithBob();
    const mine = openT3Record(root, path.join(root, 'home'), 'running');
    const bobs = openT3Record(root, path.join(root, 'members', 'bob', 'home'), 'running');

    expect(cleanupPlan([{ onCleanup: places.onCleanup, observed: await places.observe(await context([mine, bobs])) }])).toEqual({
      kind: 'refuse',
      refusals: [{
        why: 'an attempt place of the world is still open, or its record cannot be read, and that record, which cleanup would remove, is what closes it. Close each one as its line says, then run cleanup again',
        items: [
          `run r1 attempt a1's place on teamai-t3/t3 (thread-1), running: close it with \`npm run -s verify -- teamai ${RUN} workflow cancel r1\``,
          `run r1 attempt a1's place on teamai-t3/t3 (thread-1), running: close it with \`npm run -s verify -- teamai ${RUN}@bob workflow cancel r1\``,
        ],
      }],
    });
  });

  it('refuses while a record cannot be read, since its place may be open, as uninstall does', async () => {
    const { root, context } = worldWithBob();
    const file = openT3Record(root, path.join(root, 'home'), 'garbled');
    const plan = cleanupPlan([{ onCleanup: places.onCleanup, observed: await places.observe(await context([file])) }]);

    expect(plan.kind).toBe('refuse');
    expect(JSON.stringify(plan)).toContain(`close what it can with \`npm run -s verify -- teamai ${RUN} workflow cancel r1\`, or fix that record`);
  });

  it('goes on once every place is closed', async () => {
    const { root, context } = worldWithBob();

    expect(cleanupPlan([{ onCleanup: places.onCleanup, observed: await places.observe(await context([openT3Record(root, path.join(root, 'home'), 'closed')])) }]).kind).toBe('remove');
  });
});

describe("a sandboxed attempt's environment in section (f)", () => {
  it('is NOT OBSERVED when its step ended before the observer first looked', async () => {
    const world = sandboxWorld();
    const observer = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: dockerListing(world, []) });

    expect(await observer.stop()).toEqual([]);
    expect(await places.observe(await contextOf([closedRecord('docker')], world))).toEqual([
      { kind: 'observed', findings: [], notes: ["NOT OBSERVED: run r0123abcd attempt a0123abcd's environment on docker, which no observer line read: its sandbox closed before the observer looked, or could not be read"] },
    ]);
  });

  it('says nothing more once an observer line read it', async () => {
    const world = sandboxWorld();
    const observer = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: dockerListing(world, ['teamai-r0123abcd-a0123abcd']) });

    expect(await observer.stop()).toEqual(['[verify] observed docker:teamai-r0123abcd-a0123abcd: env ok']);
    expect(await places.observe(await contextOf([closedRecord('docker')], world))).toEqual([{ kind: 'observed', findings: [], notes: [] }]);
  });

  it("is NOT OBSERVED, and refuses no cleanup, when the observer's records cannot be read", async () => {
    const world = sandboxWorld();
    fs.mkdirSync(path.join(world.dir, 'observed.jsonl'));
    const observed = await places.observe(await contextOf([closedRecord('docker')], world));

    expect(observed).toEqual([{ kind: 'observed', findings: [], notes: [expect.stringMatching(/^NOT OBSERVED: run r0123abcd attempt a0123abcd's environment on docker, since observed\.jsonl could not be read \(EISDIR/)] }]);
    expect(cleanupPlan([{ onCleanup: places.onCleanup, observed }]).kind).toBe('remove');
  });

  it('is NOT OBSERVED on a provider no observer reads', async () => {
    expect(await places.observe(await contextOf([closedRecord('seatbelt')]))).toEqual([
      { kind: 'observed', findings: [], notes: ["NOT OBSERVED: run r0123abcd attempt a0123abcd's environment on seatbelt, which no observer reads: the env check proves nothing for it"] },
    ]);
  });
});
