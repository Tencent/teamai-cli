import path from 'node:path';
import { canList } from '@teamai/shared/fs-failure';
import { fitReason, type ConfinedKept, type InitInstance, type RuntimeFailure, type RuntimeMessage } from '@teamai/runtime-protocol';
import { isOnThisMachine } from './daemon/address.js';
import { codexHomes, type InstalledTool, type Target } from './daemon/connect.js';
import { CONFINED_MODES, isPaseoTool, PASEO_TOOLS, type ProviderToAdd } from './providers.js';
import { readsTokens } from './usage.js';

// ─── What this daemon can run ────────────────────────────
//
//  From the tools and instances the daemon has installed, as init found them: what the runtime offers of each, how
//  Paseo runs it, and init's answer, with the notices a person reads once.
//

/** What this runtime keeps of a confined prompt: its agent is briefed to read only the directory, and cannot write without asking. */
export const CONFINED_KEPT: ConfinedKept = { level: 'best-effort', access: 'read' };

/** What init offered of an installed tool: its steps and judges, its steps only, or nothing, with why not. */
export type Offer = { runs: 'steps-and-judges' } | { runs: 'steps'; noJudge: string } | { runs: 'nothing'; reason: string };

/**
 * Why a new step or judge on `tool` is refused, or undefined when init offered it in `offers`. teamai holds a step whose `tool` was
 * not offered, but not one that takes its tool from the definition's default, so the runtime refuses it here too.
 */
export const notOffered = (offers: ReadonlyMap<string, Offer>, tool: string, isJudge: boolean): RuntimeFailure | undefined => {
  const offer = offers.get(tool) ?? { runs: 'nothing', reason: 'the daemon has not installed it' };
  const reason = offer.runs === 'nothing' ? offer.reason : offer.runs === 'steps' && isJudge ? offer.noJudge : undefined;

  return reason === undefined ? undefined : { code: 'tool_unavailable', message: `teamai-runtime-paseo did not offer ${tool}: ${reason}.` };
};

/** What init offers, and what the runtime keeps of it to run steps on: `init` is the answer, `notices` the lines a person reads first. */
export interface Offered {
  init: Extract<RuntimeMessage, { type: 'init' }>;
  notices: string[];
  offers: Map<string, Offer>;
  targets: Map<string, Target>;
  modeIds: Map<string, string>;
  sessionHomes: Map<string, string>;
  homeDirs: Map<string, string>;
  providerHomes: Map<string, string>;
  toAdd: Map<string, { planned: ProviderToAdd; instance: InitInstance }>;
}

/**
 * What init found on the daemon at `url`: `installed`, each tool and instance as the daemon can run it or not, and
 * `foreign`, the names the providers option gives that teamai passed no instance for.
 */
interface Found {
  installed: InstalledTool[];
  instances: readonly InitInstance[];
  foreign: string[];
  url: string;
}

/** The tools of `installed` the daemon can run, and why it cannot run each other one, by name. */
function runnableOf({ installed, instances, foreign, url }: Found) {
  const tools = installed.flatMap((entry) => (entry.kind === 'unavailable' ? [] : [entry]));

  // It starts though it can run no tool, so the run's command steps still go to the next runtime: each tool it cannot
  // run is named with why, which teamai shows on a step on that tool.
  const unavailable = Object.fromEntries([...PASEO_TOOLS, ...installed.map(({ name }) => name).filter((name) => !isPaseoTool(name))].flatMap((name): Array<[string, string]> => {
    const entry = installed.find((candidate) => candidate.name === name);

    if (entry && entry.kind !== 'unavailable') return [];
    const reason = entry ? entry.reason : `it is not installed where the daemon finds its tools; install ${name} on the daemon's PATH and sign in to it there`;

    return [[name, fitReason(`The Paseo daemon at ${url} cannot run ${name}: ${reason}.`)]];
  }).concat(foreign.map((name): [string, string] => {
    const passed = instances.find((instance) => instance.name === name);

    const why = passed
      ? `it extends ${passed.tool}, which Paseo does not run. Remove ${name} from the providers option.`
      : `the runtime's providers option names it, and teamai passed no tool instance ${name} here; a team tool runs here once its command is accepted on this machine. If it is no team tool, remove ${name} from the providers option.`;

    return [name, fitReason(`The Paseo daemon at ${url} cannot run ${name}: ${why}`)];
  })));

  return { tools, unavailable };
}

/** A check's answer: the tools the daemon can run now, or why it can run none. */
export function checkOf(found: Found): Extract<RuntimeMessage, { type: 'init' }> {
  const { tools, unavailable } = runnableOf(found);

  return tools.length > 0
    ? { type: 'init', ok: true, prompt: true, conversations: true, can: { exec: false, env: false, hitl: false, unattended: false, tools: tools.map(({ name }) => name) } }
    : { type: 'init', ok: false, error: { code: 'tool_unavailable', message: `teamai-runtime-paseo can run no tool on the Paseo daemon at ${found.url} now: ${Object.values(unavailable).join(' ')}` } };
}

