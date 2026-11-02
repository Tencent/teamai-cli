/**
 * What `workflow start --describe` proposes for the inputs of teamai's default `teamai-session-to-task` (#1402), each
 * with why, also when it proposes no value: the calling session and its tool, the commit it started at, the fix at
 * HEAD, and the one benchmark suite whose repo is this checkout's origin.
 *
 *   start   earliest dashboard session_start of the session → its gitAtStart, when clean
 *   fix     HEAD of the caller's checkout, when clean and not start
 *   suite   the one cached suite whose repo matches origin → its directory
 *
 * A task of that suite whose source already names this session or this fix is named in that input's why, so a person
 * does not propose the same task twice.
 */
import path from 'node:path';
import { listCachedSuites } from './benchmark/suite-cache.js';
import type { Suite, Task } from './benchmark/suite.js';
import { AgentSession } from './session-flow/agent-session.js';
import type { LocalConfig } from './types.js';
import { getConfiguredRemoteUrl, getHeadState, getRemoteUrl, remotesMatch, type HeadState } from './utils/git.js';
import type { OutputSchema } from './workflow/types.js';

const SESSION_TO_TASK = 'teamai-session-to-task';

/** The inputs teamai proposes values for, by name: a team override that declares one as a string gets it filled. */
const CONTRACT = ['session', 'source', 'suite', 'start', 'fix'] as const;
type ContractInput = typeof CONTRACT[number];

function isContractInput(name: string): name is ContractInput {
  return (CONTRACT as readonly string[]).includes(name);
}

/** A value teamai proposes for one input, or none, and why. */
interface Proposal {
  value?: string;
  why: string;
}

const NO_SESSION_WHY = 'No agent session found: give the session and its tool.';

/** What the dashboard recorded of one session start: when, and the checkout's state then, when it was in git. */
interface SessionStart {
  timestamp: string;
  gitAtStart?: HeadState;
}

/**
 * The commit session's earliest start recorded, when tracked files were not modified then. Resume and compaction also
 * write a start, so only the earliest one is the commit the bug was found at.
 */
function startProposal(starts: readonly SessionStart[]): Proposal {
  const [earliest] = [...starts].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  if (earliest?.gitAtStart === undefined) return { why: 'No value: teamai did not record the commit this session started at. Give the commit the bug was found at.' };
  if (earliest.gitAtStart.dirty) return { why: 'No value: tracked files were modified when this session started, so no commit holds the bug. Give the commit the bug was found at.' };
  return { value: earliest.gitAtStart.head, why: 'The commit this session started at.' };
}

/** HEAD of the caller's checkout, when it holds a fix: it differs from `start`, and no tracked file is modified. */
function fixProposal(start: string | undefined, head: HeadState | null): Proposal {
  if (start === undefined) return { why: 'No value: there is no starting commit to compare HEAD with. Give the fix\'s commit.' };
  if (head === null) return { why: 'No value: this directory has no commit checked out. Give the fix\'s commit.' };
  if (head.dirty) return { why: 'No value: tracked files are modified. Commit the fix, then ask again, or give the commit.' };
  if (head.head === start) return { why: 'No value: HEAD is still the starting commit. Commit the fix, then ask again, or give the commit.' };
  return { value: head.head, why: 'The commit at HEAD: the fix this session made.' };
}

/**
 * The directory of the one suite in `suites` whose repo is `origin`, as written or as git rewrites it: a member's
 * `url.<base>.insteadOf` may point the team's URL at a mirror, or the other way round.
 */
function suiteProposal(origin: readonly string[], suites: readonly Suite[]): { proposal: Proposal; suite?: Suite } {
  if (origin.length === 0) return { proposal: { why: 'No value: this checkout has no origin remote. Give the suite\'s directory, such as benchmarks/frontend.' } };
  const matching = suites.filter((suite) => origin.some((url) => remotesMatch(suite.repo, url)));
  const [only, ...more] = matching;
  if (only === undefined) return { proposal: { why: 'No value: no benchmark suite this checkout received has its origin as repo. Give the suite\'s directory, such as benchmarks/frontend.' } };
  if (more.length > 0) {
    const dirs = matching.map((suite) => path.posix.dirname(suite.relativePath));
    return { proposal: { why: `No value: ${dirs.slice(0, -1).join(', ')} and ${dirs.slice(-1).join('')} ${dirs.length > 2 ? 'all' : 'both'} have this checkout's origin as repo. Give one of them.` } };
  }
  return { proposal: { value: path.posix.dirname(only.relativePath), why: 'The one benchmark suite whose repo is this checkout\'s origin.' }, suite: only };
}

