import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── E2E for unified hooks (issue #19) ──────────────────────
//
// Spawns the real `teamai` CLI against a temp $HOME with a fake team repo
// containing hooks/hooks.yaml, exercising the full command path:
//   CLI → hooksInject/hooksList/hooksRemove → resolveTeamHooks → reconcile → disk

const CLI_PATH = path.resolve(__dirname, '../../dist/index.js');
const execFileAsync = promisify(execFile);

let home: string;
let repo: string;

function run(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', [CLI_PATH, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, ...env },
  }).catch((e: { stdout?: string; stderr?: string; message: string }) => ({
    stdout: e.stdout ?? '',
    stderr: e.stderr ?? e.message,
  }));
}

function writeConfig(): void {
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.teamai', 'config.yaml'),
    `repo:\n  localPath: ${repo}\n  remote: https://example.com/repo.git\nusername: tester\nscope: user\nadditionalRoles: []\n`,
  );
  fs.writeFileSync(path.join(repo, 'teamai.yaml'), `team: test-team\nrepo: https://example.com/repo.git\n`);
}

function writeHooksYaml(content: string): void {
  fs.mkdirSync(path.join(repo, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'hooks', 'hooks.yaml'), content);
}

function readJson(p: string): Record<string, never> {
  return JSON.parse(fs.readFileSync(path.join(home, p), 'utf-8'));
}

const TEAM_HOOK = `hooks:\n  - id: lint\n    description: run lint at stop\n    event: Stop\n    command: npm run lint\n    tools: [claude, cursor, codex]\n`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hooks-e2e-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hooks-e2e-repo-'));
  writeConfig();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('teamai hooks — unified A+B end-to-end', () => {
  it('injects built-in + team hooks across tools and records the manifest', async () => {
    writeHooksYaml(TEAM_HOOK);
    const { stderr } = await run(['hooks', 'inject', '--silent']);
    expect(stderr).not.toMatch(/Error|not initialized/i);

    const claude = readJson('.claude/settings.json') as unknown as {
      hooks: Record<string, Array<{ description?: string; hooks: Array<{ command: string }> }>>;
    };
    // Built-in dispatch hooks present.
    expect(claude.hooks.SessionStart[0].hooks[0].command).toContain('hook-dispatch');
    // Team hook appended to Stop.
    const teamHook = claude.hooks.Stop.find((h) => h.description?.startsWith('[teamai:hook:lint]'));
    expect(teamHook).toBeDefined();
    expect(teamHook!.hooks[0].command).toBe('npm run lint');

    const cursor = readJson('.cursor/hooks.json') as unknown as { hooks: Record<string, Array<{ command: string }>> };
    expect(cursor.hooks.stop.some((h) => h.command === 'npm run lint')).toBe(true);

    const codex = readJson('.codex/hooks.json') as unknown as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(codex.hooks.Stop.some((h) => h.hooks[0].command === 'npm run lint')).toBe(true);

    const manifest = readJson('.teamai/managed-hooks.json') as unknown as Record<string, Array<{ id: string }>>;
    expect(manifest.claude.map((r) => r.id)).toContain('lint');
    expect(manifest.codex.map((r) => r.id)).toContain('lint');
  });

  it('`hooks list` audits built-in and team hooks', async () => {
    writeHooksYaml(TEAM_HOOK);
    const { stdout } = await run(['hooks', 'list']);
    expect(stdout).toContain('Built-in hooks (A)');
    expect(stdout).toContain('hook-dispatch');
    expect(stdout).toContain('Team hooks (B)');
    expect(stdout).toContain('[lint] Stop');
    expect(stdout).toContain('npm run lint');
  });

  it('re-inject after removing the team hook from yaml drops it but keeps built-in', async () => {
    writeHooksYaml(TEAM_HOOK);
    await run(['hooks', 'inject', '--silent']);
    writeHooksYaml('hooks: []');
    await run(['hooks', 'inject', '--silent']);

    const claude = readJson('.claude/settings.json') as unknown as {
      hooks: Record<string, Array<{ description?: string }>>;
    };
    expect(claude.hooks.Stop.some((h) => h.description?.startsWith('[teamai:hook:lint]'))).toBe(false);
    expect(claude.hooks.Stop.some((h) => h.description?.startsWith('[teamai] '))).toBe(true);
  });

  it('TEAMAI_HOOKS_DISABLED kill-switch skips team hooks but keeps built-in', async () => {
    writeHooksYaml(TEAM_HOOK);
    await run(['hooks', 'inject', '--silent'], { TEAMAI_HOOKS_DISABLED: '1' });

    const claude = readJson('.claude/settings.json') as unknown as {
      hooks: Record<string, Array<{ description?: string }>>;
    };
    expect(claude.hooks.Stop.some((h) => h.description?.startsWith('[teamai:hook:lint]'))).toBe(false);
    expect(claude.hooks.SessionStart).toHaveLength(1); // built-in still injected
  });

  it('`hooks remove` strips all teamai hooks (A + B)', async () => {
    writeHooksYaml(TEAM_HOOK);
    await run(['hooks', 'inject', '--silent']);
    await run(['hooks', 'remove']);

    const claude = readJson('.claude/settings.json') as unknown as { hooks: Record<string, unknown[]> };
    for (const entries of Object.values(claude.hooks)) {
      expect(entries).toHaveLength(0);
    }
  });
});
