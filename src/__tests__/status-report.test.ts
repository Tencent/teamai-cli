import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import {
  resolveReportEndpoint,
  resolveEndpoints,
  getReportableAgents,
  scanReportableSkills,
  runStatusReport,
} from '../status-report.js';
import { startMockServer, type MockServerHandle } from './helpers/mock-server.js';
import type { LocalConfig } from '../types.js';

let tmpDir: string;
let originalHome: string;
let server: MockServerHandle | undefined;
const API_KEY = 'test-key';
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['TEAMAI_REPORT_ENDPOINT', 'TEAMAI_REPORT_AGENTS', 'TEAMAI_API_TOKEN', 'TEAMAI_API_KEY', 'TEAMAI_REPORT_PATHS'];

function setupHome(): void {
  // Local config (user scope, git-style repo — reporting endpoint comes from env).
  const repoPath = path.join(tmpDir, '.teamai', 'team-repo');
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, 'teamai.yaml'),
    YAML.stringify({ team: 'mock', repo: 'http://x', toolPaths: { codebuddy: { skills: '.codebuddy/skills' } } }),
  );
  const config = {
    repo: { localPath: repoPath, remote: 'http://x' },
    username: 'tester',
    scope: 'user',
    additionalRoles: [],
  };
  fs.mkdirSync(path.join(tmpDir, '.teamai'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.teamai', 'config.yaml'), YAML.stringify(config));
  fs.writeFileSync(path.join(tmpDir, '.teamai', 'apikey'), API_KEY);

  // A user-installed (local) skill.
  const skillDir = path.join(tmpDir, '.codebuddy', 'skills', 'mylocal');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: mylocal\nversion: 2.0.0\n---\nbody');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-report-test-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  process.env.HOME = originalHome;
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── pure helpers ───────────────────────────────────────

describe('resolveEndpoints', () => {
  it('defaults to the clawpro contract paths (no v1)', () => {
    const ep = resolveEndpoints();
    expect(ep.report).toBe('/api/local-agent/report');
    expect(ep.sync).toBe('/api/local-agent/sync');
    expect(ep.ack).toBe('/api/local-agent/commands/ack');
  });

  it('honors a TEAMAI_REPORT_PATHS override (interface names not hard-coded)', () => {
    process.env.TEAMAI_REPORT_PATHS = JSON.stringify({
      report: '/r',
      sync: '/s',
      ack: '/c/done',
    });
    const ep = resolveEndpoints();
    expect(ep.report).toBe('/r');
    expect(ep.sync).toBe('/s');
    expect(ep.ack).toBe('/c/done');
  });
});

describe('getReportableAgents', () => {
  it('defaults to workbuddy + codebuddy only (phase 1)', () => {
    const set = getReportableAgents();
    expect(set.has('codebuddy')).toBe(true);
    expect(set.has('workbuddy')).toBe(true);
    expect(set.has('claude')).toBe(false);
  });
});

describe('resolveReportEndpoint', () => {
  it('uses repo.url for http kind', () => {
    const cfg = { repo: { localPath: '/x', remote: 'u', kind: 'http', url: 'https://h.com/' } } as unknown as LocalConfig;
    expect(resolveReportEndpoint(cfg)).toBe('https://h.com');
  });
  it('falls back to env for git kind, null when unset', () => {
    const cfg = { repo: { localPath: '/x', remote: 'u' } } as unknown as LocalConfig;
    expect(resolveReportEndpoint(cfg)).toBeNull();
    process.env.TEAMAI_REPORT_ENDPOINT = 'https://e.com/';
    expect(resolveReportEndpoint(cfg)).toBe('https://e.com');
  });
});

describe('scanReportableSkills', () => {
  it('lists installed skills from the agent skills dir', async () => {
    setupHome();
    const skillsDir = path.join(tmpDir, '.codebuddy', 'skills');
    const skills = await scanReportableSkills(skillsDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ slug: 'mylocal', version: '2.0.0', display_name: 'mylocal' });
    expect(skills[0]).not.toHaveProperty('source');
  });
});

// ─── e2e against the local mock server ──────────────────

describe('runStatusReport (session phase)', () => {
  it('reports installed skills (local) and syncs', async () => {
    setupHome();
    server = await startMockServer({ apiKey: API_KEY });
    process.env.TEAMAI_REPORT_ENDPOINT = server.url;

    await runStatusReport({ stdin: {}, tool: 'codebuddy', phase: 'session' });

    expect(server.reports).toHaveLength(1);
    const report = server.reports[0] as { agent_type: string; skills: Array<{ slug: string }> };
    expect(report.agent_type).toBe('codebuddy');
    expect(report.skills.find((s) => s.slug === 'mylocal')).toBeTruthy();
    expect(JSON.stringify(report)).not.toContain('"source"');
    // No install_path / machine_id leaked in the payload (privacy boundary).
    expect(JSON.stringify(report)).not.toContain('install_path');
    expect(JSON.stringify(report)).not.toContain('machine_id');
    expect(server.syncs).toHaveLength(1);
  });

  it('executes an install command from sync and acks success', async () => {
    setupHome();
    server = await startMockServer({ apiKey: API_KEY });
    process.env.TEAMAI_REPORT_ENDPOINT = server.url;
    // Seed the install command now that the server URL (and download endpoint) is known.
    server.seedCommands([
      {
        id: 1,
        type: 'install_skill',
        skill_slug: 'weather',
        skill_version: '1.0.0',
        download_url: `${server.url}/download?slug=weather&access_token=smh`,
      },
    ]);

    await runStatusReport({ stdin: {}, tool: 'codebuddy', phase: 'session' });

    // Skill installed into the agent skills dir.
    expect(fs.existsSync(path.join(tmpDir, '.codebuddy', 'skills', 'weather', 'SKILL.md'))).toBe(true);
    // Ack recorded as success.
    expect(server.acks).toHaveLength(1);
    expect(server.acks[0]).toMatchObject({ id: 1 });
    expect((server.acks[0].body as { id: number }).id).toBe(1);
    expect((server.acks[0].body as { status: string }).status).toBe('success');
  });
});

describe('runStatusReport offline resilience', () => {
  it('does not throw and buffers when the endpoint is unreachable', async () => {
    setupHome();
    process.env.TEAMAI_REPORT_ENDPOINT = 'http://127.0.0.1:1'; // nothing listening

    await expect(runStatusReport({ stdin: {}, tool: 'codebuddy', phase: 'session' })).resolves.toBeUndefined();

    const queuePath = path.join(tmpDir, '.teamai', 'reporter', 'queue.jsonl');
    expect(fs.existsSync(queuePath)).toBe(true);
  });

  it('skips agents outside the reportable set', async () => {
    setupHome();
    server = await startMockServer({ apiKey: API_KEY });
    process.env.TEAMAI_REPORT_ENDPOINT = server.url;

    await runStatusReport({ stdin: {}, tool: 'claude', phase: 'session' });
    expect(server.reports).toHaveLength(0);
  });
});
