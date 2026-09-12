/**
 * Write direction for `repo.kind === 'server'`: push, contribute, remove and
 * usage reporting go straight to the management backend as change sets and
 * report events. No git, no branches, no MRs — the console shows the review.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getHandler } from './resources/index.js';
import { getUserVotesDir, type GlobalOptions, type LocalConfig, type ResourceItem, type ResourceType, type TeamaiConfig } from './types.js';
import { listFilesRecursive, pathExists, readFileSafe, readJson, writeJsonAtomic } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { log, spinner } from './utils/logger.js';
import { askSelection } from './utils/prompt.js';
import {
  changesetUrl, contributeLearning, listTeams, loadCredentials, loadSnapshot, nextSeq, reportEvents, sha256Hex,
  submitChangeset, uploadBlob, type ChangeOp, type ReportEvent, type ServerCredentials,
} from './server-repo.js';
import { ENTRY_FILE, type ServerSnapshot, type SnapshotEntry } from './server-format.js';

const KIND_OF_TYPE: Record<string, string> = { skills: 'skill', rules: 'rule', agents: 'agent', env: 'env', mcp: 'mcp', docs: 'doc' };

async function requireCreds(): Promise<ServerCredentials> {
  const creds = await loadCredentials();
  if (!creds) throw new Error('Not logged in to the team server. Run `teamai init --server <url>`.');
  return creds;
}

function findEntry(snap: ServerSnapshot | null, kind: string, name: string): SnapshotEntry | undefined {
  return snap?.resources.find((e) => e.kind === kind && e.name === name);
}

/**
 * Decide where an operation lands. Existing resources keep their level and
 * carry `expected_prev_version`; new ones go to the single bound project, or to
 * the project named by --project.
 */
async function placeOp(
  creds: ServerCredentials,
  snap: ServerSnapshot | null,
  op: ChangeOp,
  projectSlug?: string,
): Promise<ChangeOp> {
  const existing = findEntry(snap, op.kind, op.name);
  if (existing) {
    op.level = (existing.level as ChangeOp['level']) ?? 'org';
    if (existing.version) op.expected_prev_version = existing.version;
    if (op.level === 'project') {
      op.project_id = snap?.projects.find((p) => p.slug === existing.namespace)?.id;
    } else if (op.level === 'team') {
      op.team_id = (await listTeams(creds)).find((t) => t.slug === existing.namespace)?.id;
    }
    if (op.level !== 'org' && !op.project_id && !op.team_id) op.level = 'org'; // group-granted → its real level is org
    return op;
  }
  const projects = snap?.projects ?? [];
  if (projectSlug) {
    const p = projects.find((x) => x.slug === projectSlug);
    if (!p) throw new Error(`Project "${projectSlug}" is not bound to this directory (bound: ${projects.map((x) => x.slug).join(', ') || 'none'}).`);
    op.level = 'project';
    op.project_id = p.id;
  } else if (projects.length === 1) {
    op.level = 'project';
    op.project_id = projects[0].id;
  } else if (projects.length === 0) {
    op.level = 'org';
  } else {
    throw new Error(`${op.kind}/${op.name} is new and this directory follows several projects — pass --project <slug> (${projects.map((x) => x.slug).join(', ')}).`);
  }
  return op;
}

async function fileOps(creds: ServerCredentials, dir: string, rel: string[]): Promise<{ files: ChangeOp['files']; changed: boolean }> {
  const files: NonNullable<ChangeOp['files']> = [];
  for (const r of rel.sort()) {
    const content = await fs.promises.readFile(path.join(dir, ...r.split('/')));
    files.push({ path: r, ...(await uploadBlob(creds, content)) });
  }
  return { files, changed: files.length > 0 };
}

/**
 * Turn a scanned resource into a `put`, reading from its SOURCE (the AI-tool
 * directory). localPath is never mutated by push: it stays a faithful mirror of
 * the server, so the scanner keeps reporting the change as pending until the
 * change set is published and the next sync brings it back down.
 */
