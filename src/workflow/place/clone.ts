/**
 * The clone place a step opens with `workspace: { clone: … }`: a fresh clone of the place's commit with its own `.git`,
 * no remotes and its hooks off, fetched offline from the run's checkout or the commit cache, and the team assets the
 * place names installed by a `teamai pull` whose HOME is the clone's own. Every step that continues it runs there, and
 * its commits stay there: nothing is pushed.
 *
 *   <os.tmpdir()>/teamai-clones/<8 hex>/                 root, one per clone prepared, short on purpose: Windows paths
 *     r/                                                the clone, the place's dir
 *     h/                                                the HOME of the clone's own `teamai pull`: its partition and team clone
 *     team.git/                                         a bare repo that holds only the team revision the place pins
 *     saved/                                            the commit's agent files, put back where a step left them as delivered
 *
 * A receipt, `<runsDir>/<run>/clones/<8 hex of the branch>.json`, names the root before anything under it exists, so `sweepClones`
 * removes exactly what a crash left, once no step that runs in the clone is still to settle.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { observeCheckout, ReportedAgentSchema, type ReportedAgent } from '../../agent-observation.js';
import { resolveCliEntry } from '../../builtin-hooks.js';
import { saveLocalConfigForScope } from '../../config.js';
import { stepEnvironment } from '../../env-exec.js';
import { removeGitHook } from '../../git-hook.js';
import { createProjectToolRoots } from '../../project-agent-root.js';
import { scoresDir } from '../../scorers/attempts.js';
import { removeSubjectEvidence } from '../../scorers/evidence.js';
import { homeVariables, isToolId, TOOLS } from '../../tools.js';
import { getDataHome, LocalConfigSchema, type LocalConfig } from '../../types.js';
import { execCommand } from '../../utils/exec.js';
import { readJson, writeJsonAtomic } from '../../utils/fs.js';
import { getDefaultBranch, HEAD_STATUS, headStateOf, resolveAnchors, type HeadState } from '../../utils/git.js';
import { log } from '../../utils/logger.js';
import { projectSlug } from '../../utils/partition.js';
import type { TeamDelivery } from '../../pull.js';
import { CommitSchema, type ClonePlace, type InstalledTeam } from '../clone.js';
import { runDeadline } from '../limits.js';
import { runPasses } from '../loop.js';
import { stepDefinitions } from '../scope.js';
import { stageEvidence } from '../scoring-evidence.js';
import { settled } from '../step-state.js';
import { readRun, runsDir, type RunId } from '../store.js';
import type { RunState, WorkflowFailure } from '../types.js';
import { cloneBranchOf } from '../workspace.js';
import { commitWithout } from './team-without.js';
import { boundedGit, commitWork, recordConfigOverlay, replaceConfig, restoreUneditedConfig, saveConfig, untrustedGit, type Git } from '../worktree.js';

/**
 * The commit a clone's install pulled for a treatment without some paths, which teamai made of `revision` without them.
 * The clone ran on `revision`, so its observations name that.
 */
const WithoutSchema = z.object({ commit: CommitSchema, revision: CommitSchema }).strict();
type Without = z.infer<typeof WithoutSchema>;

/**
 * What teamai made of the clone: `prepared`, what it observed there once the clone and its install were done, the team
 * revision the install pinned and the commit; `install`, that install's config, absent when the place installs no team,
 * and the commit it pulled for a treatment without some paths.
 */
const Made = {
  prepared: ReportedAgentSchema,
  install: z.object({ config: LocalConfigSchema, dataHome: z.string().min(1), without: WithoutSchema.optional() }).strict().optional(),
};