/** `proposal` with the tasks of `suite` that `comesFrom` picks named in its why. */
function namingTasks(proposal: Proposal, suite: Suite | undefined, comesFrom: (source: NonNullable<Task['source']>) => boolean): Proposal {
  const tasks = (suite?.tasks ?? []).flatMap((task) => (task.source !== undefined && comesFrom(task.source) ? [task.relativePath] : []));
  if (tasks.length === 0) return proposal;
  return { ...proposal, why: `${proposal.why} ${tasks.join(', ')} already ${tasks.length > 1 ? 'come' : 'comes'} from it.` };
}

/** The checkout's HEAD state, or null outside a git work tree. */
async function headOf(cwd: string): Promise<HeadState | null> {
  try {
    return await getHeadState(cwd);
  } catch {
    return null;
  }
}

/** Every proposal for the calling session `session` of `tool`, in the checkout `cwd`. */
async function offer(config: LocalConfig, { session, tool, cwd }: { session: string; tool: string; cwd: string }): Promise<Record<ContractInput, Proposal>> {
  // The skill driver imports this module for describe, so it loads the dashboard reader only here.
  const { readEvents } = await import('./dashboard-collector.js');
  const [events, head, written, rewritten, suites] = await Promise.all([readEvents(), headOf(cwd), getConfiguredRemoteUrl(cwd), getRemoteUrl(cwd), listCachedSuites(config)]);
  const origin = [...new Set([written, rewritten].flatMap((url) => (url === null ? [] : [url])))];
  const start = startProposal(events.filter((event) => event.type === 'session_start' && event.sessionId === session));
  const fix = fixProposal(start.value, head);
  const { proposal: suite, suite: proposed } = suiteProposal(origin, suites);
  const platform = AgentSession.platformForTool(tool);
  return {
    session: namingTasks({ value: session, why: 'This session: the one that fixed the bug.' }, proposed, (source) => source.sessionId === session),
    source: platform === undefined ? { value: tool, why: 'This session\'s tool.' } : { value: platform, why: 'This session\'s tool, as teamai session list names it.' },
    suite,
    start,
    fix: namingTasks(fix, proposed, (source) => fix.value !== undefined && source.fix === fix.value),
  };
}

/** What describe proposes, by input, when no agent session calls: no value, and why. */
const NO_SESSION: Record<ContractInput, Proposal> = {
  session: { why: NO_SESSION_WHY },
  source: { why: NO_SESSION_WHY },
  suite: { why: 'No value: no agent session found. Give the suite\'s directory, such as benchmarks/frontend.' },
  start: { why: 'No value: no agent session found. Give the commit the bug was found at.' },
  fix: { why: 'No value: no agent session found. Give the fix\'s commit.' },
};

/**
 * What describe proposes for the declared `inputs` of the workflow `name` resolves to, by input: for
 * teamai-session-to-task, each string input the contract names, from {@link offer} for the calling session in `cwd`;
 * with no agent session, only why. Nothing for another workflow or another input.
 */
async function proposals(
  config: LocalConfig,
  { name, inputs }: { name: string; inputs: Readonly<Record<string, OutputSchema>> },
  caller: { session: string | undefined; tool: string | undefined; cwd: string },
): Promise<Record<string, Proposal>> {
  if (name !== SESSION_TO_TASK) return {};
  const matching = Object.entries(inputs).flatMap(([input, type]) => (isContractInput(input) && type.type === 'string' ? [input] : []));
  if (matching.length === 0) return {};
  const proposed = caller.session === undefined || caller.tool === undefined
    ? NO_SESSION
    : await offer(config, { session: caller.session, tool: caller.tool, cwd: caller.cwd });
  return Object.fromEntries(matching.map((input) => [input, proposed[input]]));
}

export const SessionToTask = { proposals } as const;
