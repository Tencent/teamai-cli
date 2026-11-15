/**
 * The attempt places teamai's own records say an external step runtime still keeps open, under every HOME of the world,
 * and each sandboxed attempt whose environment no observer line read (observer.ts `attemptsObserved`). The record is
 * the product's (`readAttemptPlacementAt`), read the way a cancel reads it, and judged by the predicate `teamai
 * uninstall` refuses with (`heldPlaceOf`): cleanup refuses while one is open or unreadable, since the record it would
 * remove is what closes the place.
 */
import path from 'node:path';
import { readAttemptPlacementAt, type AttemptPlacement } from '../../../src/workflow/runtimes/attempt.js';
import { heldPlaceOf } from '../../../src/workflow/runtimes/cancelled.js';
import type { LeftoverKind } from '../leftovers.js';
import type { World } from '../world.js';

/** Each record file's placement, in the order given. */
export function readPlacements(files: readonly string[]): Promise<AttemptPlacement[]> {
  return Promise.all(files.map((file) => readAttemptPlacementAt(file)));
}

/** `<run> attempt <attempt>` from `.../runs/<run>/attempts/<attempt>/runtime.json`. */
function attemptOf(file: string): string {
  const { run, attempt } = keyOf(file);

  return `${run} attempt ${attempt}`;
}

function keyOf(file: string) {
  const attempt = path.dirname(file);

  return { run: path.basename(path.dirname(path.dirname(attempt))), attempt: path.basename(attempt) };
}

/** The verb that cancels the run of record `file` from the install whose HOME holds it: the world's own or a member's. */
function cancelOf(world: Pick<World, 'runId' | 'home' | 'members'>, file: string): string {
  const member = (world.members ?? []).find((each) => file.startsWith(`${each.home}${path.sep}`));

  return `\`npm run -s verify -- teamai ${world.runId}${member === undefined ? '' : `@${member.name}`} workflow cancel ${keyOf(file).run}\``;
}

export const places: LeftoverKind = {
  title: 'open attempt place',
  onCleanup: {
    kind: 'refuse',
    found: 'an attempt place of the world is still open, or its record cannot be read, and that record, which cleanup would remove, is what closes it. Close each one as its line says, then run cleanup again',
    unseen: 'cleanup could not read every attempt record of the world, so a place may still be open. Fix what failed, then run cleanup again',
  },
  async observe({ world, records }) {
    const { placements } = records;

    const findings = records.files.flatMap((file, index) => {
      const place = placements[index] === undefined ? undefined : heldPlaceOf(placements[index]);

      if (place === undefined) return [];
      const own = { kind: 'own' as const, why: `teamai's record ${file}` };

      if (place.held === 'unreadable') return [{ what: `the runtime record of run ${attemptOf(file)}, which cannot be read (${place.why}), so whether its place is open is unknown`, attribution: own, next: `close what it can with ${cancelOf(world, file)}, or fix that record` }];
      const { record } = place;
      const held = record.heldFor === undefined ? '' : `, held for a ${record.heldFor.conversation.tool} conversation`;

      return [{ what: `run ${attemptOf(file)}'s place on ${record.driver}/${record.runtime}${record.open.handle === undefined ? '' : ` (${record.open.handle})`}, ${record.phase}${held}`, attribution: own, next: `close it with ${cancelOf(world, file)}` }];
    });

    // The record keeps the provider once the place closes, which a short step does before the observer looks.
    const sandboxed = records.files.flatMap((file, index) => {
      const placement = placements[index];
      const provider = placement?.kind === 'external' ? (placement.record.sources ?? []).find((source) => source.sandbox !== undefined)?.sandbox?.provider : undefined;

      return provider === undefined ? [] : [{ file, provider }];
    });

    const observer = sandboxed.length === 0 ? undefined : await import('../observer.js');
    const observed = observer?.attemptsObserved(world);

    const notes = sandboxed.flatMap(({ file, provider }) => {
      const { run, attempt } = keyOf(file);

      if (observed?.kind === 'unreadable') return [`NOT OBSERVED: run ${attemptOf(file)}'s environment on ${provider}, since observed.jsonl could not be read (${observed.why})`];

      if (observed?.attempts.has(`${run}/${attempt}`) === true) return [];

      return [observer?.observerReads(provider) === false
        ? `NOT OBSERVED: run ${attemptOf(file)}'s environment on ${provider}, which no observer reads: the env check proves nothing for it`
        : `NOT OBSERVED: run ${attemptOf(file)}'s environment on ${provider}, which no observer line read: its sandbox closed before the observer looked, or could not be read`];
    });

    return [{ kind: 'observed', findings, notes }];
  },
};
