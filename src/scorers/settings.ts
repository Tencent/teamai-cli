/**
 * The team's scoring settings, in `scorers/scoring.yaml`:
 *
 *   batch: true          # a step's scorers share one judge call unless the step or its workflow says
 *   isolation: verified  # the least isolation every judge of the team's scorers needs
 *   sessions: { attended: off, unattended: auto }  # per run mode, off, ask or auto; true or false sets both
 *   daily_limit: 10      # sessions one data home leases per local day, unless a member's config.yaml says
 *
 * `scorers/<ns>/scoring.yaml` is read where `<ns>` is an active scorers namespace, as model aliases are where theirs
 * is, and replaces the root key of the same name. Two active namespaces asking for an isolation give the strictest;
 * two that set `batch` differently are a failure, as one model alias in two active namespaces is. For sessions, each run
 * mode takes the most restrictive policy of the active namespaces (`off` < `ask` < `auto`), and the lowest
 * `daily_limit` of them wins. A member's `config.yaml` `scoring` overrides both, one mode at a time. Below a workspace
 * or self scope, `scoring` in ~/.teamai/config.yaml applies where that leaves it to the team, and only where it is
 * stricter, so a machine can turn judging off or lower the limit but never start judging.
 *
 * A file that cannot be parsed fails the load, so no judge works to a default the team did not choose. A key or value
 * this teamai does not know is dropped with a problem instead, so a newer CLI's additions never stop this one.
 */
import path from 'node:path';
import YAML from 'yaml';
import { getKnowledgeDir, type LocalConfig } from '../types.js';
import { readEntryFileText } from '../namespaced-entries.js';
import { isSafeNamespaceSegment } from '../manifest-schema.js';
import { listDirs, pathExists } from '../utils/fs.js';
import { SCORING_FILE, scorerNamespaces } from './cache.js';
import type { IsolationSetting } from './isolation.js';
import { loadMemberSettings } from '../config.js';
import { SessionPolicy, type PolicySource, type SessionPolicies } from '../session-flow/session-policy.js';

/** Every key a `scoring.yaml` may set: the parser handles each one, and the problem for any other key lists them. */
const SCORING_KEYS = ['batch', 'isolation', 'sessions', 'daily_limit'] as const;
type ScoringKey = (typeof SCORING_KEYS)[number];

function isScoringKey(key: string): key is ScoringKey {
  return SCORING_KEYS.some((known) => known === key);
}

/** What one `scoring.yaml` sets, or why it cannot be read; every message names the file. */
export type ScoringFileRead =
  | { ok: true; batch?: boolean; isolation?: string; sessions?: Partial<SessionPolicies>; dailyLimit?: number; problems: string[] }
  | { ok: false; reason: string };

export function parseScoringFile(relativePath: string, text: string): ScoringFileRead {
  let document: unknown;
  try {
    document = YAML.parse(text);
  } catch (error) {
    const [message = ''] = (error instanceof Error ? error.message : String(error)).split('\n');
    return { ok: false, reason: `${relativePath} is not valid YAML: ${message.replace(/:\s*$/, '')}` };
  }
  if (document === null || document === undefined) return { ok: true, problems: [] };
  if (typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, reason: `${relativePath} must be a mapping, such as \`isolation: verified\`` };
  }
  const read: ScoringFileRead & { ok: true } = { ok: true, problems: [] };
  for (const [key, value] of Object.entries(document)) {
    if (!isScoringKey(key)) {
      read.problems.push(`${relativePath}: "${key}" is not a scoring setting (${SCORING_KEYS.join(', ')}), so it is ignored`);
      continue;
    }
    switch (key) {
      case 'batch':
        if (typeof value === 'boolean') read.batch = value;
        else read.problems.push(`${relativePath}: batch is ${JSON.stringify(value)}, not true or false, so it is ignored`);
        break;
      case 'isolation':
        read.isolation = typeof value === 'string' ? value : JSON.stringify(value);
        break;
      case 'sessions': {
        const policies = SessionPolicy.read(`${relativePath} sessions`, value, { booleans: true });
        read.sessions = policies.set;
        read.problems.push(...policies.problems);
        break;
      }
      case 'daily_limit':
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) read.dailyLimit = value;
        else read.problems.push(`${relativePath}: daily_limit is ${JSON.stringify(value)}, not a whole number of 0 or more, so it is ignored`);
        break;
      default: {
        const unhandled: never = key;
        void unhandled;
      }
    }
  }
  return read;
}

