import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { RUNTIME_PROTOCOL } from '@teamai/runtime-protocol';
import { resolvePathCommand } from '@teamai/shared/cli-path';
import { copyRegularTree, readRegularFile, readRegularFileNoLink } from '@teamai/shared/regular-file';
import { identityOf, signalPid } from '@teamai/shared/process-group';
import { parseYaml } from '@teamai/shared/yaml';
import { teamaiBin } from '../../default-drivers.js';
import type { RunMode } from '../../launch-context.js';
import { isSymlink, RESOURCE_LAYOUTS } from '../../resources/resolver.js';
import { acceptTeamCommand } from '../../tool-instances.js';
import { getDataHome, getTrustDir, type LocalConfig } from '../../types.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import type { WorkflowFailure } from '../types.js';
import type { ResolvedDriver } from './definitions.js';
import { findInLayers, namesOf, type Layer, type LayerFind, type LayerItem } from './layers.js';
import { firstLink, folderEntries, folderRevision } from './resource-folder.js';

// ─── Where a step runtime comes from ─────────────────────
//
//  `tools` is built in: it launches the member's tools in teamai's own process, and `local` names it too. Any other
//  runtime is a resource, `runtimes/<name>.yaml` or the folder `runtimes/<name>/` with its `RUNTIME.yaml` and its code.
//  `use: <name>` takes the first of: the member's own ~/.teamai/runtimes/, the team repo's runtimes/ (and
//  runtimes/<namespace>/ for each active namespace), then teamai's own runtimes/ in its package; first by the exact name
//  in every layer, then as teamai-<name>. A team runtime is code a teammate pushed, so before its first spawn a person
//  accepts it: a folder at its revision, a file's command at the file's content. An attended run asks, and an
//  unattended one refuses.
//

/** The marker of a runtime folder, which the folder form holds beside its code. */
export const RUNTIME_MARKER = RESOURCE_LAYOUTS.runtimes.marker;

/** What a runtime's marker sets, in its file form (`runtimes/<x>.yaml`) and its folder form (`runtimes/<x>/RUNTIME.yaml`). */
const RuntimeMarkerSchema = z.object({
  protocol: z.number().int(),
  entry: z.union([
    z.string().min(1).transform((file) => ({ kind: 'path' as const, file })),
    z.object({ command: z.string().min(1) }).strict().transform(({ command }) => ({ kind: 'command' as const, command })),
    z.object({ bin: z.string().min(1) }).strict().transform(({ bin }) => ({ kind: 'bin' as const, bin })),
  ]),
  exec: z.boolean().optional(),
}).strict();

/** The layer a runtime was found in, which decides what a person accepts before it runs. */
export type RuntimeLayer = Layer;

/** How teamai starts a runtime: the Node that runs teamai runs a built file of teamai's own package, or the runtime's executable runs. */
export type RuntimeLaunch = { readonly kind: 'node'; readonly file: string } | { readonly kind: 'executable'; readonly executable: string };

/**
 * What a person accepts before a team runtime first runs here: its folder at its revision, or its file's command at the
 * file's content. A member's own runtime and teamai's need nothing. `copy`: the copy of the folder it runs from, once
 * pinned (`pinRuntime`), which the person reviews; `dir` stays what an acceptance is kept for.
 */
export type RuntimeTrust = { readonly kind: 'none' } | { readonly kind: 'folder'; readonly dir: string; readonly copy?: string } | { readonly kind: 'command'; readonly command: string };

/** A runtime that is an external program, as its marker declares it. */
export interface ExternalRuntime {
  readonly kind: 'external';
  /** The name its entry gives it with `use`, which messages and records name it by. */
  readonly name: string;
  /** The name of the resource found for it: `name` itself, or `teamai-<name>`. */
  readonly resource: string;
  readonly layer: RuntimeLayer;
  /** The marker file: the file form itself, or the folder's `RUNTIME.yaml`. */
  readonly marker: string;
  /** Where a message names it: its path in the team repo (`runtimes/t3/`), the member's file, or teamai's. */
  readonly location: string;
  readonly launch: RuntimeLaunch;
  /** `exec: false` when its marker says it runs no command, which a run that needs no AI tool reads without starting it. */
  readonly exec?: boolean;
  /** The sha256 of the file form's content, or the folder's revision (`folderRevision`). */
  readonly revision: string;
  readonly trust: RuntimeTrust;
  /** The runtime of teamai's own this one of the member or the team stands in for, by the name `use` would find it. */
  readonly replaces?: string;
}

