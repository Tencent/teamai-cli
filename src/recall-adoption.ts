/**
 * Adoption of recalled docs (#884): a doc counts as adopted when the session
 * that ran a recall opens it within 24 hours after the run.
 *
 *   PostToolUse ── recordToolCall ──▶ claim / evidence ─┐
 *   teamai recall ────────────────▶ run ────────────────┼─▶ recall log
 *   Stop / SubagentStop ── creditAdoptedDocs ◀── join ──┤
 *   pull ── drainRecallLog: pending sessions, retention ┘
 *              ├─▶ creditRecallAdoptions (durable ledger) ─▶ consumed, credit
 *              └─▶ countRecalledSessions ─▶ counted
 *
 * The votes file holds each root session's credit of a doc for good, whoever
 * gave it: a read here, or an adoption label `teamai score write` wrote (#1391).
 * Credit and counted lines project that state into the journal for reporting.
 *
 * The hook side only classifies the call and appends its lines in one write;
 * it never reads the log. The reducer does the join, at Stop, at SubagentStop
 * and, as a recovery, at `pull`, which alone prunes the log.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Option } from 'commander';
import { z } from 'zod';

import { GLOBAL_OPTIONS } from './global-options.js';
import { HookStdinSchema, type HookStdin } from './hook-dispatch.js';
import { appendRecallLines, readRecallLog, recallLogPath } from './recall-log.js';
import type { Actor, ClaimLine, CreditLine, EvidenceLine, LinkLine, RecallLogLine, RecalledDoc, RunLine } from './recall-log.js';
import { getVotesDir } from './types.js';
import { forgetSessionIdentities, readUserVotes, type AdoptionVerdict } from './votes.js';
import type { JsonValue, LocalConfig } from './types.js';
import { isAbsolutePath, pathKey, samePath } from './utils/agent-path.js';
import { rewriteJsonl } from './utils/jsonl-store.js';
import { log } from './utils/logger.js';
import { deriveDispatchSessionId } from './utils/session-id.js';
import { commandWords, simpleCommands } from './utils/shell-command.js';
import { classifyToolCall } from './utils/tool-call.js';

/** How long after a run a read of one of its docs counts as adoption. */
const ADOPTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The run ids recall prints: on its region's start line, or at the end of the
 * line it prints for no hits (after the logger's glyph).
 */
const RUN_ID_PATTERN = /^(?:--- \[teamai:recall:start\] --- \(\d+ results?\)|(?:\S* )?No matching learnings found for ".*"\.) run=([0-9a-f-]{36})(?=\s|$)/gm;

/** The binary's file name; after `npx`, the package, with or without a version. */
const TEAMAI_BINARY = /^teamai(?:\.cmd|\.exe)?$/i;
const TEAMAI_PACKAGE = /^teamai(?:-cli)?(?:@\S*)?$/i;

/** The recall subagent's name: its `--caller`, and the `agent_type` its hooks carry. */
const RECALL_SUBAGENT = 'teamai-recall';

/** The root program's options, as Commander reads their flags. */
const ROOT_OPTIONS = GLOBAL_OPTIONS.map(([flags]) => new Option(flags));

/**
 * How many words at `words[i]` are one of the root program's options, with
 * its value when it takes one (`--name value`, `--name=value`); 0 when
 * `words[i]` is none.
 */
function rootOptionWords(words: string[], i: number): number {
  const word = words[i] ?? '';
  const eq = word.startsWith('--') ? word.indexOf('=') : -1;
  const flag = eq === -1 ? word : word.slice(0, eq);
  const option = ROOT_OPTIONS.find((o) => o.short === flag || o.long === flag);

  if (!option) return 0;
  const takesValue = option.required || option.optional;

  if (eq !== -1) return takesValue ? 1 : 0;

  // Commander gives an optional value the next word unless it is an option.
  return option.required || (option.optional && !(words[i + 1] ?? '-').startsWith('-')) ? 2 : 1;
}

/**
 * Whether a shell command itself runs `teamai recall`: one of its simple
 * commands has `teamai` (by path or `.cmd`/`.exe` too, or the package after
 * `npx`) as its command word, after any `NAME=value` assignments, with
 * `recall` next, after any of the root program's options (`teamai -v
 * recall`). A command that only names it inside a quoted argument, such as
 * `codex exec "run teamai recall …"`, does not.
 */
function invokesRecall(command: string): boolean {
  return simpleCommands(command).some((simple) => {
    const words = commandWords(simple.words);
    let i = 0;
    let name = TEAMAI_BINARY;

    if (words[i] === 'npx') {
      i++;

      while (i < words.length && words[i].startsWith('-')) i++;
      name = TEAMAI_PACKAGE;
    }

    if (!name.test(words[i]?.split(/[\\/]/).pop() ?? '')) return false;
    i++;

    for (let n = rootOptionWords(words, i); n > 0; n = rootOptionWords(words, i)) i += n;

    return words[i] === 'recall';
  });
}

const NonEmptyTextSchema = z.string().min(1);

function nonEmpty(value: JsonValue | undefined): string | undefined {
  const text = NonEmptyTextSchema.safeParse(value);

  return text.success ? text.data : undefined;
}

/** The actor a hook payload names: its session, and the subagent it fired in, if any. */
function actorOf(stdin: HookStdin, tool: string): Actor {
  const agentId = nonEmpty(stdin.agent_id);
  const agentType = nonEmpty(stdin.agent_type);
  const actor: Actor = { session: deriveDispatchSessionId(stdin, tool) };

  if (agentId) actor.agentId = agentId;

  if (agentType) actor.agentType = agentType;

  return actor;
}

/**
 * Record what the recall log needs from one PostToolUse: a link when it names
 * the child session a subagent ran in; a claim for each run
 * id a shell call printed, noting whether its command ran `teamai recall`
 * itself; evidence for each file under the knowledge roots it read, or whose
 * lines a search showed, unless it failed; nothing otherwise. Whether a claim or a read of unknown status
 * counts is the reducer's call. The command itself is never recorded. All of
 * a call's lines go in one write, however many files a search showed.
 */
export async function recordToolCall(stdin: HookStdin, tool: string, config: LocalConfig): Promise<void> {
  await appendRecallLines(config, await toolCallLines(stdin, tool, config));
}

async function toolCallLines(stdin: HookStdin, tool: string, config: LocalConfig): Promise<RecallLogLine[]> {
  const lines: RecallLogLine[] = [];
  // A subagent's own session, which a bridge names on the call that ran it (OpenCode's task tool) or on the subagent's first call (OMP).
  const link = HookStdinSchema.safeParse(stdin.session_link);
  const child = link.success ? nonEmpty(link.data.child) : undefined;
  const parent = link.success ? nonEmpty(link.data.parent) : undefined;

  if (child && parent && child !== parent) {
    lines.push({ kind: 'link', ts: new Date().toISOString(), child, parent });
  }

  const call = classifyToolCall(stdin, tool);

  if (call.command !== undefined && call.output !== undefined) {
    const runs = [...new Set([...call.output.matchAll(RUN_ID_PATTERN)].map((m) => m[1]))];

    if (runs.length > 0) {
      const actor = actorOf(stdin, tool);
      const direct = invokesRecall(call.command);

      for (const run of runs) lines.push({ kind: 'claim', ts: new Date().toISOString(), run, ...actor, direct, agent: tool });

      return lines;
    }
  }

  // A search's paths are the files its output showed lines of; the reducer keeps those a run printed.
  if ((call.category !== 'read' && call.category !== 'search') || call.status === 'failure') return lines;
  let roots: string[] | undefined;

  for (const file of call.paths) {
    // Recalled docs are markdown: no other path can vote, and none that is text a search printed reaches the log.
    if (!/\.md$/i.test(file)) continue;

    // A relative path had no base to place it under a root: it is kept for the suffix match.
    if (isAbsolutePath(file)) {
      const { knowledgeRoots, isUnderRoots } = await import('./utils/learnings-roots.js');
      roots ??= await knowledgeRoots(config);

      if (!isUnderRoots(file, roots)) continue;
    }

    lines.push({
      kind: 'evidence', ts: new Date().toISOString(), id: randomUUID(),
      ...actorOf(stdin, tool), path: file, status: call.status, simple: call.simple,
    });
  }

  return lines;
}

export interface AdoptionResult {
  /** Docs newly upvoted for the session, or null when the votes file was busy and nothing was credited. */
  credited: string[] | null;
  /** Distinct docs the session's runs returned. */
  recalled: number;
}

function segments(p: string): string[] {
  return pathKey(p).split('/').filter((s) => s !== '' && s !== '.');
}

/**
 * The paths of `paths` a read of `evidencePath` opened. An absolute path must
 * name the printed one, however either is written (agent-path). A relative
 * path had no base: it matches by its trailing segments (at least the parent
 * and the file name), and only when a single printed path has them.
 */
function openedPaths(evidencePath: string, paths: string[]): string[] {
  if (isAbsolutePath(evidencePath)) return paths.filter((p) => samePath(p, evidencePath));
  const tail = segments(evidencePath);

  if (tail.length < 2) return [];

  const hits = paths.filter((p) => {
    const segs = segments(p);

    return segs.length >= tail.length && tail.every((s, i) => segs[segs.length - tail.length + i] === s);
  });

  return new Set(hits.map((p) => segments(p).join('/'))).size === 1 ? hits : [];
}

/** The docs a read of `evidencePath` opened. */
function docsOpened(evidencePath: string, docs: RecalledDoc[]): RecalledDoc[] {
  const opened = new Set(openedPaths(evidencePath, docs.map((d) => d.path)));

  return docs.filter((d) => opened.has(d.path));
}

/** What the reducer reads off the whole log, once per pass. */
interface LogIndex {
  lines: RecallLogLine[];
  /** Each run's first valid claim: its command ran the recall itself, for a run in this log, earliest by time. */
  claimOf: Map<string, ClaimLine>;
  /** Ids of the evidence already credited. */
  consumed: Set<string>;
  /** The first credit of each root session and doc, by `creditKey`, with whether its votes were written. */
  credits: Map<string, CreditLine & { isWritten: boolean }>;
  /** The root sessions and docs counted in a doc's recalled sessions, by `creditKey`. */
  counted: Set<string>;
  /** The session a child's work counts for: its links followed up to the root. */
  rootOf: (session: string) => string;
  /** The session a run is settled to, or null when it is unsettled. */
  ownerOf: (run: RunLine) => string | null;
}

function indexLog(lines: RecallLogLine[]): LogIndex {
  const logged = new Set(lines.flatMap((l) => l.kind === 'run' ? [l.run] : []));
  const claimOf = new Map<string, ClaimLine>();
  const parentOf = new Map<string, string>();
  const consumed = new Set<string>();
  const credits = new Map<string, CreditLine & { isWritten: boolean }>();
  const written = new Set<string>();
  const counted = new Set<string>();

  for (const line of lines) {
    if (line.kind === 'claim') {
      if (line.direct !== true || !logged.has(line.run)) continue;
      // Earliest by time: a claim a busy lock left in a side record reads after the file's lines.
      const first = claimOf.get(line.run);

      if (!first || line.ts < first.ts) claimOf.set(line.run, line);
    } else if (line.kind === 'link') {
      if (!parentOf.has(line.child)) parentOf.set(line.child, line.parent);
    } else if (line.kind === 'consumed') consumed.add(line.evidence);
    else if (line.kind === 'credit') {
      const key = creditKey(line.session, line.doc);

      if (!credits.has(key)) credits.set(key, { ...line, isWritten: false });

      if (line.votes === 'written') written.add(line.id);
    } else if (line.kind === 'counted') counted.add(creditKey(line.session, line.doc));
  }

  for (const credit of credits.values()) credit.isWritten = written.has(credit.id);

  // A cycle stops where it closes.
  const rootOf = (session: string): string => {
    const seen = new Set<string>([session]);
    let root = session;

    for (let up = parentOf.get(root); up !== undefined && !seen.has(up); up = parentOf.get(root)) {
      seen.add(up);
      root = up;
    }

    return root;
  };

  const ownerOf = (r: RunLine): string | null => claimOf.get(r.run)?.session ?? (r.unambiguous === true ? r.session : null);

  return { lines, claimOf, consumed, credits, counted, rootOf, ownerOf };
}

/** The key of a root session's credit of a doc, or of its count in the doc's recalled sessions. */
function creditKey(session: string, doc: string): string {
  return `${session}\n${doc}`;
}

/** Durable credits survive the recall journal's retention and an interrupted completion append. */
async function durableCredits(config: LocalConfig, session: string): Promise<Set<string>> {
  const votes = await readUserVotes(path.join(getVotesDir(config), `${config.username}.yaml`));

  return new Set(votes.adoptionCredits?.[session] ?? []);
}

/** Whether `at` falls within the adoption window after the run. */
function inWindow(at: number, run: RunLine): boolean {
  const since = at - Date.parse(run.ts);

  return since >= 0 && since <= ADOPTION_WINDOW_MS;
}

/**
 * The reducer: credit the docs `sessionId` adopted, through the per-session
 * durable adoption ledger, and mark the evidence that credited them consumed so it never
 * votes again. A run's doc is credited once: a later read of it counts for
 * nothing, even after the journal is pruned. When the votes file is busy
 * nothing is consumed, so the next trigger (Stop, SubagentStop or `pull`)
 * retries.
 *
 * Each run is settled first: by its first valid claim (one whose command ran
 * the recall itself, for a run in this log, earliest by time), or else by the
 * session its environment named, only when that was the only candidate. A
 * later claim that disagrees is kept but not applied, and an unsettled run
 * never votes. A run the recall subagent made (its `--caller`, or its valid
 * claim's agent type) is marked: reads by the actor that ran it never count
 * for it, while reads by the main agent or any other subagent do. A read
 * whose status the agent did not report counts only when it was the call's
 * only command, of a path one of the session's runs printed. Only eligible
 * docs are credited: an inherited user-scope doc stays read-only while a
 * project is active.
 *
 * A subagent that ran in a child session (OpenCode's task tool, OMP) is linked to
 * the session that started it: the runs and reads of every session linked up
 * to the same root count as the root's, the ledger's session, whichever of
 * them stopped. The child stays their actor, so a marked run's own reads are
 * still excluded. Links apply whenever they arrived: evidence that did not
 * count before its link is never consumed, so the next trigger re-evaluates it.
 */
export async function creditAdoptedDocs(config: LocalConfig, sessionId: string): Promise<AdoptionResult> {
  return creditRoot(config, indexLog(await readRecallLog(config)), sessionId);
}

/** What one root session's settled runs and countable reads are, as the reducer judges them. */
interface RootView {
  runs: RunLine[];
  /** Distinct docs the runs returned. */
  recalled: number;
  /** Distinct docs consumed reads credited. */
  adopted: number;
  /** Runs a countable read opened a recorded related path of, within the run's window (#1562). */
  viaRelation: number;
  /** The root's reads whose status lets them count. */
  evidence: EvidenceLine[];
  /** The eligible docs a read opened, of the runs whose window it falls in and whose own reads it may count for. */
  opened: (e: EvidenceLine) => RecalledDoc[];
  /** The credit a doc earns: once per run. */
  creditOf: (d: RecalledDoc) => string;
  /** The credits consumed reads already earned. */
  done: Set<string>;
}

function viewRoot(index: LogIndex, target: string): RootView {
  const { lines, claimOf, consumed, rootOf, ownerOf } = index;

  const runs = lines.filter((l): l is RunLine => {
    if (l.kind !== 'run') return false;
    const owner = ownerOf(l);

    return owner !== null && rootOf(owner) === target;
  });

  // A marked run's actor: the session that ran it, and its claim's subagent there, or the main agent (null).
  const markedActor = new Map<RunLine, { session: string; agentId: string | null }>();

  for (const r of runs) {
    const claim = claimOf.get(r.run);

    if (r.caller === RECALL_SUBAGENT || claim?.agentType === RECALL_SUBAGENT) {
      markedActor.set(r, { session: ownerOf(r)!, agentId: claim?.agentId ?? null });
    }
  }

  const recalled = new Set(runs.flatMap((r) => r.docs.map((d) => d.key))).size;
  const runOf = new Map<RecalledDoc, RunLine>(runs.flatMap((r) => r.docs.map((d) => [d, r] as const)));
  const creditOf = (d: RecalledDoc): string => `${runOf.get(d)!.run}\n${d.key}`;

  // The eligible docs a read opened, of the runs whose window it falls in and whose own reads it may count for.
  const opened = (e: EvidenceLine): RecalledDoc[] => {
    const at = Date.parse(e.ts);

    const docs = runs
      .filter((r) => inWindow(at, r))
      .filter((r) => {
        const actor = markedActor.get(r);

        return !actor || actor.session !== e.session || actor.agentId !== (e.agentId ?? null);
      })
      .flatMap((r) => r.docs);

    return docsOpened(e.path, docs).filter((d) => d.eligible);
  };

  const evidence = lines.filter((e): e is EvidenceLine => e.kind === 'evidence' && rootOf(e.session) === target
    // A read of unknown status (Codex's shell) counts only as a simple read, never as a pipeline's head or an item of a list.
    && (e.status === 'success' || (e.status === 'unknown' && e.simple === true)));

  const credited = evidence.filter((e) => consumed.has(e.id)).flatMap(opened);
  const done = new Set(credited.map(creditOf));
  // A run counts once when any countable read — credited or still pending —
  // opens any related path the run recorded, within its window and under the
  // same marked-actor rule as adoption (#1562). Related opens never credit,
  // so unlike `done` this set never feeds the votes ledger.
  const relatedPathsOf = (r: RunLine): string[] => [...new Set(r.docs.flatMap((d) => (d.related ?? []).map((x) => x.path)))];
  const viaRelationRuns = new Set<string>();

  for (const e of evidence) {
    const at = Date.parse(e.ts);

    // The ambiguity pool holds every in-window run's recalled paths and
    // related paths: a relative read that could name one of each credits
    // nothing — it is plausibly an ordinary read of the recalled doc
    // itself, not a related open (#1637 review). Counted runs stay in the
    // pool; only the adding loop skips them.
    const pool = runs.filter((r) => {
      if (!inWindow(at, r)) return false;
      const actor = markedActor.get(r);

      return !actor || actor.session !== e.session || actor.agentId !== (e.agentId ?? null);
    });

    const poolPathsOf = (r: RunLine): string[] => [...new Set([...r.docs.map((d) => d.path), ...relatedPathsOf(r)])];
    const matched = new Set(openedPaths(e.path, pool.flatMap(poolPathsOf)));

    for (const r of pool) {
      if (viaRelationRuns.has(r.run)) continue;

      if (relatedPathsOf(r).some((p) => matched.has(p))) viaRelationRuns.add(r.run);
    }
  }

  // A judge's adopted verdict counts once its upvote is written, as a read counts once credited.
  const judged = [...index.credits.values()].flatMap((c) => (c.session === target && c.source === 'judge' && c.adopted && c.isWritten ? [c.doc] : []));

  return { runs, recalled, adopted: new Set([...credited.map((d) => d.key), ...judged]).size, viaRelation: viaRelationRuns.size, evidence, opened, creditOf, done };
}

async function creditRoot(config: LocalConfig, index: LogIndex, sessionId: string): Promise<AdoptionResult> {
  const target = index.rootOf(sessionId);
  const { runs, recalled, evidence, opened, creditOf, done } = viewRoot(index, target);

  if (runs.length === 0) return { credited: [], recalled };
  const { consumed, credits } = index;
  const votePath = path.join(getVotesDir(config), `${config.username}.yaml`);

  if (!await countSessions(config, index, target, runs, votePath)) return { credited: null, recalled };
  const held = await durableCredits(config, target);

  const keys = new Set<string>();
  // Docs the votes file credited whose journal markers an interrupted append lost: marked again, never counted again.
  const unmarked = new Set<string>();
  const crediting: string[] = [];

  for (const e of evidence) {
    if (consumed.has(e.id)) continue;
    // A doc this session credited once, by a read or an adoption label, never credits again (#1391).
    const fresh = opened(e).filter((d) => !done.has(creditOf(d)) && !credits.has(creditKey(target, d.key)));

    if (fresh.length === 0) continue;

    for (const d of fresh) (held.has(d.key) ? unmarked : keys).add(d.key);
    crediting.push(e.id);
  }

  if (crediting.length === 0) return { credited: [], recalled };

  const ts = new Date().toISOString();
  const lineOf = (doc: string): CreditLine => ({ kind: 'credit', ts, id: randomUUID(), session: target, doc, source: 'tool', adopted: true, votes: 'written' });
  const creditLines = [...keys].map(lineOf);
  const { creditRecallAdoptions } = await import('./votes.js');
  const credited = await creditRecallAdoptions({ votePath, credits: creditLines });

  if (credited === null) return { credited: null, recalled };

  for (const id of crediting) consumed.add(id);
  const marked = [...creditLines, ...[...unmarked].map(lineOf)];

  // A key the ledger had already credited is this session's credit too.
  for (const line of marked) credits.set(creditKey(target, line.doc), { ...line, isWritten: true });

  try {
    await appendRecallLines(config, [...crediting.map((evidenceId): RecallLogLine => ({ kind: 'consumed', ts, evidence: evidenceId })), ...marked]);
  } catch (e) {
    // The votes file holds the credit identity, so a retry cannot increment it again.
    log.debug(`recall adoption: could not mark ${crediting.length} evidence line(s) consumed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { credited: credited.map((credit) => credit.doc), recalled };
}

/**
 * Counts root session `target` once in the recalled sessions of each eligible doc its `runs` returned that it was not
 * counted for yet. False when the votes file was busy: nothing was counted, and the next trigger retries.
 */
async function countSessions(config: LocalConfig, index: LogIndex, target: string, runs: readonly RunLine[], votePath: string): Promise<boolean> {
  const docs = [...new Set(runs.flatMap((r) => r.docs.filter((d) => d.eligible).map((d) => d.key)))].filter((doc) => !index.counted.has(creditKey(target, doc)));

  if (docs.length === 0) return true;
  const { countRecalledSessions } = await import('./votes.js');

  if (!await countRecalledSessions({ votePath, sessionId: target, docIds: docs })) return false;

  for (const doc of docs) index.counted.add(creditKey(target, doc));

  try {
    const ts = new Date().toISOString();
    await appendRecallLines(config, docs.map((doc) => ({ kind: 'counted', ts, session: target, doc })));
  } catch (e) {
    // The votes file holds the identity too, so a retry restores the marker without counting again.
    log.debug(`recall adoption: could not record ${docs.length} counted session(s): ${e instanceof Error ? e.message : String(e)}`);
  }

  return true;
}

/**
 * The eligible docs root session `sessionId`'s runs returned that no countable read of the session opened, credited or
 * still pending, and that the session holds no credit of: what an adoption question asks of (#1391). None for a
 * session another session started: its runs count under the root's.
 */
export async function adoptionCandidates(config: LocalConfig, sessionId: string): Promise<RecalledDoc[]> {
  const index = indexLog(await readRecallLog(config));

  if (index.rootOf(sessionId) !== sessionId) return [];
  const { runs, evidence, opened } = viewRoot(index, sessionId);
  const read = new Set(evidence.flatMap(opened).map((d) => d.key));
  const held = await durableCredits(config, sessionId);
  const docs = runs.flatMap((r) => r.docs).filter((d) => d.eligible && !read.has(d.key) && !index.credits.has(creditKey(sessionId, d.key)) && !held.has(d.key));

  return [...new Map(docs.map((d) => [d.key, d] as const)).values()];
}

/**
 * Credits `verdicts` on root session `sessionId` (#1391): each claims the session and doc with a pending judge credit,
 * unless a read or an earlier label holds one, then writes the votes of the claims that stand, and marks them written.
 * Judge credits a busy votes file left pending before are written first. Returns the verdicts credited now, or null
 * when the votes file was busy: the claims stay pending, and the next adoption write or `pull` writes them. A session
 * no line of the recall log names any more is credited nothing: `pull` may have forgotten its adoption credits.
 */
export async function creditAdoptionVerdicts(config: LocalConfig, sessionId: string, verdicts: readonly AdoptionVerdict[]): Promise<AdoptionVerdict[] | null> {
  const before = indexLog(await readRecallLog(config));
  const root = before.rootOf(sessionId);

  if (!before.lines.some((line) => sessionsOf(line).includes(root))) {
    log.debug(`recall adoption: not crediting ${verdicts.length} adoption verdict(s) of session ${root}: the recall log no longer names it`);

    return [];
  }

  const ts = new Date().toISOString();
  const held = await durableCredits(config, root);

  const claims = [...new Map(verdicts.map((v) => [v.doc, v] as const)).values()].flatMap((v): CreditLine[] => (before.credits.has(creditKey(root, v.doc)) || held.has(v.doc)
    ? []
    : [{ kind: 'credit', ts, id: randomUUID(), session: root, doc: v.doc, source: 'judge', adopted: v.adopted, votes: 'pending' }]));

  if (claims.length > 0) await appendRecallLines(config, claims);
  // Read again: of two writers claiming one session and doc, the first line stands.
  const ok = await writePendingJudgeCredits(config, indexLog(await readRecallLog(config)));

  if (!ok) return null;

  return claims.map((c) => ({ doc: c.doc, adopted: c.adopted }));
}

/**
 * Writes the votes of every judge credit in `index` still pending, then marks them written. False when the votes file
 * was busy: they stay pending.
 */
async function writePendingJudgeCredits(config: LocalConfig, index: LogIndex): Promise<boolean> {
  const pending = [...index.credits.values()].filter((c) => c.source === 'judge' && !c.isWritten);

  if (pending.length === 0) return true;
  const { creditRecallAdoptions } = await import('./votes.js');

  if (await creditRecallAdoptions({ votePath: path.join(getVotesDir(config), `${config.username}.yaml`), credits: pending }) === null) return false;
  const ts = new Date().toISOString();
  await appendRecallLines(config, pending.map(({ isWritten: _isWritten, ...c }): CreditLine => ({ ...c, ts, votes: 'written' })));

  return true;
}

/** Eligible docs from this session's settled, linked recall runs, keyed for voting. */
export async function recalledDocsForSession(config: LocalConfig, sessionId: string): Promise<RecalledDoc[]> {
  const index = indexLog(await readRecallLog(config));
  const { runs } = viewRoot(index, index.rootOf(sessionId));

  return [...new Map(runs.flatMap(r => r.docs.filter(d => d.eligible).map(d => [d.key, d] as const))).values()];
}

/** One root session's recall activity, as `teamai stats` shows it. */
export interface RecallSessionSummary {
  /** The root session: a linked child's runs and reads count under it. */
  session: string;
  /** The agent family of its newest run the environment named it in, when one did. */
  agent?: string;
  /** Settled runs, those with no hits included. */
  runs: number;
  /** Distinct docs the runs returned. */
  recalled: number;
  /** Distinct docs the reducer credited or a judge found adopted: a read or a verdict still pending is not counted. */
  adopted: number;
  /**
   * Runs in which a countable read opened at least one of the related paths
   * the run recorded, within its window (#1562). A run counts once, however
   * many related paths open; a pending read counts as an open.
   */
  viaRelation: number;
  /** The newest run's time. */
  last: string;
}

/**
 * The root sessions of the scope's log with settled runs, newest run first,
 * at most `limit`, settled, linked and credited exactly as the reducer does.
 * It only reads the log.
 */
export async function recallSessions(config: LocalConfig, limit: number): Promise<RecallSessionSummary[]> {
  const index = indexLog(await readRecallLog(config));
  const newest = new Map<string, RunLine>();

  for (const line of index.lines) {
    if (line.kind !== 'run') continue;
    const owner = index.ownerOf(line);

    if (owner === null) continue;
    const root = index.rootOf(owner);
    const seen = newest.get(root);

    if (!seen || line.ts > seen.ts) newest.set(root, line);
  }

  return [...newest].sort(([, a], [, b]) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, limit).map(([session, last]) => {
    const { runs, recalled, adopted, viaRelation } = viewRoot(index, session);
    // A run's agent is the one whose hook claimed it, else its environment's
    // family when the run settled to the session that environment named.
    const agentOf = (r: RunLine) => index.claimOf.get(r.run)?.agent ?? (index.ownerOf(r) === r.session ? r.agent : undefined);
    const named = runs.filter((r) => agentOf(r));
    const agent = named.reduce<RunLine | undefined>((a, r) => (!a || r.ts > a.ts ? r : a), undefined);
    const family = agent ? agentOf(agent) : undefined;

    const counts = { runs: runs.length, recalled, adopted, viaRelation, last: last.ts };

    return family ? { session, agent: family, ...counts } : { session, ...counts };
  });
}

/** How long the recall log keeps a line. */
const RECALL_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The most lines the recall log keeps, the oldest dropped first. */
const RECALL_LOG_MAX_LINES = 5000;

/**
 * What `teamai pull` does with a scope's recall log. First it credits the
 * sessions whose evidence is still pending, a recovery for a read after the
 * session's last Stop, or a Stop that found the votes file busy (git teams
 * only, as votes are). Once those writes succeed, it forgets the recalled sessions the log no longer names (see
 * {@link forgetUnnamedSessions}), then applies retention under the log's lock (see {@link retainedLines}). Never call it from a hook: the prune may wait
 * seconds for the lock. Failures are logged, not thrown: the next pull
 * retries.
 */
export async function drainRecallLog(config: LocalConfig): Promise<void> {
  const file = recallLogPath(config);

  if (config.repo.kind !== 'http') {
    try {
      if (!await creditPendingSessions(config)) return;
    } catch (e) {
      log.debug(`recall adoption: could not credit pending sessions from ${file}: ${e instanceof Error ? e.message : String(e)}`);

      return;
    }
  }

  try {
    await forgetUnnamedSessions(config);
  } catch (e) {
    log.debug(`recall adoption: could not forget recalled sessions ${file} no longer names: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Taking the lock creates its directory: a scope that never recalled gets none.
  if (!fs.existsSync(file)) return;

  try {
    await rewriteJsonl(file, (lines) => retainedLines(lines, Date.now()));
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return;
    log.error(`Could not prune ${file}: ${e instanceof Error ? e.message : String(e)}. It is pruned again at the next pull.`);
  }
}

/**
 * Write the votes of judge credits a busy votes file left pending, then run
 * the reducer for each root session with evidence not yet consumed, or a
 * recalled doc it was not counted for yet. It stops at the first busy votes
 * file: the rest stays pending for the next trigger.
 */
async function creditPendingSessions(config: LocalConfig): Promise<boolean> {
  const index = indexLog(await readRecallLog(config));

  if (!await writePendingJudgeCredits(config, index)) return false;

  const uncounted = index.lines.flatMap((l) => {
    const owner = l.kind === 'run' ? index.ownerOf(l) : null;

    return l.kind === 'run' && owner !== null && l.docs.some((d) => d.eligible && !index.counted.has(creditKey(index.rootOf(owner), d.key))) ? [index.rootOf(owner)] : [];
  });

  const roots = new Set([...index.lines.flatMap((l) => l.kind === 'evidence' && !index.consumed.has(l.id) ? [index.rootOf(l.session)] : []), ...uncounted]);

  for (const root of roots) {
    if ((await creditRoot(config, index, root)).credited === null) return false;
  }

  return true;
}

/**
 * Forget the recalled-session and adoption-credit identities of the sessions no line of the log names. It runs before
 * retention, so a session whose last lines this pull drops is forgotten at the next one. A verdict written later for
 * such a session credits nothing (see {@link creditAdoptionVerdicts}).
 */
async function forgetUnnamedSessions(config: LocalConfig): Promise<void> {
  const votePath = path.join(getVotesDir(config), `${config.username}.yaml`);
  const named = new Set((await readRecallLog(config)).flatMap(sessionsOf));
  const { recalledSessions, adoptionCredits } = await readUserVotes(votePath);

  if ([...Object.keys(recalledSessions ?? {}), ...Object.keys(adoptionCredits ?? {})].every((session) => named.has(session))) return;
  await forgetSessionIdentities({ votePath, named });
}

/** The sessions a line names, any of which a reducer may count or credit from it. */
function sessionsOf(line: RecallLogLine): string[] {
  switch (line.kind) {
    case 'run': return line.session === null ? [] : [line.session];
    case 'claim':
    case 'evidence':
    case 'credit':
    case 'counted': return [line.session];
    case 'link': return [line.child, line.parent];
    case 'consumed': return [];
    default: {
      const unhandled: never = line;

      return unhandled;
    }
  }
}

/** What retention requires of a raw line: a kind and a time. The line itself is kept as written. */
const RetainedLineSchema = z.looseObject({ kind: z.string(), ts: z.string() });

/** A field of a retained line that retention reads as text, which a hand-edited line may lack. */
const LineTextSchema = z.string();

interface LogEntry {
  text: string;
  line: RecallLogLine;
  at: number;
}

/**
 * Retention of the recall log's raw lines at `now`, or null when it drops
 * none. It keeps lines newer than {@link RECALL_LOG_RETENTION_MS}, then drops
 * the oldest until {@link RECALL_LOG_MAX_LINES} remain. Neither drops pending
 * evidence younger than the adoption window, nor what it needs to vote: the
 * runs whose docs it opened within their window, their claims, the reads
 * already credited for them, and the links up from those sessions. Evidence
 * and its `consumed` lines go together, so a credited read never looks
 * pending again. A malformed line, or one without a time, is dropped.
 */
function retainedLines(raw: string[], now: number): string[] | null {
  const entries: LogEntry[] = [];

  for (const text of raw) {
    let json: JsonValue;

    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }

    const parsed = RetainedLineSchema.safeParse(json);

    if (!parsed.success) continue;
    const at = Date.parse(parsed.data.ts);

    if (!Number.isFinite(at)) continue;
    // SAFETY: appendRecallLines writes every line of this log from a RecallLogLine; its kind and time are checked
    // above, and retention parses the evidence id and session it reads before using them.
    entries.push({ text, line: parsed.data as typeof parsed.data & RecallLogLine, at });
  }

  // Units in file order: each evidence with its consumed lines, at the evidence's time and place; each other line alone.
  const units: LogEntry[][] = [];
  const unitOf = new Map<string, LogEntry[]>();

  for (const entry of entries) {
    if (entry.line.kind !== 'evidence' || !LineTextSchema.safeParse(entry.line.id).success || unitOf.has(entry.line.id)) continue;
    unitOf.set(entry.line.id, [entry]);
  }

  for (const entry of entries) {
    const { line } = entry;

    if (line.kind === 'consumed') {
      // A consumed line without its evidence marks nothing any more.
      unitOf.get(line.evidence)?.push(entry);
    } else if (line.kind === 'evidence' && unitOf.get(line.id)?.[0] === entry) {
      units.push(unitOf.get(line.id)!);
    } else if (line.kind !== 'evidence') {
      units.push([entry]);
    }
  }

  const aged = units.filter((unit) => now - unit[0].at < RECALL_LOG_RETENTION_MS);
  const kept = new Set(aged);
  const needed = neededForPending(aged.flat(), now);
  let count = aged.reduce((n, unit) => n + unit.length, 0);

  for (const unit of aged) {
    if (count <= RECALL_LOG_MAX_LINES) break;

    if (unit.some((entry) => needed.has(entry))) continue;
    kept.delete(unit);
    count -= unit.length;
  }

  const survivors = new Set([...kept].flat());

  if (survivors.size === raw.length) return null;

  return entries.flatMap((entry) => (survivors.has(entry) ? [entry.text] : []));
}

/**
 * The entries pending evidence younger than the adoption window still needs
 * to vote: itself, the runs whose docs it opened within their window, their
 * claims, the reads already credited for those runs (which stop a second
 * credit), and the links up from every session involved. It ignores
 * settlement, which a claim or link arriving later can change.
 */
function neededForPending(entries: LogEntry[], now: number): Set<LogEntry> {
  const consumed = new Set(entries.flatMap(({ line }) => line.kind === 'consumed' ? [line.evidence] : []));
  const evidence = entries.filter((e): e is LogEntry & { line: EvidenceLine } => e.line.kind === 'evidence');
  const pending = evidence.filter((e) => !consumed.has(e.line.id) && now - e.at < ADOPTION_WINDOW_MS);

  if (pending.length === 0) return new Set();
  const opens = (e: LogEntry & { line: EvidenceLine }, run: RunLine): boolean => inWindow(e.at, run) && docsOpened(e.line.path, run.docs).length > 0;

  const runs = entries.filter((r): r is LogEntry & { line: RunLine } => {
    const { line } = r;

    return line.kind === 'run' && Array.isArray(line.docs) && pending.some((e) => opens(e, line));
  });

  const runIds = new Set(runs.map((r) => r.line.run));
  const claims = entries.filter((c) => c.line.kind === 'claim' && runIds.has(c.line.run));
  const reads = evidence.filter((e) => runs.some((r) => opens(e, r.line)));
  const needed = new Set<LogEntry>([...pending, ...runs, ...claims, ...reads]);

  const sessions = new Set<string>();

  for (const { line } of needed) {
    if (line.kind !== 'run' && line.kind !== 'claim' && line.kind !== 'evidence') continue;
    const session = LineTextSchema.safeParse(line.session);

    if (session.success) sessions.add(session.data);
  }

  const links = entries.filter((l): l is LogEntry & { line: LinkLine } => l.line.kind === 'link');

  for (let grew = true; grew;) {
    grew = false;

    for (const link of links) {
      if (needed.has(link) || !sessions.has(link.line.child)) continue;
      needed.add(link);
      sessions.add(link.line.parent);
      grew = true;
    }
  }

  return needed;
}