/** Judge launches a local day takes for finished sessions in one data home, when nothing sets another limit. */
export const SESSION_DAILY_LIMIT = 10;

/**
 * Whether this scope's finished sessions are judge work in each run mode, and how many judge launches a local day may
 * take for them, with what set that limit.
 */
export type SessionScoring = { policies: SessionPolicies; dailyLimit: number; dailyLimitSource: PolicySource };

/**
 * What scoring in this scope follows: the team's `batch` default, every isolation setting that applies here, and whether
 * finished sessions are judge work.
 */
export type ScopeScoring =
  | { ok: true; batch: boolean | undefined; isolation: IsolationSetting[]; sessions: SessionScoring; problems: string[] }
  | { ok: false; reason: string };

/** A `scoring.yaml` this member reads; `namespace` is null for the root file. */
interface TeamFile {
  namespace: string | null;
  relativePath: string;
  sessions?: Partial<SessionPolicies>;
  dailyLimit?: number;
}

/**
 * Each run mode's `sessions` policy as the member's `config.yaml` `scoring` sets it, else the most restrictive of the
 * active namespace files, else the root file, else `off` attended and `auto` unattended; and `daily_limit` as the member
 * sets it, else the lowest of the namespace files, else the root file. `machine`, the `scoring` of ~/.teamai/config.yaml
 * below a workspace or self scope, replaces the team's policy or limit only where it is stricter; where both are alike,
 * the team set it. A member value it cannot use is reported to `problems` and sets nothing. A limit of 0 turns session
 * scoring off in both modes.
 */
function sessionScoring({ config, machine, rootFile, inNamespaces, problems }: {
  config: LocalConfig;
  machine: LocalConfig['scoring'];
  rootFile: TeamFile | undefined;
  inNamespaces: readonly TeamFile[];
  problems: string[];
}): SessionScoring {
  const member = config.scoring?.sessions;
  const limit = config.scoring?.daily_limit;
  if (typeof limit === 'string') problems.push(`config.yaml scoring.daily_limit is ${limit}, not a whole number of 0 or more, so it is ignored`);
  if (typeof machine?.daily_limit === 'string') problems.push(`~/.teamai/config.yaml scoring.daily_limit is ${machine.daily_limit}, not a whole number of 0 or more, so it is ignored`);
  const fromMember = SessionPolicy.read('config.yaml scoring.sessions', member ?? {}, { booleans: true });
  const fromMachine = SessionPolicy.read('~/.teamai/config.yaml scoring.sessions', machine?.sessions ?? {}, { booleans: true });
  problems.push(...fromMember.problems, ...fromMachine.problems);
  const defaults = { attended: 'off', unattended: 'auto' } as const;
  const ofTeam = SessionPolicy.resolve([inNamespaces.map((file) => file.sessions ?? {}), [rootFile?.sessions ?? {}]], defaults);
  // The team's comes first, so it keeps the credit where the machine says the same.
  const policies = SessionPolicy.resolve([[fromMember.set], [ofTeam, fromMachine.set]], defaults);
  const [lowest] = inNamespaces.flatMap((file) => (file.dailyLimit === undefined ? [] : [{ value: file.dailyLimit, source: `${file.relativePath} daily_limit` }]))
    .sort((left, right) => left.value - right.value);
  const ofTeamLimit = lowest ?? (rootFile?.dailyLimit === undefined ? undefined : { value: rootFile.dailyLimit, source: `${rootFile.relativePath} daily_limit` });
  const machineLimit = typeof machine?.daily_limit === 'number' && machine.daily_limit < (ofTeamLimit?.value ?? SESSION_DAILY_LIMIT)
    ? { value: machine.daily_limit, source: '~/.teamai/config.yaml scoring.daily_limit' }
    : undefined;
  const daily = typeof limit === 'number' ? { value: limit, source: 'config.yaml scoring.daily_limit' } : machineLimit ?? ofTeamLimit;
  if (!daily) return { policies, dailyLimit: SESSION_DAILY_LIMIT, dailyLimitSource: { kind: 'default' } };
  const dailyLimitSource = { kind: 'setting', key: daily.source } as const;
  if (daily.value > 0) return { policies, dailyLimit: daily.value, dailyLimitSource };
  const off = { policy: 'off', source: dailyLimitSource } as const;
  return { policies: { attended: off, unattended: off }, dailyLimit: 0, dailyLimitSource };
}