/** Where a runtime was found: the built-in `tools`, or an external one. */
export type RuntimeSource = { readonly kind: 'builtin'; readonly name: 'tools' } | ExternalRuntime;

/** The runtime a definition declares, or why its marker or entry cannot run, which fails the run. */
type DefinitionRead = { readonly kind: 'found'; readonly source: ExternalRuntime } | { readonly kind: 'unusable'; readonly failure: WorkflowFailure };

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** What a member does to fix a definition in `layer`. */
export function fixOf(layer: RuntimeLayer): string {
  switch (layer) {
    case 'personal':
      return 'Fix the file and start again.';
    case 'team':
      return 'Fix it, push it, run teamai pull, and start again.';
    case 'teamai':
      return 'Reinstall teamai.';
    default: {
      const unhandled: never = layer;

      return unhandled;
    }
  }
}

/**
 * The runtime `definition` declares, or why it cannot run: its marker must parse, speak `RUNTIME_PROTOCOL`, and name an
 * entry its form allows that is there: a path inside the folder, an executable on PATH for a file of the member's or
 * the team's, a program of teamai's own package for teamai's.
 */
async function readDefinition(driver: ResolvedDriver, use: string, definition: LayerItem): Promise<DefinitionRead> {
  const markerFile = definition.form === 'folder' ? path.join(definition.at, RUNTIME_MARKER) : definition.at;
  // What the marker itself says wrong names the marker; what the folder holds names the folder.
  const markerLocation = definition.form === 'folder' && /[\\/]$/.test(definition.location) ? `${definition.location}${RUNTIME_MARKER}` : definition.location;

  const refuse = (at: string, reason: string): DefinitionRead => ({
    kind: 'unusable',
    failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "${use}", and ${at} cannot run it: ${reason}. ${fixOf(definition.layer)}` },
  });

  const unusable = (reason: string): DefinitionRead => refuse(definition.location, reason);
  const badMarker = (reason: string): DefinitionRead => refuse(markerLocation, reason);

  let text = definition.layer === 'teamai' ? definition.text : undefined;

  if (text === undefined && definition.form === 'file' && await isSymlink(markerFile)) return unusable(`it is a link, and teamai reads a runtime only from a file ${definition.layer === 'team' ? 'the team repo' : 'your directory'} holds`);

  if (text === undefined) {
    try {
      text = await readRegularFileNoLink(markerFile, 'utf8');
    } catch (error) {
      return badMarker(`it cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  let raw: unknown;

  try {
    raw = parseYaml(text);
  } catch (error) {
    return badMarker(`it is not YAML (${error instanceof Error ? error.message : String(error)})`);
  }

  const parsed = RuntimeMarkerSchema.safeParse(raw);

  if (!parsed.success) {
    const [issue] = parsed.error.issues;

    return badMarker(`${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'not valid'}; a runtime sets protocol, entry and optionally exec`);
  }

  const marker = parsed.data;

  if (marker.protocol !== RUNTIME_PROTOCOL) return badMarker(`it declares protocol ${marker.protocol}, and this teamai speaks protocol ${RUNTIME_PROTOCOL}`);
  const launched = await launchOf(definition, marker.entry);

  if (!launched.ok) return unusable(launched.reason);
  let revision: string;

  try {
    revision = definition.form === 'folder' ? await folderRevision(definition.at) : sha256(text);
  } catch (error) {
    return unusable(`its folder cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }

  return {
    kind: 'found',
    source: {
      kind: 'external', name: use, resource: definition.resource, layer: definition.layer, marker: markerFile, location: definition.location,
      launch: launched.launch, ...(marker.exec !== undefined && { exec: marker.exec }), revision, trust: launched.trust,
    },
  };
}

/** What a marker's `entry` names: a file inside its folder, an executable on PATH, or a program of teamai's own package. */
type RuntimeEntry = z.infer<typeof RuntimeMarkerSchema>['entry'];

/** How `definition`'s `entry` starts it, and what a person accepts first, or why it cannot: each form and layer takes one kind of entry. */
async function launchOf(definition: LayerItem, entry: RuntimeEntry): Promise<{ ok: true; launch: RuntimeLaunch; trust: RuntimeTrust } | { ok: false; reason: string }> {
  const isTeam = definition.layer === 'team';

  switch (entry.kind) {
    case 'path': {
      if (definition.form !== 'folder') return { ok: false, reason: `entry: ${entry.file} is a path, and a runtime file names an executable on PATH as entry: { command: <name> }; a runtime with its own code is a folder runtimes/<name>/${RUNTIME_MARKER}` };
      const relative = path.posix.normalize(entry.file.split(path.sep).join('/'));

      if (path.posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) return { ok: false, reason: `entry: ${entry.file} leaves the folder, and its entry is a file inside it, such as ./runtime` };
      const executable = path.join(definition.at, ...relative.split('/'));
      const stat = await fs.lstat(executable).catch(() => undefined);

      if (stat?.isFile() !== true) return { ok: false, reason: `entry: ${entry.file} names a file the folder does not hold` };

      return { ok: true, launch: { kind: 'executable', executable }, trust: isTeam ? { kind: 'folder', dir: definition.at } : { kind: 'none' } };
    }

    case 'bin': {
      if (definition.layer !== 'teamai') return { ok: false, reason: `entry: { bin: ${entry.bin} } names a program of teamai's own package, which only teamai's runtimes use; name an executable on PATH with entry: { command: <name> }, or keep the code in a folder runtimes/<name>/${RUNTIME_MARKER}` };
      const file = teamaiBin(entry.bin);

      return file === undefined ? { ok: false, reason: `entry: { bin: ${entry.bin} } names no program teamai's package holds` } : { ok: true, launch: { kind: 'node', file }, trust: { kind: 'none' } };
    }

    case 'command': {
      if (definition.form === 'folder') return { ok: false, reason: `entry: { command: ${entry.command} } is a command, and a runtime folder's entry is a file inside it, such as ./runtime` };

      if (definition.layer === 'teamai') return { ok: false, reason: `entry: { command: ${entry.command} } is a command on PATH, and teamai's runtimes run a program of its own package` };
      const executable = resolvePathCommand(entry.command);

      if (executable === null) return { ok: false, reason: `entry: { command: ${entry.command} } names no executable on PATH, as a bare name such as acme-runtime` };

      return { ok: true, launch: { kind: 'executable', executable }, trust: isTeam ? { kind: 'command', command: entry.command } : { kind: 'none' } };
    }

    default: {
      const unhandled: never = entry;

      return unhandled;
    }
  }
}

/** The failure of a lookup the first layer holding `use`'s runtime refused. */
function refusalOf(driver: ResolvedDriver, use: string, found: Extract<LayerFind, { kind: 'refused' }>): WorkflowFailure {
  const { refusal, layer, location, resource } = found;
  const opening = `Driver "${driver.name}" uses runtime "${use}"`;
  const unusable = (reason: string): WorkflowFailure => ({ code: 'runtime_not_found', message: `${opening}, and ${location} cannot run it: ${reason}. ${fixOf(layer)}` });

  switch (refusal.kind) {
    case 'duplicate':
      return {
        code: 'runtime_namespace_conflict',
        message: layer === 'personal'
          ? `Runtime "${resource}" is defined twice in your own runtimes (${refusal.first} and ${refusal.second}). Keep one, and start again.`
          : `Runtime "${resource}" is defined twice in one place (${refusal.first} and ${refusal.second}). Keep one, push it, run teamai pull, and start again.`,
      };
    case 'two-namespaces':
      return { code: 'runtime_namespace_conflict', message: `Runtime "${resource}" is defined in two active namespaces (${refusal.first} and ${refusal.second}). Keep one, push it, run teamai pull, and start again.` };
    case 'linked-dir':
      return { code: 'runtime_not_found', message: `${opening}, and ${refusal.dir} in the team repo is a link, and teamai runs a team runtime only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.` };
    case 'linked-folder':
      return { code: 'runtime_not_found', message: `${opening}, whose folder ${refusal.folder} in the team repo is a link, and teamai runs a team runtime only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.` };
    case 'holds-link':
      return { code: 'runtime_not_found', message: `${opening}, whose folder ${location.slice(0, -1)} in the team repo holds the link ${refusal.link}, and teamai runs a team runtime only when its folder holds no link, so the revision you accept is all it runs. Replace the link with what it names, push it, run teamai pull, and start again.` };
    case 'unreadable':
      return unusable(refusal.reason);
    case 'no-marker':
      return unusable(`it holds no ${refusal.marker}, the marker that names its protocol and its code, such as protocol: 1 and entry: ./runtime`);
    default: {
      const unhandled: never = refusal;

      return unhandled;
    }
  }
}

/** The runtime `use` names for `driver`, or why there is none. */
export async function locateRuntime(driver: ResolvedDriver, use: string): Promise<{ ok: true; source: RuntimeSource } | { ok: false; failure: WorkflowFailure }> {
  // `local` is the name `tools` had while it ran on the host beside the commands.
  if (use === 'tools' || use === 'local') return { ok: true, source: { kind: 'builtin', name: 'tools' } };

  if (use === 'skill') {
    return { ok: false, failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "${use}", which this version of teamai does not run from a definition. Use tools, or a runtime of your own or of the team.` } };
  }

  if (use === 'host') {
    return { ok: false, failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "host", the name teamai gives the command slot it adds to every definition. Name the runtime otherwise, or use tools.` } };
  }

  const found = await findInLayers('runtimes', namesOf(use), { personal: true, teams: [driver.config] });

  switch (found.kind) {
    case 'found': {
      // A definition that cannot run fails the run: another layer's never stands in for the one the member was given.
      const read = await readDefinition(driver, use, found.item);

      if (read.kind !== 'found') return { ok: false, failure: read.failure };

      return { ok: true, source: found.replaces === undefined ? read.source : { ...read.source, replaces: found.replaces } };
    }

    case 'refused':
      return { ok: false, failure: refusalOf(driver, use, found) };
    case 'missing':
      return {
        ok: false,
        failure: {
          code: 'runtime_not_found',
          message: `Driver "${driver.name}" uses runtime "${use}", and none is declared: add runtimes/${use}.yaml (or runtimes/${use}/${RUNTIME_MARKER} with its code) to the team repo and run teamai pull, or add ~/.teamai/runtimes/${use}.yaml for yourself.`,
        },
      };
    default: {
      const unhandled: never = found;

      return unhandled;
    }
  }
}

const TrustFileSchema = z.object({ accepted: z.array(z.object({ dir: z.string(), revision: z.string(), acceptedAt: z.string() })) });

function trustFile(): string {
  return path.join(getTrustDir(), 'runtimes.json');
}

async function readTrust(): Promise<z.infer<typeof TrustFileSchema>> {
  try {
    return TrustFileSchema.parse(JSON.parse(await readRegularFile(trustFile(), 'utf8')));
  } catch {
    return { accepted: [] };
  }
}

/**
 * Asks the person at this terminal: true for yes, false for anything else, undefined when they closed the question
 * unanswered with Ctrl-C or Ctrl-D, which stops the command as it stops a step's question.
 */
export async function askAtTerminal(question: string): Promise<boolean | undefined> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return /^y(es)?$/i.test((await terminal.question(question)).trim());
  } catch {
    return undefined;
  } finally {
    terminal.close();
  }
}