/** `installed`: the clone and its install are done, and setup is not; `ready`: setup is done too. */
const CloneReceiptSchema = z.object({
  v: z.literal(1),
  branch: z.string().min(1),
  root: z.string().min(1),
  /** What git and the install in the clone run without. */
  withhold: z.array(z.string()),
  state: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('preparing') }).strict(),
    z.object({ kind: z.literal('installed'), ...Made }).strict(),
    z.object({ kind: z.literal('ready'), ...Made }).strict(),
  ]),
}).strict();
type CloneReceipt = z.infer<typeof CloneReceiptSchema>;

const CLONES = 'teamai-clones';

/**
 * The key of the clone of `branch` among a driver's places: two attempts in one clone share it. Not a path: each clone
 * prepared gets a root of its own, so a process a killed step left behind never writes into the next clone.
 */
export function cloneKeyOf(branch: string): string {
  return `clone:${branch}`;
}

function receiptPath(runsRoot: string, run: string, branch: string): string {
  return path.join(runsRoot, run, 'clones', `${createHash('sha256').update(branch).digest('hex').slice(0, 8)}.json`);
}

async function readReceipt(file: string): Promise<CloneReceipt | undefined> {
  const parsed = CloneReceiptSchema.safeParse(await readJson(file));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Where a clone fetches commits it starts from, which the run's checkout may lack, such as a shallow CI checkout's,
 * and commits no repo holds, such as those a benchmark makes of its suite files. `repo` keys it and is never fetched.
 * Safe to delete only while no run of `repo` is open.
 */
export function commitCacheOf(config: LocalConfig, repo: string): string {
  return path.join(getDataHome(config), 'benchmarks', 'objects', `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.git`);
}

/** What opening a clone place reads of its lease. */
export interface CloneLease {
  attempt: string;
  step: string;
  branch: string;
  clone: ClonePlace;
  /** The commit the step starts from: the clone's latest, which is the place's commit until a step committed there. */
  start: string;
  /** The names the clone's git, its install, and whatever they start never get. */
  withhold: readonly string[];
  /** The tool the step runs on, which the install delivers to; else the member's enabled agents. */
  tool?: string;
  expiresAt?: string;
}

/**
 * Opens the clone of `lease.branch`: the prepared one when its receipt says so, else a fresh one in a root of its own,
 * which `created` says, once any earlier root of the branch is gone. `dir` is where the clone is, or would have been. A step that continues work an earlier step committed there fails
 * when the clone is gone, rather than run on a fresh one. `checkout` is the run's checkout, the first place a commit is
 * fetched from.
 */
export async function openClone(input: { config: LocalConfig; run: RunId; checkout: string; lease: CloneLease }): Promise<{ dir: string } & ({ created: boolean } | { failure: WorkflowFailure })> {
  const { config, run, lease } = input;
  const file = receiptPath(runsDir(config), run, lease.branch);
  const found = await readReceipt(file);
  if (found?.state.kind === 'ready' && await isDirectory(path.join(found.root, 'r'))) {
    await redeliver(found.root);
    return { dir: path.join(found.root, 'r'), created: false };
  }
  if (lease.start !== lease.clone.commit) {
    return { dir: path.join(found?.root ?? scratchCloneRoot(), 'r'), failure: { code: 'workspace_base', message: `The clone of ${lease.branch} is gone, so step "${lease.step}" cannot continue the work committed there.` } };
  }
  if (found) await removeRoot(found.root, file);
  const root = scratchCloneRoot();
  const dir = path.join(root, 'r');
  // Every git and pull that prepares the clone runs without what the lease withholds, as its step does.
  const scoped = await cloneEnv(lease.withhold);
  if (!scoped.ok) return { dir, failure: scoped.failure };
  await writeJsonAtomic(file, { v: 1, branch: lease.branch, root, withhold: [...lease.withhold], state: { kind: 'preparing' } } satisfies CloneReceipt);
  const cloned = await freshClone(root, lease.clone.commit, [input.checkout, ...(lease.clone.repo !== undefined ? [commitCacheOf(config, lease.clone.repo)] : [])], lease.expiresAt, scoped.env);
  if (cloned) return { dir, failure: cloned };
  const { team } = lease.clone;
  const installed = 'revision' in team ? await installTeam({ config, root, lease, team, env: scoped.env }) : undefined;
  if (installed && 'code' in installed) return { dir, failure: installed };
  const git = boundedGit(lease.expiresAt, scoped.env);
  const status = await git(dir, [...HEAD_STATUS]);
  const head = status.code === 0 ? headStateOf(status.stdout) : null;
  const tool = installed ? installed.config.enabledAgents?.[0] : undefined;
  const prepared = installed && tool !== undefined
    ? await observeCheckout({ config: installed.config, tool, cwd: dir, head, delivery: await cloneDelivery({ install: installed.config, without: installed.without }, tool) ?? null })
    : head ? { project: { commit: head.head, dirty: head.dirty } } : {};
  const made = { prepared, ...(installed ? { install: { config: LocalConfigSchema.parse(installed.config), dataHome: installed.dataHome, ...(installed.without ? { without: installed.without } : {}) } } : {}) };
  await writeJsonAtomic(file, { v: 1, branch: lease.branch, root, withhold: [...lease.withhold], state: { kind: 'installed', ...made } } satisfies CloneReceipt);
  return { dir, created: true };
}

/**
 * Puts back, for a later step in the clone, the team assets its install delivered, which the last step's commit took
 * out with the clone's other agent files, and records them as the overlay again, so they are not that step's edits.
 * A clone that installs no team kept no copy of them; one whose overlay is still on has its `saved`.
 */
async function redeliver(root: string): Promise<void> {
  const clone = path.join(root, 'r');
  const saved = path.join(root, 'saved');
  const delivered = path.join(root, DELIVERED);
  if (!await isDirectory(delivered) || await isDirectory(saved)) return;
  // Renamed into place once the overlay is recorded, so `saved` is never half written.
  const partial = `${saved}.partial`;
  await fs.rm(partial, { recursive: true, force: true });
  await fs.mkdir(partial);
  await saveConfig(clone, partial);
  await replaceConfig(clone, delivered);
  await recordConfigOverlay(clone, partial);
  await fs.rename(partial, saved);
}

/** Records the clone of `branch` set up, so a later step continues it instead of making another. */
export async function markCloneReady(config: LocalConfig, run: RunId, branch: string): Promise<void> {
  const file = receiptPath(runsDir(config), run, branch);
  const found = await readReceipt(file);
  if (found?.state.kind !== 'installed') return;
  await writeJsonAtomic(file, { ...found, state: { ...found.state, kind: 'ready' } } satisfies CloneReceipt);
}

/**
 * The clone of `branch` as teamai prepared it: what it observed there, and the config of the clone's own install,
 * absent when the place installs no team, with the commit it pulled for a treatment without some paths. Undefined when
 * this machine prepared none.
 */
export async function preparedClone(config: LocalConfig, run: RunId, branch: string): Promise<{ prepared: ReportedAgent; install?: LocalConfig; without?: Without } | undefined> {
  const found = await readReceipt(receiptPath(runsDir(config), run, branch));
  if (found?.state.kind !== 'ready') return undefined;
  const { prepared, install } = found.state;
  return { prepared, ...(install ? { install: { ...install.config, dataHome: install.dataHome }, ...(install.without ? { without: install.without } : {}) } : {}) };
}

/**
 * What the clone's own install delivered for `tool`, as a step's observation reads it, or undefined when it cannot be
 * read. An install without some paths pulled a commit teamai made of its revision, so the delivery names that revision.
 */
export async function cloneDelivery({ install, without }: { install: LocalConfig; without?: Without }, tool: string): Promise<TeamDelivery | undefined> {
  const { teamDelivery } = await import('../../pull.js');
  const delivery = await teamDelivery(install, tool).catch(() => undefined);
  return delivery?.complete && without && delivery.commit === without.commit ? { ...delivery, commit: without.revision } : delivery;
}

/** Gives up the clone of `branch`: its root and receipt go, so the next step that opens it gets a fresh one. */
export async function removeClone(config: LocalConfig, run: RunId, branch: string): Promise<void> {
  const file = receiptPath(runsDir(config), run, branch);
  const found = await readReceipt(file);
  if (found) await removeRoot(found.root, file);
  else await fs.rm(file, { force: true });
}

/**
 * The step's end in its clone: the agent files the clone's install delivered put back where the step left them as
 * delivered, then everything it left committed, from `start`, so its changes run from there and hold only its edits.
 * Git gets the environment without `withhold`, and is stopped at `expiresAt`.
 */
export async function commitClone(input: { dir: string; branch: string; step: string; base: string; start: string; withhold: readonly string[]; expiresAt?: string }): Promise<{ changes: { branch: string; base: string; from: string; to: string; commits: string[] } } | WorkflowFailure> {
  const { dir, branch, step, base, start } = input;
  const git = await cloneGit(input.withhold, input.expiresAt);
  if ('code' in git) return git;
  const saved = path.join(path.dirname(dir), 'saved');
  // Only putting the agent files back removes `saved`, so a finish run again finds them back already.
  const unrestored = await isDirectory(saved) ? await restoreUneditedConfig(dir, start, saved, git) : undefined;
  if (unrestored !== undefined) {
    return { code: 'workspace_base', message: `Step "${step}" ran, but the team assets delivered into its clone could not be told apart from its edits, so nothing was committed: ${unrestored}` };
  }
  const committed = await commitWork(dir, `teamai: ${step}`, start, git);
  if ('error' in committed) return { code: 'workspace_base', message: `Step "${step}" ran, but its work could not be committed in its clone: ${committed.error}` };
  return { changes: { branch, base, ...committed } };
}

/**
 * The head of the clone of `branch` as it is now, read by git without the names its place withholds, as its commit is:
 * setup or a step may have configured what git starts there. Null when this machine prepared none, or git cannot read it
 * before `expiresAt`.
 */
export async function cloneHead(config: LocalConfig, run: RunId, branch: string, expiresAt: string | undefined): Promise<HeadState | null> {
  const found = await readReceipt(receiptPath(runsDir(config), run, branch));
  if (found?.state.kind !== 'ready') return null;
  const git = await cloneGit(found.withhold, expiresAt);
  if (typeof git !== 'function') return null;
  const status = await git(path.join(found.root, 'r'), [...HEAD_STATUS]);
  return status.code === 0 ? headStateOf(status.stdout) : null;
}

/** `untrustedGit` without `withhold`: a step ran in the clone, so its config may start anything. */
async function cloneGit(withhold: readonly string[], expiresAt: string | undefined): Promise<Git | WorkflowFailure> {
  const scoped = await cloneEnv(withhold);
  return scoped.ok ? untrustedGit(scoped.env, expiresAt) : scoped.failure;
}

/** The environment git gets in a clone: this process's, without `withhold`. */
export function cloneEnv(withhold: readonly string[]): ReturnType<typeof stepEnvironment> {
  return stepEnvironment({ values: new Map(), facts: { declared: new Set(), secrets: new Set(), present: new Set() } }, { provide: [], withhold });
}

/**
 * Removes the root and the receipt of every clone that no longer needs them: its run is not running, or no step that
 * runs in it is still to settle. Every step there that settled had its evidence staged then. The evidence a report
 * staged for a pass there that did not succeed goes too, as no judge reads it. `runId` limits it to one run. A receipt this teamai cannot read is kept.
 */
export async function sweepClones(config: LocalConfig, runId?: string): Promise<void> {
  const root = runsDir(config);
  const runs = runId !== undefined
    ? [runId]
    : (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const id of runs) {
    const dir = path.join(root, id, 'clones');
    for (const name of (await fs.readdir(dir).catch((): string[] => [])).filter((entry) => entry.endsWith('.json'))) {
      const file = path.join(dir, name);
      const receipt = await readReceipt(file);
      if (!receipt) {
        log.debug(`Kept clone receipt ${file}: this teamai cannot read it.`);
        continue;
      }
      const run = await readRun(config, id);
      const inClone = (step: string): boolean => typeof run === 'object' && cloneBranchOf(run, step) === receipt.branch;
      if (typeof run === 'object' && run.status === 'running' && run.steps.some((step) => !settled(step) && inClone(step.id))) continue;
      await removeRoot(receipt.root, file);
      if (typeof run === 'object') await removeUnjudgedEvidence(config, run, inClone);
    }
  }
}

/**
 * Stages, from its clone, the evidence the judges of each workflow step in `succeeded` read, when it runs in a clone:
 * `succeeded` holds the steps the operation about to save `run` settled `success`. Such a step settles once its last
 * step does, under the run lock, so its evidence exists before that save makes its judge entry or a dependent visible.
 * A prompt's evidence is staged by its report. Evidence already staged is kept, so a later step in the clone never
 * overwrites it. Reading the clone stops at the run's deadline, so a large checkout never holds the run lock past it.
 */
export async function stageSettledEvidence(config: LocalConfig, run: RunState, succeeded: readonly string[]): Promise<void> {
  const definitionOf = stepDefinitions(run);
  for (const step of succeeded) {
    const branch = definitionOf(step)?.workflow !== undefined ? cloneBranchOf(run, step) : undefined;
    const receipt = branch !== undefined ? await readReceipt(receiptPath(runsDir(config), run.id, branch)) : undefined;
    if (!receipt) continue;
    const scoped = await cloneEnv(receipt.withhold);
    if (!scoped.ok) continue;
    const state = run.steps.find((item) => item.id === step);
    await stageEvidence(config, run, { runId: run.id, step, pass: state?.pass ?? 1 }, { checkout: path.join(receipt.root, 'r'), untrustedEnv: scoped.env, expiresAt: runDeadline(run) });
  }
}

/**
 * Removes the evidence staged for each pass in the clone that did not succeed. A report removes it itself unless it was
 * stopped between staging the evidence and the engine's answer; then the step never settles from that report.
 */
async function removeUnjudgedEvidence(config: LocalConfig, run: RunState, inClone: (step: string) => boolean): Promise<void> {
  const passes = runPasses(run).filter((pass) => inClone(pass.step));
  const succeeded = new Set(passes.filter((pass) => pass.outcome === 'success').map((pass) => `${pass.step}#${pass.pass}`));
  const staged = [
    ...passes.map((pass) => ({ step: pass.step, pass: pass.pass })),
    ...run.steps.filter((state) => inClone(state.id)).map((state) => ({ step: state.id, pass: state.pass ?? 1 })),
  ];
  await removeSubjectEvidence(scoresDir(config), staged.filter((subject) => !succeeded.has(`${subject.step}#${subject.pass}`)).map((subject) => ({ runId: run.id, ...subject })));
}

/**
 * A fresh clone with its own `.git`, no remotes and no refs, at a detached HEAD, its hooks pointed at a directory that
 * does not exist. The commit comes from the first of `sources` that has it. Every git call is an argv array: no shell
 * string, and stops at `expiresAt`, as a fetch or checkout may never return.
 */
export async function freshClone(root: string, commit: string, sources: readonly string[], expiresAt: string | undefined, env: NodeJS.ProcessEnv): Promise<WorkflowFailure | undefined> {
  const git = boundedGit(expiresAt, env);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root);
  const clone = path.join(root, 'r');
  const made = await git(root, ['init', '-q', '--template=', clone]);
  const configured = made.code === 0 ? await git(clone, ['config', 'core.hooksPath', path.join(root, 'no-hooks')]) : made;
  if (configured.code !== 0) {
    return { code: 'clone_prepare_failed', message: `The clone could not be made in ${root}: ${configured.stderr.trim()}` };
  }
  const said: string[] = [];
  for (const source of sources) {
    if (!await isDirectory(source)) continue;
    const fetched = await git(clone, ['fetch', '-q', '--no-tags', source, commit]);
    if (fetched.code === 0) {
      const checkedOut = await git(clone, ['checkout', '-q', '--detach', commit]);
      return checkedOut.code === 0
        ? undefined
        : { code: 'clone_prepare_failed', message: `The clone could not check out ${commit}: ${checkedOut.stderr.trim()}` };
    }
    said.push(`${source}: ${fetched.stderr.trim()}`);
  }
  return { code: 'clone_prepare_failed', message: `Commit ${commit} could not be fetched into the clone (${said.join('; ') || 'no checkout to fetch it from'}). Fetch it into the checkout the run started in, or fix the commit, and start the run again.` };
}

