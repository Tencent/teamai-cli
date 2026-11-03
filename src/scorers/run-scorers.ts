/**
 * The scorers a run's passes are judged by: each `scorers/<name>.md` a step of the run lists, read at the team revision
 * the run started from, plus its patch, so a rubric edited while the run is open does not change how its passes are
 * judged; and the scorers the run generated, such as a benchmark's `teamai:correctness:<task>`, from the run's own files.
 * A run started before runs pinned a team revision kept its scorers in its file, and is judged by those until it ends.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getBusinessRoot, isSelfMode, type LocalConfig } from '../types.js';
import { readFileSafe, writeFileAtomic } from '../utils/fs.js';
import { setStderrOnly } from '../utils/logger.js';
import { revisionHoldsSources, withoutStaleTeamRevision } from '../utils/team-revision.js';
import { scoredPasses, type ScorablePass } from '../workflow/judge-work.js';
import { runsDir } from '../workflow/store.js';
import { TeamPin, type PinRead } from '../workflow/team-pin.js';
import { stepWorkflow, type RunState, type WorkflowStep } from '../workflow/types.js';
import { cachedScorerNames, pinScorers, scorerSourceHash, syncScorerDefinitions } from './cache.js';
import { PinnedScorerSchema, type PinnedScorer } from './pin.js';

export type RunScorerPins = { ok: true; pins: Record<string, PinnedScorer> } | { ok: false; reason: string };

type Run = Pick<RunState, 'id' | 'teamPin' | 'definition' | 'workflows' | 'admitted'>;

/** What a run file written before team pins held: its scorers, pinned as the cache held them when it started. */
const OlderRunSchema = z.looseObject({ scorers: z.record(z.string(), PinnedScorerSchema) });

/** The scorers every step of `steps` lists, inline workflows and `finally` included. */
function listedBy(steps: readonly WorkflowStep[]): string[] {
  return steps.flatMap((step) => {
    const child = stepWorkflow(step);

    return [...step.scorers?.names ?? [], ...(child?.kind === 'inline' ? listedBy(child.workflow.steps) : [])];
  });
}

/** Every scorer a step of `run` lists: of its workflow, the workflows it runs by name, and those its steps output. */
function listedScorers(run: Run): string[] {
  const definitions = [run.definition, ...Object.values(run.workflows ?? {}), ...Object.values(run.admitted ?? {}).map(({ definition }) => definition)];

  return [...new Set(definitions.flatMap((definition) => listedBy([...definition.steps, ...definition.finally ?? []])))];
}

/**
 * `runs/<run>/scorers/teamai/correctness/<task>.md` for `teamai:correctness:<task>`: a generated name's `:`s are
 * directories. Beside the run's scratch, not in it: its steps write there, and the engine removes it when the run ends.
 */
function generatedPath(config: LocalConfig, runId: string, name: string): string {
  return `${path.join(runsDir(config), runId, 'scorers', ...name.split(':'))}.md`;
}

/** Each team scorer the sync at the pin of `run` finds valid, with the pinned commit when that commit holds its bytes. */
async function teamScorersAt(config: LocalConfig, run: Run): Promise<PinRead<Record<string, PinnedScorer>>> {
  const { teamPin } = run;

  if (teamPin === undefined) return { ok: true, value: await pinScorers(config, await cachedScorerNames(config)) };

  return TeamPin.withTree(config, run, async (at) => {
    // The pin is read, not pulled: the sync's lines must not reach a verb's JSON on stdout.
    const previous = setStderrOnly(true);

    try {
      await syncScorerDefinitions(at, { scopeLabel: `team commit ${teamPin.revision.slice(0, 7)}` });
    } finally {
      setStderrOnly(previous);
    }

    const knowledge = at.repo.localPath;
    const repositoryRoot = await fs.realpath(isSelfMode(at) ? getBusinessRoot(at) : knowledge);
    const pins: Record<string, PinnedScorer> = {};

    for (const [name, { teamRevision: _atClone, ...pin }] of Object.entries(await pinScorers(at, await cachedScorerNames(at)))) {
      const holds = pin.relativePath !== undefined && await revisionHoldsSources(knowledge, { repositoryRoot, revision: teamPin.revision }, [{ path: pin.relativePath, content: pin.content }]);
      pins[name] = holds ? await withoutStaleTeamRevision(config.repo.localPath, { ...pin, teamRevision: teamPin.revision }) ?? pin : pin;
    }

    return pins;
  });
}

/** One read per team pin in a process: the runs a drain lists mostly share one. */
const readsAtPin = new Map<string, Promise<PinRead<Record<string, PinnedScorer>>>>();

/** The generated scorers among `names`, from the files run `runId` keeps; a name without one is left out. */
async function generatedOf(config: LocalConfig, runId: string, names: readonly string[]): Promise<Record<string, PinnedScorer>> {
  const pins: Record<string, PinnedScorer> = {};

  for (const name of names.filter((listed) => listed.includes(':'))) {
    const content = await readFileSafe(generatedPath(config, runId, name));

    if (content !== null) pins[name] = { sourceHash: scorerSourceHash(content), relativePath: `scorers/${name.split(':').join('/')}.md`, content, generated: true };
  }

  return pins;
}

export const RunScorers = {
  /**
   * The scorers the steps of `run` list, as its passes are judged: an older run's own pins, else the team's at the run's
   * pin with those it generated. A name with no valid scorer there is left out. Fails when the pin cannot be read here.
   */
  async of(config: LocalConfig, run: Run): Promise<RunScorerPins> {
    const older = OlderRunSchema.safeParse(run);

    if (older.success) return { ok: true, pins: older.data.scorers };
    const names = listedScorers(run);
    const key = JSON.stringify([config.repo.localPath, getBusinessRoot(config), run.teamPin ?? null]);
    const read = readsAtPin.get(key) ?? teamScorersAt(config, run);

    // A run with no pin reads the cache as it is now, which a pull may change.
    if (run.teamPin !== undefined) readsAtPin.set(key, read);
    const team = await read;

    if (!team.ok) return { ok: false, reason: `Run ${run.id}'s scorers cannot be read at the team revision it started from: ${team.failed}` };
    const pins = Object.fromEntries(names.flatMap((name) => (team.value[name] ? [[name, team.value[name]] as const] : [])));

    return { ok: true, pins: { ...pins, ...await generatedOf(config, run.id, names) } };
  },

  /** The passes of `run` this install judges, each with the scorers its step lists that `of` reads; a pass with none is left out. */
  async scoredPasses(config: LocalConfig, run: RunState, install: string): Promise<{ ok: true; passes: ScorablePass[] } | { ok: false; reason: string }> {
    const passes = scoredPasses(run, install);

    if (passes.length === 0) return { ok: true, passes };
    const read = await RunScorers.of(config, run);

    if (!read.ok) return read;

    return { ok: true, passes: passes.flatMap((pass) => {
      const scorers = pass.scorers.filter((name) => Object.hasOwn(read.pins, name));

      return scorers.length > 0 ? [{ ...pass, scorers }] : [];
    }) };
  },

  /** Writes each of `scorers`, named with a `:`, as a file of run `runId`, where `of` reads it. */
  async writeGenerated(config: LocalConfig, runId: string, scorers: Readonly<Record<string, PinnedScorer>>): Promise<void> {
    for (const [name, { content }] of Object.entries(scorers)) await writeFileAtomic(generatedPath(config, runId, name), content);
  },
};