/** Whether a runtime may run here, or why not. */
type Acceptance = { ok: true } | { ok: false; failure: WorkflowFailure };

function unanswered(source: ExternalRuntime): Acceptance {
  return { ok: false, failure: { code: 'interrupted', message: `The question to accept step runtime "${source.name}" closed without an answer, so it did not run and nothing was accepted. Run the same command again to answer it.` } };
}

/** The runtime a source runs as, and what removes the copy it runs from once nothing runs it. */
export type PinnedRuntime = { ok: true; source: ExternalRuntime; remove: () => Promise<void> };

/**
 * Where each teamai process keeps the copies of team runtime folders it runs: `<pid>-<host>-<random>`, one per open,
 * `<host>` telling the host and pid namespace whose `<pid>` it is.
 */
function runtimeCopies(config: LocalConfig): string {
  return path.join(getDataHome(config), 'workflows', 'runtime-copies');
}

/** This process's host and pid namespace as a copy's name holds them: a container sharing the home has its own. */
async function copierHost(): Promise<string> {
  const { pidNamespace } = await identityOf(process.pid);

  return createHash('sha256').update(`${os.hostname()}\0${pidNamespace ?? ''}`).digest('hex').slice(0, 12);
}

/**
 * Removes the copies in `dir` whose teamai process is gone, as a killed one leaves them. A pid of another host or pid
 * namespace names no process here, so its copies stay, for as long as that teamai may run from them. A copy named before
 * copies named their host, `<pid>-<random>`, is taken as this host's, as every one was then.
 */
