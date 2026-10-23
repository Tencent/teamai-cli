/**
 * agent-session-tool-roots.test.ts — session stores of a relocated Claude Code or Codex.
 *
 * A member who moved a tool (CLAUDE_CONFIG_DIR, CODEX_HOME) records the root with `teamai init`
 * (`toolRoots.<tool>`). AgentSession reads and writes that tool's sessions under the recorded
 * root, never under the default one, and never from the variable itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const mocks = vi.hoisted(() => ({ home: '' }));
/** The PATH this file started with: resume reads the workspace's remote through the real CLI. */
const startPath = process.env.PATH ?? '';

// Default storage paths come from os.homedir(); keep them under the temporary home too.
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { AgentSession, toolRootsLookup } from '../session-flow/agent-session.js';
import { ClaudeCodeAdapter } from '../session-flow/adapters/index.js';
import type { Session } from '../session-flow/ir.js';
import { registerSessionFlowCommands } from '../session-flow/session-cmd.js';
import { SyncManager, defaultSyncMeta, encodeRepoIdentity } from '../session-flow/sync.js';

/** Run `teamai session <argv>` and return what it printed. */
async function runSession(...argv: string[]): Promise<string> {
  const printed: string[] = [];
  const capture = (...a: unknown[]) => void printed.push(a.map(String).join(' '));
  const log = vi.spyOn(console, 'log').mockImplementation(capture);
  const error = vi.spyOn(console, 'error').mockImplementation(capture);
  try {
    const program = new Command();
    program.option('--dry-run', 'preview');
    registerSessionFlowCommands(program.command('session'));
    await program.parseAsync(['node', 'teamai', 'session', ...argv]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return printed.join('\n');
}

function mkSession(cwd: string, text: string): Session {
  return {
    sessionId: `source-${text.replace(/ /g, '-')}`,
    title: text,
    cwd,
    platform: 'claude-code',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:05.000Z',
    messages: [
      { role: 'user', timestamp: '2026-10-01T10:00:00.000Z', content: [{ type: 'text', text }] },
      { role: 'assistant', timestamp: '2026-10-01T10:00:05.000Z', content: [{ type: 'text', text: 'ok' }] },
    ],
    metadata: {},
  };
}

/** A workspace that exists, spelled the way the file system stores it. */
function workspace(name: string): string {
  const dir = path.join(mocks.home, 'work', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

/** What `teamai init` records for a member whose tools live under `toolRoots`. */
function recordToolRoots(toolRoots: Record<string, string>): void {
  const configPath = path.join(mocks.home, '.teamai', 'config.yaml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify({
    repo: { localPath: path.join(mocks.home, '.teamai', 'team-repo'), remote: 'https://example.test/t/r.git' },
    username: 'u',
    scope: 'user',
    additionalRoles: [],
    toolRoots,
  }));
}

/** Write a Claude Code session straight into the `projects` store under `root`. */
async function plantClaude(root: string, cwd: string, text: string): Promise<string> {
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  return new ClaudeCodeAdapter('claude-code', projects).writeSession(mkSession(cwd, text), cwd);
}

beforeEach(() => {
  mocks.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamairoots')));
  vi.stubEnv('HOME', mocks.home);
  vi.stubEnv('USERPROFILE', mocks.home);
  // Only the recorded root counts: a variable in this shell must change nothing.
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('CODEX_HOME', '');
  // Keep Codex's indexing step from starting a real CLI.
  vi.stubEnv('PATH', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('AgentSession with a recorded Claude Code root', () => {
  it('lists the sessions under <root>/projects, not ~/.claude/projects', async () => {
    const root = path.join(mocks.home, '.claude-work');
    recordToolRoots({ claude: root });
    const cwd = workspace('alpha');
    const relocated = await plantClaude(root, cwd, 'relocated work');
    const stale = await plantClaude(path.join(mocks.home, '.claude'), cwd, 'stale work');

    const listed = await AgentSession.list({ platforms: ['claude-code'] });

    expect(listed.failures).toEqual([]);
    expect(listed.sessions.map((s) => s.sessionId)).toEqual([relocated]);
    expect(listed.sessions.map((s) => s.sessionId)).not.toContain(stale);
  });

  it('finds a session by id under <root>/projects', async () => {
    const root = path.join(mocks.home, '.claude-work');
    recordToolRoots({ claude: root });
    const cwd = workspace('alpha');
    const relocated = await plantClaude(root, cwd, 'relocated work');

    const found = await AgentSession.find({ platform: 'claude-code', sessionId: relocated, cwd });

    expect(found.status).toBe('done');
    expect(found.status === 'done' && found.session.title).toBe('relocated work');
  });

  it('writes a copy under <root>/projects, where the relocated Claude Code resumes it', async () => {
    const root = path.join(mocks.home, '.claude-work');
    recordToolRoots({ claude: root });
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
    const source = workspace('source');
    const target = workspace('target');
    const variantRoot = path.join(mocks.home, '.claude-internal', 'projects');
    fs.mkdirSync(variantRoot, { recursive: true });
    const sourceId = await new ClaudeCodeAdapter('claude-internal', variantRoot).writeSession(mkSession(source, 'variant work'), source);

    const copied = await AgentSession.copy({
      from: { platform: 'claude-internal', sessionId: sourceId, cwd: source },
      to: { platform: 'claude-code', cwd: target },
    });

    expect(copied.status).toBe('done');
    if (copied.status !== 'done') return;
    expect(path.relative(path.join(root, 'projects'), copied.filePath ?? '')).toMatch(/^[^.][^/]*\/[^/]+\.jsonl$/);
    expect(fs.existsSync(copied.filePath ?? '')).toBe(true);
    expect(fs.existsSync(path.join(mocks.home, '.claude', 'projects'))).toBe(false);
  });
});

describe('AgentSession with a recorded Codex root', () => {
  it('writes a copy under <root>/sessions and indexes it with CODEX_HOME set to <root>', async () => {
    const claudeRoot = path.join(mocks.home, '.claude-work');
    const codexRoot = path.join(mocks.home, '.codex-work');
    recordToolRoots({ claude: claudeRoot, codex: codexRoot });
    fs.mkdirSync(path.join(codexRoot, 'sessions'), { recursive: true });
    const source = workspace('source');
    const target = workspace('target');
    const sourceId = await plantClaude(claudeRoot, source, 'relocated work');
    // A stand-in Codex CLI that notes the CODEX_HOME each indexing call was started with.
    const bin = path.join(mocks.home, 'bin');
    const seen = path.join(mocks.home, 'codex-home.log');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'codex'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.0.0'; exit 0; fi\nprintf '%s\\n' "$CODEX_HOME" >> '${seen}'\n`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', bin);

    const copied = await AgentSession.copy({
      from: { platform: 'claude-code', sessionId: sourceId, cwd: source },
      to: { platform: 'codex', cwd: target },
    });

    expect(copied.status).toBe('done');
    if (copied.status !== 'done') return;
    expect(copied.filePath?.startsWith(path.join(codexRoot, 'sessions') + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(mocks.home, '.codex'))).toBe(false);
    expect(fs.readFileSync(seen, 'utf8').trim().split('\n')).toEqual([codexRoot]);
  });
});

describe('session commands with a recorded Claude Code root', () => {
  it('rollback removes a copy under <root>/projects', async () => {
    const root = path.join(mocks.home, '.claude-work');
    recordToolRoots({ claude: root });
    const cwd = workspace('target');
    const id = await plantClaude(root, cwd, 'migrated work');

    const printed = await runSession('rollback', id, '--platform', 'claude-code', '--cwd', cwd);

    expect(printed).toContain(`Rolled back: claude-code/${id}`);
    const left = fs.readdirSync(path.join(root, 'projects'), { recursive: true }) as string[];
    expect(left.filter((f) => f.endsWith('.jsonl'))).toEqual([]);
  });

  it('resume restores an archived session under <root>/projects', async () => {
    const root = path.join(mocks.home, '.claude-work');
    recordToolRoots({ claude: root });
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
    vi.stubEnv('PATH', startPath);
    const cwd = workspace('alpha');
    execFileSync('git', ['init', '-q', cwd]);
    execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'https://github.com/org/alpha.git']);
    const repoRoot = path.join(mocks.home, 'team');
    const session = { ...mkSession(cwd, 'archived work'), sessionId: '0b6f3c1e-5a2d-4c8e-9f10-7a1b2c3d4e5f' };
    await new SyncManager(repoRoot).saveSession(
      session,
      defaultSyncMeta(
        { platform: 'claude-code', author: 'u', cwd, sessionId: session.sessionId, repoIdentity: 'github.com/org/alpha', title: session.title },
        session.createdAt,
      ),
    );
    const index = path.join(repoRoot, 'sessions', 'repos', encodeRepoIdentity('github.com/org/alpha'), '_index.json');
    const [{ sessionName }] = (JSON.parse(fs.readFileSync(index, 'utf-8')) as { sessions: Array<{ sessionName: string }> }).sessions;

    await runSession('resume', sessionName, '--platform', 'claude-code', '--repo-root', repoRoot, '--cwd', cwd);

    const written = (fs.readdirSync(path.join(root, 'projects'), { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl'));
    expect(written).toHaveLength(1);
    expect(fs.existsSync(path.join(mocks.home, '.claude', 'projects'))).toBe(false);
  });

  it('platforms reports Claude Code installed when only <root>/projects exists', async () => {
    recordToolRoots({ claude: path.join(mocks.home, '.claude-work') });
    fs.mkdirSync(path.join(mocks.home, '.claude-work', 'projects'), { recursive: true });

    const printed = await runSession('platforms');

    expect(printed).toContain('claude-code: ✓ installed');
  });
});

describe('toolRootsLookup', () => {
  it('reads each workspace once per run, so one run sees one record per workspace', async () => {
    recordToolRoots({ claude: path.join(mocks.home, '.claude-work') });
    const alpha = workspace('alpha');
    const toolRootsFor = toolRootsLookup();
    const first = await toolRootsFor(alpha);

    recordToolRoots({ claude: path.join(mocks.home, '.claude-other') });

    expect(await toolRootsFor(alpha)).toEqual(first);
    expect(await toolRootsFor(workspace('beta'))).toEqual({ claude: path.join(mocks.home, '.claude-other') });
  });
});

describe('AgentSession with no recorded root', () => {
  it('keeps reading ~/.claude/projects', async () => {
    const cwd = workspace('alpha');
    const id = await plantClaude(path.join(mocks.home, '.claude'), cwd, 'default work');

    const listed = await AgentSession.list({ platforms: ['claude-code'] });

    expect(listed.sessions.map((s) => s.sessionId)).toEqual([id]);
  });
});
