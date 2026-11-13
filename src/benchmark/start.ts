/**
 * `teamai benchmark plan` and `try`: the shell around plan.ts. A suite that cannot be planned is refused before the
 * run's trials exist, so `teamai benchmark run` leaves no run. Each refusal says what happened and what to do.
 */
import fs from 'node:fs/promises';
import os from 'node:os';

import path from 'node:path';
import { isRecordableLabel, isRecordableName, observeCheckout } from '../agent-observation.js';
import { loadLocalConfigForScope } from '../config.js';
import { isModelAlias, loadModelAliases, loadTeamModelAliases, noModelCause, noModelReason, resolveModelValue, type ModelAliases, type ModelResolution, type NoModel } from '../models/aliases.js';
import { readFolderMarker, RESOURCE_LAYOUTS } from '../resources/resolver.js';
import { defaultScorerRubric, pinScorers } from '../scorers/cache.js';
import { RunScorers } from '../scorers/run-scorers.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import { resolveTeamRef, TeamRefError } from '../team-ref.js';
import { roleDeclaration, type RoleDeclaration } from '../roles.js';
import type { LocalConfig } from '../types.js';
import { definedFields } from '../utils/defined-fields.js';
import { withTeamRevision } from '../workflow/cache.js';
import { loadCachedSuite, readSuiteFiles } from './suite-cache.js';
import { error } from '../workflow/engine.js';
import { runDeadline } from '../workflow/limits.js';
import { findAttemptRun } from '../workflow/run-location.js';
import { judgeUnavailable } from '../scorers/judges-here.js';
import { chooseJudgeModel } from '../scorers/judge-model.js';
import type { RunState, WorkflowEnvelope, WorkflowFailure } from '../workflow/types.js';
import { formatDiagnostic } from '../workflow/parse.js';
import { git } from '../workflow/worktree.js';
import { addedOf, compileBundle, freezePlan, trialScorersOf, type BenchmarkEstimate, type BenchmarkPlan, type CompiledBundle, type PinnedRubric, type PlannedArm } from './plan.js';
import { isMixedTask } from './calibration.js';
import { estimateOf, judgeCallsOf } from './estimate.js';
import { log } from '../utils/logger.js';
import { defaultsArmOf, parseSuite, type Arm, type Suite, type Task, type TaskCheck, TaskJudge } from './suite.js';
import { coveredDelivery, coveredSkillName, teamFilesAt } from './team-without.js';
import { pinArmWorkflow, type PinnedArmWorkflow } from './arm-workflow.js';
import type { TeamSelection } from '../workflow/clone.js';
import type { ArmTeam, SkillChanges } from './terms.js';
import type { Added } from '../scorers/check.js';
import { runCheckAt, type CheckRun } from '../scorers/check-run.js';
import { commitCacheOf, firstUnreachable } from '../workflow/place/place.js';
import { leavesOut, withoutRefusal } from './team-without.js';
import { commitCheckFiles, trialBlocker, type CommittedSuite } from './trial.js';
import { planOfRun, trialsUnattended } from './run-plan.js';

/** What planning reads besides the suite. */
interface BenchmarkStart {
  /** The member's checkout, where trials fetch task commits from. */
  checkout: string;
  /** `--aliases member`: resolve arm models with this member's ~/.teamai/models/aliases.yaml over the team's. */
  memberAliases: boolean;
  /** Every step that runs the plan is a strict sandbox, so each trial prompt runs `permissions: unattended`. */
  unattended: boolean;
  /** The task ids and arm names to run, in any order; `[]` runs all of them. */
  chosen: Chosen;
}

/** What `--task` and `--arm`, or the inputs `tasks` and `arms`, chose of a suite; `[]` chooses all. */
export interface Chosen {
  tasks: readonly string[];
  arms: readonly string[];
}

/**
 * What `teamai benchmark plan` prints: the workflow bundle a benchmark run's `from` step runs, and `plan`, the
 * measurement its `check` and `report` steps read. Each is frozen as `planBenchmark` freezes it, and the suite's timeout
 * comes with them. The correctness scorers it generates are files of the run, which `plan` writes.
 */
export interface BenchmarkPlanned {
  definition: Omit<CompiledBundle, 'scorers'>;
  plan: BenchmarkPlan;
}

/**
 * Freezes suite `name`, and answers the bundle and plan of a benchmark run, with the suite's
 * timeout, which bounds the run. Fills the commit cache with every commit a trial reads. Refused, as `team_ref_blocked`,
 * when this machine cannot pin the team a trial runs, so no trial runs with a team it did not ask for.
 */
export async function planBenchmark(config: LocalConfig, name: string, options: BenchmarkStart): Promise<{ planned: BenchmarkPlanned; generated: CompiledBundle['scorers']; timeoutMs: number } | { refused: Refusal }> {
  // First: no suite, arm or commit read later changes that this machine cannot pin the team a trial gets.
  const blocked = await trialBlocker(config);

  if (blocked !== undefined) return { refused: error('team_ref_blocked', blocked) };
  const frozen = await freezeSuite(config, name, options);

  if (!frozen.ok) return { refused: frozen.refused };
  const { suite, committed, pinned, armWorkflows, correctnessRubric } = frozen;
  const plan = { ...frozen.plan, estimate: await estimateFor(config, { plan: frozen.plan, committed, pinned }) };
  const { definition, workflows, scorers } = compileBundle(plan, committed, { armWorkflows, unattended: options.unattended, correctnessRubric });

  return { planned: { definition: { definition, workflows }, plan }, generated: scorers, timeoutMs: suite.timeoutMs };
}

