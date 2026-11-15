/**
 * The recall log of one scope (#884): each `teamai recall` run, and the tool
 * calls that confirm a run or read a file under the knowledge roots, one JSON
 * line each. The adoption reducer joins them at Stop, SubagentStop and `pull`,
 * and only `pull` prunes the log (drainRecallLog).
 *
 *   run       recall searched: the session from the environment, its caller and the docs it returned
 *   claim     the PostToolUse of a shell call that printed a run id: its actor, and whether it ran the recall itself
 *   evidence  a PostToolUse read of a file under the knowledge roots, or a search that showed its lines, by its actor: its path and status, never its command or output
 *   link      a child session a subagent ran in, and the session that started it (OpenCode's task tool)
 *   consumed  evidence that has been credited, so it never votes again
 *   credit    a root session's credit of a recalled doc, by a read (tool) or an adoption label (judge): the first for a
 *             session and doc stands; the votes file deduplicates the effect durably (#1391). A judge credit is written before its votes
 *             and again once they are, so a busy votes file is retried at pull
 *   counted   a root session counted once in a doc's recalled sessions (#1391)
 *
 * It never holds a query, prompt, tool output or file content. It is local and
 * owner-only, and lives in `dashboard/`, which every data home's `.gitignore`
 * already ignores, so no new ignore entry is needed for it or its side files.
 */
import path from 'node:path';
import { z } from 'zod';

import { appendJsonlBatch, readJsonl } from './utils/jsonl-store.js';
import { type JsonlRecord } from '@teamai/shared/json';
import { getDataHome, getTeamaiHomeDir } from './types.js';
import type { KnowledgeType, LocalConfig } from './types.js';
import type { ResourceRelationType } from './resource-relations.js';

/**
 * One `Related:` line's target, as a run records it for a doc (#1562):
 * exactly what recall printed, `direction` naming the arrow.
 */
export interface RelatedRef {
  relation: ResourceRelationType;
  /** `out` for a printed `→` line, `in` for `←`. */
  direction: 'out' | 'in';
  /** The resolved path the line printed. */
  path: string;
}

/** A doc a run returned, as recall printed it. */
export interface RecalledDoc {
  /** The id its votes are kept under. */
  key: string;
  type?: KnowledgeType;
  /** The scope whose index returned it. */
  scope: 'project' | 'user';
  /** The `File:` path recall printed. */
  path: string;
  score: number;
  /** False for an inherited user-scope doc while a project is active: it stays read-only. */
  eligible: boolean;
  /** The `Related:` targets the run printed for this doc (#1562); absent when none. */
  related?: RelatedRef[];
}

/**
 * Who made a tool call: a session, and within it the subagent the hook fired
 * in. No `agentId` means the session's main agent.
 */
export interface Actor {
  session: string;
  /** The hook's `agent_id`: present only inside a subagent. */
  agentId?: string;
  /** The hook's `agent_type`: for a custom subagent, its agent file's `name`. */
  agentType?: string;
}

export interface RunLine {
  kind: 'run';
  ts: string;
  run: string;
  /**
   * The agent session recall read from its environment, or null when none was
   * set. The environment names no subagent, so the run's own actor is that
   * session's main agent; its claim names the actor that ran it.
   */
  session: string | null;
  /** The agent family whose variable named `session`, e.g. `claude` or `codex`. */
  agent?: string;
  /** `env` when the environment named `session`, `none` when it named none. A hook's confirmation is a claim. */
  via: 'env' | 'none';
  /**
   * True when the environment held a single session id. A run settles by its
   * first valid claim, or else by `session` only when this is true.
   */
  unambiguous: boolean | undefined;
  /** `--caller`: `teamai-recall` when the recall subagent ran it. */
  caller?: string;
  docs: RecalledDoc[];
}

export interface ClaimLine extends Actor {
  kind: 'claim';
  ts: string;
  run: string;
  /**
   * Whether the shell command itself ran `teamai recall`, rather than only
   * printing a recall's output. Only a direct claim can settle its run.
   */
  direct: boolean | undefined;
  /** The agent whose hook sent the claim: its dispatch tool id. */
  agent?: string;
}

export interface EvidenceLine extends Actor {
  kind: 'evidence';
  ts: string;
  id: string;
  /** Absolute once resolved against the call's cwd; relative when the call had no cwd. */
  path: string;
  /** A failed read is never recorded. `unknown` when the agent reports no status, as Codex's shell. */
  status: 'success' | 'unknown';
  /** True when the read was the call's only command, not the head of a pipeline. */
  simple: boolean | undefined;
}

/**
 * A subagent that ran in a session of its own: the reducer counts the child's
 * runs and reads as the parent's, while the child stays their actor.
 */
export interface LinkLine {
  kind: 'link';
  ts: string;
  child: string;
  parent: string;
}

export interface ConsumedLine {
  kind: 'consumed';
  ts: string;
  /** The id of the evidence that was credited. */
  evidence: string;
}

/**
 * A root session's credit of a recalled doc (#1391): a read that opened it (`tool`), or an adoption label (`judge`),
 * whose `adopted` says whether it upvoted. `votes` says whether the votes file holds it yet: a judge credit claims the
 * session and doc as `pending` before it writes the votes, and its `written` line follows, under the same `id`.
 */
export interface CreditLine {
  kind: 'credit';
  ts: string;
  id: string;
  session: string;
  doc: string;
  source: 'tool' | 'judge';
  adopted: boolean;
  votes: 'pending' | 'written';
}

/** A root session counted once in a doc's `recalled_session_count` (#1391). */
export interface CountedLine {
  kind: 'counted';
  ts: string;
  session: string;
  doc: string;
}

export type RecallLogLine = RunLine | ClaimLine | EvidenceLine | LinkLine | ConsumedLine | CreditLine | CountedLine;

const RecallLogKindSchema = z.enum(['run', 'claim', 'evidence', 'link', 'consumed', 'credit', 'counted']);

/**
 * The recall log of the scope `config` names, beside its votes: a historical
 * project-scoped config with no project root records into the user scope's, as
 * its votes do (getVotesDir).
 */
export function recallLogPath(config: LocalConfig): string {
  const home = !config.dataHome && config.scope === 'project' && !config.projectRoot
    ? getTeamaiHomeDir()
    : getDataHome(config);

  return path.join(home, 'dashboard', 'recall.jsonl');
}

/** Append one line. Throws on I/O errors; the caller decides what a lost line costs. */
export async function appendRecallLine(config: LocalConfig, line: RecallLogLine): Promise<void> {
  await appendRecallLines(config, [line]);
}

/** Append lines in one write under one lock, so a hook makes at most one write per call. Throws on I/O errors. */
export async function appendRecallLines(config: LocalConfig, lines: RecallLogLine[]): Promise<void> {
  await appendJsonlBatch(recallLogPath(config), lines);
}

/** Every line of the scope's log, those a busy lock left in side records included. */
export async function readRecallLog(config: LocalConfig): Promise<RecallLogLine[]> {
  const records = await readJsonl(recallLogPath(config));

  return records.filter((r): r is RecallLogLine & JsonlRecord => RecallLogKindSchema.safeParse(r.kind).success);
}
