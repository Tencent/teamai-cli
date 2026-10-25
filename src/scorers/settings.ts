/**
 * The team's scoring settings, in `scorers/scoring.yaml`:
 *
 *   batch: true          # a step's scorers share one judge call unless the step or its workflow says
 *   isolation: verified  # the least isolation every judge of the team's scorers needs
 *   sessions: true       # members' finished sessions are judge work, unless a member's config.yaml says
 *   daily_limit: 10      # sessions one data home leases per local day, unless a member's config.yaml says
 *
 * `scorers/<ns>/scoring.yaml` is read where `<ns>` is an active scorers namespace, as model aliases are where theirs
 * is, and replaces the root key of the same name. Two active namespaces asking for an isolation give the strictest;
 * two that set `batch` differently are a failure, as one model alias in two active namespaces is. For sessions, one
 * active namespace that sets `sessions: false` turns them off, and the lowest `daily_limit` of them wins.
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
import { machineIsolation, type IsolationSetting } from './isolation.js';

/** Every key a `scoring.yaml` may set: the parser handles each one, and the problem for any other key lists them. */
const SCORING_KEYS = ['batch', 'isolation', 'sessions', 'daily_limit'] as const;
type ScoringKey = (typeof SCORING_KEYS)[number];

function isScoringKey(key: string): key is ScoringKey {
  return SCORING_KEYS.some((known) => known === key);
}

/** What one `scoring.yaml` sets, or why it cannot be read; every message names the file. */
export type ScoringFileRead =
  | { ok: true; batch?: boolean; isolation?: string; sessions?: boolean; dailyLimit?: number; problems: string[] }
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
      case 'sessions':
        if (typeof value === 'boolean') read.sessions = value;
        else read.problems.push(`${relativePath}: sessions is ${JSON.stringify(value)}, not true or false, so it is ignored`);
        break;
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

/** Whether this scope's finished sessions are judge work, and how many judge launches a local day may take for them. */
export type SessionScoring = { enabled: false; reason: string } | { enabled: true; dailyLimit: number };

/** Judge launches a local day takes for finished sessions in one data home, when nothing sets another limit. */
export const SESSION_DAILY_LIMIT = 10;

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
  sessions?: boolean;
  dailyLimit?: number;
}

/**
 * `sessions` and `daily_limit` as the member's `config.yaml` `scoring` sets them, else the active namespace files, else
 * the root file. A member value that is not true or false, or not a whole number of 0 or more, is reported and sets
 * nothing. A limit of 0 turns session scoring off.
 */
function sessionScoring(config: LocalConfig, rootFile: TeamFile | undefined, inNamespaces: readonly TeamFile[], problems: string[]): SessionScoring {
  const member = config.scoring?.sessions;
  const limit = config.scoring?.daily_limit;
  if (typeof member === 'string') problems.push(`config.yaml scoring.sessions is "${member}", not true or false, so it is ignored`);
  if (typeof limit === 'string') problems.push(`config.yaml scoring.daily_limit is ${limit}, not a whole number of 0 or more, so it is ignored`);
  const sessionsFile = inNamespaces.find((file) => file.sessions === false) ?? inNamespaces.find((file) => file.sessions === true)
    ?? (rootFile?.sessions === undefined ? undefined : rootFile);
  const enabled = typeof member === 'boolean' ? { on: member, source: 'config.yaml scoring.sessions' }
    : sessionsFile && { on: sessionsFile.sessions === true, source: `${sessionsFile.relativePath} sessions` };
  if (!enabled?.on) return { enabled: false, reason: enabled ? `${enabled.source} is false` : 'nothing sets scoring.sessions: true in config.yaml or sessions: true in scorers/scoring.yaml' };
  const [lowest] = inNamespaces.flatMap((file) => (file.dailyLimit === undefined ? [] : [{ value: file.dailyLimit, source: `${file.relativePath} daily_limit` }]))
    .sort((left, right) => left.value - right.value);
  const daily = typeof limit === 'number' ? { value: limit, source: 'config.yaml scoring.daily_limit' }
    : lowest ?? (rootFile?.dailyLimit === undefined ? undefined : { value: rootFile.dailyLimit, source: `${rootFile.relativePath} daily_limit` });
  if (!daily) return { enabled: true, dailyLimit: SESSION_DAILY_LIMIT };
  return daily.value === 0 ? { enabled: false, reason: `${daily.source} is 0` } : { enabled: true, dailyLimit: daily.value };
}

function failed(cause: string): ScopeScoring {
  return { ok: false, reason: `${cause}. Scoring is off in this scope until the team repo fixes it.` };
}

/** The team's scoring files this member reads, with this scope's `config.yaml` `scoring.isolation`. */
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
  return {
    ok: true,
    batch: first?.batch ?? rootFile?.batch,
    isolation: [...teamIsolation.map((file) => ({ source: `${file.relativePath} isolation`, value: file.isolation })), machineIsolation(config)],
    sessions: sessionScoring(config, rootFile, inNamespaces, problems),
    problems,
  };
}
