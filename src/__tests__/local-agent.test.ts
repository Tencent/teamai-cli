import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { agentHookDescription } from '../hooks.js';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let tmpDir: string;
let origHome: string | undefined;
let origPpid: number;

const TEST_SESSION_ID = 'test-session';

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-la-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
  origPpid = process.ppid;
  // Bind prompt is on by default — start each test from that baseline.
  delete process.env.TEAMAI_BIND_PROMPT_ENABLED;
  // Clean hint markers (both old ppid-based and new sessionId-based)
  await fse.remove(path.join(os.tmpdir(), `teamai-bind-hint-${TEST_SESSION_ID}`));
  await fse.remove(path.join(os.tmpdir(), `teamai-bind-session-${TEST_SESSION_ID}`));
});

afterEach(async () => {
  process.env.HOME = origHome;
  delete process.env.TEAMAI_BIND_PROMPT_ENABLED;
  await fse.remove(path.join(os.tmpdir(), `teamai-bind-hint-${TEST_SESSION_ID}`));
  await fse.remove(path.join(os.tmpdir(), `teamai-bind-session-${TEST_SESSION_ID}`));
  await fse.remove(tmpDir);
  vi.restoreAllMocks();
});

async function setupConfig(bindings: Record<string, unknown> = {}) {
  const configDir = path.join(tmpDir, '.teamai', 'local-agent');
  await fse.ensureDir(configDir);
  await fse.writeJson(path.join(configDir, 'config.json'), {
    endpoint: 'https://test.example.com/api',
    token: 'test-token',
    localAgentId: 'test-agent-id',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceBindings: bindings,
  });
}

describe('local-agent: buildReportPayload disk scan', () => {
  async function writeSkill(baseDir: string, tool: string, dir: string, name: string, version?: string): Promise<void> {
    const skillDir = path.join(baseDir, `.${tool}`, 'skills', dir);
    await fse.ensureDir(skillDir);
    const fm = ['---', `name: ${name}`, ...(version ? [`version: ${version}`] : []), '---', '', '# skill'].join('\n');
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), fm);
  }

  async function writeRule(baseDir: string, tool: string, slug: string): Promise<void> {
    const rulesDir = path.join(baseDir, `.${tool}`, 'rules');
    await fse.ensureDir(rulesDir);
    await fse.writeFile(path.join(rulesDir, `${slug}.md`), '# rule');
  }

  it('scans user-level skills/rules from disk, leaves instance empty, derives source from manifest', async () => {
    await setupConfig();
    // Manifest records one slug → that one is `enterprise`, the rest `local`.
    const manifestDir = path.join(tmpDir, '.teamai', 'local-agent');
    await fse.writeJson(path.join(manifestDir, 'manifest.json'), {
      scopes: { instance: { skills: { 'known-skill': { slug: 'known-skill', installed_at: 'x' } }, rules: {}, claudemd: {} } },
    });
    // User-level resources on disk (~/.codebuddy under mocked HOME=tmpDir).
    await writeSkill(tmpDir, 'codebuddy', 'known-skill', 'known-skill', '1.0.0');
    await writeSkill(tmpDir, 'codebuddy', 'local-skill', 'local-skill');
    await writeRule(tmpDir, 'codebuddy', 'my-rule');

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = await buildReportPayload(config!, { tool: 'codebuddy' }) as {
      skills?: unknown[];
      rules?: unknown[];
      user_level: { skills: Array<{ slug: string; source: string; version?: string }>; rules: Array<{ slug: string }> };
    };

    // Instance level is omitted entirely (phase-1 legacy) — not sent as [] so
    // the server's full-sync semantics don't wipe instance resources.
    expect(payload.skills).toBeUndefined();
    expect(payload.rules).toBeUndefined();

    // User level scanned from disk.
    const userSkills = payload.user_level.skills;
    expect(userSkills.map((s) => s.slug).sort()).toEqual(['known-skill', 'local-skill']);
    expect(userSkills.find((s) => s.slug === 'known-skill')?.source).toBe('enterprise');
    expect(userSkills.find((s) => s.slug === 'local-skill')?.source).toBe('local');
    expect(userSkills.find((s) => s.slug === 'known-skill')?.version).toBe('1.0.0');
    expect(payload.user_level.rules.map((r) => r.slug)).toEqual(['my-rule']);
  });
});

describe('local-agent: local_agent_id derivation (per-tool install dir)', () => {
  it('derives the id from ~/.<tool>, matching the historical status-report口径', async () => {
    await setupConfig();
    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const { deriveLocalAgentId, getMachineId } = await import('../machine-id.js');
    const config = await loadLocalAgentConfig();

    const payload = (await buildReportPayload(config!, { tool: 'codebuddy' })) as {
      local_agent_id: string;
    };

    // Expected = same deterministic algorithm, seeded with the tool's own dir
    // (~/.codebuddy), NOT the teamai home. This keeps the id byte-for-byte
    // identical to what the status-report path produced pre-upgrade.
    const expected = deriveLocalAgentId('codebuddy', getMachineId(), path.join(tmpDir, '.codebuddy'));
    expect(payload.local_agent_id).toBe(expected);
    // It must NOT be seeded with the teamai home (the drifted口径).
    const drifted = deriveLocalAgentId('codebuddy', getMachineId(), path.join(tmpDir, '.teamai', 'local-agent'));
    expect(payload.local_agent_id).not.toBe(drifted);
  });

  it('gives claude and codebuddy different ids on the same machine', async () => {
    await setupConfig();
    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();

    const claude = (await buildReportPayload(config!, { tool: 'claude' })) as { local_agent_id: string };
    const codebuddy = (await buildReportPayload(config!, { tool: 'codebuddy' })) as { local_agent_id: string };

    expect(claude.local_agent_id).not.toBe(codebuddy.local_agent_id);
  });

  it('honors TEAMAI_LOCAL_AGENT_ID override', async () => {
    await setupConfig();
    const prev = process.env.TEAMAI_LOCAL_AGENT_ID;
    process.env.TEAMAI_LOCAL_AGENT_ID = 'pinned-xyz';
    try {
      const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
      const config = await loadLocalAgentConfig();
      const payload = (await buildReportPayload(config!, { tool: 'codebuddy' })) as { local_agent_id: string };
      expect(payload.local_agent_id).toBe('pinned-xyz');
    } finally {
      if (prev === undefined) delete process.env.TEAMAI_LOCAL_AGENT_ID;
      else process.env.TEAMAI_LOCAL_AGENT_ID = prev;
    }
  });
});