function failed(cause: string): ScopeScoring {
  return { ok: false, reason: `${cause}. Scoring is off in this scope until the team repo fixes it.` };
}

/** The team's scoring files this member reads, with `scoring` from this scope's `config.yaml` and from ~/.teamai/config.yaml. */
export async function scopeScoring(config: LocalConfig): Promise<ScopeScoring> {
  const root = path.join(getKnowledgeDir(config), 'scorers');
  const dirs: string[] = [];
  for (const dir of (await listDirs(root)).filter(isSafeNamespaceSegment).sort()) {
    if (await pathExists(path.join(root, dir, SCORING_FILE))) dirs.push(dir);
  }
  const { active } = await scorerNamespaces(config, dirs);
  const files: Array<TeamFile & { batch?: boolean; isolation?: string }> = [];
  const problems: string[] = [];
  for (const namespace of [null, ...active]) {
    const relativePath = namespace === null ? `scorers/${SCORING_FILE}` : `scorers/${namespace}/${SCORING_FILE}`;
    const text = await readEntryFileText(path.join(root, ...(namespace === null ? [] : [namespace]), SCORING_FILE), relativePath);
    if (!text.ok) return failed(text.reason);
    if (text.text === null) continue;
    const read = parseScoringFile(relativePath, text.text);
    if (!read.ok) return failed(read.reason);
    problems.push(...read.problems);
    files.push({ namespace, relativePath, ...read });
  }
  const rootFile = files.find((file) => file.namespace === null);
  const inNamespaces = files.filter((file) => file.namespace !== null);

  const batches = inNamespaces.filter((file) => file.batch !== undefined);
  const [first] = batches;
  const differing = batches.find((file) => file.batch !== first?.batch);
  if (first && differing) {
    return failed(`batch is ${String(first.batch)} in ${first.relativePath} and ${String(differing.batch)} in ${differing.relativePath}, and both `
      + 'namespaces are active here, so nothing says which one you should receive. Remove batch from one of the files, '
      + 'or stop declaring one of the namespaces for your roles and projects');
  }
  const isolations = inNamespaces.filter((file) => file.isolation !== undefined);
  const teamIsolation = isolations.length > 0 ? isolations : rootFile?.isolation !== undefined ? [rootFile] : [];
  // In user scope, ~/.teamai/config.yaml is this scope's own config.
  const machine = config.scope === 'user' ? undefined : (await loadMemberSettings()).scoring;
  return {
    ok: true,
    batch: first?.batch ?? rootFile?.batch,
    isolation: [
      ...teamIsolation.map((file) => ({ source: `${file.relativePath} isolation`, value: file.isolation })),
      { source: 'config.yaml scoring.isolation', value: config.scoring?.isolation },
      ...(machine?.isolation === undefined ? [] : [{ source: '~/.teamai/config.yaml scoring.isolation', value: machine.isolation }]),
    ],
    sessions: sessionScoring({ config, machine, rootFile, inNamespaces, problems }),
    problems,
  };
}
