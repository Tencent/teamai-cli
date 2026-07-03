/**
 * Agent status reporter (issue #1, 方案二) — hooks-driven online reporting.
 *
 * Three interfaces (iWiki §5.A): report / sync / ack.
 *   - report (SessionStart only): upsert local info + installed skill list.
 *   - sync   (SessionStart + UserPromptSubmit): report status + pull commands.
 *     commands drive install/update (pull) + uninstall (delete) of skills.
 *   - ack    (per command): success | failed (terminal, no retry).
 *
 * Endpoint paths are NOT hard-coded — they live in an internal mapping that
 * defaults to the iWiki/clawpro contract and can be overridden via env
 * (per reviewer note "接口名不一定写死,内部有个映射关系就好").
 *
 * The whole flow is best-effort and MUST NOT block the agent: failures are
 * swallowed and unsent payloads are buffered to an offline queue for next time.
 */

import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadTeamConfig } from './config.js';
import { resolveApiKey } from './api-key.js';
import { executeSkillCommand, type SkillCommand } from './skill-command.js';
import {
  listDirs,
  pathExists,
  readFileSafe,
  ensureDir,
  writeFile,
  remove,
} from './utils/fs.js';
import { resolveBaseDir, type LocalConfig, type TeamaiConfig } from './types.js';
import { getMachineId, deriveLocalAgentId } from './machine-id.js';
import { log } from './utils/logger.js';
import { getAgentVersion } from './agent-version.js';

// ─── Endpoint mapping (internal, overridable) ───────────────

export interface EndpointMap {
  report: string;
  sync: string;
  /** ack endpoint — the command id travels in the request body (id: int). */
  ack: string;
}

/** Default contract paths (clawpro backend, post v1-removal). */
const DEFAULT_ENDPOINTS: EndpointMap = {
  report: '/api/local-agent/report',
  sync: '/api/local-agent/sync',
  ack: '/api/local-agent/commands/ack',
};

/**
 * Resolve the endpoint map. Optional env override TEAMAI_REPORT_PATHS is a JSON
 * object `{ report, sync, ack }` with plain path strings.
 */
export function resolveEndpoints(): EndpointMap {
  const raw = process.env.TEAMAI_REPORT_PATHS;
  if (!raw) return DEFAULT_ENDPOINTS;
  try {
    const parsed = JSON.parse(raw) as { report?: string; sync?: string; ack?: string };
    return {
      report: parsed.report ?? DEFAULT_ENDPOINTS.report,
      sync: parsed.sync ?? DEFAULT_ENDPOINTS.sync,
      ack: parsed.ack ?? DEFAULT_ENDPOINTS.ack,
    };
  } catch {
    return DEFAULT_ENDPOINTS;
  }
}

// ─── Reportable agents (phase 1: workbuddy / codebuddy) ─────

/**
 * Agents that report in phase 1. Overridable via TEAMAI_REPORT_AGENTS
 * (comma-separated) so future phases / tests can widen the set.
 */
export function getReportableAgents(): Set<string> {
  const raw = process.env.TEAMAI_REPORT_AGENTS;
  if (raw) return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return new Set(['workbuddy', 'codebuddy']);
}

// ─── Endpoint resolution ────────────────────────────────────

/**
 * Resolve the reporting base URL. Shares the HTTP team-repo endpoint when the
 * repo is an http source; otherwise falls back to env TEAMAI_REPORT_ENDPOINT.
 * Returns null when not configured (opt-in: no endpoint ⇒ no reporting).
 */
export function resolveReportEndpoint(localConfig: LocalConfig): string | null {
  const repo = localConfig.repo as { kind?: string; url?: string };
  if (repo.kind === 'http' && repo.url) return repo.url.replace(/\/$/, '');
  const fromEnv = process.env.TEAMAI_REPORT_ENDPOINT;
  return fromEnv ? fromEnv.replace(/\/$/, '') : null;
}

// ─── Skill scanning ─────────────────────────────────────────

