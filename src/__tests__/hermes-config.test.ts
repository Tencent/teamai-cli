import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { getHermesHome } from '../hermes-home.js';
import {
  upsertSoulRules,
  removeSoulRules,
  upsertHermesHook,
  removeHermesHookByCommand,
  getHermesConfigPath,
  getHermesSoulPath,
} from '../hermes-config.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END } from '../types.js';

let tmpDir: string;
let savedHermesHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-test-'));
  savedHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = tmpDir;
});

afterEach(() => {
  if (savedHermesHome === undefined) {
    delete process.env.HERMES_HOME;
  } else {
    process.env.HERMES_HOME = savedHermesHome;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── getHermesHome ────────────────────────────────────────────────────────────

describe('getHermesHome', () => {
  it('returns the HERMES_HOME env var as-is when it is an absolute path', () => {
    expect(getHermesHome()).toBe(tmpDir);
  });

  it('resolves HERMES_HOME to an absolute path when it is relative', () => {
    process.env.HERMES_HOME = 'relative/path';
    const result = getHermesHome();
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve('relative/path'));
  });

  it('returns ~/.hermes when HERMES_HOME is not set', () => {
    delete process.env.HERMES_HOME;
    const result = getHermesHome();
    expect(result).toBe(path.join(os.homedir(), '.hermes'));
    // restore for afterEach cleanup
    process.env.HERMES_HOME = tmpDir;
  });
});

// ─── upsertSoulRules / removeSoulRules ───────────────────────────────────────

describe('upsertSoulRules', () => {
  it('creates SOUL.md with marker block when file does not exist', async () => {
    await upsertSoulRules('rule body');
    const content = fs.readFileSync(getHermesSoulPath(), 'utf-8');
    expect(content).toContain(TEAMAI_RULES_START);
    expect(content).toContain('rule body');
    expect(content).toContain(TEAMAI_RULES_END);
  });

  it('preserves existing user content and appends teamai block', async () => {
    const soulPath = getHermesSoulPath();
    fs.mkdirSync(path.dirname(soulPath), { recursive: true });
    fs.writeFileSync(soulPath, '# User content\n\nsome notes\n');

    await upsertSoulRules('team rule');
    const content = fs.readFileSync(soulPath, 'utf-8');
    expect(content).toContain('# User content');
    expect(content).toContain('some notes');
    expect(content).toContain(TEAMAI_RULES_START);
    expect(content).toContain('team rule');
    expect(content).toContain(TEAMAI_RULES_END);
  });

  it('replaces existing teamai block on re-upsert (idempotent replacement)', async () => {
    const soulPath = getHermesSoulPath();
    fs.mkdirSync(path.dirname(soulPath), { recursive: true });
    const initial = `# Header\n\n${TEAMAI_RULES_START}\nold rule\n${TEAMAI_RULES_END}\n\n# Footer\n`;
    fs.writeFileSync(soulPath, initial);

    await upsertSoulRules('new rule');
    const content = fs.readFileSync(soulPath, 'utf-8');
    expect(content).toContain('new rule');
    expect(content).not.toContain('old rule');
    // user sections outside the managed block are preserved
    expect(content).toContain('# Header');
    expect(content).toContain('# Footer');
    // only one start marker
    expect(content.split(TEAMAI_RULES_START).length - 1).toBe(1);
  });

  it('removes teamai block and preserves user content when called with empty string', async () => {
    const soulPath = getHermesSoulPath();
    fs.mkdirSync(path.dirname(soulPath), { recursive: true });
    const initial = `# User notes\n\n${TEAMAI_RULES_START}\nrule\n${TEAMAI_RULES_END}\n`;
    fs.writeFileSync(soulPath, initial);

    await upsertSoulRules('');
    const content = fs.readFileSync(soulPath, 'utf-8');
    expect(content).toContain('# User notes');
    expect(content).not.toContain(TEAMAI_RULES_START);
    expect(content).not.toContain(TEAMAI_RULES_END);
  });

  it('deletes SOUL.md entirely when result would be blank after removing teamai block', async () => {
    const soulPath = getHermesSoulPath();
    fs.mkdirSync(path.dirname(soulPath), { recursive: true });
    fs.writeFileSync(soulPath, `${TEAMAI_RULES_START}\nrule\n${TEAMAI_RULES_END}\n`);

    await upsertSoulRules('');
    expect(fs.existsSync(soulPath)).toBe(false);
  });

  it('strips injected marker lines from rule body before writing (sanitize)', async () => {
    const rulesText = `legit rule\n${TEAMAI_RULES_END}\nmore legit content`;
    await upsertSoulRules(rulesText);
    const content = fs.readFileSync(getHermesSoulPath(), 'utf-8');
    // Only the outer markers should appear — one start, one end
    expect(content.split(TEAMAI_RULES_START).length - 1).toBe(1);
    expect(content.split(TEAMAI_RULES_END).length - 1).toBe(1);
    expect(content).toContain('legit rule');
    expect(content).toContain('more legit content');
  });
});

describe('removeSoulRules', () => {
  it('is a no-op when SOUL.md does not exist', async () => {
    await expect(removeSoulRules()).resolves.toBeUndefined();
    expect(fs.existsSync(getHermesSoulPath())).toBe(false);
  });
});

// ─── upsertHermesHook / removeHermesHookByCommand ────────────────────────────

describe('upsertHermesHook', () => {
  it('creates config.yaml with the hook entry when file does not exist', async () => {
    await upsertHermesHook('on_session_start', { command: '/x.sh', timeout: 60 });
    const raw = fs.readFileSync(getHermesConfigPath(), 'utf-8');
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    const hooks = parsed['hooks'] as Record<string, unknown>;
    const entries = hooks['on_session_start'] as Array<{ command: string; timeout: number }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe('/x.sh');
    expect(entries[0].timeout).toBe(60);
  });

  it('preserves user fields and comments in config.yaml after upsert', async () => {
    const configPath = getHermesConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Write a config with a comment and an existing field
    fs.writeFileSync(configPath, '# comment\nmodel: gpt-4\n');

    await upsertHermesHook('on_session_start', { command: '/x.sh', timeout: 60 });
    const raw = fs.readFileSync(configPath, 'utf-8');
    // Comment must be preserved
    expect(raw).toContain('# comment');
    // User field must be preserved
    expect(raw).toContain('model: gpt-4');
    // Hook entry must be present
    expect(raw).toContain('/x.sh');
  });

  it('is idempotent: upserting the same command twice yields only one entry', async () => {
    await upsertHermesHook('on_session_start', { command: '/x.sh', timeout: 60 });
    await upsertHermesHook('on_session_start', { command: '/x.sh', timeout: 60 });
    const raw = fs.readFileSync(getHermesConfigPath(), 'utf-8');
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    const hooks = parsed['hooks'] as Record<string, unknown>;
    const entries = hooks['on_session_start'] as Array<{ command: string }>;
    const matchCount = entries.filter((e) => e.command === '/x.sh').length;
    expect(matchCount).toBe(1);
  });
});

describe('removeHermesHookByCommand', () => {
  it('removes the matching entry and cleans up empty event/hooks keys', async () => {
    await upsertHermesHook('on_session_start', { command: '/x.sh', timeout: 60 });
    await removeHermesHookByCommand('/x.sh');
    const raw = fs.readFileSync(getHermesConfigPath(), 'utf-8');
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    // hooks key should be absent when all entries are removed
    expect(parsed['hooks']).toBeUndefined();
  });

  it('preserves user fields after removing the hook entry', async () => {
    const configPath = getHermesConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '# comment\nmodel: gpt-4\n');

    await upsertHermesHook('on_session_start', { command: '/x.sh', timeout: 60 });
    await removeHermesHookByCommand('/x.sh');
    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).toContain('# comment');
    expect(raw).toContain('model: gpt-4');
    expect(raw).not.toContain('/x.sh');
  });

  it('is a no-op when the command is not present in config.yaml', async () => {
    // config.yaml does not exist — should not throw
    await expect(removeHermesHookByCommand('/nonexistent.sh')).resolves.toBeUndefined();
  });
});