/**
 * What `plan` will cost, from the earlier runs of its suite on this machine and on teamai-reports as this checkout last
 * read it. Its judge calls are counted batched, as teamai's benchmark workflow judges a trial. The earlier runs never
 * refuse a plan: when they cannot be read, a warning says why, and the estimate has no basis.
 */
async function estimateFor(config: LocalConfig, { plan, committed, pinned }: { plan: BenchmarkPlan; committed: CommittedSuite; pinned: Record<string, PinnedScorer> }): Promise<BenchmarkEstimate> {
  const definitions = Object.fromEntries(Object.entries(pinned).flatMap(([name, pin]) => {
    const definition = pinnedDefinition(name, pin);

    return definition ? [[name, { model: definition.model, tool: definition.tool }]] : [];
  }));

  const calls = judgeCallsOf({
    trials: plan.trials,
    tasks: committed.suite.tasks.map((task) => ({ id: task.id, scorers: trialScorersOf(committed.suite, task), isMixed: plan.tasks.some((one) => one.id === task.id && isMixedTask(one)) })),
    judges: plan.judges, definitions, calibrationRate: plan.calibration?.rate ?? 0, batch: true,
  });

  const { benchmarkRuns } = await import('../dashboard/benchmarks.js');

  const earlier = await benchmarkRuns(config, { refresh: false }).catch((cause: unknown) => {
    log.warn(`Could not read the earlier runs of ${plan.suite.name} to estimate its cost, so the run starts without an estimate: ${cause instanceof Error ? cause.message : String(cause)}`);

    return [];
  });

  return estimateOf({ plan, calls, earlier });
}

/**
 * `teamai benchmark plan <suite>`, as a step of the run whose attempt `env` marks: the suite planned from the run's
 * checkout, its generated correctness scorers written as files of the run, which `teamai score plan` reads. Refused when the run has no deadline, or one later than the suite's timeout allows, since then the suite's
 * timeout would bound nothing: start it with `workflow start --timeout`, as `teamai benchmark run` does. Its trial
 * prompts run unattended only when every step that runs the plan is a strict sandbox (`trialsUnattended`).
 */
export async function planStep(name: string, env: NodeJS.ProcessEnv, { memberAliases, chosen }: Pick<BenchmarkStart, 'memberAliases' | 'chosen'>): Promise<{ planned: BenchmarkPlanned } | { failure: WorkflowFailure }> {
  const found = await findAttemptRun(env);

  if ('error' in found) return { failure: found.error };
  const { config, run, step } = found;
  const planned = await planBenchmark(config, name, { checkout: run.checkout ?? process.cwd(), memberAliases, unattended: trialsUnattended(run, step.id), chosen });

  if ('refused' in planned) return { failure: planned.refused.error };
  const limit = runDeadline(run) === undefined ? undefined : Math.min(...[run.definition.timeout, run.timeout].filter((ms) => ms !== undefined));

  if (limit === undefined || limit > planned.timeoutMs) {
    const bound = limit === undefined ? 'has no timeout' : `may take ${durationText(limit)}`;

    return { failure: { code: 'invalid_arguments', message: `Run ${run.id} ${bound}, and suite "${name}" allows ${durationText(planned.timeoutMs)}. Start it with teamai workflow start ${run.name} --timeout ${durationText(planned.timeoutMs)}, or with teamai benchmark run ${name}, which sets it.` } };
  }

  await RunScorers.writeGenerated(config, run.id, planned.generated);

  return { planned: planned.planned };
}