async function opForItem(creds: ServerCredentials, item: ResourceItem): Promise<ChangeOp | null> {
  const kind = KIND_OF_TYPE[item.type];
  if (!kind) return null;
  switch (item.type) {
    case 'skills': {
      const rel = (await listFilesRecursive(item.sourcePath)).filter((r) => !r.split('/').some((seg) => seg.startsWith('.')) && r !== 'CONTRIBUTORS');
      const { files } = await fileOps(creds, item.sourcePath, rel);
      return { op: 'put', level: 'org', kind, name: item.name, files };
    }
    case 'rules': {
      let content = await readFileSafe(item.sourcePath);
      if (content === null) throw new Error(`Cannot read rule source ${item.sourcePath}`);
      if (item.sourcePath.endsWith('.mdc')) {
        // Cursor keeps tool frontmatter in .mdc; push only the markdown body onto the team file.
        const { mergeCursorBodyIntoTeamMd } = await import('./resources/cursor-mdc.js');
        content = mergeCursorBodyIntoTeamMd(content, await readFileSafe(path.join(localPathOf(item), 'rules', `${item.name}.md`)));
      }
      return { op: 'put', level: 'org', kind, name: item.name, files: [{ path: ENTRY_FILE.rule, ...(await uploadBlob(creds, Buffer.from(content))) }] };
    }
    case 'agents': {
      const agent = item as ResourceItem & { mergedSpec?: unknown; skipReason?: string };
      if (agent.skipReason || !agent.mergedSpec) {
        log.warn(`[agents] skipped ${item.name}: ${agent.skipReason ?? 'could not build the team YAML spec'}`);
        return null;
      }
      const { serializeAgentYaml } = await import('./resources/agent-format.js');
      const content = serializeAgentYaml(agent.mergedSpec as Parameters<typeof serializeAgentYaml>[0]);
      return { op: 'put', level: 'org', kind, name: item.name, files: [{ path: ENTRY_FILE.agent, ...(await uploadBlob(creds, Buffer.from(content))) }] };
    }
    default:
      return null;
  }
}

let currentLocalPath = '';
function localPathOf(_item: ResourceItem): string {
  return currentLocalPath;
}

/**
 * env.yaml is one merged file locally but one resource per variable on the
 * server: diff each key against the last snapshot and emit a `put` per change.
 * Secret variables never carry a value — the local env.yaml only ever sees an
 * empty value for them, so they are skipped rather than pushed back as blank.
 */
async function envOps(creds: ServerCredentials, localPath: string, snap: ServerSnapshot | null): Promise<ChangeOp[]> {
  const raw = await readFileSafe(path.join(localPath, 'env', 'env.yaml'));
  if (!raw) return [];
  let parsed: { variables?: Array<{ key: string; value?: string; description?: string }> };
  try { parsed = YAML.parse(raw) ?? {}; } catch { return []; }
  const ops: ChangeOp[] = [];
  for (const v of parsed.variables ?? []) {
    if (!v.key || v.value === undefined || v.value === '') continue;
    const content = `value: ${YAML.stringify(v.value).trim()}\n${v.description ? `description: ${YAML.stringify(v.description).trim()}\n` : ''}`;
    const existing = findEntry(snap, 'env', v.key);
    const entry = existing?.files?.find((f) => f.path === ENTRY_FILE.env);
    if (entry && entry.sha256 === `sha256:${sha256Hex(content)}`) continue;
    ops.push({ op: 'put', level: 'org', kind: 'env', name: v.key, files: [{ path: ENTRY_FILE.env, ...(await uploadBlob(creds, Buffer.from(content))) }] });
  }
  return ops;
}

// ── push ─────────────────────────────────────────────────────