describe('local-agent: bindCurrentProject --skip', () => {
  it('writes projectId 0 and __skipped__ marker to config', async () => {
    await setupConfig();
    // Create a git repo in tmpDir so resolveWorkspacePath works
    const projectDir = path.join(tmpDir, 'my-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    const { bindCurrentProject } = await import('../local-agent.js');
    await bindCurrentProject({ skip: true, cwd: projectDir });

    const config = await fse.readJson(
      path.join(tmpDir, '.teamai', 'local-agent', 'config.json'),
    );
    // git rev-parse resolves symlinks (macOS /tmp -> /private/var/...)
    const realProjectDir = fse.realpathSync(projectDir);
    const binding = config.workspaceBindings[realProjectDir] ?? config.workspaceBindings[projectDir];
    expect(binding).toBeDefined();
    expect(binding.projectId).toBe(0);
    expect(binding.projectName).toBe('__skipped__');
    expect(binding.boundAt).toBeTruthy();
  });
});

describe('local-agent: emitBindingHint via reportAndSyncLocalAgent', () => {
  it('outputs hookSpecificOutput with choices when project is unbound', async () => {
    process.env.TEAMAI_BIND_PROMPT_ENABLED = '1';
    await setupConfig();
    const projectDir = path.join(tmpDir, 'unbound-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    // Mock global fetch to handle /api/projects/mine and /api/local-agent/report
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/projects/mine')) {
        return new Response(JSON.stringify({
          ok: true,
          projects: [
            { id: 100, name: 'alpha' },
            { id: 200, name: 'beta' },
          ],
        }));
      }
      // report/sync — just return ok
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    // Capture stdout
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const { reportAndSyncLocalAgent } = await import('../local-agent.js');
      await reportAndSyncLocalAgent({
        cwd: projectDir,
        tool: 'claude',
        event: { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId: 'test-session', tool: 'claude' },
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = stdoutChunks.join('');
    expect(output).toContain('hookSpecificOutput');

    const parsed = JSON.parse(output.trim().split('\n').find((l) => l.includes('hookSpecificOutput'))!);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[ClawPro项目 绑定提示]');
    expect(ctx).toContain('当前工作区未绑定ClawPro项目');
    expect(ctx).toContain('绑定到「alpha」项目');
    expect(ctx).toContain('绑定到「beta」项目');
    expect(ctx).toContain('不绑定，以后也不再提示');
    expect(ctx).toContain('teamai bind-project --project-id 100');
    expect(ctx).toContain('teamai bind-project --project-id 200');
    expect(ctx).toContain('teamai bind-project --skip');
  });

  it('does NOT emit hint when TEAMAI_BIND_PROMPT_ENABLED is explicitly disabled', async () => {
    // Explicitly disable the bind prompt via TEAMAI_BIND_PROMPT_ENABLED=0.
    process.env.TEAMAI_BIND_PROMPT_ENABLED = '0';
    await setupConfig();
    const projectDir = path.join(tmpDir, 'disabled-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const { reportAndSyncLocalAgent } = await import('../local-agent.js');
      await reportAndSyncLocalAgent({
        cwd: projectDir,
        tool: 'claude',
        event: { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId: 'test-session', tool: 'claude' },
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = stdoutChunks.join('');
    expect(output).not.toContain('hookSpecificOutput');
    // user-groups must not even be fetched when the prompt is disabled
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/user-groups/mine'))).toBe(false);
  });

  it('does NOT emit hint when project is already bound', async () => {
    process.env.TEAMAI_BIND_PROMPT_ENABLED = '1';
    const projectDir = path.join(tmpDir, 'bound-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    await setupConfig({
      [projectDir]: { projectId: 1, projectName: 'existing', boundAt: '2026-01-01T00:00:00.000Z' },
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const { reportAndSyncLocalAgent } = await import('../local-agent.js');
      await reportAndSyncLocalAgent({
        cwd: projectDir,
        tool: 'claude',
        event: { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId: 'test-session', tool: 'claude' },
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = stdoutChunks.join('');
    expect(output).not.toContain('hookSpecificOutput');
  });

  it('does NOT emit hint when project is skipped (projectId 0)', async () => {
    process.env.TEAMAI_BIND_PROMPT_ENABLED = '1';
    const projectDir = path.join(tmpDir, 'skipped-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    await setupConfig({
      [projectDir]: { projectId: 0, projectName: '__skipped__', boundAt: '2026-01-01T00:00:00.000Z' },
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const { reportAndSyncLocalAgent } = await import('../local-agent.js');
      await reportAndSyncLocalAgent({
        cwd: projectDir,
        tool: 'claude',
        event: { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId: 'test-session', tool: 'claude' },
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = stdoutChunks.join('');
    expect(output).not.toContain('hookSpecificOutput');
  });

  it('does NOT emit hint for WorkBuddy ephemeral task directories', async () => {
    process.env.TEAMAI_BIND_PROMPT_ENABLED = '1';
    await setupConfig();

    // Create a WorkBuddy ephemeral task directory (not a git repo)
    const ephemeralDir = path.join(tmpDir, 'WorkBuddy', '2026-07-31-16-04-39');
    await fse.ensureDir(ephemeralDir);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/projects/mine')) {
        return new Response(JSON.stringify({ ok: true, projects: [{ id: 1, name: 'proj' }] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const { reportAndSyncLocalAgent } = await import('../local-agent.js');
      await reportAndSyncLocalAgent({
        cwd: ephemeralDir,
        tool: 'workbuddy',
        event: { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId: TEST_SESSION_ID, tool: 'workbuddy' },
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = stdoutChunks.join('');
    expect(output).not.toContain('hookSpecificOutput');
    expect(output).not.toContain('ClawPro项目 绑定提示');
  });

  it('emits hint only once per sessionId', async () => {
    process.env.TEAMAI_BIND_PROMPT_ENABLED = '1';
    await setupConfig();
    const projectDir = path.join(tmpDir, 'dedup-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/projects/mine')) {
        return new Response(JSON.stringify({ ok: true, projects: [{ id: 1, name: 'proj' }] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const allOutput: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      allOutput.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const { reportAndSyncLocalAgent } = await import('../local-agent.js');
      const makeEvent = () => ({
        type: 'prompt_submit' as const,
        timestamp: new Date().toISOString(),
        sessionId: TEST_SESSION_ID,
        tool: 'claude',
      });

      // First call — should emit hint
      await reportAndSyncLocalAgent({ cwd: projectDir, tool: 'claude', event: makeEvent() });
      const firstOutput = allOutput.join('');
      expect(firstOutput).toContain('ClawPro项目 绑定提示');

      // Second call with same sessionId — should NOT emit hint
      allOutput.length = 0;
      await reportAndSyncLocalAgent({ cwd: projectDir, tool: 'claude', event: makeEvent() });
      const secondOutput = allOutput.join('');
      expect(secondOutput).not.toContain('ClawPro项目 绑定提示');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

describe('local-agent: security — install command hardening', () => {
  async function runInstallCommand(command: Record<string, unknown>) {
    await setupConfig();
    const projectDir = path.join(tmpDir, 'sec-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    const acks: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('/local-agent/sync')) {
        return new Response(JSON.stringify({ ok: true, commands: [command] }));
      }
      if (url.includes('/commands/ack')) {
        acks.push(JSON.parse(init?.body ?? '{}'));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: projectDir, tool: 'claude', status: 'running' });
    return acks;
  }

  it('rejects a path-traversal slug and acks failed without escaping the repo', async () => {
    const acks = await runInstallCommand({
      id: 1,
      type: 'install_rule',
      rule_slug: '../../evil',
      download_url: 'https://test.example.com/evil.md',
    });

    // The malicious command must be reported as failed with the guard message.
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('failed');
    expect(String(acks[0].error)).toContain('Invalid resource slug');

    // Nothing must have been written outside the resource repo.
    await expect(fse.pathExists(path.join(tmpDir, '.teamai', 'evil.md'))).resolves.toBe(false);
    await expect(fse.pathExists(path.join(tmpDir, 'evil.md'))).resolves.toBe(false);
  });

  it('rejects a file:// download_url (SSRF / arbitrary local file read)', async () => {
    const acks = await runInstallCommand({
      id: 2,
      type: 'install_rule',
      rule_slug: 'legit-rule',
      download_url: 'file:///etc/passwd',
    });

    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('failed');
    expect(String(acks[0].error)).toContain('Unsupported download URL scheme');
  });
});

describe('local-agent: security — token file permissions', () => {
  it('writes the credential token with owner-only (0o600) permissions', async () => {
    const { writeTokenFile } = await import('../local-agent.js');
    const tokenPath = path.join(tmpDir, 'token');
    await writeTokenFile(tokenPath, 'secret-token-abc');

    expect(await fse.pathExists(tokenPath)).toBe(true);
    expect(await fse.readFile(tokenPath, 'utf-8')).toBe('secret-token-abc\n');
    const mode = (await fse.stat(tokenPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('tightens permissions on an already-existing token file', async () => {
    const { writeTokenFile } = await import('../local-agent.js');
    const tokenPath = path.join(tmpDir, 'token');
    // Pre-create with world-readable perms to prove chmod tightens it.
    await fse.writeFile(tokenPath, 'old\n', { mode: 0o644 });
    await writeTokenFile(tokenPath, 'new-token');

    const mode = (await fse.stat(tokenPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('local-agent: skill directory naming (SKILL.md name vs server slug)', () => {
  // Build a real skill zip whose SKILL.md `name:` may differ from the slug.
  async function makeSkillZip(skillName: string): Promise<Uint8Array> {
    const { zipSync, strToU8 } = await import('fflate');
    const skillMd = `---\nname: ${skillName}\ndescription: test skill\n---\n# ${skillName}\nbody\n`;
    return zipSync({ [`${skillName}/SKILL.md`]: strToU8(skillMd) });
  }

  // Run a single install/uninstall command through the full sync path.
  async function runCommand(command: Record<string, unknown>, zip?: Uint8Array) {
    // codebuddy must look "installed" or pullItem skips it.
    await fse.ensureDir(path.join(tmpDir, '.codebuddy', 'skills'));
    await setupConfig();

    const acks: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: { body?: string }) => {
      // downloadResource passes a URL object; report/sync pass strings.
      const url = String(input);
      if (url.includes('/skill.zip') && zip) {
        return new Response(Buffer.from(zip));
      }
      if (url.includes('/local-agent/sync')) {
        return new Response(JSON.stringify({ ok: true, commands: [command] }));
      }
      if (url.includes('/commands/ack')) {
        acks.push(JSON.parse(init?.body ?? '{}'));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: tmpDir, tool: 'codebuddy', status: 'running' });
    return acks;
  }

  const codebuddySkillsDir = () => path.join(tmpDir, '.codebuddy', 'skills');
  const port = 41999;

  it('installs the skill under its SKILL.md name, not the server slug', async () => {
    const zip = await makeSkillZip('my-real-skill-name');
    const acks = await runCommand({
      id: 1,
      type: 'install_skill',
      skill_slug: 'server-slug-xyz',
      skill_version: '1.0.0',
      download_url: `http://127.0.0.1:${port}/skill.zip`,
    }, zip);

    expect(acks[0]?.status).toBe('success');
    expect(await fse.pathExists(path.join(codebuddySkillsDir(), 'my-real-skill-name'))).toBe(true);
    expect(await fse.pathExists(path.join(codebuddySkillsDir(), 'server-slug-xyz'))).toBe(false);

    // Manifest keeps the slug as key but records the on-disk dir name.
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'local-agent', 'manifest.json'));
    expect(manifest.scopes.user.skills['server-slug-xyz'].dir_name).toBe('my-real-skill-name');
  });

  it('uninstalls by slug and removes the SKILL.md-name directory', async () => {
    const zip = await makeSkillZip('my-real-skill-name');
    await runCommand({
      id: 1, type: 'install_skill', skill_slug: 'server-slug-xyz',
      skill_version: '1.0.0', download_url: `http://127.0.0.1:${port}/skill.zip`,
    }, zip);
    expect(await fse.pathExists(path.join(codebuddySkillsDir(), 'my-real-skill-name'))).toBe(true);

    await runCommand({ id: 2, type: 'uninstall_skill', skill_slug: 'server-slug-xyz' });
    expect(await fse.pathExists(path.join(codebuddySkillsDir(), 'my-real-skill-name'))).toBe(false);
  });

  it('falls back to the slug when SKILL.md name equals the slug', async () => {
    const zip = await makeSkillZip('server-slug-xyz');
    await runCommand({
      id: 1, type: 'install_skill', skill_slug: 'server-slug-xyz',
      skill_version: '1.0.0', download_url: `http://127.0.0.1:${port}/skill.zip`,
    }, zip);

    expect(await fse.pathExists(path.join(codebuddySkillsDir(), 'server-slug-xyz'))).toBe(true);
    // No rename happened, so no dir_name is recorded.
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'local-agent', 'manifest.json'));
    expect(manifest.scopes.user.skills['server-slug-xyz'].dir_name).toBeUndefined();
  });
});

describe('local-agent: normalizeScope — workspace scope installs to project dir', () => {
  const port = 42001;

  it('installs to project-level skills dir when backend sends scope=workspace', async () => {
    const projectDir = path.join(tmpDir, 'ws-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
    await fse.ensureDir(path.join(projectDir, '.codebuddy', 'skills'));
    await setupConfig();

    const { zipSync, strToU8 } = await import('fflate');
    const skillMd = '---\nname: ws-skill\ndescription: test\n---\n# ws-skill\nbody\n';
    const zip = zipSync({ 'ws-skill/SKILL.md': strToU8(skillMd) });

    const acks: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/skill.zip')) {
        return new Response(Buffer.from(zip));
      }
      if (url.includes('/local-agent/sync')) {
        return new Response(JSON.stringify({
          ok: true,
          commands: [{
            id: 1,
            type: 'install_skill',
            skill_slug: 'ws-skill',
            skill_version: '1.0.0',
            download_url: `http://127.0.0.1:${port}/skill.zip`,
            scope: 'workspace',
            workspace_path: projectDir,
            project_id: 101,
          }],
        }));
      }
      if (url.includes('/commands/ack')) {
        acks.push(JSON.parse(init?.body ?? '{}'));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: projectDir, tool: 'codebuddy', status: 'running' });

    expect(acks[0]?.status).toBe('success');

    // Skill must land under the project dir, not the user HOME.
    const projectSkillDir = path.join(projectDir, '.codebuddy', 'skills', 'ws-skill');
    const userSkillDir = path.join(tmpDir, '.codebuddy', 'skills', 'ws-skill');
    await expect(fse.pathExists(projectSkillDir)).resolves.toBe(true);
    await expect(fse.pathExists(userSkillDir)).resolves.toBe(false);

    // The skill must be recorded under a `project:` manifest scope key
    // (scopeKey('project', workspacePath)), not `user` or `instance`.
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'local-agent', 'manifest.json'));
    const projectKey = Object.keys(manifest.scopes ?? {}).find((key) => key.startsWith('project:'));
    expect(projectKey).toBeDefined();
    expect(manifest.scopes[projectKey!].skills['ws-skill']).toBeDefined();
  });
});

describe('local-agent: full-snapshot workspace reporting', () => {
  it('reports all bound workspaces, not just the current cwd', async () => {
    const wsA = path.join(tmpDir, 'ws-a');
    const wsB = path.join(tmpDir, 'ws-b');
    await fse.ensureDir(wsA);
    await fse.ensureDir(wsB);
    await setupConfig({
      [wsA]: { projectId: 11, projectName: 'A', boundAt: 'x', ideType: 'codebuddy' },
      [wsB]: { projectId: 22, projectName: 'B', boundAt: 'x', ideType: 'codebuddy' },
    });

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = await buildReportPayload(config!, { tool: 'codebuddy' }) as {
      workspaces?: Array<Record<string, unknown>>;
    };

    const rA = fse.realpathSync(wsA);
    const rB = fse.realpathSync(wsB);
    expect(payload.workspaces).toHaveLength(2);
    const paths = (payload.workspaces ?? []).map((w) => w.path as string);
    expect(new Set(paths)).toEqual(new Set([rA, rB]));
    const wsAEntry = (payload.workspaces ?? []).find((w) => w.path === rA);
    const wsBEntry = (payload.workspaces ?? []).find((w) => w.path === rB);
    expect(wsAEntry?.project_id).toBe(11);
    expect(wsBEntry?.project_id).toBe(22);
    // Empty directories — no skills or rules installed.
    expect(wsAEntry).not.toHaveProperty('skills');
    expect(wsAEntry).not.toHaveProperty('rules');
    expect(wsBEntry).not.toHaveProperty('skills');
    expect(wsBEntry).not.toHaveProperty('rules');
  });

  it('omits skills/rules for empty workspaces but includes them when present', async () => {
    const wsFull = path.join(tmpDir, 'ws-full');
    const wsEmpty = path.join(tmpDir, 'ws-empty');
    // Write a real codebuddy skill into wsFull.
    const skillDir = path.join(wsFull, '.codebuddy', 'skills', 'demo-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\n---\n\n# skill',
    );
    await fse.ensureDir(wsEmpty);
    await setupConfig({
      [wsFull]: { projectId: 7, projectName: 'full', boundAt: 'x', ideType: 'codebuddy' },
      [wsEmpty]: { projectId: 8, projectName: 'empty', boundAt: 'x', ideType: 'codebuddy' },
    });

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = await buildReportPayload(config!, { tool: 'codebuddy' }) as {
      workspaces?: Array<Record<string, unknown>>;
    };

    const rFull = fse.realpathSync(wsFull);
    const rEmpty = fse.realpathSync(wsEmpty);
    const wsFullEntry = (payload.workspaces ?? []).find((w) => w.path === rFull) as
      | (Record<string, unknown> & { skills?: Array<{ slug: string }> })
      | undefined;
    const wsEmptyEntry = (payload.workspaces ?? []).find((w) => w.path === rEmpty);

    expect(wsFullEntry?.skills).toBeDefined();
    expect(wsFullEntry?.skills?.map((s) => s.slug)).toContain('demo-skill');
    expect(wsEmptyEntry).not.toHaveProperty('skills');
    expect(wsEmptyEntry).not.toHaveProperty('rules');
  });

  it('prunes workspaces whose directory no longer exists', async () => {
    const wsLive = path.join(tmpDir, 'ws-live');
    const wsDead = path.join(tmpDir, 'ws-dead');
    await fse.ensureDir(wsLive);
    // wsDead is intentionally not created.
    await setupConfig({
      [wsLive]: { projectId: 3, projectName: 'live', boundAt: 'x' },
      [wsDead]: { projectId: 4, projectName: 'dead', boundAt: 'x' },
    });

    const { pruneDeadWorkspaceBindings, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const pruned = await pruneDeadWorkspaceBindings(config!);

    expect(pruned).toBe(true);
    expect(Object.keys(config!.workspaceBindings)).toEqual([fse.realpathSync(wsLive)]);
  });

  it('returns false when all directories exist', async () => {
    const wsA = path.join(tmpDir, 'ws-a2');
    const wsB = path.join(tmpDir, 'ws-b2');
    await fse.ensureDir(wsA);
    await fse.ensureDir(wsB);
    await setupConfig({
      [wsA]: { projectId: 1, projectName: 'a', boundAt: 'x' },
      [wsB]: { projectId: 2, projectName: 'b', boundAt: 'x' },
    });

    const { pruneDeadWorkspaceBindings, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const pruned = await pruneDeadWorkspaceBindings(config!);

    expect(pruned).toBe(false);
    expect(Object.keys(config!.workspaceBindings)).toHaveLength(2);
  });

  it('includes unbound current cwd in the report', async () => {
    const { execFileSync } = await import('node:child_process');
    const cwdDir = path.join(tmpDir, 'current');
    const wsA = path.join(tmpDir, 'ws-a3');
    await fse.ensureDir(cwdDir);
    await fse.ensureDir(wsA);
    execFileSync('git', ['init'], { cwd: cwdDir, stdio: 'ignore' });
    await setupConfig({
      [wsA]: { projectId: 5, projectName: 'A', boundAt: 'x', ideType: 'codebuddy' },
    });

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = await buildReportPayload(config!, { tool: 'codebuddy', cwd: cwdDir }) as {
      workspaces?: Array<Record<string, unknown>>;
    };

    const realCwd = fse.realpathSync(cwdDir);
    const rA = fse.realpathSync(wsA);
    expect(payload.workspaces).toHaveLength(2);
    const allPaths = (payload.workspaces ?? []).map((w) => w.path as string);
    expect(allPaths).toContain(rA);
    expect(allPaths).toContain(realCwd);
    const cwdEntry = (payload.workspaces ?? []).find((w) => w.path === realCwd);
    const wsAEntry = (payload.workspaces ?? []).find((w) => w.path === rA);
    expect(cwdEntry?.project_id).toBeUndefined();
    expect(wsAEntry?.project_id).toBe(5);
  });

  it('omits user_level skills/rules when none installed', async () => {
    // HOME is tmpDir (set in beforeEach); no codebuddy skills/rules written there.
    await setupConfig();

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = await buildReportPayload(config!, { tool: 'codebuddy' }) as {
      user_level: Record<string, unknown>;
    };

    expect(payload.user_level).toHaveProperty('group_id');
    expect(payload.user_level).not.toHaveProperty('skills');
    expect(payload.user_level).not.toHaveProperty('rules');
  });

  it('reports skipped workspaces with project_id 0', async () => {
    const wsSkip = path.join(tmpDir, 'ws-skip');
    await fse.ensureDir(wsSkip);
    await setupConfig({
      [wsSkip]: { projectId: 0, projectName: '__skipped__', boundAt: 'x', ideType: 'codebuddy' },
    });

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = await buildReportPayload(config!, { tool: 'codebuddy' }) as {
      workspaces?: Array<Record<string, unknown>>;
    };

    const entry = (payload.workspaces ?? []).find((w) => w.path === fse.realpathSync(wsSkip));
    expect(entry).toBeDefined();
    expect(entry?.project_id).toBe(0);
  });

  it('prunes a skipped workspace whose directory is gone', async () => {
    const wsSkipDead = path.join(tmpDir, 'ws-skip-dead');
    // Intentionally not created — directory does not exist.
    await setupConfig({
      [wsSkipDead]: { projectId: 0, projectName: '__skipped__', boundAt: 'x' },
    });

    const { pruneDeadWorkspaceBindings, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const pruned = await pruneDeadWorkspaceBindings(config!);

    expect(pruned).toBe(true);
    expect(Object.keys(config!.workspaceBindings)).not.toContain(wsSkipDead);
  });

  it('filters by tool: workbuddy report only includes workbuddy-owned binding', async () => {
    const wsCb = path.join(tmpDir, 'ws-cb');
    const wsWb = path.join(tmpDir, 'ws-wb');
    await fse.ensureDir(wsCb);
    await fse.ensureDir(wsWb);
    await setupConfig({
      [wsCb]: { projectId: 10, projectName: 'cb', boundAt: 'x', ideType: 'codebuddy' },
      [wsWb]: { projectId: 20, projectName: 'wb', boundAt: 'x', ideType: 'workbuddy' },
    });

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();

    const wbPayload = await buildReportPayload(config!, { tool: 'workbuddy' }) as {
      workspaces?: Array<Record<string, unknown>>;
    };
    expect(wbPayload.workspaces).toHaveLength(1);
    expect(wbPayload.workspaces![0].path).toBe(fse.realpathSync(wsWb));
    expect(wbPayload.workspaces![0].ide_type).toBe('workbuddy');

    const cbPayload = await buildReportPayload(config!, { tool: 'codebuddy' }) as {
      workspaces?: Array<Record<string, unknown>>;
    };
    expect(cbPayload.workspaces).toHaveLength(1);
    expect(cbPayload.workspaces![0].path).toBe(fse.realpathSync(wsCb));
    expect(cbPayload.workspaces![0].ide_type).toBe('codebuddy');
  });

  it('collapses two path aliases of the same physical workspace into one entry', async () => {
    // Real directory + a symlink alias pointing at it. Both are valid strings
    // for the same physical workspace (mirrors macOS case-insensitive aliasing).
    const realWs = path.join(tmpDir, 'ws-real');
    const aliasWs = path.join(tmpDir, 'ws-alias');
    await fse.ensureDir(realWs);
    await fse.symlink(realWs, aliasWs, 'dir');

    // Config stores the two aliases as distinct keys, as a pre-migration install would.
    await setupConfig({
      [realWs]: { projectId: 11, projectName: 'real', boundAt: 'x', ideType: 'codebuddy' },
      [aliasWs]: { projectId: 11, projectName: 'alias', boundAt: 'x', ideType: 'codebuddy' },
    });

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();

    // After canonicalization migration, only one binding key remains.
    const canonical = fse.realpathSync(realWs);
    expect(Object.keys(config!.workspaceBindings)).toEqual([canonical]);

    const payload = await buildReportPayload(config!, { tool: 'codebuddy' }) as {
      workspaces?: Array<Record<string, unknown>>;
    };
    expect(payload.workspaces).toHaveLength(1);
    expect(payload.workspaces![0].path).toBe(canonical);
    expect(payload.workspaces![0].project_id).toBe(11);
  });

  it('warns and keeps first binding when aliases have conflicting project ids', async () => {
    const realWs = path.join(tmpDir, 'ws-conflict-real');
    const aliasWs = path.join(tmpDir, 'ws-conflict-alias');
    await fse.ensureDir(realWs);
    await fse.symlink(realWs, aliasWs, 'dir');

    // Order in the object literal determines iteration order; realWs (id 11) is first.
    await setupConfig({
      [realWs]: { projectId: 11, projectName: 'real', boundAt: 'x', ideType: 'codebuddy' },
      [aliasWs]: { projectId: 22, projectName: 'alias', boundAt: 'x', ideType: 'codebuddy' },
    });

    const { loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();

    const canonical = fse.realpathSync(realWs);
    expect(Object.keys(config!.workspaceBindings)).toEqual([canonical]);
    // First-seen non-zero projectId wins.
    expect(config!.workspaceBindings[canonical].projectId).toBe(11);
  });

  it('includes unattributed cwd binding as current tool and excludes unattributed non-cwd binding', async () => {
    const { execFileSync } = await import('node:child_process');
    const cwdDir = path.join(tmpDir, 'cwd-no-type');
    const wsOther = path.join(tmpDir, 'ws-other-no-type');
    await fse.ensureDir(cwdDir);
    await fse.ensureDir(wsOther);
    execFileSync('git', ['init'], { cwd: cwdDir, stdio: 'ignore' });
    await setupConfig({
      [cwdDir]: { projectId: 30, projectName: 'cwd-ws', boundAt: 'x' },
      [wsOther]: { projectId: 31, projectName: 'other-ws', boundAt: 'x' },
    });

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = await buildReportPayload(config!, { tool: 'codebuddy', cwd: cwdDir }) as {
      workspaces?: Array<Record<string, unknown>>;
    };

    const realCwd = fse.realpathSync(cwdDir);
    // Only the cwd binding is included; the unattributed non-cwd binding is skipped.
    expect(payload.workspaces).toHaveLength(1);
    expect(payload.workspaces![0].path).toBe(realCwd);
    expect(payload.workspaces![0].ide_type).toBe('codebuddy');
    // wsOther has no ideType and is not cwd, so it is excluded.
    const paths = (payload.workspaces ?? []).map((w) => w.path as string);
    expect(paths).not.toContain(wsOther);
  });

  it('stampWorkspaceTool writes ideType to cwd binding and returns true', async () => {
    const wsCwd = path.join(tmpDir, 'stamp-ws');
    await fse.ensureDir(wsCwd);
    await setupConfig({
      [wsCwd]: { projectId: 40, projectName: 'stamp', boundAt: 'x' },
    });

    const { stampWorkspaceTool, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const realWsCwd = fse.realpathSync(wsCwd);

    const changed = stampWorkspaceTool(config!, realWsCwd, 'codebuddy');
    expect(changed).toBe(true);
    expect(config!.workspaceBindings[realWsCwd].ideType).toBe('codebuddy');

    // Calling again with same tool is idempotent.
    const changedAgain = stampWorkspaceTool(config!, realWsCwd, 'codebuddy');
    expect(changedAgain).toBe(false);
  });

  it('stampWorkspaceTool returns false when currentPath is null or undefined', async () => {
    const wsCwd = path.join(tmpDir, 'stamp-null-ws');
    await fse.ensureDir(wsCwd);
    await setupConfig({
      [wsCwd]: { projectId: 41, projectName: 'stamp-null', boundAt: 'x' },
    });

    const { stampWorkspaceTool, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const realWsCwd = fse.realpathSync(wsCwd);

    expect(stampWorkspaceTool(config!, null, 'codebuddy')).toBe(false);
    expect(stampWorkspaceTool(config!, undefined, 'codebuddy')).toBe(false);
    // Config must be untouched.
    expect(config!.workspaceBindings[realWsCwd].ideType).toBeUndefined();
  });

  it('stampWorkspaceTool returns false when currentPath has no binding in config', async () => {
    await setupConfig({});

    const { stampWorkspaceTool, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();

    const missingPath = path.join(tmpDir, 'no-such-binding');
    expect(stampWorkspaceTool(config!, missingPath, 'codebuddy')).toBe(false);
  });

  it('buildSyncPayload filters by tool matching ideType', async () => {
    const wsCb = path.join(tmpDir, 'sync-cb');
    const wsWb = path.join(tmpDir, 'sync-wb');
    await fse.ensureDir(wsCb);
    await fse.ensureDir(wsWb);
    await setupConfig({
      [wsCb]: { projectId: 50, projectName: 'sync-cb', boundAt: 'x', ideType: 'codebuddy' },
      [wsWb]: { projectId: 51, projectName: 'sync-wb', boundAt: 'x', ideType: 'workbuddy' },
    });

    const { buildSyncPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();

    const cbPayload = await buildSyncPayload(config!, { tool: 'codebuddy' }) as {
      workspaces?: Array<Record<string, unknown>>;
    };
    expect(cbPayload.workspaces).toHaveLength(1);
    expect(cbPayload.workspaces![0].path).toBe(fse.realpathSync(wsCb));
    expect(cbPayload.workspaces![0].ide_type).toBe('codebuddy');

    const wbPayload = await buildSyncPayload(config!, { tool: 'workbuddy' }) as {
      workspaces?: Array<Record<string, unknown>>;
    };
    expect(wbPayload.workspaces).toHaveLength(1);
    expect(wbPayload.workspaces![0].path).toBe(fse.realpathSync(wsWb));
    expect(wbPayload.workspaces![0].ide_type).toBe('workbuddy');
  });
});

describe('local-agent: CloudStudio sandbox suppression', () => {
  afterEach(() => {
    delete process.env.X_IDE_IS_CLOUDSTUDIO;
    delete process.env.TEAMAI_ALLOW_SANDBOX_REPORT;
  });

  it('skips report but still runs sync when X_IDE_IS_CLOUDSTUDIO=TRUE', async () => {
    process.env.X_IDE_IS_CLOUDSTUDIO = 'TRUE';
    await setupConfig();
    let reportCalled = false;
    let syncCalled = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/report')) reportCalled = true;
      if (url.includes('/sync')) syncCalled = true;
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const result = await reportAndSyncLocalAgent({ tool: 'claude', cwd: tmpDir });
    expect(reportCalled).toBe(false);
    expect(syncCalled).toBe(true);
    expect(result).toBe(true);
  });

  it('proceeds with normal reporting when TEAMAI_ALLOW_SANDBOX_REPORT=1 overrides sandbox', async () => {
    process.env.X_IDE_IS_CLOUDSTUDIO = 'TRUE';
    process.env.TEAMAI_ALLOW_SANDBOX_REPORT = '1';
    await setupConfig();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'claude', cwd: tmpDir });

    expect(fetchMock).toHaveBeenCalled();
  });

  it('proceeds with normal reporting when no sandbox env is set', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    await setupConfig();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'claude', cwd: tmpDir });

    expect(fetchMock).toHaveBeenCalled();
  });

  it('skips report but still runs sync when /var/run/cloudstudio exists', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).includes('cloudstudio'));
    await setupConfig();
    let reportCalled = false;
    let syncCalled = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/report')) reportCalled = true;
      if (url.includes('/sync')) syncCalled = true;
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const result = await reportAndSyncLocalAgent({ tool: 'claude', cwd: tmpDir });
    expect(reportCalled).toBe(false);
    expect(syncCalled).toBe(true);
    expect(result).toBe(true);
  });

  it('does not prune workspace bindings or rewrite config inside the sandbox', async () => {
    process.env.X_IDE_IS_CLOUDSTUDIO = 'TRUE';
    // A binding whose workspace path does not exist on disk — outside the sandbox
    // this would be pruned and the config rewritten. Inside the sandbox it must survive.
    const deadPath = path.join(tmpDir, 'not-mounted-in-container');
    await setupConfig({ [deadPath]: { projectId: 7, projectName: 'dead-ws', boundAt: '2026-01-01T00:00:00.000Z' } });
    const configPath = path.join(tmpDir, '.teamai', 'local-agent', 'config.json');
    const before = await fse.readJson(configPath);

    let syncCalled = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/sync')) syncCalled = true;
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    const result = await reportAndSyncLocalAgent({ tool: 'claude', cwd: tmpDir });

    const after = await fse.readJson(configPath);
    // Binding preserved + config untouched (no prune/save ran).
    expect(after.workspaceBindings).toEqual(before.workspaceBindings);
    expect(after.workspaceBindings[deadPath]).toBeTruthy();
    // Sync still runs so pushed cmds are delivered.
    expect(syncCalled).toBe(true);
    expect(result).toBe(true);
  });

  it('still emits binding hint (stdout) but skips HTTP report inside sandbox', async () => {
    process.env.X_IDE_IS_CLOUDSTUDIO = 'TRUE';
    process.env.TEAMAI_BIND_PROMPT_ENABLED = '1';
    await setupConfig();
    const projectDir = path.join(tmpDir, 'sandbox-unbound-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    let reportCalled = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/projects/mine')) {
        return new Response(JSON.stringify({
          ok: true,
          projects: [{ id: 100, name: 'alpha' }],
        }));
      }
      if (url.includes('/report')) reportCalled = true;
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    let result: boolean;
    try {
      const { reportAndSyncLocalAgent } = await import('../local-agent.js');
      result = await reportAndSyncLocalAgent({
        cwd: projectDir,
        tool: 'claude',
        event: { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId: 'test-session', tool: 'claude' },
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = stdoutChunks.join('');
    // Binding hint must still be injected via stdout even inside the sandbox.
    expect(output).toContain('hookSpecificOutput');
    expect(output).toContain('绑定到「alpha」项目');
    // But the HTTP report must be skipped; sync still runs, function returns true.
    expect(reportCalled).toBe(false);
    expect(result).toBe(true);
  });
});

describe('local-agent: parseTeamaiCmd tokenizer', () => {
  it('splits quoted args and keeps spaces inside quotes', async () => {
    const { parseTeamaiCmd } = await import('../local-agent.js');
    expect(parseTeamaiCmd('teamai foo --name "a b"')).toEqual(['teamai', 'foo', '--name', 'a b']);
    expect(parseTeamaiCmd("teamai uninstall --agent 'claude code'")).toEqual(
      ['teamai', 'uninstall', '--agent', 'claude code'],
    );
  });

  it('rejects a non-teamai first token', async () => {
    const { parseTeamaiCmd } = await import('../local-agent.js');
    expect(() => parseTeamaiCmd('rm -rf /')).toThrow(/only "teamai"/);
  });

  it('rejects empty input and unterminated quotes', async () => {
    const { parseTeamaiCmd } = await import('../local-agent.js');
    expect(() => parseTeamaiCmd('   ')).toThrow(/Empty cmd/);
    expect(() => parseTeamaiCmd('teamai "oops')).toThrow(/Unterminated quote/);
  });
});

describe('local-agent: uninstall_teamai command execution', () => {
  let origArgv1: string;
  let helperScript: string;
  let sideEffectFile: string;

  beforeEach(async () => {
    origArgv1 = process.argv[1];
    sideEffectFile = path.join(tmpDir, 'cmd-ran.marker');
  });

  afterEach(() => {
    process.argv[1] = origArgv1;
    delete process.env.TEAMAI_DISABLE_REMOTE_CMD;
  });

  // Write a throwaway node script and point the cmd entry resolver at it via
  // process.argv[1], so runCmdCommand execs `node <helper> <args>` for real
  // without needing a built teamai binary.
  async function installHelper(bodyLines: string[]): Promise<void> {
    helperScript = path.join(tmpDir, 'fake-teamai-entry.mjs');
    await fse.writeFile(helperScript, bodyLines.join('\n'));
    process.argv[1] = helperScript;
  }

  interface AckBody {
    id: number;
    type: string;
    status: string;
    error?: string;
    version?: string;
  }

  // fetch mock that returns exactly one command from /sync and records the ack.
  function stubFetchWithCommand(command: Record<string, unknown>): { getAck: () => AckBody | undefined } {
    let ackBody: AckBody | undefined;
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('/commands/ack')) {
        ackBody = JSON.parse(init?.body ?? '{}');
        return new Response(JSON.stringify({ ok: true }));
      }
      if (url.includes('/sync')) {
        return new Response(JSON.stringify({ ok: true, cmds: [command] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);
    return { getAck: () => ackBody };
  }

  it('runs the uninstall_teamai cmd and acks success', async () => {
    await setupConfig();
    await installHelper([
      `import fs from 'node:fs';`,
      `fs.writeFileSync(${JSON.stringify(sideEffectFile)}, 'ran');`,
      `process.stdout.write('uninstalled');`,
    ]);
    const { getAck } = stubFetchWithCommand({
      id: 6,
      type: 'uninstall_teamai',
      cmd: 'teamai uninstall --force --agent codebuddy',
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', cwd: tmpDir });

    // The uninstall actually executed (helper ran) instead of being skipped.
    expect(fs.existsSync(sideEffectFile)).toBe(true);
    const ack = getAck();
    expect(ack).toBeDefined();
    if (!ack) return;
    expect(ack.id).toBe(6);
    expect(ack.type).toBe('uninstall_teamai');
    expect(ack.status).toBe('success');
  });

  it('rejects a non-teamai cmd without executing it and acks failed', async () => {
    await setupConfig();
    await installHelper([
      `import fs from 'node:fs';`,
      `fs.writeFileSync(${JSON.stringify(sideEffectFile)}, 'ran');`,
    ]);
    const { getAck } = stubFetchWithCommand({ id: 8, type: 'uninstall_teamai', cmd: 'rm -rf /' });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', cwd: tmpDir });

    expect(fs.existsSync(sideEffectFile)).toBe(false);
    const ack = getAck();
    expect(ack).toBeDefined();
    if (!ack) return;
    expect(ack.status).toBe('failed');
    expect(ack.error).toMatch(/only "teamai"/);
  });

  it('acks failed with "disabled" when TEAMAI_DISABLE_REMOTE_CMD=1', async () => {
    await setupConfig();
    process.env.TEAMAI_DISABLE_REMOTE_CMD = '1';
    await installHelper([
      `import fs from 'node:fs';`,
      `fs.writeFileSync(${JSON.stringify(sideEffectFile)}, 'ran');`,
    ]);
    const { getAck } = stubFetchWithCommand({
      id: 9,
      type: 'uninstall_teamai',
      cmd: 'teamai uninstall --force --agent codebuddy',
    });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', cwd: tmpDir });

    expect(fs.existsSync(sideEffectFile)).toBe(false);
    const ack = getAck();
    expect(ack).toBeDefined();
    if (!ack) return;
    expect(ack.status).toBe('failed');
    expect(ack.error).toMatch(/disabled/);
  });

  it('acks failed with stderr detail when the subcommand exits non-zero', async () => {
    await setupConfig();
    await installHelper([
      `process.stderr.write('boom happened');`,
      `process.exit(3);`,
    ]);
    const { getAck } = stubFetchWithCommand({ id: 10, type: 'uninstall_teamai', cmd: 'teamai explode' });

    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ tool: 'codebuddy', cwd: tmpDir });

    const ack = getAck();
    expect(ack).toBeDefined();
    if (!ack) return;
    expect(ack.status).toBe('failed');
    expect(ack.error).toMatch(/cmd failed/);
    expect(ack.error).toMatch(/boom happened/);
  });
});

describe('local-agent: cmds[] migration', () => {
  async function makeSkillZip(skillName: string): Promise<Uint8Array> {
    const { zipSync, strToU8 } = await import('fflate');
    const skillMd = `---\nname: ${skillName}\ndescription: test skill\n---\n# ${skillName}\nbody\n`;
    return zipSync({ [`${skillName}/SKILL.md`]: strToU8(skillMd) });
  }

  async function runResponse(body: Record<string, unknown>, zip?: Uint8Array, tool: string = 'codebuddy') {
    await fse.ensureDir(path.join(tmpDir, '.codebuddy', 'skills'));
    await setupConfig();
    const acks: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/skill.zip') && zip) return new Response(Buffer.from(zip));
      if (url.endsWith('.md')) return new Response('# content\nbody\n');
      if (url.includes('/local-agent/sync')) return new Response(JSON.stringify({ ok: true, ...body }));
      if (url.includes('/commands/ack')) acks.push(JSON.parse(init?.body ?? '{}'));
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { reportAndSyncLocalAgent } = await import('../local-agent.js');
    await reportAndSyncLocalAgent({ cwd: tmpDir, tool, status: 'running' });
    return acks;
  }

  it('prefers cmds[] over commands[]', async () => {
    const zip = await makeSkillZip('skill-a');
    const acks = await runResponse({
      cmds: [{
        id: 1, type: 'install_skill', slug: 'skill-a', version: '1.0.0',
        download_url: 'http://127.0.0.1:42100/skill.zip', scope: 'user',
      }],
      commands: [{ id: 9, type: 'uninstall_skill', skill_slug: 'skill-a' }],
    }, zip);

    await expect(fse.pathExists(path.join(tmpDir, '.codebuddy', 'skills', 'skill-a'))).resolves.toBe(true);
    expect(acks.find((a) => a.id === 1)?.status).toBe('success');
    expect(acks.find((a) => a.id === 9)).toBeUndefined();
  });

  it('handle_type=prompt routes to claudemd', async () => {
    const acks = await runResponse({
      cmds: [{
        id: 2, type: 'install_prompt_rule', handle_type: 'prompt', slug: 'doc-a',
        version: '1.0.0', download_url: 'http://127.0.0.1:42100/doc-a.md', scope: 'user',
      }],
    });

    expect(acks.find((a) => a.id === 2)?.status).toBe('success');
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'local-agent', 'manifest.json'));
    expect(manifest.scopes.user.claudemd?.['doc-a']).toBeDefined();
    expect(manifest.scopes.user.rules?.['doc-a']).toBeUndefined();
  });

  it('handle_type=rule routes to rule', async () => {
    const acks = await runResponse({
      cmds: [{
        id: 3, type: 'install_rule_rule', handle_type: 'rule', slug: 'rule-b',
        version: '1.0.0', download_url: 'http://127.0.0.1:42100/rule-b.md', scope: 'user',
      }],
    });

    expect(acks.find((a) => a.id === 3)?.status).toBe('success');
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'local-agent', 'manifest.json'));
    expect(manifest.scopes.user.rules?.['rule-b']).toBeDefined();
    expect(manifest.scopes.user.claudemd?.['rule-b']).toBeUndefined();
  });

  it('consumes unified slug/version (no prefixed fields)', async () => {
    const zip = await makeSkillZip('skill-c');
    const acks = await runResponse({
      cmds: [{
        id: 4, type: 'install_skill', slug: 'skill-c', version: '1.0.0',
        download_url: 'http://127.0.0.1:42100/skill.zip', scope: 'user',
      }],
    }, zip);

    await expect(fse.pathExists(path.join(tmpDir, '.codebuddy', 'skills', 'skill-c'))).resolves.toBe(true);
    expect(acks.find((a) => a.id === 4)?.version).toBe('1.0.0');
  });

  it('install_hook_rule writes a slug-tagged claude hook with default timeout', async () => {
    const acks = await runResponse({
      cmds: [{
        id: 20, type: 'install_hook_rule', handle_type: 'hook', slug: 'hk1',
        event: 'SessionStart', cmd: 'echo hi', scope: 'user',
      }],
    });
    expect(acks.find((a) => a.id === 20)?.status).toBe('success');
    const settings = await fse.readJson(path.join(tmpDir, '.codebuddy', 'settings.json'));
    const entries = settings.hooks.SessionStart;
    const mine = entries.find((e: any) => e.description === agentHookDescription('hk1'));
    expect(mine).toBeDefined();
    expect(mine.hooks[0].command).toBe('echo hi');
    expect(mine.hooks[0].timeout).toBe(10);
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'local-agent', 'agent-hooks.json'));
    expect(manifest.hk1).toMatchObject({ tool: 'codebuddy', event: 'SessionStart', command: 'echo hi', timeout: 10 });
  });

  it('honors explicit timeout and replaces on re-install (idempotent)', async () => {
    const cmd21 = {
      id: 21, type: 'install_hook_rule', handle_type: 'hook', slug: 'hk2',
      event: 'Stop', cmd: 'echo a', timeout: 30, scope: 'user',
    };
    await runResponse({ cmds: [cmd21] });
    const cmd22 = {
      id: 22, type: 'install_hook_rule', handle_type: 'hook', slug: 'hk2',
      event: 'Stop', cmd: 'echo b', timeout: 45, scope: 'user',
    };
    const acks2 = await runResponse({ cmds: [cmd22] });
    expect(acks2.find((a) => a.id === 22)?.status).toBe('success');
    const settings = await fse.readJson(path.join(tmpDir, '.codebuddy', 'settings.json'));
    const mine = settings.hooks.Stop.filter((e: any) => e.description === agentHookDescription('hk2'));
    expect(mine).toHaveLength(1);
    expect(mine[0].hooks[0].command).toBe('echo b');
    expect(mine[0].hooks[0].timeout).toBe(45);
  });

  it('install_hook_rule writes a codex hook (no description, command-matched)', async () => {
    await fse.ensureDir(path.join(tmpDir, '.codex'));
    const cmd23 = {
      id: 23, type: 'install_hook_rule', handle_type: 'hook', slug: 'hk3',
      event: 'PreToolUse', cmd: 'echo cx', scope: 'user',
    };
    const acks = await runResponse({ cmds: [cmd23] }, undefined, 'codex');
    expect(acks.find((a) => a.id === 23)?.status).toBe('success');
    const hooksJson = await fse.readJson(path.join(tmpDir, '.codex', 'hooks.json'));
    const mine = hooksJson.hooks.PreToolUse.find((e: any) => e.hooks[0].command === 'echo cx');
    expect(mine).toBeDefined();
  });

  it('re-install same codex slug with a new command leaves no stale entry', async () => {
    const first = {
      id: 30, type: 'install_hook_rule', handle_type: 'hook', slug: 'cxr',
      event: 'PreToolUse', cmd: 'echo old', scope: 'user',
    };
    await fse.ensureDir(path.join(tmpDir, '.codex'));
    await runResponse({ cmds: [first] }, undefined, 'codex');
    const second = {
      id: 31, type: 'install_hook_rule', handle_type: 'hook', slug: 'cxr',
      event: 'PreToolUse', cmd: 'echo new', scope: 'user',
    };
    const acks = await runResponse({ cmds: [second] }, undefined, 'codex');
    expect(acks.find((a) => a.id === 31)?.status).toBe('success');
    const hooksJson = await fse.readJson(path.join(tmpDir, '.codex', 'hooks.json'));
    const cmds = (hooksJson.hooks.PreToolUse ?? []).map((e: any) => e.hooks[0].command);
    expect(cmds).toContain('echo new');
    expect(cmds).not.toContain('echo old');
    const manifest = await fse.readJson(
      path.join(tmpDir, '.teamai', 'local-agent', 'agent-hooks.json'),
    );
    expect(manifest.cxr?.command).toBe('echo new');
  });

  it('uninstall_hook_rule removes the entry and manifest record; missing slug is success', async () => {
    const cmd24 = {
      id: 24, type: 'install_hook_rule', handle_type: 'hook', slug: 'hk4',
      event: 'SessionStart', cmd: 'echo x', scope: 'user',
    };
    await runResponse({ cmds: [cmd24] });
    const cmd25 = {
      id: 25, type: 'uninstall_hook_rule', handle_type: 'hook', slug: 'hk4', scope: 'user',
    };
    const acks = await runResponse({ cmds: [cmd25] });
    expect(acks.find((a) => a.id === 25)?.status).toBe('success');
    const settings = await fse.readJson(path.join(tmpDir, '.codebuddy', 'settings.json'));
    const isHk4 = (e: any) => e.description === agentHookDescription('hk4');
    const remaining = (settings.hooks.SessionStart ?? []).filter(isHk4);
    expect(remaining).toHaveLength(0);
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'local-agent', 'agent-hooks.json'));
    expect(manifest.hk4).toBeUndefined();
    // Missing slug → idempotent success.
    const cmd26 = {
      id: 26, type: 'uninstall_hook_rule', handle_type: 'hook', slug: 'nope', scope: 'user',
    };
    const acks2 = await runResponse({ cmds: [cmd26] });
    expect(acks2.find((a) => a.id === 26)?.status).toBe('success');
  });

  it('rejects invalid install_hook_rule with a failed ack', async () => {
    const cmd27 = {
      id: 27, type: 'install_hook_rule', handle_type: 'hook', slug: 'bad1',
      cmd: 'echo x', scope: 'user',
    };
    const a1 = await runResponse({ cmds: [cmd27] });
    expect(a1.find((a) => a.id === 27)?.status).toBe('failed');
    expect(String(a1.find((a) => a.id === 27)?.error)).toMatch(/event|cmd/i);

    const cmd28 = {
      id: 28, type: 'install_hook_rule', handle_type: 'hook', slug: 'bad2',
      event: 'NotAnEvent', cmd: 'echo x', scope: 'user',
    };
    const a2 = await runResponse({ cmds: [cmd28] });
    expect(a2.find((a) => a.id === 28)?.status).toBe('failed');
    expect(String(a2.find((a) => a.id === 28)?.error)).toMatch(/unsupported event/i);

    await fse.ensureDir(path.join(tmpDir, '.cursor'));
    const cmd29 = {
      id: 29, type: 'install_hook_rule', handle_type: 'hook', slug: 'bad3',
      event: 'SessionStart', cmd: 'echo x', scope: 'user',
    };
    const a3 = await runResponse({ cmds: [cmd29] }, undefined, 'cursor');
    expect(a3.find((a) => a.id === 29)?.status).toBe('failed');
    expect(String(a3.find((a) => a.id === 29)?.error)).toMatch(/unsupported tool/i);
  });

  it('rejects install_hook_rule when TEAMAI_DISABLE_REMOTE_CMD=1', async () => {
    const prev = process.env.TEAMAI_DISABLE_REMOTE_CMD;
    process.env.TEAMAI_DISABLE_REMOTE_CMD = '1';
    try {
      const cmd40 = {
        id: 40, type: 'install_hook_rule', handle_type: 'hook', slug: 'gated',
        event: 'SessionStart', cmd: 'echo x', scope: 'user',
      };
      const acks = await runResponse({ cmds: [cmd40] });
      expect(acks.find((a) => a.id === 40)?.status).toBe('failed');
      expect(String(acks.find((a) => a.id === 40)?.error)).toMatch(/disabled/i);
      const settings = path.join(tmpDir, '.codebuddy', 'settings.json');
      const written = (await fse.pathExists(settings)) ? await fse.readJson(settings) : {};
      const hooks = written.hooks?.SessionStart ?? [];
      expect(hooks.some((e: any) => e.description === agentHookDescription('gated'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TEAMAI_DISABLE_REMOTE_CMD;
      else process.env.TEAMAI_DISABLE_REMOTE_CMD = prev;
    }
  });

  it('skips an unknown hook type (handle_type=hook) without a failed ack', async () => {
    // A future hook `type` outside the known set must still skip silently via
    // handle_type, not fall through to commandKind() and get acked as failed.
    const acks = await runResponse({
      cmds: [{
        id: 11, type: 'toggle_hook_rule', handle_type: 'hook', slug: 'hook-future',
        version: '1.0.0', event: 'SessionStart', cmd: 'echo hi', scope: 'user',
      }],
    });

    expect(acks.find((a) => a.id === 11)).toBeUndefined();
  });

  it('falls back to commands[] when cmds absent', async () => {
    const zip = await makeSkillZip('skill-legacy');
    const acks = await runResponse({
      commands: [{
        id: 8, type: 'install_skill', skill_slug: 'skill-legacy', skill_version: '1.0.0',
        download_url: 'http://127.0.0.1:42100/skill.zip', scope: 'user',
      }],
    }, zip);

    await expect(fse.pathExists(path.join(tmpDir, '.codebuddy', 'skills', 'skill-legacy'))).resolves.toBe(true);
    expect(acks.find((a) => a.id === 8)?.status).toBe('success');
  });

  it('empty cmds[] falls back to commands[]', async () => {
    const zip = await makeSkillZip('skill-empty');
    const acks = await runResponse({
      cmds: [],
      commands: [{
        id: 9, type: 'install_skill', skill_slug: 'skill-empty', skill_version: '1.0.0',
        download_url: 'http://127.0.0.1:42100/skill.zip', scope: 'user',
      }],
    }, zip);

    await expect(fse.pathExists(path.join(tmpDir, '.codebuddy', 'skills', 'skill-empty'))).resolves.toBe(true);
    expect(acks.find((a) => a.id === 9)?.status).toBe('success');
  });
});