async function removeOrphanCopies(dir: string, host: string): Promise<void> {
  for (const entry of await fs.readdir(dir).catch(() => [])) {
    const parts = entry.split('-');
    const pid = Number(parts[0]);
    const isHere = parts.length === 2 || parts[1] === host;

    if (isHere && Number.isSafeInteger(pid) && signalPid(pid, 0) === 'gone') await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * `source` as it runs: a team runtime folder copied where no pull reaches it, with the revision of that copy, so the
 * revision a person accepts is all that runs, for as long as it runs. The copy sits in the data home, where programs
 * run as from the team repo, not in the temp folder, which may forbid it; a copy whose teamai was killed goes at the
 * next one. Any other runtime runs where it was found, with nothing to remove.
 */
export async function pinRuntime(source: ExternalRuntime, { config }: { config: LocalConfig }): Promise<PinnedRuntime | { ok: false; failure: WorkflowFailure }> {
  const { trust, launch } = source;

  if (trust.kind !== 'folder' || launch.kind !== 'executable') return { ok: true, source, remove: async () => undefined };

  const pinned = await pinFolder(trust.dir, { config });

  if (!pinned.ok) {
    return { ok: false, failure: { code: 'runtime_not_found', message: `Step runtime "${source.name}" from the team repo (${source.location}) did not run: ${runtimePinReason(pinned.problem)}. ${fixOf(source.layer)}` } };
  }

  const { copy, remove } = pinned;

  return { ok: true, source: { ...source, revision: await folderRevision(copy), trust: { ...trust, copy }, launch: { kind: 'executable', executable: path.join(copy, path.relative(trust.dir, launch.executable)) } }, remove };
}

/** Why a team runtime's folder has no copy to run from, as its failure says it. */
function runtimePinReason(problem: PinProblem): string {
  switch (problem.kind) {
    case 'uncopied':
      return `its folder could not be copied to run from (${problem.why})`;
    case 'link':
      return `its folder now holds the link ${problem.link}, and teamai runs a team runtime only when its folder holds no link`;
    case 'unreadable':
      return problem.why;
    default: {
      const unhandled: never = problem;

      return unhandled;
    }
  }
}

/** Why a team folder has no copy to use: it could not be copied, it now holds a link, or its copy cannot be read. */
export type PinProblem = { kind: 'uncopied'; why: string } | { kind: 'link'; link: string } | { kind: 'unreadable'; why: string };

/**
 * A copy of folder `dir` of the team repo to run or build from, which no pull changes while it is used, with what
 * removes it. It sits in the data home, and a copy whose teamai was killed goes at the next one.
 */
export async function pinFolder(dir: string, { config }: { config: LocalConfig }): Promise<{ ok: true; copy: string; remove: () => Promise<void> } | { ok: false; problem: PinProblem }> {
  const copies = runtimeCopies(config);
  const host = await copierHost();
  await removeOrphanCopies(copies, host);
  await fs.mkdir(copies, { recursive: true });
  const copy = await fs.mkdtemp(path.join(copies, `${process.pid}-${host}-`));
  const remove = async (): Promise<void> => fs.rm(copy, { recursive: true, force: true });

  const refused = async (problem: PinProblem): Promise<{ ok: false; problem: PinProblem }> => {
    await remove();

    return { ok: false, problem };
  };

  try {
    await copyRegularTree(dir, copy);
  } catch (error) {
    return refused({ kind: 'uncopied', why: error instanceof Error ? error.message : String(error) });
  }

  // A link a pull added since the folder was found: the revision taken would not be all of it.
  const link = await firstLink(copy);

  if (!link.ok) return refused({ kind: 'unreadable', why: link.reason });

  if (link.link !== undefined) return refused({ kind: 'link', link: link.link });

  return { ok: true, copy, remove };
}

/** Whether `source` was accepted here, asking no one: for a decision that must not wait on a person. */
export async function isRuntimeAccepted(source: ExternalRuntime): Promise<boolean> {
  return (await acceptRuntime(source, { mode: 'unattended', canAsk: false })).ok;
}

/**
 * Whether `source` may be spawned on this machine. Only a team runtime needs it: its folder's revision, or its file's
 * command at the file's content, must be one a person accepted here. `mode` attended with a person at the terminal
 * (`canAsk`) asks and records a yes; otherwise an unaccepted one is refused, naming what to run.
 */
export async function acceptRuntime(source: RuntimeSource, { mode, canAsk, ask = askAtTerminal }: { mode: RunMode; canAsk: boolean; ask?: (question: string) => Promise<boolean | undefined> }): Promise<Acceptance> {
  if (source.kind === 'builtin') return { ok: true };
  const { trust } = source;
  const isAsking = mode === 'attended' && canAsk;

  switch (trust.kind) {
    case 'none':
      return { ok: true };
    case 'command': {
      // The command's question takes the line typed; this one's `ask` answers yes or no, or nothing once closed.
      const askLine = async (question: string): Promise<string | undefined> => {
        const answer = await ask(question);

        return answer === undefined ? undefined : answer ? 'y' : 'n';
      };

      const accepted = await acceptTeamCommand(
        { kind: 'runtime', name: source.resource, command: trust.command, file: source.location, revision: source.revision },
        { ask: isAsking ? askLine : undefined },
      );

      if (accepted.ok) return accepted;

      return accepted.reason === 'unanswered' ? unanswered(source) : { ok: false, failure: { code: 'runtime_not_accepted', message: accepted.message } };
    }

    case 'folder':
      return acceptFolder(source, { dir: trust.dir, review: trust.copy ?? trust.dir }, { isAsking, ask });
    default: {
      const unhandled: never = trust;

      return unhandled;
    }
  }
}

/** Whether the runtime folder `dir` of `source` was accepted here at `source`'s revision, asking when `isAsking` to review `review`. */
async function acceptFolder(source: ExternalRuntime, { dir, review }: { dir: string; review: string }, { isAsking, ask }: { isAsking: boolean; ask: (question: string) => Promise<boolean | undefined> }): Promise<Acceptance> {
  const { revision } = source;
  const trust = await readTrust();

  if (trust.accepted.some((entry) => entry.dir === dir && entry.revision === revision)) return { ok: true };
  const short = revision.slice(0, 12);
  const relative = source.location.replace(/\/$/, '');

  if (isAsking) {
    const question = `Step runtime "${source.name}" comes from the team repo (${relative}) at revision ${short}, which you have not accepted on this machine. `
      + `It runs as you, with your files. Review ${review} (${(await folderEntries(review)).join(', ')}) before you accept it.\nRun it? [y/N] `;

    const accepted = await ask(question);

    if (accepted === undefined) return unanswered(source);

    if (accepted) {
      await writeJsonAtomic(trustFile(), { accepted: [...trust.accepted, { dir, revision, acceptedAt: new Date().toISOString() }] });

      return { ok: true };
    }

    return { ok: false, failure: { code: 'runtime_not_accepted', message: `Step runtime "${source.name}" at revision ${short} was not accepted, so it did not run. Nothing of the run changed.` } };
  }

  return {
    ok: false,
    failure: {
      code: 'runtime_not_accepted',
      message: `Step runtime "${source.name}" comes from the team repo (${relative}) at revision ${short}, which no one has accepted on this machine, and an unattended run does not ask. `
        + 'Run the same command once in a terminal, attended, to review and accept that revision, then run it unattended again.',
    },
  };
}