export async function pushServer(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
  options: GlobalOptions & { all?: boolean; project?: string; role?: string; skill?: string; fastTrack?: boolean },
): Promise<void> {
  const creds = await requireCreds();
  const localPath = localConfig.repo.localPath;
  const snap = await loadSnapshot(localPath);

  const spin = spinner('Scanning local resources...').start();
  const types: ResourceType[] = ['skills', 'rules', 'env', 'agents'];
  const allItems: ResourceItem[] = [];
  for (const type of types) {
    const items = await getHandler(type).scanLocalForPush(teamConfig, localConfig);
    allItems.push(...items);
  }
  spin.stop();

  if (options.skill) {
    const name = path.basename(options.skill.replace(/[/\\]+$/, ''));
    const match = allItems.find((i) => i.type === 'skills' && (i.name === name || path.resolve(i.sourcePath) === path.resolve(options.skill!)));
    if (!match) {
      log.error(`Skill not found among local changes: ${options.skill}`);
      process.exitCode = 1;
      return;
    }
    allItems.length = 0;
    allItems.push(match);
  }
  if (allItems.length === 0) {
    log.info('No new or modified resources to push');
    return;
  }

  console.log('');
  console.log(`Found ${allItems.length} resource(s) to push:`);
  allItems.forEach((item, i) => {
    console.log(`  ${`${i + 1}.`.padStart(4)} [${item.type}] ${item.name} (${item.status === 'modified' ? 'modified' : 'new'})`);
    console.log(`       from: ${item.sourcePath}`);
  });
  console.log('');
  if (options.dryRun) {
    log.info('Dry run — no changes made');
    return;
  }

  let selected: ResourceItem[];
  if (options.all || options.silent) {
    selected = [...allItems];
  } else {
    const prompt = allItems.length === 1 ? 'Push this resource? [1/all/none] (default: all): ' : `Select items to push [1-${allItems.length}, or "all"] (default: all): `;
    const idx = await askSelection(prompt, allItems.length, true);
    if (!idx || idx.length === 0) { log.info('Cancelled'); return; }
    selected = idx.map((i) => allItems[i]);
  }

  const pushSpin = spinner('Uploading to the team server...').start();
  try {
    currentLocalPath = localPath;
    const ops: ChangeOp[] = [];
    for (const item of selected) {
      if (item.type === 'env') continue;
      const op = await opForItem(creds, item);
      if (op) ops.push(await placeOp(creds, snap, op, options.project));
    }
    if (selected.some((i) => i.type === 'env')) {
      for (const op of await envOps(creds, localPath, snap)) ops.push(await placeOp(creds, snap, op, options.project));
    }
    if (ops.length === 0) {
      pushSpin.succeed('Nothing to push (already up to date on the server)');
      return;
    }
    const title = ops.length === 1 ? `${ops[0].op} ${ops[0].kind}/${ops[0].name}` : `Push ${ops.length} resource(s) from ${localConfig.username}`;
    const cs = await submitChangeset(creds, {
      title, ops, fastTrack: options.fastTrack,
      description: ops.map((o) => `- [${o.kind}] ${o.name}`).join('\n'),
    });
    const verb = cs.state === 'published' ? 'Published' : 'Submitted for review';
    pushSpin.succeed(`${verb}: ${ops.length} resource(s) → ${changesetUrl(creds, cs.id)}`);
  } catch (e) {
    pushSpin.fail(`Push failed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// ── contribute ───────────────────────────────────────────────

export async function contributeServer(
  localConfig: LocalConfig,
  content: string,
  options: { title?: string; sessionId?: string },
): Promise<void> {
  const creds = await requireCreds();
  const snap = await loadSnapshot(localConfig.repo.localPath);
  const title = options.title?.trim() || firstHeading(content) || 'Session notes';
  const projectId = snap?.projects.length === 1 ? snap.projects[0].id : undefined;
  const spin = spinner('Contributing session knowledge...').start();
  try {
    const cs = await contributeLearning(creds, { title, content, projectId });
    const name = cs.ops?.[0]?.name;
    // Make it recallable right away instead of waiting for the next sync.
    if (name) {
      const dest = path.join(localConfig.repo.localPath, 'learnings', `${name}.md`);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, content, 'utf8');
    }
    spin.succeed(cs.state === 'published' ? `Contributed: learnings/${name}.md` : `Submitted for review: ${changesetUrl(creds, cs.id)}`);
    if (options.sessionId) {
      const { markContributed } = await import('./contribute-check.js');
      await markContributed(options.sessionId);
    }
  } catch (e) {
    const msg = (e as Error).message;
    spin.fail(msg.includes('SECRET_DETECTED') ? `Rejected: the content looks like it contains a secret — remove it and retry. (${msg})` : `Contribution failed: ${msg}`);
    process.exitCode = 1;
  }
}

function sessionDurationMs(s: { startedAt?: string; lastActivity?: string; stoppedAt?: string } | undefined): number {
  if (!s?.startedAt) return 0;
  const end = Date.parse(s.stoppedAt || s.lastActivity || '');
  const start = Date.parse(s.startedAt);
  return Number.isFinite(end) && Number.isFinite(start) && end > start ? end - start : 0;
}

function firstHeading(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// ── remove ───────────────────────────────────────────────────

export async function removeServer(
  localConfig: LocalConfig,
  type: string,
  names: string[],
  options: GlobalOptions & { fastTrack?: boolean },
): Promise<void> {
  const creds = await requireCreds();
  const snap = await loadSnapshot(localConfig.repo.localPath);
  const kind = KIND_OF_TYPE[type];
  const ops: ChangeOp[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (!findEntry(snap, kind, name)) { missing.push(name); continue; }
    ops.push(await placeOp(creds, snap, { op: 'delete', level: 'org', kind, name }));
  }
  if (missing.length) log.warn(`Not on the server (skipping): ${missing.join(', ')}`);
  if (ops.length === 0) { log.error('No matching resources found to remove'); return; }
  console.log(`Will submit removal of ${ops.length} ${type}: ${ops.map((o) => o.name).join(', ')}`);
  if (options.dryRun) { log.info('Dry run — no changes made'); return; }
  const cs = await submitChangeset(creds, { title: `Remove ${ops.length} ${type} (${localConfig.username})`, ops, fastTrack: options.fastTrack });
  log.success(cs.state === 'published' ? 'Removed. They disappear from every machine on its next sync.' : `Removal submitted for review: ${changesetUrl(creds, cs.id)}`);
}

// ── reporting ────────────────────────────────────────────────

interface ReportedSnapshot { sessions: Record<string, { prompts: number; interrupt: number; toolReject: number; correction: number }>; daily: Record<string, unknown> }

function reportedPath(): string {
  return path.join(getUserHome(), '.teamai', 'server-reported.json');
}

/**
 * Report skill usage, votes, per-session summaries and daily usage to the
 * server. Idempotent: skill events are truncated by the caller after success,
 * votes carry their own pending deltas, sessions/days are tracked in a local
 * "already reported" snapshot so a re-run never double-counts.
 */
export async function reportToServer(localConfig: LocalConfig, opts: { projectRoot?: string; excludeProjectRoots?: string[] } = {}): Promise<{ sent: number }> {
  const creds = await requireCreds();
  const snap = await loadSnapshot(localConfig.repo.localPath);
  const events: Array<Omit<ReportEvent, 'seq'>> = [];
  const now = new Date().toISOString();

  // skill usage
  const { readUsageEvents } = await import('./usage-tracker.js');
  const { aggregateUsage } = await import('./stats.js');
  const usage = await readUsageEvents();
  for (const s of aggregateUsage(usage)) {
    events.push({ event_id: `skill:${s.name}:${s.lastUsed.toISOString()}:${s.count}`, type: 'skill_usage', occurred_at: s.lastUsed.toISOString(), payload: { skill: s.name, count: s.count } });
  }

  // votes: local pending deltas keyed by learning name → server resource id
  const { loadUserVotes, saveUserVotes } = await import('./votes.js');
  const votePath = path.join(getUserVotesDir(), `${localConfig.username}.yaml`);
  const votes = await loadUserVotes(votePath);
  const voteIds: string[] = [];
  for (const [docId, d] of Object.entries(votes.deltas ?? {})) {
    const entry = snap?.resources.find((e) => e.kind === 'learning' && (e.name === docId || `${e.name}.md` === docId));
    const bundleId = (entry as SnapshotEntry & { resource_id?: string } | undefined)?.resource_id;
    if (!bundleId) continue;
    voteIds.push(docId);
    events.push({ event_id: `vote:${docId}:${now}`, type: 'vote_delta', occurred_at: now, payload: { bundle_id: bundleId, recalled_delta: d.recalled_delta, upvoted_delta: d.upvoted_delta } });
  }

  // sessions + daily
  const reported = (await readJson<ReportedSnapshot>(reportedPath())) ?? { sessions: {}, daily: {} };
  const { readEvents, aggregateSessionMetrics, rebuildSessions } = await import('./dashboard-collector.js');
  const { filterEventsByScope } = await import('./team-push.js');
  const { aggregateDailySessions, computeDailyStatsDelta } = await import('./session-trends.js');
  const dashboard = filterEventsByScope(await readEvents(), opts);
  const metrics = aggregateSessionMetrics(dashboard);
  const sessions = rebuildSessions(dashboard);
  const nextSessions = { ...reported.sessions };
  for (const [sid, m] of metrics) {
    const prev = reported.sessions[sid];
    if (prev && prev.prompts === m.prompts && prev.interrupt === m.interrupt && prev.toolReject === m.toolReject && prev.correction === m.correction) continue;
    const s = sessions.find((x) => x.sessionId === sid);
    const toolTotal = dashboard.filter((e) => e.sessionId === sid && e.type === 'tool_use').length;
    events.push({
      event_id: `session:${sid}:${m.prompts}:${m.interrupt + m.toolReject + m.correction}`, type: 'session_summary', occurred_at: now,
      payload: {
        session_id: sid, tool: s?.tool ?? dashboard.find((e) => e.sessionId === sid)?.tool ?? '',
        started_at: s?.startedAt ?? dashboard.find((e) => e.sessionId === sid)?.timestamp,
        duration_ms: sessionDurationMs(s), prompt_turns: m.prompts, tool_total: toolTotal,
        interventions: { interrupt: m.interrupt, tool_reject: m.toolReject, tool_error: m.correction },
        tokens: { input: m.tokens?.input ?? 0, output: m.tokens?.output ?? 0, cache_read: m.tokens?.cacheRead ?? 0, cache_write: m.tokens?.cacheCreation ?? 0 },
      },
    });
    nextSessions[sid] = { prompts: m.prompts, interrupt: m.interrupt, toolReject: m.toolReject, correction: m.correction };
  }
  const { delta: daily, nextReported: nextDaily } = computeDailyStatsDelta(aggregateDailySessions(dashboard), reported.daily as never);
  for (const [day, d] of Object.entries(daily)) {
    if (!d.sessionsEnded && !d.promptTurns && !d.durationMs) continue;
    events.push({
      event_id: `daily:${day}:${now}`, type: 'usage_daily', occurred_at: now,
      payload: {
        day, sessions_ended: d.sessionsEnded, sessions_succeeded: d.sessionsSucceeded, prompt_turns: d.promptTurns, duration_ms: d.durationMs,
        sessions_corrected: d.sessionsCorrected, priced_requests: d.pricedRequests, cost_micros: d.costMicros,
        cache_read_tokens: d.cacheReadTokens, cache_eligible_input_tokens: d.cacheEligibleInputTokens,
      },
    });
  }

  if (events.length === 0) return { sent: 0 };
  const first = await nextSeq(events.length);
  const batch: ReportEvent[] = events.map((e, i) => ({ ...e, seq: first + i }));
  await reportEvents(creds, batch);

  // advance local bookkeeping only after the server accepted the batch
  if (voteIds.length) {
    for (const id of voteIds) delete votes.deltas[id];
    await saveUserVotes(votePath, votes);
  }
  await writeJsonAtomic(reportedPath(), { sessions: nextSessions, daily: { ...reported.daily, ...nextDaily } });
  return { sent: batch.length };
}