/** What the runtime offers of what init found, for a run in `mode`. */
export function offerOf(found: Found & { mode: 'attended' | 'unattended' }): Offered {
  const { installed, instances, mode, url } = found;
  const { tools, unavailable } = runnableOf(found);
  const notices: string[] = [];

  // A tool whose Paseo default never asks starts its steps in a tighter mode, which the person is told once.
  for (const entry of tools) {
    const { stepMode } = entry;

    if (stepMode.kind === 'tightened') {
      notices.push(`Paseo starts ${entry.name} in mode ${stepMode.insteadOf} by default, which never asks before it acts; teamai starts its ${entry.name} steps in mode ${stepMode.id}, the nearest one before it in Paseo's list that asks.`);
    }
  }

  // A provider that moves a tool's home away from teamai's own for it: its steps sign in and keep sessions there.
  for (const entry of tools) {
    const { name, provider } = entry;
    const providerHome = entry.kind === 'runs' ? entry.providerHome : undefined;

    if (providerHome && path.resolve(providerHome.dir) !== path.resolve(providerHome.teamaiHome)) {
      notices.push(`Paseo provider ${provider} runs ${name} with ${providerHome.variable}=${providerHome.dir}, not teamai's home for it (${providerHome.teamaiHome}): its steps sign in and keep their sessions in ${providerHome.dir}, where teamai reads them.`);
    }
  }

  const targets = new Map(tools.map(({ name, tool, provider }) => [name, { name, tool, provider }]));
  const homeDirs = new Map(instances.flatMap((instance) => (instance.home ? [[instance.name, instance.home.dir]] : [])));
  const modeIds = new Map(tools.flatMap(({ name, stepMode }) => (stepMode.kind === 'unset' ? [] : [[name, stepMode.id]])));
  const sessionHomes = new Map(tools.flatMap((entry) => (entry.kind === 'runs' && entry.home !== undefined ? [[entry.name, entry.home]] : [])));
  const providerHomes = new Map(tools.flatMap((entry) => (entry.kind === 'runs' && entry.providerHome !== undefined ? [[entry.name, entry.providerHome.dir]] : [])));

  const toAdd = new Map(tools.flatMap((entry) => {
    const instance = instances.find((candidate) => candidate.name === entry.name);

    return entry.kind === 'to-add' && instance ? [[entry.name, { planned: entry.toAdd, instance }]] : [];
  }));

  const offers = new Map(installed.map((entry): [string, Offer] => {
    if (entry.kind === 'unavailable') return [entry.name, { runs: 'nothing', reason: entry.reason }];
    const confinedMode = CONFINED_MODES[entry.tool];

    return [entry.name, entry.modes.includes(confinedMode) ? { runs: 'steps-and-judges' } : { runs: 'steps', noJudge: `has no ${confinedMode} mode, which teamai judges it in` }];
  }));

  const judges = tools.flatMap(({ name }) => (offers.get(name)?.runs === 'steps-and-judges' ? [name] : []));
  // The tools the member opted into a mode that never asks: teamai warns once and records their steps' isolation none.
  const permissions = Object.fromEntries(tools.flatMap(({ name, stepMode }) => (stepMode.kind === 'bypass' ? [[name, 'full-access' as const]] : [])));

  // A step reports the tokens its session's transcript records, which the runtime reads on a daemon on this machine, for
  // Claude in the home its diagnostic or its provider names, and for Codex in the home that holds the session's rollout.
  // With any other tool offered, or a folder of those homes teamai cannot list, as one a daemon running as another user
  // keeps, not every success report would carry its tokens.
  const sessionFolders = (entry: (typeof tools)[number]): string[] | undefined => {
    const providerHome = entry.kind === 'runs' ? entry.providerHome?.dir : undefined;

    switch (entry.tool) {
      case 'claude': {
        const home = entry.kind === 'runs' ? entry.home ?? providerHome : undefined;

        return home === undefined ? undefined : [path.join(home, 'projects')];
      }

      case 'codex':
        return codexHomes({ providerHome, homeDir: homeDirs.get(entry.name) ?? '.codex' }).map((home) => path.join(home, 'sessions'));
      case 'opencode':
        return undefined;
      default: {
        const unhandled: never = entry.tool;

        return unhandled;
      }
    }
  };

  const reportsTokens = isOnThisMachine(url) && tools.length > 0
    && tools.every((entry) => readsTokens(entry.tool) && (sessionFolders(entry)?.every(canList) ?? false));

  const init: Offered['init'] = {
    type: 'init', ok: true, prompt: true, conversations: true,
    ...(judges.length > 0 && { confinedPrompt: true }),
    ...(Object.keys(unavailable).length > 0 && { unavailable }),
    ...(Object.keys(permissions).length > 0 && { permissions }),
    can: {
      // unattended: a step that may run without asking needs a strict sandbox, which the daemon's host is not, so none
      // starts here, not even in a mode the member opted into that never asks.
      // hitl: in an attended run, a person works through an interactive step in its agent in the Paseo app.
      // role: Paseo runs a project's worktree setup only in a worktree it creates itself, or when asked to run it; this
      // runtime only opens the copy teamai prepared, so nothing delivers the member's own resources over the role's.
      exec: false, setup: false, hitl: mode === 'attended', unattended: false, env: false, tokens: reportsTokens, max_turns: false, workspace: ['read-only', 'new', 'continue', 'clone', 'team'], role: true, tools: tools.map(({ name }) => name),
      ...(judges.length > 0 && { confined: [{ ...CONFINED_KEPT, tools: judges }] }),
    },
  };

  return { init, notices, offers, targets, modeIds, sessionHomes, homeDirs, providerHomes, toAdd };
}
