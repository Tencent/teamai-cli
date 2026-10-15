import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isMrHintEnabled, TeamaiConfigSchema, LocalConfigSchema } from '../types.js';
import { computeMrHintOutput } from '../mr-hint.js';
import type { LocalConfig } from '../types.js';

// Keep the real spawnSync so the config readers under test still work; mock it
// only to observe the one call the hint makes for itself.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

describe('isMrHintEnabled', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('defaults to enabled when neither team nor user has an opinion', () => {
    expect(isMrHintEnabled({}, {}, env)).toBe(true);
    expect(isMrHintEnabled({}, { sharing: {} }, env)).toBe(true);
  });

  it('honors the team default', () => {
    expect(isMrHintEnabled({}, { sharing: { mrHint: { enabled: false } } }, env)).toBe(false);
    expect(isMrHintEnabled({}, { sharing: { mrHint: { enabled: true } } }, env)).toBe(true);
  });

  it('lets the user override the team default in both directions', () => {
    expect(
      isMrHintEnabled({ mrHintEnabled: true }, { sharing: { mrHint: { enabled: false } } }, env),
    ).toBe(true);
    expect(
      isMrHintEnabled({ mrHintEnabled: false }, { sharing: { mrHint: { enabled: true } } }, env),
    ).toBe(false);
    expect(isMrHintEnabled({ mrHintEnabled: false }, {}, env)).toBe(false);
  });

  it('TEAMAI_MR_HINT_DISABLED=1 wins over every config layer', () => {
    const killed = { TEAMAI_MR_HINT_DISABLED: '1' } as NodeJS.ProcessEnv;
    expect(
      isMrHintEnabled({ mrHintEnabled: true }, { sharing: { mrHint: { enabled: true } } }, killed),
    ).toBe(false);
    expect(isMrHintEnabled({}, {}, { TEAMAI_MR_HINT_DISABLED: '0' } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });

  it('never reads the contribute-hint switch (#988)', () => {
    // Each switch has to be able to move on its own. Parsing keeps these as real
    // TeamaiConfig / LocalConfig values rather than shapes that only fit
    // isMrHintEnabled's own parameters.
    const teamWithContributeOff = TeamaiConfigSchema.parse({
      team: 't',
      repo: 'r',
      sharing: { contributeHint: { enabled: false } },
    });
    expect(isMrHintEnabled({}, teamWithContributeOff, env)).toBe(true);

    const localWithContributeOff = LocalConfigSchema.parse({
      repo: { localPath: '/x', remote: '' },
      username: 'u',
      contributeHintEnabled: false,
    });
    expect(isMrHintEnabled(localWithContributeOff, {}, env)).toBe(true);
  });

  it('parses the new fields and leaves existing configs valid', () => {
    const team = TeamaiConfigSchema.parse({
      team: 't',
      repo: 'r',
      sharing: { mrHint: { enabled: false } },
    });
    expect(team.sharing.mrHint?.enabled).toBe(false);
    expect(TeamaiConfigSchema.parse({ team: 't', repo: 'r' }).sharing.mrHint).toBeUndefined();
    const local = LocalConfigSchema.parse({
      repo: { localPath: '/x', remote: '' },
      username: 'u',
      mrHintEnabled: false,
    });
    expect(local.mrHintEnabled).toBe(false);
  });
});

describe('computeMrHintOutput resolves the switch before it touches the repo', () => {
  const dirs: string[] = [];

  const scopeDir = (teamaiYaml: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mrhint-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), teamaiYaml);
    return dir;
  };

  const scope = (dir: string): LocalConfig =>
    ({ repo: { localPath: dir, remote: 'https://example.invalid/t.git' } }) as unknown as LocalConfig;

  /** Only the probe the hint makes for itself, not whatever the config readers run. */
  const remoteProbes = () =>
    vi
      .mocked(spawnSync)
      .mock.calls.filter(
        (call) => call[0] === 'git' && Array.isArray(call[1]) && (call[1] as string[])[0] === 'remote',
      ).length;

  afterEach(() => {
    vi.mocked(spawnSync).mockClear();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null without probing the repo when the team turned the hint off', async () => {
    const dir = scopeDir(
      'team: t\nrepo: https://example.invalid/t.git\nsharing:\n  mrHint:\n    enabled: false\n',
    );
    expect(await computeMrHintOutput(undefined, scope(dir))).toBeNull();
    expect(remoteProbes()).toBe(0);
  });

  it('returns null without probing the repo when the user turned the hint off', async () => {
    const dir = scopeDir('team: t\nrepo: https://example.invalid/t.git\n');
    const config = { ...scope(dir), mrHintEnabled: false } as LocalConfig;
    expect(await computeMrHintOutput(undefined, config)).toBeNull();
    expect(remoteProbes()).toBe(0);
  });

  it('still probes the repo when the scope leaves the hint on', async () => {
    const dir = scopeDir('team: t\nrepo: https://example.invalid/t.git\n');
    const original = process.env.TEAMAI_MR_HINT_CWD;
    process.env.TEAMAI_MR_HINT_CWD = dir;
    try {
      await computeMrHintOutput(undefined, scope(dir));
      expect(remoteProbes()).toBe(1);
    } finally {
      if (original === undefined) delete process.env.TEAMAI_MR_HINT_CWD;
      else process.env.TEAMAI_MR_HINT_CWD = original;
    }
  });
});