/** A new root for a clone no run records, such as one check tried before a task joins its suite. */
export function scratchCloneRoot(): string {
  return path.join(os.tmpdir(), CLONES, createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8));
}

/** The directory of a clone's root holding the agent files its install delivered. */
const DELIVERED = 'delivered';

/** The env variables that move a tool's home away from HOME, which the clone's own pull must not follow. */
const TOOL_HOME_VARIABLES = [...new Set(Object.keys(TOOLS).filter(isToolId).flatMap(homeVariables))];

/** How long the clone's own `teamai pull` may take: it fetches only from the clone's root. */
const PULL_TIMEOUT_MS = 10 * 60_000;

/**
 * The clone's own teamai install at `team.revision`, offline, with nothing written outside `root`: a bare repo holding
 * only that revision, fetched from the member's team clone, and for a treatment without some paths, the commit
 * `commitWithout` makes of it there, on its branch; the clone's team clone of it; its partition config, written
 * from the place's selection with every per-machine knob off; then `teamai pull --team-ref` as a child whose HOME is
 * `<root>/h`, so the hooks, shell profiles and env registry a workspace pull writes under HOME land there. The git hooks
 * that pull writes into the clone go again, so neither teamai nor a step's git runs teamai there, and the delivered files
 * are recorded as the overlay, so they are never a step's edits.
 */