export interface ReportedSkill {
  slug: string;
  version: string;
  display_name: string;
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;

async function readSkillMeta(skillMdPath: string): Promise<{ name: string; version: string }> {
  const content = await readFileSafe(skillMdPath);
  if (!content) return { name: '', version: '' };
  const fm = content.match(FRONTMATTER_REGEX);
  if (!fm) return { name: '', version: '' };
  try {
    const parsed = YAML.parse(fm[1]) as Record<string, unknown> | null;
    const name = typeof parsed?.name === 'string' ? parsed.name : '';
    const version = parsed?.version != null ? String(parsed.version) : '';
    return { name, version };
  } catch {
    return { name: '', version: '' };
  }
}

/**
 * Scan an agent's skills directory and return every installed skill.
 */
export async function scanReportableSkills(skillsDir: string): Promise<ReportedSkill[]> {
  if (!(await pathExists(skillsDir))) return [];
  const dirs = (await listDirs(skillsDir)).filter((slug) => !slug.startsWith('.'));
  const skills = await Promise.all(
    dirs.map(async (slug): Promise<ReportedSkill | null> => {
      const skillMd = path.join(skillsDir, slug, 'SKILL.md');
      if (!(await pathExists(skillMd))) return null;
      const meta = await readSkillMeta(skillMd);
      return { slug, version: meta.version, display_name: meta.name || slug };
    }),
  );
  return skills
    .filter((s): s is ReportedSkill => s !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// ─── Offline queue ──────────────────────────────────────────

function queuePath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'reporter', 'queue.jsonl');
}

interface QueuedRequest {
  url: string;
  body: unknown;
}

async function enqueue(req: QueuedRequest): Promise<void> {
  const p = queuePath();
  await ensureDir(path.dirname(p));
  const fse = await import('fs-extra');
  await fse.default.appendFile(p, JSON.stringify(req) + '\n', 'utf-8');
}

/** Replay buffered requests; drop those that succeed, keep the rest. */
async function flushQueue(apiKey: string): Promise<void> {
  const p = queuePath();
  const raw = await readFileSafe(p);
  if (!raw) return;
  const lines = raw.split('\n').filter((l) => l.trim());
  const remaining: string[] = [];
  for (const line of lines) {
    let req: QueuedRequest;
    try {
      req = JSON.parse(line);
    } catch {
      continue; // drop malformed
    }
    try {
      await postJson(req.url, apiKey, req.body);
    } catch {
      remaining.push(line);
    }
  }
  if (remaining.length === 0) {
    await remove(p);
  } else {
    await writeFile(p, remaining.join('\n') + '\n');
  }
}

// ─── HTTP ───────────────────────────────────────────────────

async function postJson(url: string, apiKey: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ─── Main entry ─────────────────────────────────────────────

export interface StatusReportOptions {
  stdin: Record<string, unknown>;
  tool: string;
  phase: 'session' | 'message';
  /** Override config loading (tests). */
  localConfig?: LocalConfig | null;
  teamConfig?: TeamaiConfig | null;
}

/**
 * Run one reporter cycle. Never throws — all failures degrade silently and
 * unsent payloads land in the offline queue.
 */
export async function runStatusReport(opts: StatusReportOptions): Promise<void> {
  try {
    await runStatusReportInner(opts);
  } catch (e) {
    log.debug(`[status-report] swallowed error: ${(e as Error).message}`);
  }
}

async function runStatusReportInner(opts: StatusReportOptions): Promise<void> {
  const agentType = opts.tool;
  if (!getReportableAgents().has(agentType)) {
    log.debug(`[status-report] agent "${agentType}" not in reportable set, skipping`);
    return;
  }

  const localConfig = opts.localConfig ?? (await loadLocalConfigFromStdin(opts.stdin));
  if (!localConfig) return;

  const endpoint = resolveReportEndpoint(localConfig);
  const apiKey = resolveApiKey();
  if (!endpoint || !apiKey) {
    log.debug('[status-report] no endpoint/apiKey configured, skipping (opt-in)');
    return;
  }

  const teamConfig =
    opts.teamConfig ?? (await loadTeamConfig(localConfig.repo.localPath));
  if (!teamConfig) return;

  const toolPath = teamConfig.toolPaths[agentType];
  const skillsRel = toolPath?.skills;
  if (!skillsRel) {
    log.debug(`[status-report] no skills path for agent "${agentType}"`);
    return;
  }

  const baseDir = resolveBaseDir(localConfig);
  const skillsDir = path.join(baseDir, skillsRel);
  const installPath = path.join(baseDir, path.dirname(skillsRel));
  const machineId = getMachineId();
  const localAgentId = deriveLocalAgentId(agentType, machineId, installPath);
  const endpoints = resolveEndpoints();

  // Make every invocation visible: which agent/phase/endpoint actually ran.
  // Without this there is no trace that a UserPromptSubmit/SessionStart hook
  // fired at all, so "sync never triggered" is impossible to diagnose.
  log.debug(`[status-report] run: agent=${agentType} phase=${opts.phase} id=${localAgentId} endpoint=${endpoint}`);

  // Best-effort: replay anything stuck in the offline queue first.
  await flushQueue(apiKey).catch(() => {});

  // ① report — SessionStart only.
  if (opts.phase === 'session') {
    const skills = await scanReportableSkills(skillsDir);
    const agentVersion = await getAgentVersion(agentType);
    const reportBody = {
      local_agent_id: localAgentId,
      agent_type: agentType,
      agent_version: agentVersion,
      host_name: os.hostname(),
      os: `${process.platform}/${process.arch}`,
      started_at: new Date().toISOString(),
      skills,
    };
    await sendOrQueue(`${endpoint}${endpoints.report}`, apiKey, reportBody, 'report');
  }

  // ② sync — both phases. Returns commands to execute.
  const syncBody = {
    local_agent_id: localAgentId,
    agent_type: agentType,
    status: 'running',
  };
  let syncResp: unknown;
  try {
    syncResp = await postJson(`${endpoint}${endpoints.sync}`, apiKey, syncBody);
  } catch (e) {
    log.debug(`[status-report] sync FAILED (queued, phase=${opts.phase}): ${(e as Error).message}`);
    await enqueue({ url: `${endpoint}${endpoints.sync}`, body: syncBody });
    return; // no commands to act on
  }

  const commands = extractCommands(syncResp);
  log.debug(`[status-report] sync OK (phase=${opts.phase}): ${commands.length} command(s)`);
  for (const cmd of commands) {
    const label = `${cmd.type} ${cmd.skill_slug}@${cmd.skill_version || '?'}`;
    // Log what the server told us to do (incl. the signed download_url) so a
    // failed install is diagnosable: you can see exactly what was fetched.
    log.debug(`[status-report] command: ${label}${cmd.download_url ? ` url=${cmd.download_url}` : ''}`);
    // ③ execute + ack each command (terminal — no retry).
    let status: 'success' | 'failed' = 'success';
    let error = '';
    try {
      await executeSkillCommand(cmd, skillsDir);
      log.debug(`[status-report] ${label} → ${skillsDir} OK`);
    } catch (e) {
      status = 'failed';
      error = (e as Error).message;
      log.error(`[status-report] ${label} FAILED: ${error}`);
    }
    if (cmd.id != null) {
      const ackBody = { id: cmd.id, status, error };
      await sendOrQueue(`${endpoint}${endpoints.ack}`, apiKey, ackBody, `ack#${cmd.id}(${status})`);
    }
  }
}

async function sendOrQueue(url: string, apiKey: string, body: unknown, label: string): Promise<void> {
  try {
    await postJson(url, apiKey, body);
    log.debug(`[status-report] ${label} OK`);
  } catch (e) {
    log.debug(`[status-report] ${label} FAILED (queued): ${(e as Error).message}`);
    await enqueue({ url, body });
  }
}

function extractCommands(resp: unknown): SkillCommand[] {
  if (!resp || typeof resp !== 'object') return [];
  const arr = (resp as { commands?: unknown }).commands;
  if (!Array.isArray(arr)) return [];
  const out: SkillCommand[] = [];
  for (const c of arr) {
    if (c && typeof c === 'object' && typeof (c as SkillCommand).skill_slug === 'string') {
      out.push(c as SkillCommand);
    }
  }
  return out;
}

/**
 * Load the local config for the scope implied by the hook's cwd. Project scope
 * is preferred when the cwd has a project-scope teamai config; otherwise user.
 */
async function loadLocalConfigFromStdin(stdin: Record<string, unknown>): Promise<LocalConfig | null> {
  const { detectProjectConfig, loadLocalConfigForScope } = await import('./config.js');
  const cwd = typeof stdin.cwd === 'string' ? stdin.cwd : undefined;
  if (cwd) {
    const projectConfig = await detectProjectConfig(cwd);
    if (projectConfig) return projectConfig;
  }
  return loadLocalConfigForScope('user');
}