/** `ms` as the largest whole unit a timeout takes: 2h, 10m, 30s or 500ms. */
function durationText(ms: number): string {
  const unit = ([['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const).find(([, size]) => ms % size === 0);

  return unit ? `${ms / unit[1]}${unit[0]}` : `${ms}ms`;
}

type Frozen = { ok: true; suite: Suite; plan: BenchmarkPlan; committed: CommittedSuite; pinned: Record<string, PinnedScorer>; armWorkflows: Map<string, PinnedArmWorkflow>; correctnessRubric: string } | Refused;

/**
 * Suite `name` as the plan freezes it, at the team revision this checkout last pulled: its arms' team resources and models,
 * its team scorers pinned, the correctness rubric of every arm (the team's scorers/teamai-correctness.md that pull kept,
 * else teamai's), its check files committed into the commit cache, and every task commit fetched into it.
 * Refused when any of them cannot be, or when the suite needs a judge this machine cannot run.
 */
async function freezeSuite(config: LocalConfig, name: string, options: BenchmarkStart): Promise<Frozen> {
  const refuse = (refused: Refusal): Refused => ({ ok: false, refused });
  const pulled = await pulledTeamRevision(config, options.checkout);

  if ('refused' in pulled) return refuse(error('team_revision_unpullable', pulled.refused));
  const { revision } = pulled;
  const cached = await loadCachedSuite(config, name);

  if (cached === null) {
    return refuse(error('benchmark_not_found', `Suite "${name}" has no runnable version for this member. Check benchmarks/${name}/SUITE.yaml and that your roles or projects receive its namespace, push it, run teamai pull, and start again.`));
  }

  const tasks = chosenOf(cached.tasks, options.chosen.tasks, ({ id }) => id);

  if (!tasks.ok) return refuse(error('invalid_arguments', `Suite "${name}" has no task "${tasks.missing}". Its tasks: ${cached.tasks.map(({ id }) => id).join(', ')}.`));
  const chosenArms = chosenOf(cached.arms, options.chosen.arms, ({ name: arm }) => arm);

  if (!chosenArms.ok) return refuse(error('invalid_arguments', `Suite "${name}" has no arm "${chosenArms.missing}". Its arms: ${cached.arms.map(({ name: arm }) => arm).join(', ')}.`));
  const found: Suite = { ...cached, tasks: tasks.chosen, arms: chosenArms.chosen };
  const isSubset = found.tasks.length < cached.tasks.length || found.arms.length < cached.arms.length;

  const unreachable = await unreachableTask(config, found, options.checkout);

  if (unreachable) {
    const { task, commit } = unreachable;
    const named = commit === task.startingCommit ? `starts from ${short(commit)}` : `writes check.add from its solutionCommit ${short(commit)}`;

    return refuse(error('commit_unreachable', `Task "${task.id}" ${named}, which neither this checkout nor ${found.repo} has. Push it, or fix ${commit === task.startingCommit ? 'startingCommit' : 'solutionCommit'}, and start again.`));
  }

  let aliases: Promise<ModelAliases> | undefined;
  const loadAliases = (): Promise<ModelAliases> => (aliases ??= armAliases(config, revision, options.memberAliases));
  const [firstArm, ...otherArms] = found.arms;
  const first = await plannedArm(config, firstArm, revision, loadAliases);

  if (!first.ok) return first;
  const rest: PlannedArm[] = [];

  for (const arm of otherArms) {
    const resolved = await plannedArm(config, arm, revision, loadAliases);

    if (!resolved.ok) return resolved;
    rest.push(resolved.arm);
  }

  const unpublishable = [first.arm, ...rest].map(unpublishableArm).find((message) => message !== undefined);

  if (unpublishable !== undefined) return refuse(error('arm_unpublishable', unpublishable));
  const undeclared = await undeclaredArmRole(config, [first.arm, ...rest]);

  if (undeclared !== undefined) return refuse(error('role_unavailable', undeclared));
  const armWorkflows = new Map<string, PinnedArmWorkflow>();
  const arms: [PlannedArm, ...PlannedArm[]] = [first.arm, ...rest];

  for (const [index, arm] of arms.entries()) {
    const workflow = found.arms[index]?.workflow;

    if (workflow === undefined) continue;
    const pinnedWorkflow = await pinArmWorkflow(config, { arm, name: workflow, revision: arm.team.kind === 'none' ? revision : arm.team.revision, unattended: options.unattended });

    if (!pinnedWorkflow.ok) {
      const { code, message } = pinnedWorkflow;

      return refuse(code === 'workflow_namespace_conflict' ? error('workflow_namespace_conflict', message) : error('arm_workflow_unrunnable', message));
    }

    armWorkflows.set(arm.name, pinnedWorkflow.pinned);
    arms[index] = { ...arm, workflow: { name: workflow, sourceHash: pinnedWorkflow.pinned.sourceHash } };
  }

  const listedByTasks = found.tasks.flatMap((task) => (task.scorers ?? []).map((scorer) => ({ task, scorer })));
  const pinned = await pinScorers(config, [...new Set([...found.scorers, ...listedByTasks.map(({ scorer }) => scorer)])]);
  const unpinned = found.scorers.find((scorer) => !Object.hasOwn(pinned, scorer));

  if (unpinned !== undefined) {
    return refuse(error('scorer_not_found', `Suite "${found.name}" lists scorer "${unpinned}", which has no valid scorers/${unpinned}.md for this member. Add the scorer, or remove it from ${found.relativePath}, push it, run teamai pull, and start again.`));
  }

  const unpinnedOfTask = listedByTasks.find(({ scorer }) => !Object.hasOwn(pinned, scorer));

  if (unpinnedOfTask !== undefined) {
    const { task, scorer } = unpinnedOfTask;

    return refuse(error('scorer_not_found', `Task "${task.id}" of suite "${found.name}" lists scorer "${scorer}", which has no valid scorers/${scorer}.md for this member. Add the scorer, or remove it from ${task.relativePath}, push it, run teamai pull, and start again.`));
  }

  const rubrics: Record<string, PinnedRubric> = {};

  for (const [scorer, pin] of Object.entries(pinned)) {
    const definition = pinnedDefinition(scorer, pin);
    const [firstLabel, ...otherLabels] = definition?.labels ?? [];

    if (!definition || !firstLabel) return refuse(error('scorer_invalid', `Scorer "${scorer}" of suite "${found.name}" is written in a form this teamai cannot read. Update teamai, and start again.`));
    rubrics[scorer] = { pin, definition: definedFields<PinnedRubric['definition']>({ labels: [firstLabel, ...otherLabels], passingScore: definition.passingScore, tool: definition.tool, model: definition.model }) };
  }

  const committed = await commitCheckFiles(commitCacheOf(config, found.repo), found);

  if (!committed.ok) {
    return refuse(error('check_files_unwritable', `Task "${committed.task}" writes files from the suite directory before its check, and they could not be written as a commit into this machine's benchmark cache: ${committed.failed} Fix that, and start again.`));
  }

  const skillChanges = await skillChangesOf(config, arms, { baseline: revision, defaults: defaultsArmOf(found)?.name });

  if ('refused' in skillChanges) return refuse(skillChanges.refused);
  const covered = await coveredTaskRefusal(config, { tasks: found.tasks, pulled: revision, arms, member: selectionOf(config) });

  if ('refusal' in covered) return refuse(covered.refusal);
  const { content: correctnessRubric } = await defaultScorerRubric(config, 'teamai-correctness');
  const plan = freezePlan({ committed: committed.suite, baselineTeamRevision: revision, selection: selectionOf(config), arms, scorers: rubrics, correctnessRubric, coveredSkills: covered.skills, coveredWithheldFrom: covered.withheldFrom, skillChanges: skillChanges.changes, isSubset });
  const unjudgeable = unjudgeableScorer(found.name, plan.judges, await loadAliases());

  if (unjudgeable !== undefined) return refuse(unjudgeable);
  const { scorers: generated } = compileBundle(plan, committed.suite, { armWorkflows, unattended: options.unattended, correctnessRubric });
  const criteria = found.tasks.find((task) => task.judge.kind !== 'check');
  const listing = listedByTasks[0];
  const needs = found.scorers.length > 0 ? `its scorers ${found.scorers.join(', ')}` : listing ? `task "${listing.task.id}" lists scorers ${(listing.task.scorers ?? []).join(', ')}` : criteria ? `task "${criteria.id}" has successCriteria` : undefined;

  // A correctness scorer a check decides has a pin and no judge.
  const judged = Object.entries({ ...pinned, ...generated }).flatMap(([scorer, pin]) => {
    const judge = plan.judges[scorer];

    return judge ? [[scorer, { pin, tool: judge.tool }] as const] : [];
  });

  const unjudged = needs === undefined ? undefined : await judgeUnavailable(config, Object.fromEntries(judged));

  if (unjudged !== undefined) {
    return refuse(error('scoring_unavailable', `This suite needs a judge (${needs}), and this machine cannot judge: ${unjudged} Fix it, or start the benchmark where a judge tool is installed.`));
  }

  return { ok: true, suite: found, plan, committed: committed.suite, pinned, armWorkflows, correctnessRubric };
}

/** The items of `all` that `names` names, in `all`'s order, or the first name none of them has; `[]` names all of them. */
function chosenOf<TItem>(all: [TItem, ...TItem[]], names: readonly string[], nameOf: (item: TItem) => string): { ok: true; chosen: [TItem, ...TItem[]] } | { ok: false; missing: string } {
  const missing = names.find((name) => !all.some((item) => nameOf(item) === name));

  if (missing !== undefined) return { ok: false, missing };
  const [first, ...rest] = all.filter((item) => names.length === 0 || names.includes(nameOf(item)));

  // Every name matched an item, so the filter kept one at least.
  return { ok: true, chosen: first === undefined ? all : [first, ...rest] };
}

type ArmResolution = { ok: true; arm: PlannedArm } | { ok: false; message: string };

/**
 * Why start refuses the paths the suite's tasks cover, or undefined when every one can be compared: a path the pulled
 * team revision does not have or that no arm's clone receives (`coveredDelivery`, the same resolvers as an arm's
 * `without`), and
 * two covered skill paths of the same bare name, which a trial's load record could not tell apart.
 */
async function coveredTaskRefusal(config: LocalConfig, { tasks, pulled, arms, member }: { tasks: readonly Task[]; pulled: string; arms: readonly PlannedArm[]; member: TeamSelection }): Promise<{ refusal: Refusal } | { skills: Record<string, string | null>; withheldFrom: Record<string, string[]> }> {
  const covers = tasks.flatMap((task) => task.covers ?? []);

  if (covers.length === 0) return { skills: {}, withheldFrom: {} };

  const listed = await teamFilesAt(config, { paths: covers, revision: pulled });

  // SAFETY: teamFilesAt fails only with `arm_team_unresolved`, reworded for the plan step that reads the team once.
  if ('failed' in listed) return { refusal: error('arm_team_unresolved', `A task covers ${listed.failed.message}`) };

  // Two different paths may share one bare skill name, which a trial's load record cannot tell apart; the same path twice is one.
  const byName = new Map<string, string>();

  for (const covered of new Set(covers)) {
    const bare = coveredSkillName(covered, listed.files);

    if (bare === undefined) continue;

    const other = byName.get(bare);

    if (other !== undefined) {
      return { refusal: error('task_covers_ambiguous', `Tasks cover ${other} and ${covered}, two skills of the same name ${bare}, which a trial's load record cannot tell apart. Cover one of them, fix the team's tasks, push them, run teamai pull, and start again.`) };
    }

    byName.set(bare, covered);
  }

  const delivered = await coveredDelivery(config, { paths: [...new Set(covers)], revision: pulled, arms, member, files: listed.files });

  if ('refusal' in delivered) return { refusal: error('arm_team_unresolved', delivered.refusal.message) };

  const skills = new Map<string, string | null>();

  for (const covered of new Set(covers)) skills.set(covered, coveredSkillName(covered, listed.files) ?? null);

  return { skills: Object.fromEntries(skills), withheldFrom: delivered.withheldFrom };
}


/** A refusal before any run exists. */
type Refusal = ReturnType<typeof error>;

type Refused = { ok: false; refused: Refusal };

/** The arm as the plan freezes it, its team resources resolved before its model, or why start refuses it. */
async function plannedArm(config: LocalConfig, arm: Arm, pulled: string, aliases: () => Promise<ModelAliases>): Promise<{ ok: true; arm: PlannedArm } | Refused> {
  const team = await resolveTeam(config, arm, pulled);

  if (!team.ok) return team;
  const resolved = await resolveArm(arm, team.team, aliases);

  return resolved.ok ? resolved : { ok: false, refused: error('arm_model_missing', resolved.message) };
}

/**
 * The team resources of `arm` as the plan freezes them: a ref resolved, as `pull --team-ref` resolves it, to a commit on the
 * team remote; the paths it runs without checked at the pulled revision, with the arm's role (`withoutRefusal`). An arm without team resources is refused on a
 * machine whose user-scope install delivers to its tool, since the tool would read those resources from the home.
 */
async function resolveTeam(config: LocalConfig, { name, tool, team, role }: Arm, pulled: string): Promise<{ ok: true; team: ArmTeam } | Refused> {
  switch (team.kind) {
    case 'pulled':
      return { ok: true, team: { kind: 'pulled', revision: pulled } };
    case 'none': {
      const user = await loadLocalConfigForScope('user', undefined, { dryRun: true, suppressMigrationNotice: true });

      if (user && (user.enabledAgents === undefined || user.enabledAgents.includes(tool))) {
        return { ok: false, refused: error('arm_team_unclean', `Arm "${name}" runs without team resources, and this machine's user-scope teamai install delivers team resources to ${tool} in your home, where its trials would read them. Start the benchmark on a machine where teamai is installed only in workspace scope.`) };
      }

      return { ok: true, team: { kind: 'none' } };
    }

    case 'ref': {
      const resolved = await resolveTeamRef(config.repo.localPath, team.ref).then((ref) => ({ ok: true as const, commit: ref.commit }), (cause: unknown) => ({ ok: false as const, cause }));

      if (resolved.ok) return { ok: true, team: { kind: 'ref', ref: team.ref, revision: resolved.commit } };

      if (resolved.cause instanceof TeamRefError) {
        return { ok: false, refused: error('arm_team_unresolved', `Arm "${name}" runs on team ref "${team.ref}", which is no branch, tag or commit of this checkout's team repo that holds teamai.yaml. Its branches: ${resolved.cause.branches.join(', ') || 'none'}. Fetch it, or fix the arm's team, push it, run teamai pull, and start again.`) };
      }

      const cause = resolved.cause instanceof Error ? resolved.cause.message : String(resolved.cause);

      return { ok: false, refused: error('arm_team_unreadable', `Arm "${name}" runs on team ref "${team.ref}", and git could not read this checkout's team repo at ${config.repo.localPath}: ${cause}. Repair the team repo, or run teamai pull, and start again.`) };
    }

    case 'without': {
      const refusal = await withoutRefusal(config, { arm: name, paths: team.paths, revision: pulled, selection: selectionOf(config), role });

      if (refusal?.code === 'arm_team_unreadable') return { ok: false, refused: error('arm_team_unreadable', refusal.message) };

      if (refusal) return { ok: false, refused: error('arm_team_unresolved', refusal.message) };

      return { ok: true, team: { kind: 'without', paths: team.paths, revision: pulled } };
    }

    default: {
      const unhandled: never = team;

      return unhandled;
    }
  }
}

/** The files of the baseline and of an arm's team revision, and those that differ between them. */
interface ComparedFiles {
  before: string[];
  after: string[];
  touched: string[];
}

/**
 * The skills each arm's team resources add, remove or change against the `baseline` team revision, by directory under
 * skills/: for an arm on another ref, as git compares the two revisions; for an arm without some paths, those of the
 * baseline it leaves out, whole or in part, namespaced ones too. An arm on the pulled revision, or with no team resources,
 * changes none.
 */
async function skillChangesOf(config: LocalConfig, arms: readonly PlannedArm[], { baseline, defaults }: { baseline: string; defaults: string | undefined }): Promise<{ changes: SkillChanges[] } | { refused: Refusal }> {
  const changes: SkillChanges[] = [];
  const listing = (revision: string) => git(config.repo.localPath, ['ls-tree', '-r', '--name-only', revision]);
  const lines = (text: string): string[] => text.split('\n').filter((file) => file !== '');

  for (const arm of arms) {
    const against = defaults === undefined || defaults === arm.name ? {} : { defaults };
    let compared: ComparedFiles;

    if (arm.team.kind === 'without') {
      const { paths } = arm.team;
      const before = await listing(baseline);

      if (before.code !== 0) {
        return { refused: error('arm_team_unreadable', `Arm "${arm.name}" runs without ${paths.join(', ')}, and git could not list the skills of the team revision this checkout pulled at ${config.repo.localPath}: ${before.stderr.trim()}. Repair the team repo, or run teamai pull, and start again.`) };
      }

      const files = lines(before.stdout);
      compared = { before: files, after: files.filter((file) => !leavesOut(paths, file)), touched: files.filter((file) => leavesOut(paths, file)) };
    } else {
      if (arm.team.kind !== 'ref' || arm.team.revision === baseline) continue;
      const [before, after, diff] = await Promise.all([listing(baseline), listing(arm.team.revision), git(config.repo.localPath, ['diff', '--name-only', '--no-renames', baseline, arm.team.revision])]);
      const failed = [before, after, diff].find((read) => read.code !== 0);

      if (failed) {
        return { refused: error('arm_team_unreadable', `Arm "${arm.name}" runs on team ref "${arm.team.ref}", and git could not compare its skills with the team revision this checkout pulled at ${config.repo.localPath}: ${failed.stderr.trim()}. Repair the team repo, or run teamai pull, and start again.`) };
      }

      compared = { before: lines(before.stdout), after: lines(after.stdout), touched: lines(diff.stdout) };
    }

    const [had, has] = [skillDirectories(compared.before), skillDirectories(compared.after)];

    const skills = [...new Set([...had, ...has])].sort().flatMap((directory) => {
      const change = !had.has(directory) ? 'added' as const : !has.has(directory) ? 'removed' as const
        : compared.touched.some((file) => file.startsWith(`${directory}/`)) ? 'changed' as const : undefined;

      return change ? [{ name: path.posix.basename(directory), change }] : [];
    });

    const [first, ...rest] = skills;

    if (first) changes.push({ arm: arm.name, ...against, skills: [first, ...rest] });
  }

  return { changes };
}

/** The skill directories, each the directory of a SKILL.md under skills/, among `files`. */
function skillDirectories(files: readonly string[]): Set<string> {
  return new Set(files.flatMap((file) => (/(?:^|\/)skills\/(?:[^/]+\/)*?[^/]+\/SKILL\.md$/.test(file) ? [path.posix.dirname(file)] : [])));
}

/** What a member can do about an arm whose model gives its tool none. */
const NO_MODEL_FIX = {
  unmapped: 'Add one and start again.',
  local: 'Remove that entry, or start again without --member-aliases.',
  switched: 'Run teamai models restore, or start again without --member-aliases.',
  unresolved: 'Fix that and start again.',
} as const satisfies Record<NoModel, string>;

/**
 * The arm as the plan freezes it: its model alias resolved for its tool to a model name and effort, or its model name as
 * written. An alias that gives the tool no model refuses the start. `source` is `member` when the member's own entry,
 * or their model switch, decided the model.
 */
async function resolveArm({ name, tool, model, role, recall }: Arm, team: ArmTeam, aliases: () => Promise<ModelAliases>): Promise<ArmResolution> {
  const roleField = role !== undefined ? { role } : {};
  const recallField = recall !== undefined ? { recall } : {};

  if (model === undefined) return { ok: true, arm: { name, tool, source: 'team', team, ...roleField, ...recallField } };
  const loaded = await aliases();
  const alias = isModelAlias(loaded, model);
  const resolution: ModelResolution = resolveModelValue(loaded, model, tool);

  if (!resolution.ok || resolution.model === undefined) {
    return { ok: false, message: `Arm "${name}" uses ${alias ? `model alias "${model}"` : `model "${model}"`}, which ${noModelCause(resolution, tool)}. ${NO_MODEL_FIX[noModelReason(resolution)]}` };
  }

  const source = resolution.step === 'local' || resolution.step === 'switched' ? 'member' : 'team';

  return { ok: true, arm: definedFields<PlannedArm>({ name, tool, model: resolution.model, alias: alias ? model : undefined, effort: resolution.effort, source, team, ...roleField, ...recallField }) };
}

/**
 * Why no judge can run a scorer as the plan pins it, or undefined: its tool or model is not a plain name, which the
 * record publishes, or its model alias has no model for its tool at the run's team revision.
 */
function unjudgeableScorer(suite: string, judges: BenchmarkPlan['judges'], aliases: ModelAliases): Refusal | undefined {
  for (const [scorer, { tool, model }] of Object.entries(judges)) {
    const field = !isRecordableLabel(tool) ? 'tool' : model !== '' && !isRecordableName(model) ? 'model' : undefined;

    if (field !== undefined) {
      return error('judge_unpublishable', `Suite "${suite}" judges scorer "${scorer}" with a ${field} that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. Fix the scorer or the suite's defaults.tool, push it, run teamai pull, and start again.`);
    }

    if (model === '') continue;
    const chosen = chooseJudgeModel(aliases, { name: scorer, model }, [tool]);

    if (!chosen.ok) return error('judge_model_unavailable', `Suite "${suite}" judges scorer "${scorer}" on ${tool} for every arm: the scorer's tool, else the suite's defaults.tool. ${chosen.message}`);
  }

  return undefined;
}

/**
 * Why the record cannot publish `arm` as planned, or undefined when it can: its tool, model and effort meet the name
 * rules an observed agent meets (agent-observation.ts), so no URL, credential or local path reaches a record. Says
 * nothing of the value, which may be a secret.
 */
function unpublishableArm(arm: PlannedArm): string | undefined {
  const field = !isRecordableLabel(arm.tool) ? 'tool'
    : arm.model !== undefined && !isRecordableName(arm.model) ? 'model'
      : arm.effort !== undefined && !isRecordableLabel(arm.effort) ? 'effort' : undefined;

  if (field === undefined) return undefined;

  const fix = arm.source === 'member' && field !== 'tool'
    ? 'Fix your entry in ~/.teamai/models/aliases.yaml, or start again without --member-aliases.'
    : 'Fix the suite or the team\'s models/aliases.yaml, push it, run teamai pull, and start again.';

  return `Arm "${arm.name}" has a ${field} that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. ${fix}`;
}

/**
 * Why an arm's role cannot be given to its trials, or undefined when every role is: manifest/roles.yaml at the team
 * revision the arm runs on must declare it, as the trial's clone checks it again before its pull.
 */
async function undeclaredArmRole(config: LocalConfig, arms: readonly PlannedArm[]): Promise<string | undefined> {
  const declared = new Map<string, Promise<RoleDeclaration | { failed: string }>>();

  for (const { name, role, team } of arms) {
    if (role === undefined || team.kind === 'none') continue;
    const { revision } = team;
    const roles = declared.get(revision) ?? withTeamRevision(config, revision, (at) => roleDeclaration(at.repo.localPath));
    declared.set(revision, roles);
    const read = await roles;

    if ('failed' in read) {
      return `Arm "${name}" runs with role ${role}, and team revision ${short(revision)} cannot be read: ${read.failed}. Run the arm on another team revision, push it, run teamai pull, and start again.`;
    }

    switch (read.kind) {
      case 'declared':
      case 'undeclared':
        if (read.ids.includes(role)) continue;

        return `Arm "${name}" runs with role ${role}, which manifest/roles.yaml at team revision ${short(revision)} does not declare; it declares ${read.ids.join(', ') || 'none'}. Add the role to manifest/roles.yaml, or fix the arm's role, push it, run teamai pull, and start again.`;
      case 'missing':
        return `Arm "${name}" runs with role ${role}, and team revision ${short(revision)} has no manifest/roles.yaml to declare it. Add manifest/roles.yaml declaring the role, or remove the arm's role, push it, run teamai pull, and start again.`;
      case 'unreadable':
        return `Arm "${name}" runs with role ${role}, and manifest/roles.yaml at team revision ${short(revision)} cannot be read: ${read.error}. Fix manifest/roles.yaml on that revision, or run the arm on another team revision, push it, run teamai pull, and start again.`;
      default: {
        const unhandled: never = read;

        return unhandled;
      }
    }
  }

  return undefined;
}

/** The model aliases the team files hold at `revision`, under the config's selection, and the member's over them when asked. */
async function armAliases(config: LocalConfig, revision: string, member: boolean): Promise<ModelAliases> {
  const read = await withTeamRevision(config, revision, (at) => (member ? loadModelAliases(at) : loadTeamModelAliases(at)));

  return 'failed' in read ? { ok: false, reason: `the team's model aliases at ${revision.slice(0, 7)} could not be read: ${read.failed}` } : read;
}

/**
 * The team revision this checkout last pulled, as a launch of a tool that pull delivered to observes it. Refused when
 * pull delivered to no tool, when the delivered resources were edited since, or when the revision is on no branch of the
 * team remote, so another machine could not pull it.
 */
async function pulledTeamRevision(config: LocalConfig, checkout: string): Promise<{ revision: string } | { refused: string }> {
  const { teamDelivery } = await import('../pull.js');
  const tool = (await teamDelivery(config, '')).record?.targets[0];

  if (tool === undefined) {
    return { refused: 'teamai pull set up no AI tool in this checkout, so the team revision it delivered cannot be read. Run teamai init with --agent <tool>, run teamai pull, and start again.' };
  }

  const team = (await observeCheckout({ config, tool, cwd: checkout })).team;
  const pushed = team !== undefined && !team.localChanges && await resolveTeamRef(config.repo.localPath, team.revision).then(() => true, () => false);

  return pushed ? { revision: team.revision } : { refused: 'Benchmarks start from the team revision this checkout last pulled, and it has none that another machine can pull. Push any team changes, run teamai pull, and start again.' };
}

/**
 * The first task, and its commit, whose starting commit or solution commit for check.add neither the checkout nor the commit cache has,
 * after a fetch by SHA from the suite repo into the cache: a shallow CI checkout lacks older commits, and a trial's clone
 * fetches offline.
 */
async function unreachableTask(config: LocalConfig, suite: Suite, checkout: string): Promise<{ task: Suite['tasks'][number]; commit: string } | undefined> {
  const cache = commitCacheOf(config, suite.repo);

  for (const task of suite.tasks) {
    // A check's added files come from the task's solution commit, so its trials need that commit too.
    const added = TaskJudge.checkOf(task.judge)?.add;
    const commit = await firstUnreachable({ checkout, cache, repo: suite.repo, commits: [task.startingCommit, ...(added ? [added.commit] : [])] });

    if (commit !== undefined) return { task, commit };
  }

  return undefined;
}

function selectionOf(config: LocalConfig): TeamSelection {
  return definedFields<TeamSelection>({
    primaryRole: config.primaryRole || undefined,
    additionalRoles: config.additionalRoles,
    projects: config.projects ?? [],
    subscribedTags: config.subscribedTags,
    excludedSkills: config.excludedSkills ?? [],
  });
}

/**
 * Why `teamai workflow resume` refuses `run`: a benchmark run whose plan a teamai before an upgrade froze in another
 * schemaVersion, which this one cannot measure. Undefined for any other run, which resume handles as it does every run.
 */
export function outdatedBenchmarkPlan(run: RunState): WorkflowFailure | undefined {
  const planned = planOfRun(run);

  return 'failure' in planned && planned.failure.code === 'benchmark_plan_outdated' ? planned.failure : undefined;
}

/**
 * `teamai benchmark try <task file>`: whether a task's check tells its solution from no change, before the task reaches a
 * suite. Reads the task file and the SUITE.yaml (or suite.yaml) two directories up from it as written, with no
 * install, and validates both as pull does. A check task's check must fail by its own exit at `startingCommit`, as its
 * baseline must, and with `solutionCommit`, pass at the solution with the protected paths as `startingCommit` has them, as a
 * trial's check would read a correct change. Each runs in a fresh clone from `checkout`, or from a cache that fetched the
 * commit by SHA from the suite repo as start does, under the suite's setup and timeout. No run, arm, trial, judge or
 * record.
 */
export async function tryBenchmarkTask(file: string, options: { checkout: string; signal?: AbortSignal; progress: (line: string) => void }): Promise<WorkflowEnvelope> {
  const posix = (at: string): string => at.split(path.sep).join('/');
  const suiteDir = path.dirname(path.dirname(file));
  const held = await readFolderMarker(RESOURCE_LAYOUTS.benchmarks, { full: suiteDir, path: `${posix(suiteDir)}/` });

  if (held.kind === 'invalid') return error('benchmark_invalid', held.message);
  const suiteFile = path.join(suiteDir, held.kind === 'folder' ? held.marker : RESOURCE_LAYOUTS.benchmarks.marker);
  const read = (at: string): Promise<string | undefined> => fs.readFile(at, 'utf8').catch(() => undefined);
  const [suiteText, taskText] = [await read(suiteFile), await read(file)];

  if (taskText === undefined) return error('benchmark_not_found', `The task file ${file} could not be read. Pass the path of a task file, such as benchmarks/<suite>/tasks/<task>.yaml in a checkout of the team repo.`);

  if (suiteText === undefined) return error('benchmark_not_found', `${suiteFile} could not be read: teamai benchmark try reads the suite two directories up from the task file, as in benchmarks/<suite>/tasks/<task>.yaml.`);
  const taskSource = { relativePath: posix(file), content: taskText };
  const files = await readSuiteFiles(path.dirname(suiteFile), posix(path.dirname(suiteFile)), [taskSource]);
  const parsed = parseSuite({ suite: { relativePath: posix(suiteFile), content: suiteText }, tasks: [taskSource], files });

  if (!parsed.ok) return error('benchmark_invalid', parsed.diagnostics.map(formatDiagnostic).join('\n'));
  const { suite } = parsed;
  const [task] = suite.tasks;
  const { startingCommit } = task;
  const check = TaskJudge.checkOf(task.judge);

  if (check === undefined) return tried(task.id, `Task "${task.id}" is judged by successCriteria, so there is no check to try. Its files are valid.`);
  const { solutionCommit } = task;
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-try-commits-'));

  try {
    const unreachable = await firstUnreachable({ checkout: options.checkout, cache, repo: suite.repo, commits: [startingCommit, ...(solutionCommit ? [solutionCommit] : [])] });

    if (unreachable !== undefined) {
      const named = unreachable === startingCommit ? `starts from ${short(unreachable)}` : `names the solutionCommit ${short(unreachable)}`;

      return error('commit_unreachable', `Task "${task.id}" ${named}, which neither this checkout nor ${suite.repo} has. Push it, or fix ${unreachable === startingCommit ? 'startingCommit' : 'solutionCommit'}, and try again.`);
    }

    const committed = await commitCheckFiles(cache, suite);

    if (!committed.ok) {
      return error('check_files_unwritable', `Task "${committed.task}" writes files from the suite directory before its check, and they could not be written as a commit into a temporary cache: ${committed.failed} Fix that, and try again.`);
    }

    return await tryCheck(suite, task, check, addedOf(check, committed.suite.files.get(task.id)), [options.checkout, cache], options);
  } finally {
    await fs.rm(cache, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * --try once the task's commits are reachable from `sources`: its check at the starting commit, then at the solution, each
 * with the files `add` writes.
 */
async function tryCheck(suite: Suite, task: Suite['tasks'][number], judge: TaskCheck, add: readonly Added[], sources: readonly string[], options: { checkout: string; signal?: AbortSignal; progress: (line: string) => void }): Promise<WorkflowEnvelope> {
  const { startingCommit } = task;
  const expiresAt = new Date(Date.now() + suite.timeoutMs).toISOString();

  const at = (commit: string, protect?: readonly string[]): Promise<CheckRun> => runCheckAt({
    commit, startingCommit, command: judge.run, protect, add, setup: suite.setup, sources, expiresAt, signal: options.signal,
  });

  options.progress(`Task ${task.id}: trying the check at ${short(startingCommit)}`);
  const start = await at(startingCommit);
  const unusable = unusableRun(task.id, judge.run, startingCommit, start);

  if (unusable !== undefined) return error('task_try_failed', unusable);

  if (start.kind === 'check' && start.verdict.verdict === 'passed') {
    return error('task_try_failed', `Task "${task.id}": the check passes without changes at ${short(startingCommit)}, so it cannot tell a solution from no change. Pick a startingCommit where the check fails, or fix the check.`);
  }

  const { solutionCommit } = task;

  if (solutionCommit === undefined) return tried(task.id, `Task "${task.id}": the check fails at ${short(startingCommit)}, as the task expects. The task has no solutionCommit, so the check was not tried on a solution.`);
  options.progress(`Task ${task.id}: trying the check at the solution ${short(solutionCommit)}, with the protected paths as ${short(startingCommit)} has them`);
  const solved = await at(solutionCommit, judge.protect);
  const unusableSolution = unusableRun(task.id, judge.run, solutionCommit, solved);

  if (unusableSolution !== undefined) return error('task_try_failed', unusableSolution);

  if (solved.kind === 'check' && solved.verdict.verdict === 'failed') {
    const changed = await git(options.checkout, ['diff', '--name-only', startingCommit, solutionCommit, '--', ...judge.protect.map((entry) => `:(glob)${entry}`)]);
    const added = new Set(add.flatMap((entry) => entry.paths));
    const paths = changed.code === 0 ? changed.stdout.split('\n').filter((line) => line !== '' && !added.has(line)) : [];
    const hint = paths.length > 0 ? ` The solution changes ${paths.join(', ')}, which protect puts back as ${short(startingCommit)} has them: list a test the solution brought in check.add.` : '';

    return error('task_try_failed', `Task "${task.id}": the check fails at the solution ${short(solutionCommit)} (exit ${solved.verdict.exitCode}), with the protected paths as ${short(startingCommit)} has them.${hint}`);
  }

  return tried(task.id, `Task "${task.id}": the check fails at ${short(startingCommit)} and passes at the solution ${short(solutionCommit)}, with the protected paths as ${short(startingCommit)} has them.`);
}

function tried(task: string, message: string): WorkflowEnvelope {
  return { data: { try: { task, message } } };
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

/** Why `ran` at `commit` says nothing of the check, or undefined when the check ran to its own exit. */
function unusableRun(task: string, command: string, commit: string, ran: CheckRun): string | undefined {
  if (ran.kind === 'error') return `Task "${task}" could not be tried at ${short(commit)}: ${ran.failure.message}`;
  const { verdict } = ran;

  if (verdict.verdict !== 'could_not_run') return undefined;

  return `Task "${task}": the check "${command}" could not run at ${short(commit)} (${verdict.cause}${verdict.detail ? `: ${verdict.detail}` : ''}). Make the command runnable after setup there, or fix check.run.`;
}
