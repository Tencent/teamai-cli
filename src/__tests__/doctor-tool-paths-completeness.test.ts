import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';

const COMPLETENESS = /toolPaths entry is missing/;

/**
 * The completeness findings in the doctor-stage registry, resolved the way the
 * command resolves it: mocked config loaders, a real context, a real assembly.
 */
async function completenessFindings(): Promise<Check[]> {
  const ctx = await resolveDoctorContext();
  if (!ctx) throw new Error('expected a resolved doctor context');
  return (await buildChecks(ctx)).filter((c) => COMPLETENESS.test(c.name));
}

/**
 * A `toolPaths:` section replaces the default table whole (the zod `.default`
 * applies only when the section is absent), and every field of an entry is
 * optional — so a custom entry that drops half the surfaces the built-in
 * default provided is accepted silently and pull skips them without a trace
 * (#1115). The doctor check names the dropped keys.
 */
describe('doctor — a toolPaths entry missing default keys is named', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-toolpaths-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('reports the keys a customized entry drops, with the replace-whole reason', async () => {
    // The #1054 verification shape: zcode with skills/agents/mcp but no
    // `settings`, so the default `.zcode/cli/config.json` vanished and hooks
    // skip the tool with no warning anywhere.
    vi.mocked(loadTeamConfig).mockResolvedValue({
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: { zcode: { skills: '.zcode/skills', agents: '.zcode/agents', mcp: '.agents/mcp.json' } },
    });

    const findings = await completenessFindings();

    expect(findings.map((c) => c.name)).toEqual(['zcode toolPaths entry is missing 1 default path']);
    const [finding] = findings;
    expect(await finding.check()).toBe(false);
    expect(finding.fix).toContain('replaces the default table whole');
    expect(finding.fix).toContain('`settings`');
    expect(finding.fix).toContain('teamai.yaml');
    expect(finding.fix).toContain('teamai pull');
  });

  it('stays out of the post-pull stage, with the other budgeted checks', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: { zcode: { skills: '.zcode/skills', agents: '.zcode/agents', mcp: '.agents/mcp.json' } },
    });

    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');

    const pullNames = (await buildChecks(ctx, 'pull')).map((c) => c.name);
    expect(pullNames.some((n) => COMPLETENESS.test(n))).toBe(false);
    const doctorNames = (await buildChecks(ctx, 'doctor')).map((c) => c.name);
    expect(doctorNames.some((n) => COMPLETENESS.test(n))).toBe(true);
  });

  it('stays silent when the entry carries every key the default provides', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: {
        zcode: { skills: '.zcode/skills', agents: '.zcode/agents', settings: '.zcode/cli/config.json', mcp: '.agents/mcp.json' },
        codex: {
          skills: '.codex/skills',
          settings: '.codex/hooks.json',
          agents: '.codex/agents',
          mcp: '.codex/config.toml',
          mcpProject: '.codex/config.toml',
          userScope: { claudemd: '.codex/AGENTS.md' },
        },
      },
    });

    expect(await completenessFindings()).toEqual([]);
  });

  it('ignores tool names that are not built-in entries', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: { 'not-a-builtin': { skills: '.x/skills' } },
    });

    expect(await completenessFindings()).toEqual([]);
  });

  it('stays silent when the whole section is absent and the schema default applies', async () => {
    // No `toolPaths` key at all: the zod default fills the table in, and an
    // all-default table drops nothing.
    const parsed = TeamaiConfigSchema.parse({ team: 'test', repo: 'owner/repo', provider: 'git' });
    expect(Object.keys(parsed.toolPaths)).toContain('zcode');
    vi.mocked(loadTeamConfig).mockResolvedValue(parsed);

    expect(await completenessFindings()).toEqual([]);
  });

  it('names the userScope keys a codex-shaped entry drops in user scope', async () => {
    // The entry may be complete at the top level and still drop the user-scope
    // surfaces the default carried — the shape the codex claudemd finding
    // (doctor-delivery) caught for one family, generalized.
    vi.mocked(loadTeamConfig).mockResolvedValue({
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: {
        codex: {
          skills: '.codex/skills',
          settings: '.codex/hooks.json',
          agents: '.codex/agents',
          mcp: '.codex/config.toml',
          mcpProject: '.codex/config.toml',
        },
      },
    });

    const findings = await completenessFindings();

    expect(findings.map((c) => c.name)).toEqual(['codex toolPaths entry is missing 1 default path']);
    expect(findings[0]?.fix).toContain('`userScope.claudemd`');
  });
});
