import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reconcileTeamHooksForConfig } from '../hooks.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

let project: string;
let repo: string;

const teamConfig = {
  toolPaths: {
    claude: { settings: '.claude/settings.json' },
    cursor: { settings: '.cursor/hooks.json' },
    codex: { settings: '.codex/hooks.json' },
  },
} as unknown as TeamaiConfig;

function localConfig(): LocalConfig {
  return {
    repo: { localPath: repo, remote: 'x' },
    username: 'u',
    scope: 'project',
    projectRoot: project,
    additionalRoles: [],
  } as unknown as LocalConfig;
}

async function writeYaml(content: string): Promise<void> {
  await fse.ensureDir(path.join(repo, 'hooks'));
  await fse.writeFile(path.join(repo, 'hooks', 'hooks.yaml'), content);
}
function claudeSettings(): Promise<{ hooks: Record<string, Array<{ description?: string; hooks: Array<{ command: string }> }>> }> {
  return fse.readJson(path.join(project, '.claude', 'settings.json'));
}
function cursorSettings(): Promise<{ hooks: Record<string, Array<{ command: string }>> }> {
  return fse.readJson(path.join(project, '.cursor', 'hooks.json'));
}
function codexSettings(): Promise<{ hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>> }> {
  return fse.readJson(path.join(project, '.codex', 'hooks.json'));
}
function manifest(): Promise<Record<string, Array<{ id: string }>>> {
  return fse.readJson(path.join(project, '.teamai', 'managed-hooks.json'));
}

beforeEach(async () => {
  project = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-proj-'));
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recon-repo-'));
});
afterEach(async () => {
  await fse.remove(project);
  await fse.remove(repo);
});

describe('reconcileTeamHooksForConfig — pull/init core path', () => {
  it('injects built-in + team hooks into each tool, records the manifest', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: run lint at stop
    event: Stop
    command: npm run lint
    timeout: 20
`);
    const defs = await reconcileTeamHooksForConfig(teamConfig, localConfig());
    expect(defs).toHaveLength(1);

    const claude = await claudeSettings();
    expect(claude.hooks.Stop).toHaveLength(2); // built-in + team
    expect(claude.hooks.Stop[1].description).toBe('[teamai:hook:lint] run lint at stop');

    const cursor = await cursorSettings();
    expect(cursor.hooks.stop).toHaveLength(2);
    expect(cursor.hooks.stop.some((h) => h.command === 'npm run lint')).toBe(true);

    const codex = await codexSettings();
    expect(codex.hooks.Stop).toHaveLength(2);
    expect(codex.hooks.Stop.some((h) => h.hooks[0].command === 'npm run lint')).toBe(true);

    const m = await manifest();
    expect(m.claude.map((r) => r.id)).toEqual(['lint']);
    expect(m.cursor.map((r) => r.id)).toEqual(['lint']);
    expect(m.codex.map((r) => r.id)).toEqual(['lint']);
  });

  it('applies hooks.yaml edits on the next reconcile (add/remove), built-in untouched', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: lint
    event: Stop
    command: npm run lint
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    // Remove the team hook from the yaml and reconcile again.
    await writeYaml('hooks: []');
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const claude = await claudeSettings();
    expect(claude.hooks.Stop).toHaveLength(1); // built-in only
    expect(claude.hooks.Stop[0].description?.startsWith('[teamai] ')).toBe(true);

    const cursor = await cursorSettings();
    expect(cursor.hooks.stop.some((h) => h.command === 'npm run lint')).toBe(false);
    expect(cursor.hooks.stop).toHaveLength(1);

    const codex = await codexSettings();
    expect(codex.hooks.Stop.some((h) => h.hooks[0].command === 'npm run lint')).toBe(false);
    expect(codex.hooks.Stop).toHaveLength(1);

    const m = await manifest();
    expect(m.claude).toBeUndefined();
    expect(m.cursor).toBeUndefined();
    expect(m.codex).toBeUndefined();
  });

  it('removeAll clears built-in + team hooks', async () => {
    await writeYaml(`
hooks:
  - id: lint
    description: lint
    event: Stop
    command: npm run lint
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());
    await reconcileTeamHooksForConfig(teamConfig, localConfig(), { removeAll: true });

    const claude = await claudeSettings();
    for (const entries of Object.values(claude.hooks)) {
      expect(entries).toHaveLength(0);
    }
    const codex = await codexSettings();
    for (const entries of Object.values(codex.hooks)) {
      expect(entries).toHaveLength(0);
    }
  });

  it('applies §4.8 builtin disabled + timeout overrides from hooks.yaml', async () => {
    await writeYaml(`
hooks: []
builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]
  overrides:
    Hook dispatch stop: { timeout: 99 }
`);
    await reconcileTeamHooksForConfig(teamConfig, localConfig());

    const cursor = await cursorSettings();
    // TodoWrite dropped → 2 built-in postToolUse entries instead of 3.
    expect(cursor.hooks.postToolUse).toHaveLength(2);
    expect(cursor.hooks.postToolUse.some((h) => h.command.includes('TodoWrite'))).toBe(false);
    // Stop timeout overridden.
    expect((cursor.hooks.stop[0] as { timeout?: number }).timeout).toBe(99);
  });

  it('works with no hooks.yaml (built-in self-heal only)', async () => {
    const defs = await reconcileTeamHooksForConfig(teamConfig, localConfig());
    expect(defs).toEqual([]);
    const claude = await claudeSettings();
    expect(claude.hooks.SessionStart).toHaveLength(1);
    // No manifest written when there are no team hooks.
    expect(await fse.pathExists(path.join(project, '.teamai', 'managed-hooks.json'))).toBe(false);
  });
});
