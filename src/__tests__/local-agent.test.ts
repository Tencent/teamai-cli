import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

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

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-la-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
  origPpid = process.ppid;
  // Clean hint markers
  const markerPath = path.join(os.tmpdir(), `teamai-bind-hint-${process.ppid}`);
  await fse.remove(markerPath);
});

afterEach(async () => {
  process.env.HOME = origHome;
  const markerPath = path.join(os.tmpdir(), `teamai-bind-hint-${origPpid}`);
  await fse.remove(markerPath);
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

describe('local-agent: bindCurrentProject --skip', () => {
  it('writes groupId 0 and __skipped__ marker to config', async () => {
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
    expect(binding.groupId).toBe(0);
    expect(binding.groupName).toBe('__skipped__');
    expect(binding.boundAt).toBeTruthy();
  });
});

describe('local-agent: emitBindingHint via reportAndSyncLocalAgent', () => {
  it('outputs hookSpecificOutput with choices when project is unbound', async () => {
    await setupConfig();
    const projectDir = path.join(tmpDir, 'unbound-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    // Mock global fetch to handle /user-groups/mine and /local-agent/report
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/user-groups/mine')) {
        return new Response(JSON.stringify({
          ok: true,
          groups: [
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
    expect(ctx).toContain('绑定到「alpha」组织');
    expect(ctx).toContain('绑定到「beta」组织');
    expect(ctx).toContain('不绑定，以后也不再提示');
    expect(ctx).toContain('teamai bind-project --group-id 100');
    expect(ctx).toContain('teamai bind-project --group-id 200');
    expect(ctx).toContain('teamai bind-project --skip');
  });

  it('does NOT emit hint when project is already bound', async () => {
    const projectDir = path.join(tmpDir, 'bound-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    await setupConfig({
      [projectDir]: { groupId: 1, groupName: 'existing', boundAt: '2026-01-01T00:00:00.000Z' },
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

  it('does NOT emit hint when project is skipped (groupId 0)', async () => {
    const projectDir = path.join(tmpDir, 'skipped-project');
    await fse.ensureDir(projectDir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });

    await setupConfig({
      [projectDir]: { groupId: 0, groupName: '__skipped__', boundAt: '2026-01-01T00:00:00.000Z' },
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
