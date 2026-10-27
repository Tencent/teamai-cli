import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { loadAutoCompactRecord, reconcileAutoCompactForConfig, reconcileAutoCompactLocked, spliceCodexAutoCompact } from '../autocompact-reconcile.js';
import { resolveAutoCompactTokens } from '../types.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('auto-compact reconcile', () => {
  let tmpDir: string;
  let home: string;
  let baseLocal: LocalConfig;

  const team = (tokens?: number): TeamaiConfig => ({
    team: 't',
    description: '',
    repo: 'r',
    provider: 'tgit',
    reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '~/.teamai/docs' }, env: { injectShellProfile: false }, ...(tokens ? { autoCompact: { tokens } } : {}) },
    toolPaths: {},
  }) as unknown as TeamaiConfig;

  const run = (t: TeamaiConfig, record: Record<string, string>, local: LocalConfig = baseLocal) => reconcileAutoCompactForConfig(t, local, record);
  const json = async (rel: string) => fse.readJson(path.join(home, rel));
  const text = async (rel: string) => fse.readFile(path.join(home, rel), 'utf8');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-autocompact-test-'));
    home = path.join(tmpDir, 'home');
    for (const dir of ['.claude', '.codebuddy', '.workbuddy/cache', '.codex', '.dsh', '.teamai']) {
      await fse.ensureDir(path.join(home, dir));
    }
    await fse.writeFile(path.join(home, '.codex', 'config.toml'), '# mine\nmodel = "gpt-6.1-sol"\n\n[desktop]\nx = 1\n');
    await fse.writeJson(path.join(home, '.workbuddy', 'cache', 'acc-product-config-v3.json'), {
      config: { tokenUsageThresholds: { inputTokens: { emergency: 0.9, preMessage: 0.5 } } },
    });
    vi.stubEnv('HOME', home);
    for (const v of ['CODEX_HOME', 'DSH_HOME', 'CODEBUDDY_CONFIG_DIR', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CODEBUDDY_AUTO_COMPACT_WINDOW']) {
      vi.stubEnv(v, '');
    }
    baseLocal = { repo: { localPath: path.join(tmpDir, 'repo'), remote: 'r' }, username: 'u', scope: 'user' } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('touches nothing when neither team nor member has a threshold', async () => {
    const { changes, managed } = await run(team(), {});
    expect(changes).toEqual([]);
    expect(managed).toEqual({});
    expect(await fse.pathExists(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('translates the threshold into each tool\'s own setting', async () => {
    const { managed } = await run(team(400_000), {});

    expect((await json('.claude/settings.json')).autoCompactWindow).toBe(433_000);
    expect((await json('.codebuddy/settings.json')).autoCompactWindow).toBe(434_783); // 400K / 0.92
    expect((await json('.workbuddy/settings.json')).autoCompactWindow).toBe(444_445); // 400K / 0.9 (cached)
    expect(await text('.codex/config.toml')).toBe(
      '# mine\nmodel = "gpt-6.1-sol"\n\nmodel_auto_compact_token_limit = 400000\n\n[desktop]\nx = 1\n',
    );
    const rows = YAML.parse(await text('.dsh/cordis.patch.yml'));
    expect(rows).toEqual([{
      id: 'compaction-basic',
      config: { modelPolicies: expect.arrayContaining([{ provider: 'deepseek-official', model: 'deepseek-v4-pro', thresholdRatio: 0.4 }]) },
    }]);
    expect(Object.keys(managed)).toHaveLength(5);
  });

  it('is idempotent', async () => {
    const first = await run(team(400_000), {});
    const second = await run(team(400_000), first.managed);
    expect(second.changes.filter((c) => c.action === 'updated')).toEqual([]);
    expect(second.managed).toEqual(first.managed);
  });

  it('never overwrites a value the member set', async () => {
    await fse.writeJson(path.join(home, '.claude', 'settings.json'), { autoCompactWindow: 300_000 });
    const { changes, managed } = await run(team(400_000), {});
    expect((await json('.claude/settings.json')).autoCompactWindow).toBe(300_000);
    expect(changes.find((c) => c.tool === 'claude')).toMatchObject({ action: 'skipped', reason: 'the member set their own value' });
    expect(managed[path.join(home, '.claude', 'settings.json')]).toBeUndefined();
  });

  it('takes back its own values when the policy goes away, and only those', async () => {
    const first = await run(team(400_000), {});
    await fse.writeJson(path.join(home, '.codebuddy', 'settings.json'), { autoCompactWindow: 250_000, theme: 'dark' });

    const { changes, managed } = await run(team(), first.managed);
    expect((await json('.claude/settings.json')).autoCompactWindow).toBeUndefined();
    expect(await json('.codebuddy/settings.json')).toEqual({ autoCompactWindow: 250_000, theme: 'dark' });
    expect(await text('.codex/config.toml')).toBe('# mine\nmodel = "gpt-6.1-sol"\n\n[desktop]\nx = 1\n');
    expect(YAML.parse(await text('.dsh/cordis.patch.yml'))).toEqual([]);
    expect(changes.filter((c) => c.action === 'removed').map((c) => c.tool).sort()).toEqual(['claude', 'codex', 'dsh', 'workbuddy']);
    expect(managed).toEqual({});
  });

  it('lets a member opt out with autoCompactTokens: 0', async () => {
    expect(resolveAutoCompactTokens({ autoCompactTokens: 0 }, { sharing: { autoCompact: { tokens: 400_000 } } })).toBeUndefined();
    expect(resolveAutoCompactTokens({ autoCompactTokens: 300_000 }, { sharing: { autoCompact: { tokens: 400_000 } } })).toBe(300_000);
    const first = await run(team(400_000), {});
    await run(team(400_000), first.managed, { ...baseLocal, autoCompactTokens: 0 });
    expect((await json('.claude/settings.json')).autoCompactWindow).toBeUndefined();
  });

  it('skips Claude when CLAUDE_CODE_AUTO_COMPACT_WINDOW overrides the setting', async () => {
    vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', '500000');
    const { changes } = await run(team(400_000), {});
    expect(changes.find((c) => c.tool === 'claude')).toMatchObject({ action: 'skipped', notable: true });
    expect(await fse.pathExists(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('skips CodeBuddy when a custom model has no known window', async () => {
    await fse.writeJson(path.join(home, '.codebuddy', 'models.json'), { models: [{ id: 'my-model' }] });
    const { changes } = await run(team(400_000), {});
    expect(changes.find((c) => c.tool === 'codebuddy')).toMatchObject({ action: 'skipped', notable: true });
    expect(await fse.pathExists(path.join(home, '.codebuddy', 'settings.json'))).toBe(false);
  });

  it('writes a dsh policy only for models where the ratio stays loadable', async () => {
    await fse.writeFile(path.join(home, '.dsh', 'cordis.patch.yml'), [
      '# keep me',
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      hai: { models: [{ id: big, contextWindow: 2000000 }, { id: small, contextWindow: 200000 }] }',
      '',
    ].join('\n'));
    await run(team(400_000), {});
    const source = await text('.dsh/cordis.patch.yml');
    expect(source).toContain('# keep me');
    const policies = YAML.parse(source).find((r: { id: string }) => r.id === 'compaction-basic').config.modelPolicies;
    expect(policies).toContainEqual({ provider: 'hai', model: 'big', thresholdRatio: 0.2 });
    expect(policies.some((p: { model: string }) => p.model === 'small')).toBe(false);
  });

  it('skips dsh when no model can take the threshold', async () => {
    // 100K on DeepSeek's 1M models is ratio 0.1, at or below dsh's retainRatio: dsh would refuse to boot.
    const { changes } = await run(team(100_000), {});
    expect(changes.find((c) => c.tool === 'dsh')).toMatchObject({ action: 'skipped', notable: true });
    expect(await fse.pathExists(path.join(home, '.dsh', 'cordis.patch.yml'))).toBe(false);
  });

  it('keeps the record of a tool while it is excluded, so the value stays teamai\'s', async () => {
    const first = await run(team(400_000), {});
    const excluded = await run(team(400_000), first.managed, { ...baseLocal, disabledAgents: ['claude'] } as LocalConfig);
    expect(excluded.managed).toEqual(first.managed);

    const { changes } = await run(team(), excluded.managed);
    expect(changes.find((c) => c.tool === 'claude')).toMatchObject({ action: 'removed' });
    expect((await json('.claude/settings.json')).autoCompactWindow).toBeUndefined();
  });

  it('keeps the last record when a write fails', async () => {
    const first = await run(team(400_000), {});
    const file = path.join(home, '.claude', 'settings.json');
    await fse.chmod(file, 0o444);
    try {
      const failed = await run(team(300_000), first.managed);
      expect(failed.changes.find((c) => c.tool === 'claude')).toMatchObject({ action: 'skipped', notable: true });
      expect(failed.managed[file]).toBe(first.managed[file]);
    } finally {
      await fse.chmod(file, 0o644);
    }
    const retried = await run(team(300_000), first.managed);
    expect(retried.changes.find((c) => c.tool === 'claude')).toMatchObject({ action: 'updated' });
    expect((await json('.claude/settings.json')).autoCompactWindow).toBe(333_000);
  });

  it('takes over a value written under another scope, since the record is per machine', async () => {
    const first = await run(team(400_000), {});
    const project = { ...baseLocal, scope: 'project' } as LocalConfig;
    const { changes } = await run(team(300_000), first.managed, project);
    expect(changes.find((c) => c.tool === 'claude')).toMatchObject({ action: 'updated' });
  });

  it('writes to the Codex root the member recorded at init, even without CODEX_HOME in this shell', async () => {
    await fse.outputFile(path.join(home, '.codex-work', 'config.toml'), 'model = "x"\n');
    const local = { ...baseLocal, toolRoots: { codex: '~/.codex-work' } } as LocalConfig;
    await run(team(400_000), {}, local);
    expect(await text('.codex-work/config.toml')).toBe('model = "x"\nmodel_auto_compact_token_limit = 400000\n');
    expect(await text('.codex/config.toml')).not.toContain('model_auto_compact_token_limit');
  });

  it('keeps every project\'s entries when two pulls reconcile at once', async () => {
    const only = (tool: string) => ({ ...baseLocal, enabledAgents: [tool] }) as LocalConfig;
    const [a, b] = await Promise.all([
      reconcileAutoCompactLocked(team(400_000), only('claude')),
      reconcileAutoCompactLocked(team(400_000), only('codex')),
    ]);
    expect(a && b).toBeTruthy();
    expect(Object.keys(await loadAutoCompactRecord()).sort()).toEqual([
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.codex', 'config.toml'),
    ]);
  });

  it('splices the Codex key by text', () => {
    // An indented table header still ends the top-level region.
    expect(spliceCodexAutoCompact('a = 1\n  [desktop]\nx = 1\n', 5)).toBe('a = 1\nmodel_auto_compact_token_limit = 5\n\n  [desktop]\nx = 1\n');
    // A `[Rules]` line or a key-like line inside a multiline string is content, not a header or the key.
    const prompt = 'developer_instructions = """\n[Rules]\nmodel_auto_compact_token_limit = 1\n"""\nliteral = \'\'\'\n[x]\n\'\'\'\n';
    expect(spliceCodexAutoCompact(`${prompt}[desktop]\nx = 1\n`, 5))
      .toBe(`${prompt}model_auto_compact_token_limit = 5\n\n[desktop]\nx = 1\n`);
    expect(spliceCodexAutoCompact(`${prompt}model_auto_compact_token_limit = 5\n\n[desktop]\n`, null)).toBe(`${prompt}[desktop]\n`);
    expect(spliceCodexAutoCompact('a = "[not a table" # """\n[t]\n', 5)).toBe('a = "[not a table" # """\nmodel_auto_compact_token_limit = 5\n\n[t]\n');
    // An even run of backslashes before the closing quotes escapes itself, not the quote.
    expect(spliceCodexAutoCompact('p = """C:\\\\"""\n[t]\n', 5)).toBe('p = """C:\\\\"""\nmodel_auto_compact_token_limit = 5\n\n[t]\n');
    expect(spliceCodexAutoCompact('p = """\nC:\\\\"""\n[t]\n', 5)).toBe('p = """\nC:\\\\"""\nmodel_auto_compact_token_limit = 5\n\n[t]\n');
    expect(spliceCodexAutoCompact('p = """\nsay \\"""\n[x]\n"""\n[t]\n', 5)).toBe('p = """\nsay \\"""\n[x]\n"""\nmodel_auto_compact_token_limit = 5\n\n[t]\n');
    // A quoted key is the same key: replaced, never duplicated.
    expect(spliceCodexAutoCompact('"model_auto_compact_token_limit" = 300000\n[t]\n', 5)).toBe('model_auto_compact_token_limit = 5\n[t]\n');
    expect(spliceCodexAutoCompact('model_auto_compact_token_limit = 1\n[t]\n', 2)).toBe('model_auto_compact_token_limit = 2\n[t]\n');
    expect(spliceCodexAutoCompact('a = 1\nmodel_auto_compact_token_limit = 1\n', null)).toBe('a = 1\n');
    expect(spliceCodexAutoCompact('[t]\nmodel_auto_compact_token_limit = 1\n', null)).toBe('[t]\nmodel_auto_compact_token_limit = 1\n');
  });
});