async function installTeam(input: {
  config: LocalConfig; root: string; lease: CloneLease; team: InstalledTeam; env: NodeJS.ProcessEnv;
}): Promise<{ config: LocalConfig; dataHome: string; without?: Without } | WorkflowFailure> {
  const { config: member, root, lease, team } = input;
  const failed = (message: string): WorkflowFailure => ({ code: 'clone_prepare_failed', message });
  const { revision, selection } = team;
  const tools = selection.enabledAgents ?? (lease.tool !== undefined ? [lease.tool] : member.enabledAgents ?? []);
  const clone = path.join(root, 'r');
  const saved = path.join(root, 'saved');
  await fs.mkdir(saved);
  await saveConfig(clone, saved);
  const anchors = await resolveAnchors(clone);
  if (!anchors) return failed(`The clone ${clone} is not a git repository teamai can install into.`);
  const home = path.join(root, 'h');
  const partition = path.join(home, '.teamai', 'projects', projectSlug(anchors.projectAnchor));
  const source = member.repo.localPath;
  const bare = path.join(root, 'team.git');
  const teamClone = path.join(partition, 'team-repo');
  const branch = await getDefaultBranch(source);
  // The lease's deadline bounds the copy too, as it bounds the pull below.
  const copy = boundedGit(lease.expiresAt, input.env);
  const copied = async (steps: Array<{ cwd: string; args: string[] }>): Promise<WorkflowFailure | undefined> => {
    for (const { cwd, args } of steps) {
      const ran = await copy(cwd, args);
      if (ran.code !== 0) return failed(`Team revision ${revision} could not be copied from ${source} for the clone (git ${args[0]}): ${ran.stderr.trim()}`);
    }
    return undefined;
  };
  const fetched = await copied([
    { cwd: root, args: ['init', '-q', '--bare', bare] },
    { cwd: bare, args: ['fetch', '-q', '--no-tags', source, `${revision}:refs/heads/${branch}`] },
  ]);
  if (fetched) return fetched;
  let without: Without | undefined;
  if (typeof team.treatment === 'object') {
    const paths = team.treatment.without;
    const made = await commitWithout(copy, { repo: bare, revision, paths });
    if ('failed' in made) return failed(`Team revision ${revision} without ${paths.join(', ')} could not be made for the clone (${made.failed}).`);
    without = { commit: made.commit, revision };
  }
  const cloned = await copied([
    ...(without ? [{ cwd: bare, args: ['update-ref', `refs/heads/${branch}`, without.commit] }] : []),
    { cwd: bare, args: ['symbolic-ref', 'HEAD', `refs/heads/${branch}`] },
    { cwd: root, args: ['clone', '-q', '--no-local', bare, teamClone] },
  ]);
  if (cloned) return cloned;
  const pulling = without?.commit ?? revision;
  const config: LocalConfig = {
    repo: { localPath: teamClone, remote: member.repo.remote, kind: 'git' },
    username: member.username, provider: 'git', scope: 'project', projectRoot: anchors.workspaceRoot, dataHome: partition,
    ...(selection.primaryRole ? { primaryRole: selection.primaryRole } : {}),
    additionalRoles: selection.additionalRoles, projects: selection.projects, excludedSkills: selection.excludedSkills,
    ...(selection.subscribedTags ? { subscribedTags: selection.subscribedTags } : {}),
    enabledAgents: tools,
    recallEnabled: false, contributeHintEnabled: false, mrHintEnabled: false, usageReportEnabled: false, coAuthorEnabled: false, codexTrustEnabled: false,
  };
  await saveLocalConfigForScope(config);
  await createProjectToolRoots({ config, tools });
  const entry = resolveCliEntry();
  if (!entry) return failed('The teamai CLI that runs this workflow could not be found, so the clone\'s own teamai pull could not run.');
  const env: NodeJS.ProcessEnv = { ...input.env, HOME: home, USERPROFILE: home };
  for (const name of TOOL_HOME_VARIABLES) delete env[name];
  // The lease's deadline bounds the pull too, so a slow one does not hold the run past its timeout.
  const timeoutMs = lease.expiresAt === undefined ? PULL_TIMEOUT_MS : Math.max(0, Math.min(PULL_TIMEOUT_MS, Date.parse(lease.expiresAt) - Date.now()));
  const pulled = await execCommand(process.execPath, [entry, 'pull', '--team-ref', pulling], { cwd: clone, env, timeoutMs })
    .catch((thrown: unknown) => ({ code: 1, stdout: '', stderr: thrown instanceof Error ? thrown.message : String(thrown) }));
  if (pulled.code !== 0) {
    const tail = (pulled.stderr.trim() || pulled.stdout.trim()).slice(-500);
    return failed(`teamai pull --team-ref ${pulling.slice(0, 7)} exited ${pulled.code}: ${tail}`);
  }
  try {
    await removeGitHook(clone);
  } catch (thrown) {
    return failed(`The git hooks the clone's own teamai pull installed in ${clone} could not be removed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
  await recordConfigOverlay(clone, saved);
  // What a later step in the clone gets again, as its first step's commit takes the delivery out.
  await fs.mkdir(path.join(root, DELIVERED));
  await saveConfig(clone, path.join(root, DELIVERED));
  return { config, dataHome: partition, ...(without ? { without } : {}) };
}

/** The root, then the receipt that names it. rm retries a busy file, as Windows reports one still being closed. */
async function removeRoot(root: string, file: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  await fs.rm(file, { force: true });
}

async function isDirectory(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch(() => undefined))?.isDirectory() === true;
}
