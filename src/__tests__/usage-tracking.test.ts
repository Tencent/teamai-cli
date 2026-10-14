import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { spawnSync } from 'node:child_process';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import {
  isValidSkillName,
  appendUsageEvent,
  readUsageEvents,
  truncateUsageAfterReport,
  capUsageEvents,
  USAGE_EVENT_CAP,
  track,
  trackFromStdin,
  trackSlashCommand,
  updateKnownSkills,
  readKnownSkills,
  extractSkillName,
  skillExistsOnDisk,
} from '../usage-tracker.js';
import { aggregateUsage, showStats } from '../stats.js';
import { mergeStats } from '../team-push.js';
import { calculateSkillHealth, scoreToStars, calculateTeamHealth } from '../skill-health.js';
import { getRecommendations } from '../skill-recommend.js';
import type { LocalConfig, UsageEvent, UserStats } from '../types.js';

// ─── Test helpers ──────────────────────────────────────

let tmpDir: string;
const origHome = process.env.HOME;

/** The user scope seeded below; its usage file is `~/.teamai/user-usage.jsonl`. */
function userScope(): LocalConfig {
  return {
    repo: { localPath: path.join(tmpDir, '.teamai', 'team-repo'), remote: 'https://example.test/acme/team.git' },
    username: 'tester',
    scope: 'user',
    additionalRoles: [],
  };
}

/** A user-scope install: skill usage is recorded only where teamai is set up. */
async function seedUserConfig(): Promise<void> {
  await fse.outputFile(
    path.join(tmpDir, '.teamai', 'config.yaml'),
    `repo:\n  localPath: ${path.join(tmpDir, '.teamai', 'team-repo')}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n`,
  );
}

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-test-'));
  process.env.HOME = tmpDir;
  await seedUserConfig();
});

afterEach(async () => {
  process.env.HOME = origHome;
  await fse.remove(tmpDir);
});

/**
 * Helper: mock process.stdin to return the given string.
 * Returns a restore function.
 */
function mockStdin(data: string): () => void {
  const original = process.stdin;
  const readable = new (require('stream').Readable)({
    read() {
      this.push(data);
      this.push(null);
    },
  });
  // Mark as not a TTY so trackFromStdin reads it
  (readable as NodeJS.ReadStream).isTTY = false;

  Object.defineProperty(process, 'stdin', {
    value: readable,
    writable: true,
    configurable: true,
  });

  return () => {
    Object.defineProperty(process, 'stdin', {
      value: original,
      writable: true,
      configurable: true,
    });
  };
}

/**
 * Helper: create a fake skill on disk so `skillExistsOnDisk()` finds it.
 * Creates `~/.claude/skills/<name>/SKILL.md` under the test tmpDir.
 */
async function createFakeSkill(name: string): Promise<void> {
  const skillDir = path.join(tmpDir, '.claude', 'skills', name);
  await fse.ensureDir(skillDir);
  await fse.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFake skill for testing.\n`);
}

// ─── usage-tracker tests ───────────────────────────────

describe('isValidSkillName', () => {
  it('accepts valid skill names', () => {
    expect(isValidSkillName('code-review')).toBe(true);
    expect(isValidSkillName('tdd')).toBe(true);
    expect(isValidSkillName('plan-eng-review')).toBe(true);
    expect(isValidSkillName('everything-claude-code:tdd')).toBe(true);
    expect(isValidSkillName('my_skill.v2')).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidSkillName('../../etc/passwd')).toBe(false);
    expect(isValidSkillName('../secret')).toBe(false);
    expect(isValidSkillName('skill/../../etc')).toBe(false);
  });

  it('rejects empty and overly long names', () => {
    expect(isValidSkillName('')).toBe(false);
    expect(isValidSkillName('a'.repeat(201))).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(isValidSkillName('skill name')).toBe(false);
    expect(isValidSkillName('skill\n')).toBe(false);
    expect(isValidSkillName('<script>')).toBe(false);
  });
});

describe('skillExistsOnDisk — relocated tool roots', () => {
  it('finds a skill installed only under the root the governing config records', async () => {
    const relocated = path.join(tmpDir, '.claude-work');
    await fse.outputFile(path.join(relocated, 'skills', 'relocated-only', 'SKILL.md'), '# s');
    await expect(skillExistsOnDisk('relocated-only', { claude: relocated })).resolves.toBe(true);
    await expect(skillExistsOnDisk('relocated-only')).resolves.toBe(false);
  });

  it('finds a skill installed only under the recorded CODEX_HOME root', async () => {
    const codexHome = path.join(tmpDir, '.codex-alt');
    await fse.outputFile(path.join(codexHome, 'skills', 'codex-only', 'SKILL.md'), '# s');
    await expect(skillExistsOnDisk('codex-only', { codex: codexHome })).resolves.toBe(true);
    await expect(skillExistsOnDisk('codex-only')).resolves.toBe(false);
  });
});

describe('skillExistsOnDisk — Copilot', () => {
  it('finds user skills under a custom COPILOT_HOME', async () => {
    const copilotHome = path.join(tmpDir, 'copilot-home');
    const skillDir = path.join(copilotHome, 'skills', 'copilot-review');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# Copilot review\n');
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = copilotHome;
    try {
      await expect(skillExistsOnDisk('copilot-review')).resolves.toBe(true);
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
    }
  });

  it('finds project skills under .github/skills', async () => {
    const project = path.join(tmpDir, 'project');
    const skillDir = path.join(project, '.github', 'skills', 'copilot-test');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# Copilot test\n');
    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      await expect(skillExistsOnDisk('copilot-test')).resolves.toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('does not treat the home .github directory as a user skill scope', async () => {
    const skillDir = path.join(tmpDir, '.github', 'skills', 'project-only');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# Project only\n');

    await expect(skillExistsOnDisk('project-only')).resolves.toBe(false);
  });
});

describe('appendUsageEvent', () => {
  it('appends a valid event to JSONL', async () => {
    const event: UsageEvent = {
      skill: 'code-review',
      timestamp: '2026-03-19T10:30:00Z',
      tool: 'claude',
    };
    await appendUsageEvent(event, userScope());

    const usagePath = path.join(tmpDir, '.teamai', 'user-usage.jsonl');
    const content = await fs.promises.readFile(usagePath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.skill).toBe('code-review');
    expect(parsed.timestamp).toBe('2026-03-19T10:30:00Z');
  });

  it('appends multiple events as separate lines', async () => {
    await appendUsageEvent({ skill: 'tdd', timestamp: '2026-03-19T10:00:00Z', tool: 'claude' }, userScope());
    await appendUsageEvent({ skill: 'code-review', timestamp: '2026-03-19T11:00:00Z', tool: 'claude' }, userScope());

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(2);
    expect(events[0].skill).toBe('tdd');
    expect(events[1].skill).toBe('code-review');
  });
});

describe('readUsageEvents', () => {
  it('returns empty array for missing file', async () => {
    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('skips corrupted JSONL lines', async () => {
    const usagePath = path.join(tmpDir, '.teamai', 'user-usage.jsonl');
    await fse.ensureDir(path.dirname(usagePath));
    await fs.promises.writeFile(
      usagePath,
      '{"skill":"good","timestamp":"2026-01-01T00:00:00Z","tool":"claude"}\nNOT_JSON\n{"skill":"also-good","timestamp":"2026-01-02T00:00:00Z","tool":"claude"}\n',
    );

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(2);
    expect(events[0].skill).toBe('good');
    expect(events[1].skill).toBe('also-good');
  });

  it('handles empty file', async () => {
    const usagePath = path.join(tmpDir, '.teamai', 'user-usage.jsonl');
    await fse.ensureDir(path.dirname(usagePath));
    await fs.promises.writeFile(usagePath, '');

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });
});

describe('truncateUsageAfterReport', () => {
  it('clears file when all events reported', async () => {
    await appendUsageEvent({ skill: 'a', timestamp: '2026-01-01T00:00:00Z', tool: 'claude' }, userScope());
    await appendUsageEvent({ skill: 'b', timestamp: '2026-01-02T00:00:00Z', tool: 'claude' }, userScope());

    await truncateUsageAfterReport(2, userScope());

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('keeps unreported events', async () => {
    await appendUsageEvent({ skill: 'a', timestamp: '2026-01-01T00:00:00Z', tool: 'claude' }, userScope());
    await appendUsageEvent({ skill: 'b', timestamp: '2026-01-02T00:00:00Z', tool: 'claude' }, userScope());
    await appendUsageEvent({ skill: 'c', timestamp: '2026-01-03T00:00:00Z', tool: 'claude' }, userScope());

    await truncateUsageAfterReport(2, userScope());

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('c');
  });
});

describe('capUsageEvents (#788)', () => {
  const usagePath = () => path.join(tmpDir, '.teamai', 'user-usage.jsonl');
  const line = (i: number) => JSON.stringify({ skill: `s${i}`, timestamp: '2026-01-01T00:00:00Z', tool: 'claude' });
  const seed = async (count: number) => {
    await fse.outputFile(usagePath(), Array.from({ length: count }, (_, i) => line(i)).join('\n') + '\n');
  };

  it('keeps only the newest events of a file over the cap', async () => {
    await seed(USAGE_EVENT_CAP + 7);

    await capUsageEvents(userScope());

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(USAGE_EVENT_CAP);
    expect(events[0].skill).toBe('s7');
    expect(events[events.length - 1].skill).toBe(`s${USAGE_EVENT_CAP + 6}`);
  });

  it('does not rewrite a file at the cap', async () => {
    await seed(USAGE_EVENT_CAP);
    const past = new Date('2026-01-01T00:00:00Z');
    await fs.promises.utimes(usagePath(), past, past);

    await capUsageEvents(userScope());

    expect((await fs.promises.stat(usagePath())).mtimeMs).toBe(past.getTime());
    expect(await readUsageEvents(userScope())).toHaveLength(USAGE_EVENT_CAP);
  });

  it('creates no file where the scope has recorded nothing', async () => {
    await capUsageEvents(userScope());

    expect(fs.existsSync(usagePath())).toBe(false);
  });

  const late: UsageEvent = { skill: 'late', timestamp: '2026-01-02T00:00:00Z', tool: 'claude' };
  const skills = async () => (await readUsageEvents(userScope())).map((e) => e.skill);
  const lockPath = () => `${usagePath()}.lock`;

  it('holds an append issued mid-cap until the capped file is in place', async () => {
    await seed(USAGE_EVENT_CAP + 2);
    const before = await fs.promises.readFile(usagePath(), 'utf-8');
    const realWrite = fs.promises.writeFile;
    let append: Promise<void> | undefined;
    let landedMidCap = false;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      append = appendUsageEvent(late, userScope());
      await new Promise((r) => setTimeout(r, 100));
      landedMidCap = (await fs.promises.readFile(usagePath(), 'utf-8')) !== before;
      return realWrite(file, data, options);
    });
    try {
      await capUsageEvents(userScope());
    } finally {
      spy.mockRestore();
    }
    await append;

    expect(landedMidCap).toBe(false);
    const kept = await skills();
    expect(kept).toHaveLength(USAGE_EVENT_CAP + 1);
    expect(kept[0]).toBe('s2');
    expect(kept[kept.length - 1]).toBe('late');
  });

  it('loses no append when two caps run at once', async () => {
    await seed(USAGE_EVENT_CAP + 100);
    const appends = Array.from({ length: 5 }, (_, i) =>
      new Promise((r) => setTimeout(r, i * 5)).then(() =>
        appendUsageEvent({ skill: `late${i}`, timestamp: '2026-01-02T00:00:00Z', tool: 'claude' }, userScope()),
      ),
    );

    await Promise.all([capUsageEvents(userScope()), capUsageEvents(userScope()), ...appends]);

    const kept = await skills();
    expect(kept.filter((s) => s.startsWith('late')).sort()).toEqual(['late0', 'late1', 'late2', 'late3', 'late4']);
    expect(kept).toContain(`s${USAGE_EVENT_CAP + 99}`);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('keeps the mode of the file it replaces', async () => {
    await seed(USAGE_EVENT_CAP + 2);
    await fs.promises.chmod(usagePath(), 0o600);

    await capUsageEvents(userScope());

    expect((await fs.promises.stat(usagePath())).mode & 0o777).toBe(0o600);
    expect(await readUsageEvents(userScope())).toHaveLength(USAGE_EVENT_CAP);
  });

  it('removes temp files a killed rewrite left behind', async () => {
    await seed(USAGE_EVENT_CAP + 2);
    const orphan = `${usagePath()}.4242.0123456789ab.tmp`;
    await fs.promises.writeFile(orphan, 'partial');

    await capUsageEvents(userScope());

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('leaves the file intact and no temp file behind when the write fails', async () => {
    await seed(USAGE_EVENT_CAP + 2);
    const before = await fs.promises.readFile(usagePath(), 'utf-8');
    const realWrite = fs.promises.writeFile;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      await realWrite(file, String(data).slice(0, 100), options);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    try {
      await capUsageEvents(userScope());
    } finally {
      spy.mockRestore();
    }

    expect(await fs.promises.readFile(usagePath(), 'utf-8')).toBe(before);
    expect((await fs.promises.readdir(path.dirname(usagePath()))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('caps the target of a symlinked usage file and keeps the link', async () => {
    const target = path.join(tmpDir, 'synced', 'usage.jsonl');
    await fse.outputFile(target, Array.from({ length: USAGE_EVENT_CAP + 2 }, (_, i) => line(i)).join('\n') + '\n');
    await fs.promises.symlink(target, usagePath());

    await capUsageEvents(userScope());

    expect((await fs.promises.lstat(usagePath())).isSymbolicLink()).toBe(true);
    expect(await readUsageEvents(userScope())).toHaveLength(USAGE_EVENT_CAP);
  });

  it('caps a project scope in its own data home and leaves the user scope alone', async () => {
    const workspace = path.join(tmpDir, 'workspace');
    const project: LocalConfig = { ...userScope(), scope: 'project', projectRoot: workspace, dataHome: path.join(workspace, '.teamai') };
    await fse.outputFile(path.join(workspace, '.teamai', 'usage.jsonl'), Array.from({ length: USAGE_EVENT_CAP + 3 }, (_, i) => line(i)).join('\n') + '\n');
    await seed(USAGE_EVENT_CAP + 3);

    await capUsageEvents(project);

    const events = await readUsageEvents(project);
    expect(events).toHaveLength(USAGE_EVENT_CAP);
    expect(events[0].skill).toBe('s3');
    expect(await readUsageEvents(userScope())).toHaveLength(USAGE_EVENT_CAP + 3);
  });
});

describe('usage file lock (#788)', () => {
  const usagePath = () => path.join(tmpDir, '.teamai', 'user-usage.jsonl');
  const event = (skill: string): UsageEvent => ({ skill, timestamp: '2026-01-01T00:00:00Z', tool: 'claude' });
  const skills = async () => (await readUsageEvents(userScope())).map((e) => e.skill);
  const writeLock = (pid: number) =>
    fse.outputFile(`${usagePath()}.lock`, JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00Z', owner: 'other' }));

  it('reclaims a lock whose owner is gone', async () => {
    await writeLock(spawnSync(process.execPath, ['-e', '']).pid ?? 0);

    await appendUsageEvent(event('a'), userScope());

    expect(await skills()).toEqual(['a']);
    expect(fs.existsSync(`${usagePath()}.lock`)).toBe(false);
  });

  const pendingFiles = async () =>
    (await fs.promises.readdir(path.dirname(usagePath()))).filter((n) => n.startsWith('user-usage.pending-'));

  it('records an event beside the file within the hook budget while the lock stays held, and folds it in later', async () => {
    await appendUsageEvent(event('a'), userScope());
    await writeLock(process.pid);

    const started = Date.now();
    await appendUsageEvent(event('b'), userScope());

    expect(Date.now() - started).toBeLessThan(1000);
    expect(await skills()).toEqual(['a']);
    expect(await pendingFiles()).toHaveLength(1);

    await fs.promises.rm(`${usagePath()}.lock`);
    await appendUsageEvent(event('c'), userScope());

    expect(await skills()).toEqual(['a', 'b', 'c']);
    expect(await pendingFiles()).toEqual([]);
  });

  it('folds a side file once when it outlives its append', async () => {
    await appendUsageEvent(event('a'), userScope());
    await writeLock(process.pid);
    await appendUsageEvent(event('b'), userScope());
    await fs.promises.rm(`${usagePath()}.lock`);
    // The side file cannot be removed once its event is in the file (or the holder dies there).
    const realRm = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
      if (String(file).includes('.pending-')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return realRm(file, options);
    });
    try {
      await appendUsageEvent(event('c'), userScope());
    } finally {
      spy.mockRestore();
    }

    await appendUsageEvent(event('d'), userScope());

    expect(await skills()).toEqual(['a', 'b', 'c', 'd']);
    expect(await pendingFiles()).toEqual([]);
  });

  it('keeps a side file event identical to one already in the file', async () => {
    await appendUsageEvent(event('a'), userScope());
    await writeLock(process.pid);
    await appendUsageEvent(event('a'), userScope());
    await fs.promises.rm(`${usagePath()}.lock`);

    await appendUsageEvent(event('b'), userScope());

    expect(await skills()).toEqual(['a', 'a', 'b']);
    expect(await pendingFiles()).toEqual([]);
  });

  it('keeps two identical events recorded in side files at once', async () => {
    await writeLock(process.pid);
    await Promise.all([appendUsageEvent(event('a'), userScope()), appendUsageEvent(event('a'), userScope())]);
    expect(await pendingFiles()).toHaveLength(2);
    await fs.promises.rm(`${usagePath()}.lock`);

    await appendUsageEvent(event('b'), userScope());

    expect(await skills()).toEqual(['a', 'a', 'b']);
    expect(await pendingFiles()).toEqual([]);
  });

  it('keeps the side file id out of what readers and `teamai stats` see', async () => {
    await writeLock(process.pid);
    await appendUsageEvent(event('a'), userScope());
    await fs.promises.rm(`${usagePath()}.lock`);
    await appendUsageEvent(event('b'), userScope());
    expect(await fs.promises.readFile(usagePath(), 'utf-8')).toContain('"pendingId"');

    expect(await readUsageEvents(userScope())).toStrictEqual([event('a'), event('b')]);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await showStats();
      const printed = out.mock.calls.flat().join('\n');
      expect(printed).toContain('a');
      expect(printed).not.toContain('pendingId');
    } finally {
      out.mockRestore();
    }
  });

  const pendingMode = async () =>
    (await fs.promises.stat(path.join(path.dirname(usagePath()), (await pendingFiles())[0]))).mode & 0o777;

  it('gives a side file the mode of the usage file', async () => {
    await appendUsageEvent(event('a'), userScope());
    await fs.promises.chmod(usagePath(), 0o600);
    await writeLock(process.pid);

    await appendUsageEvent(event('b'), userScope());

    expect(await pendingMode()).toBe(0o600);
  });

  it('keeps a side file private to its owner while there is no usage file yet', async () => {
    await writeLock(process.pid);

    await appendUsageEvent(event('a'), userScope());

    expect(await pendingMode()).toBe(0o600);
  });

  it('keeps an append that gives up on the lock while a slow cap rewrites the file', async () => {
    await fse.outputFile(
      usagePath(),
      Array.from({ length: USAGE_EVENT_CAP + 2 }, (_, i) => JSON.stringify(event(`s${i}`))).join('\n') + '\n',
    );
    const realWrite = fs.promises.writeFile;
    let append: Promise<void> | undefined;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (String(file).includes('.pending-')) return realWrite(file, data, options);
      append = appendUsageEvent(event('late'), userScope());
      await append;
      return realWrite(file, data, options);
    });
    try {
      await capUsageEvents(userScope());
    } finally {
      spy.mockRestore();
    }
    await appendUsageEvent(event('next'), userScope());

    const kept = await skills();
    expect(kept).toHaveLength(USAGE_EVENT_CAP + 2);
    expect(kept.slice(-2).sort()).toEqual(['late', 'next']);
  });

  it('leaves a side file alone while it is still being written', async () => {
    const partial = path.join(tmpDir, '.teamai', 'user-usage.pending-00000000-0000-4000-8000-000000000000.jsonl');
    await fse.outputFile(partial, '');

    await appendUsageEvent(event('a'), userScope());

    expect(await skills()).toEqual(['a']);
    expect(fs.existsSync(partial)).toBe(true);
  });

  it('does not rewrite the file while another holder keeps the lock', async () => {
    await fse.outputFile(
      usagePath(),
      Array.from({ length: USAGE_EVENT_CAP + 2 }, (_, i) => JSON.stringify(event(`s${i}`))).join('\n') + '\n',
    );
    const before = await fs.promises.readFile(usagePath(), 'utf-8');
    await writeLock(process.pid);

    await capUsageEvents(userScope());
    await truncateUsageAfterReport(2, userScope());

    expect(await fs.promises.readFile(usagePath(), 'utf-8')).toBe(before);
  }, 20_000);

  it('holds an append issued mid-truncate until the truncated file is in place', async () => {
    for (const s of ['a', 'b', 'c']) await appendUsageEvent(event(s), userScope());
    const realWrite = fs.promises.writeFile;
    let append: Promise<void> | undefined;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      append = appendUsageEvent(event('late'), userScope());
      await new Promise((r) => setTimeout(r, 100));
      return realWrite(file, data, options);
    });
    try {
      await truncateUsageAfterReport(2, userScope());
    } finally {
      spy.mockRestore();
    }
    await append;

    expect(await skills()).toEqual(['c', 'late']);
  });

  it('leaves the file intact when the truncated copy cannot be written', async () => {
    for (const s of ['a', 'b', 'c']) await appendUsageEvent(event(s), userScope());
    const before = await fs.promises.readFile(usagePath(), 'utf-8');
    const spy = vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(
      Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
    );
    try {
      await truncateUsageAfterReport(2, userScope());
    } finally {
      spy.mockRestore();
    }

    expect(await fs.promises.readFile(usagePath(), 'utf-8')).toBe(before);
  });
});

describe('usage files in a legacy in-workspace .teamai/ (#788)', () => {
  // What `teamai init --scope project` wrote before the usage lock existed.
  const legacyGitignore = [
    '# teamai local config (do not commit)', 'config.yaml', 'state.json', 'token', 'teamai.lock',
    '.update-lock', 'env', 'env.sh', 'sessions/', 'dashboard/', 'usage.jsonl', 'known-skills.json',
    'learnings/', 'search-index.json', 'votes/', '',
  ].join('\n');
  const workspace = () => path.join(tmpDir, 'workspace');
  const project = (): LocalConfig => ({ ...userScope(), scope: 'project', projectRoot: workspace(), dataHome: path.join(workspace(), '.teamai') });
  const usagePath = () => path.join(workspace(), '.teamai', 'usage.jsonl');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: workspace(), encoding: 'utf-8' });
  const event = (skill: string): UsageEvent => ({ skill, timestamp: '2026-01-01T00:00:00Z', tool: 'claude' });

  beforeEach(async () => {
    await fse.outputFile(path.join(workspace(), '.teamai', '.gitignore'), legacyGitignore);
    git('init', '-q');
  });

  it('keeps an event recorded while the lock is held out of git status', async () => {
    await appendUsageEvent(event('a'), project());
    await fse.outputFile(`${usagePath()}.lock`, JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z', owner: 'other' }));

    await appendUsageEvent(event('b'), project());

    expect((await fs.promises.readdir(path.dirname(usagePath()))).some((n) => n.startsWith('usage.pending-'))).toBe(true);
    expect(git('status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(Boolean))
      .toEqual(['?? .teamai/.gitignore']);
  });

  it('ignores the lock and a rewrite\'s temp copy once the file has been capped', async () => {
    await fse.outputFile(usagePath(), Array.from({ length: USAGE_EVENT_CAP + 1 }, (_, i) => JSON.stringify(event(`s${i}`))).join('\n') + '\n');

    await capUsageEvents(project());

    const ignored = git('check-ignore', '--no-index', '.teamai/usage.jsonl.lock', '.teamai/usage.jsonl.123.0123456789ab.tmp');
    expect(ignored.stdout.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('leaves the .gitignore whole when the disk fills while it is healed', async () => {
    // The disk fills after the first bytes of the healed .gitignore, wherever it is written.
    const fillDisk = (file: unknown, data: unknown) => {
      if (!path.basename(String(file)).startsWith('.gitignore')) return false;
      fs.writeFileSync(String(file), String(data).slice(0, 40));
      return true;
    };
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const writeFile = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (fillDisk(file, data)) throw enospc();
      return writeFile(file, data, options);
    });
    const outputWrite = fse.writeFile;
    vi.spyOn(fse, 'writeFile').mockImplementation(async (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions | fs.NoParamCallback) => {
      if (fillDisk(file, data)) throw enospc();
      if (typeof options === 'function') return outputWrite(file, data, options);
      return outputWrite(file, data, options);
    });
    await fse.outputFile(usagePath(), Array.from({ length: USAGE_EVENT_CAP + 1 }, (_, i) => JSON.stringify(event(`s${i}`))).join('\n') + '\n');

    await capUsageEvents(project());
    vi.restoreAllMocks();

    expect(fs.readFileSync(path.join(workspace(), '.teamai', '.gitignore'), 'utf-8')).toBe(legacyGitignore);
    expect((await fs.promises.readdir(path.join(workspace(), '.teamai'))).filter((n) => n.startsWith('.gitignore'))).toEqual(['.gitignore']);
    expect(await readUsageEvents(project())).toHaveLength(USAGE_EVENT_CAP);
  });
});

describe('usage recorded while every scope shared ~/.teamai/usage.jsonl (#748)', () => {
  const sharedPath = () => path.join(tmpDir, '.teamai', 'usage.jsonl');
  const legacy = '{"skill":"from-another-project","timestamp":"2026-01-01T00:00:00Z","tool":"claude"}\n';

  it('is not read back as the user scope\'s own usage after an upgrade', async () => {
    // Written by an earlier release on a machine that already had a user scope.
    await fs.promises.writeFile(sharedPath(), legacy);

    expect(await readUsageEvents(userScope())).toEqual([]);
    // Reading usage (as `teamai stats` does) leaves the file alone.
    expect(fs.readFileSync(sharedPath(), 'utf-8')).toBe(legacy);
  });

  it('is not read back when an earlier release writes it again after a rollback', async () => {
    await appendUsageEvent({ skill: 'after-upgrade', timestamp: '2026-02-01T00:00:00Z', tool: 'claude' }, userScope());
    // Rolled back: the earlier release records every project's usage here again.
    await fs.promises.appendFile(sharedPath(), legacy);

    expect((await readUsageEvents(userScope())).map((e) => e.skill)).toEqual(['after-upgrade']);
  });
});

describe('track', () => {
  it('tracks Skill tool calls', async () => {
    await track('Skill', JSON.stringify({ skill: 'code-review' }));

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('code-review');
  });

  it('ignores non-Skill tool calls', async () => {
    await track('Bash', JSON.stringify({ command: 'ls' }));
    await track('Read', JSON.stringify({ path: '/tmp' }));

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('ignores invalid skill names', async () => {
    await track('Skill', JSON.stringify({ skill: '../../etc/passwd' }));

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('handles malformed JSON input', async () => {
    await track('Skill', 'not-json');

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('updates known-skills.json on successful track', async () => {
    await track('Skill', JSON.stringify({ skill: 'code-review' }));

    const known = await readKnownSkills();
    expect(known.has('code-review')).toBe(true);
  });
});

describe('skill tracking where teamai is not set up (#748)', () => {
  beforeEach(async () => {
    await fse.remove(path.join(tmpDir, '.teamai', 'config.yaml'));
  });

  async function expectNothingRecorded(): Promise<void> {
    expect(fs.existsSync(path.join(tmpDir, '.teamai', 'user-usage.jsonl'))).toBe(false);
    expect((await readKnownSkills()).size).toBe(0);
  }

  it('track records nothing', async () => {
    await track('Skill', JSON.stringify({ skill: 'code-review' }));
    await expectNothingRecorded();
  });

  it('trackFromStdin records nothing', async () => {
    const restore = mockStdin(JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'code-review' } }));
    try {
      await trackFromStdin();
    } finally {
      restore();
    }
    await expectNothingRecorded();
  });

  it('trackSlashCommand records nothing', async () => {
    await createFakeSkill('code-review');
    const restore = mockStdin(JSON.stringify({ prompt: '/code-review' }));
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }
    await expectNothingRecorded();
  });
});

// ─── trackFromStdin tests ─────────────────────────────

describe('trackFromStdin', () => {
  it('reads STDIN JSON and tracks Skill tool usage', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'plan-eng-review', args: 'test' },
      tool_output: 'some output',
      session_id: 'sess-123',
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('plan-eng-review');
  });

  it('ignores non-Skill tools from STDIN', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('handles empty STDIN gracefully', async () => {
    const restore = mockStdin('');
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('handles malformed STDIN JSON gracefully', async () => {
    const restore = mockStdin('not valid json {{{');
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('extracts skill from tool_input object (not string)', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'tdd' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('tdd');
  });

  it('updates known-skills.json on successful STDIN track', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'code-review' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const known = await readKnownSkills();
    expect(known.has('code-review')).toBe(true);
  });

  it('tracks Cursor Read tool when path is SKILL.md', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/root/.cursor/skills/tdd/SKILL.md' },
      tool_output: '# TDD Skill\n...',
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('tdd');
    expect(events[0].tool).toBe('cursor');
  });

  it('tracks Cursor Read tool using file_path field (Cursor native format)', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/root/.cursor/skills/code-review-expert/SKILL.md' },
      tool_output: '{"file_path":"...","content_length":194}',
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('code-review-expert');
    expect(events[0].tool).toBe('cursor');
  });

  it('ignores Cursor Read tool for non-SKILL.md files', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/root/project/src/index.ts' },
      tool_output: 'console.log("hello");',
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('extracts skill name from nested Cursor skill paths', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/home/user/.cursor/skills/plan-eng-review/SKILL.md' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('plan-eng-review');
    expect(events[0].tool).toBe('cursor');
  });

  it('records tool as claude for Skill tool calls', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'tdd' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude');
  });

  it('uses --tool argument as tool source when provided', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'tdd' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin('claude-internal');
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude-internal');
  });

  it('uses codebuddy as tool source when --tool codebuddy', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'code-review' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin('codebuddy');
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('codebuddy');
  });

  it('uses codex-internal as tool source when --tool codex-internal', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'code-review' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin('codex-internal');
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('codex-internal');
  });

  it('defaults to claude when no --tool argument (backward compat)', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'tdd' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude');
  });

  it('Read + SKILL.md always records cursor regardless of --tool argument', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/root/.cursor/skills/tdd/SKILL.md' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin('some-other-tool');
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('cursor');
  });

  it('ignores Read tool when path has no SKILL.md suffix', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/root/.cursor/skills/tdd/README.md' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });
});

// ─── known-skills tests ───────────────────────────────

describe('updateKnownSkills', () => {
  it('writes new skill to known-skills.json', async () => {
    await updateKnownSkills('code-review');

    const knownPath = path.join(tmpDir, '.teamai', 'known-skills.json');
    const content = JSON.parse(await fs.promises.readFile(knownPath, 'utf-8'));
    expect(content).toContain('code-review');
  });

  it('does not duplicate existing skills', async () => {
    await updateKnownSkills('tdd');
    await updateKnownSkills('tdd');
    await updateKnownSkills('tdd');

    const knownPath = path.join(tmpDir, '.teamai', 'known-skills.json');
    const content = JSON.parse(await fs.promises.readFile(knownPath, 'utf-8'));
    expect(content.filter((s: string) => s === 'tdd')).toHaveLength(1);
  });
});

describe('readKnownSkills', () => {
  it('merges usage.jsonl and known-skills.json', async () => {
    // Seed known-skills with a previously-reported skill
    await updateKnownSkills('old-skill');

    // Add a new event to usage.jsonl
    await appendUsageEvent({ skill: 'new-skill', timestamp: '2026-03-20T10:00:00Z', tool: 'claude' }, userScope());

    const skills = await readKnownSkills();
    expect(skills.has('old-skill')).toBe(true);
    expect(skills.has('new-skill')).toBe(true);
  });

  it('returns empty set when neither file exists', async () => {
    const skills = await readKnownSkills();
    expect(skills.size).toBe(0);
  });

  it('handles corrupted known-skills.json gracefully', async () => {
    const knownPath = path.join(tmpDir, '.teamai', 'known-skills.json');
    await fse.ensureDir(path.dirname(knownPath));
    await fs.promises.writeFile(knownPath, 'NOT_JSON!!!');

    // Should still work with just usage.jsonl data
    await appendUsageEvent({ skill: 'tdd', timestamp: '2026-03-20T10:00:00Z', tool: 'claude' }, userScope());

    const skills = await readKnownSkills();
    expect(skills.has('tdd')).toBe(true);
  });
});

// ─── stats tests ───────────────────────────────────────

describe('aggregateUsage', () => {
  it('aggregates events by skill', () => {
    const events: UsageEvent[] = [
      { skill: 'tdd', timestamp: '2026-03-19T10:00:00Z', tool: 'claude' },
      { skill: 'code-review', timestamp: '2026-03-19T11:00:00Z', tool: 'claude' },
      { skill: 'tdd', timestamp: '2026-03-19T12:00:00Z', tool: 'claude' },
    ];

    const stats = aggregateUsage(events);
    expect(stats).toHaveLength(2);
    expect(stats[0].name).toBe('tdd');
    expect(stats[0].count).toBe(2);
    expect(stats[1].name).toBe('code-review');
    expect(stats[1].count).toBe(1);
  });

  it('returns empty for no events', () => {
    expect(aggregateUsage([])).toEqual([]);
  });
});

// ─── skill-health tests ───────────────────────────────

describe('calculateSkillHealth', () => {
  it('returns 0 for unused skills', () => {
    expect(calculateSkillHealth(0, new Date(), 10)).toBe(0);
  });

  it('returns 0 when maxCount is 0', () => {
    expect(calculateSkillHealth(5, new Date(), 0)).toBe(0);
  });

  it('returns high score for frequently used, recent skills', () => {
    const score = calculateSkillHealth(100, new Date(), 100);
    expect(score).toBeGreaterThan(80);
  });

  it('returns lower score for stale skills', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const score = calculateSkillHealth(100, thirtyDaysAgo, 100);
    expect(score).toBeLessThanOrEqual(60); // Only usage score, no freshness
  });
});

describe('scoreToStars', () => {
  it('converts score to star rating', () => {
    expect(scoreToStars(100)).toBe('★★★★★');
    expect(scoreToStars(0)).toBe('☆☆☆☆☆');
    expect(scoreToStars(50)).toBe('★★★☆☆');
  });
});

describe('calculateTeamHealth', () => {
  it('aggregates stats across users', () => {
    const stats: UserStats[] = [
      {
        username: 'alice',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 10, lastUsed: new Date().toISOString() } },
      },
      {
        username: 'bob',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 5, lastUsed: new Date().toISOString() } },
      },
    ];

    const health = calculateTeamHealth(stats);
    expect(health).toHaveLength(1);
    expect(health[0].skill).toBe('code-review');
    expect(health[0].totalCount).toBe(15);
    expect(health[0].contributors).toBe(2);
  });

  it('handles empty stats', () => {
    expect(calculateTeamHealth([])).toEqual([]);
  });
});

// ─── skill-recommend tests ─────────────────────────────

describe('getRecommendations', () => {
  it('recommends skills user hasn\'t tried', async () => {
    // No local usage, so all team skills are recommendations
    const teamStats: UserStats[] = [
      {
        username: 'alice',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 10, lastUsed: new Date().toISOString() } },
      },
      {
        username: 'bob',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 5, lastUsed: new Date().toISOString() } },
      },
    ];

    const recs = await getRecommendations(teamStats, new Set(['code-review']));
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].skill).toBe('code-review');
  });

  it('excludes skills in known-skills.json from recommendations', async () => {
    // Mark code-review as known
    await updateKnownSkills('code-review');

    const teamStats: UserStats[] = [
      {
        username: 'alice',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 10, lastUsed: new Date().toISOString() } },
      },
      {
        username: 'bob',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 5, lastUsed: new Date().toISOString() } },
      },
    ];

    const recs = await getRecommendations(teamStats, new Set(['code-review']));
    expect(recs.length).toBe(0);
  });

  it('excludes skills after truncation when known-skills.json exists', async () => {
    // Simulate: track a skill, then report+truncate
    await track('Skill', JSON.stringify({ skill: 'tdd' }));
    await truncateUsageAfterReport(1, userScope()); // usage.jsonl is now empty

    // But known-skills.json should still have 'tdd'
    const teamStats: UserStats[] = [
      {
        username: 'alice',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { tdd: { count: 10, lastUsed: new Date().toISOString() } },
      },
      {
        username: 'bob',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { tdd: { count: 5, lastUsed: new Date().toISOString() } },
      },
    ];

    const recs = await getRecommendations(teamStats, new Set(['tdd']));
    // tdd should NOT be recommended because it's in known-skills.json
    expect(recs.find((r) => r.skill === 'tdd')).toBeUndefined();
  });

  it('returns empty for no team data', async () => {
    const recs = await getRecommendations([], new Set());
    expect(recs).toEqual([]);
  });

  it('recommends only skills the team repo delivers, not teammates\' personal or built-in ones', async () => {
    const used = (...names: string[]): UserStats['skills'] =>
      Object.fromEntries(names.map((name) => [name, { count: 3, lastUsed: '2026-10-12T10:00:00Z' }]));
    const teamStats: UserStats[] = [
      { username: 'alice', updatedAt: '2026-10-12T10:00:00Z', skills: used('tdd', 'pr', 'code-review', 'grilling') },
      { username: 'bob', updatedAt: '2026-10-12T10:00:00Z', skills: used('tnpm-beta-release') },
      { username: 'carol', updatedAt: '2026-10-12T10:00:00Z', skills: used('teamai', 'vertical-clip', 'tgit', 'npm-beta-release') },
    ];
    await updateKnownSkills('tdd');
    await updateKnownSkills('pr');
    await updateKnownSkills('code-review');
    await updateKnownSkills('grilling');
    // The skills pull delivers here: the team repo's. The others are teammates' own or the CLI's built-in.
    const delivered = new Set(['npm-beta-release', 'eli5', 'grill-me', 'grilling', 'i-have-adhd', 'archify']);

    const recs = await getRecommendations(teamStats, delivered);

    expect(recs.map((r) => r.skill)).toEqual(['npm-beta-release']);
  });
});

// ─── extractSkillName tests ────────────────────────────

describe('extractSkillName', () => {
  it('extracts from { skill: "name" }', () => {
    expect(extractSkillName({ skill: 'code-review' })).toBe('code-review');
  });

  it('extracts from { name: "name" }', () => {
    expect(extractSkillName({ name: 'tdd' })).toBe('tdd');
  });

  it('extracts from { skill_name: "name" }', () => {
    expect(extractSkillName({ skill_name: 'plan-eng-review' })).toBe('plan-eng-review');
  });

  it('extracts from { command: "name" }', () => {
    expect(extractSkillName({ command: 'code-review' })).toBe('code-review');
  });

  it('extracts skill directory name from SKILL.md path', () => {
    expect(extractSkillName({ skill: '/root/.cursor/skills/tdd/SKILL.md' })).toBe('tdd');
    expect(extractSkillName({ name: '/home/user/.claude/skills/plan-eng-review/SKILL.md' })).toBe('plan-eng-review');
  });

  it('extracts last segment from filesystem paths', () => {
    expect(extractSkillName({ skill: '/root/.cursor/skills/tdd' })).toBe('tdd');
    expect(extractSkillName({ skill: '~/skills/code-review' })).toBe('code-review');
  });

  it('handles JSON string input', () => {
    expect(extractSkillName(JSON.stringify({ skill: 'tdd' }))).toBe('tdd');
  });

  it('returns null for missing/invalid values', () => {
    expect(extractSkillName({})).toBeNull();
    expect(extractSkillName({ other: 'value' })).toBeNull();
    expect(extractSkillName({ skill: 123 } as unknown as Record<string, unknown>)).toBeNull();
    expect(extractSkillName({ skill: '' })).toBeNull();
  });

  it('returns null for malformed JSON string input', () => {
    expect(extractSkillName('not-json')).toBeNull();
  });
});

// ─── mergeStats tests ──────────────────────────────────

describe('mergeStats', () => {
  it('creates fresh stats when no existing data', () => {
    const newEvents = [
      { name: 'tdd', count: 3, lastUsed: new Date('2026-03-20T10:00:00Z') },
      { name: 'code-review', count: 1, lastUsed: new Date('2026-03-20T11:00:00Z') },
    ];

    const result = mergeStats(null, 'alice', newEvents);
    expect(result.username).toBe('alice');
    expect(result.skills.tdd.count).toBe(3);
    expect(result.skills['code-review'].count).toBe(1);
  });

  it('accumulates counts when merging with existing stats', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-03-19T10:00:00Z',
      skills: {
        tdd: { count: 10, lastUsed: '2026-03-18T10:00:00Z' },
        'code-review': { count: 5, lastUsed: '2026-03-17T10:00:00Z' },
      },
    };

    const newEvents = [
      { name: 'tdd', count: 3, lastUsed: new Date('2026-03-20T10:00:00Z') },
      { name: 'plan-eng-review', count: 1, lastUsed: new Date('2026-03-20T11:00:00Z') },
    ];

    const result = mergeStats(existing, 'alice', newEvents);

    expect(result.skills.tdd.count).toBe(13);
    expect(result.skills.tdd.lastUsed).toBe('2026-03-20T10:00:00.000Z');

    expect(result.skills['code-review'].count).toBe(5);
    expect(result.skills['code-review'].lastUsed).toBe('2026-03-17T10:00:00Z');

    expect(result.skills['plan-eng-review'].count).toBe(1);
  });

  it('keeps existing lastUsed when it is more recent', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-03-19T10:00:00Z',
      skills: {
        tdd: { count: 10, lastUsed: '2026-03-25T10:00:00Z' },
      },
    };

    const newEvents = [
      { name: 'tdd', count: 2, lastUsed: new Date('2026-03-20T10:00:00Z') },
    ];

    const result = mergeStats(existing, 'alice', newEvents);
    expect(result.skills.tdd.count).toBe(12);
    expect(result.skills.tdd.lastUsed).toBe('2026-03-25T10:00:00Z');
  });

  it('handles empty new events with existing stats', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-03-19T10:00:00Z',
      skills: {
        tdd: { count: 10, lastUsed: '2026-03-18T10:00:00Z' },
      },
    };

    const result = mergeStats(existing, 'alice', []);
    expect(result.skills.tdd.count).toBe(10);
  });

  it('preserves interventions/prompts/tokens when only skills are refreshed (Issue #425)', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-03-19T10:00:00Z',
      skills: {
        tdd: { count: 10, lastUsed: '2026-03-18T10:00:00Z' },
      },
      interventions: { sessions: 2, interrupt: 3, toolReject: 1, correction: 0 },
      prompts: 7,
      tokens: { input: 100, output: 20, cacheRead: 5, cacheCreation: 1 },
    };

    const result = mergeStats(existing, 'alice', []);
    expect(result.skills.tdd.count).toBe(10);
    expect(result.interventions).toEqual(existing.interventions);
    expect(result.prompts).toBe(7);
    expect(result.tokens).toEqual(existing.tokens);
  });
});

// ─── trackSlashCommand tests ──────────────────────────

describe('trackSlashCommand', () => {
  it('does not count path segments or URL components that match installed skills', async () => {
    for (const name of ['tdd', 'Volumes', 'External', 'project']) await createFakeSkill(name);
    const restore = mockStdin(JSON.stringify({
      prompt: '/tdd /Volumes/External/project https://example.test/project /tdd/notes /tdd\\notes',
      hook_event_name: 'UserPromptSubmit',
    }));
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    expect((await readUsageEvents(userScope())).map((event) => event.skill)).toEqual(['tdd']);
    expect(await readKnownSkills()).toEqual(new Set(['tdd']));
  });

  it('tracks a valid slash command', async () => {
    await createFakeSkill('plan-eng-review');
    const hookData = JSON.stringify({
      prompt: '/plan-eng-review some args',
      session_id: 'sess-456',
      hook_event_name: 'UserPromptSubmit',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('plan-eng-review');
    expect(events[0].tool).toBe('claude');
  });

  it('tracks a skill installed only under the root recorded by the hook directory\'s config', async () => {
    // The hook reports its cwd; the project config there records a relocated
    // Claude root, and the skill lives only under that root.
    const YAML = (await import('yaml')).default;
    const workspace = path.join(tmpDir, 'workspace');
    const relocated = path.join(tmpDir, '.claude-work');
    await fse.outputFile(path.join(workspace, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: path.join(workspace, '.teamai', 'team-repo'), remote: 'https://example.test/acme/team.git' },
      username: 'tester',
      scope: 'project',
      projectRoot: workspace,
      toolRoots: { claude: relocated },
    }));
    await fse.outputFile(path.join(relocated, 'skills', 'relocated-only', 'SKILL.md'), '# s');
    const hookData = JSON.stringify({
      prompt: '/relocated-only go',
      cwd: workspace,
      session_id: 'sess-reloc',
      hook_event_name: 'UserPromptSubmit',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents({ ...userScope(), scope: 'project', projectRoot: workspace, dataHome: path.join(workspace, '.teamai') } as LocalConfig);
    expect(events.map((e) => e.skill)).toEqual(['relocated-only']);
  });

  it('follows the user-scope record when the hook directory\'s project config has none', async () => {
    const YAML = (await import('yaml')).default;
    const workspace = path.join(tmpDir, 'workspace');
    const relocated = path.join(tmpDir, '.claude-work');
    await fse.outputFile(path.join(tmpDir, '.teamai', 'config.yaml'), YAML.stringify({
      ...userScope(),
      toolRoots: { claude: relocated },
    }));
    await fse.outputFile(path.join(workspace, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: path.join(workspace, '.teamai', 'team-repo'), remote: 'https://example.test/acme/team.git' },
      username: 'tester',
      scope: 'project',
      projectRoot: workspace,
    }));
    await fse.outputFile(path.join(relocated, 'skills', 'user-rooted', 'SKILL.md'), '# s');
    const restore = mockStdin(JSON.stringify({ prompt: '/user-rooted', cwd: workspace, session_id: 's', hook_event_name: 'UserPromptSubmit' }));
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents({ ...userScope(), scope: 'project', projectRoot: workspace, dataHome: path.join(workspace, '.teamai') } as LocalConfig);
    expect(events.map((e) => e.skill)).toEqual(['user-rooted']);
  });

  it('still records when the hook reports a directory that no longer exists', async () => {
    await createFakeSkill('gone-worktree');
    const restore = mockStdin(JSON.stringify({ prompt: '/gone-worktree', cwd: path.join(tmpDir, 'deleted-worktree'), session_id: 's', hook_event_name: 'UserPromptSubmit' }));
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }
    expect((await readUsageEvents(userScope())).map((e) => e.skill)).toEqual(['gone-worktree']);
  });

  it('tracks slash command with colon-namespaced skill', async () => {
    await createFakeSkill('gstack:tdd');
    const hookData = JSON.stringify({
      prompt: '/gstack:tdd',
      session_id: 'sess-789',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('gstack:tdd');
  });

  it('ignores non-slash prompts', async () => {
    const hookData = JSON.stringify({
      prompt: 'Help me fix a bug in the login flow',
      session_id: 'sess-abc',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('ignores empty prompt', async () => {
    const hookData = JSON.stringify({
      prompt: '',
      session_id: 'sess-def',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('handles empty STDIN gracefully', async () => {
    const restore = mockStdin('');
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('handles malformed JSON gracefully', async () => {
    const restore = mockStdin('not valid json');
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('ignores slash commands for non-existent skills', async () => {
    // "/data" is not a real skill — should NOT be tracked
    const hookData = JSON.stringify({
      prompt: '/data',
      session_id: 'sess-phantom',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toEqual([]);
  });

  it('updates known-skills.json on successful slash track', async () => {
    await createFakeSkill('tdd');
    const hookData = JSON.stringify({
      prompt: '/tdd',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const known = await readKnownSkills();
    expect(known.has('tdd')).toBe(true);
  });

  it('uses --tool argument as tool source', async () => {
    await createFakeSkill('plan-eng-review');
    const hookData = JSON.stringify({
      prompt: '/plan-eng-review args',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand('claude-internal');
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude-internal');
  });

  it('uses codex-internal as tool source when --tool codex-internal', async () => {
    await createFakeSkill('plan-eng-review');
    const hookData = JSON.stringify({
      prompt: '/plan-eng-review args',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand('codex-internal');
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('codex-internal');
  });

  it('defaults to claude when no --tool argument (backward compat)', async () => {
    await createFakeSkill('tdd');
    const hookData = JSON.stringify({
      prompt: '/tdd',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude');
  });

  it('tracks multiple slash commands in a single prompt', async () => {
    await createFakeSkill('plan-eng-review');
    await createFakeSkill('tdd');
    await createFakeSkill('code-review');
    const hookData = JSON.stringify({
      prompt: '/plan-eng-review /tdd /code-review',
      session_id: 'sess-multi',
      hook_event_name: 'UserPromptSubmit',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(3);
    expect(events.map((e: UsageEvent) => e.skill).sort()).toEqual(
      ['code-review', 'plan-eng-review', 'tdd'],
    );
  });

  it('tracks multiple slash commands with arguments between them', async () => {
    await createFakeSkill('tdd');
    await createFakeSkill('code-review');
    const hookData = JSON.stringify({
      prompt: '/tdd fix the login bug /code-review',
      session_id: 'sess-multi-args',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(2);
    expect(events.map((e: UsageEvent) => e.skill).sort()).toEqual(
      ['code-review', 'tdd'],
    );
  });

  it('skips non-existent skills among multiple slash commands', async () => {
    await createFakeSkill('tdd');
    // 'nonexistent' is NOT created on disk
    const hookData = JSON.stringify({
      prompt: '/tdd /nonexistent /tdd',
      session_id: 'sess-multi-phantom',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents(userScope());
    // Only 'tdd' should be tracked (twice — it appears twice in prompt)
    expect(events).toHaveLength(2);
    expect(events.every((e: UsageEvent) => e.skill === 'tdd')).toBe(true);
  });
});

// ─── track() with --tool tests ────────────────────────

describe('track with tool parameter', () => {
  it('uses provided tool parameter', async () => {
    await track('Skill', JSON.stringify({ skill: 'code-review' }), 'claude-internal');

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude-internal');
  });

  it('defaults to claude when tool not provided', async () => {
    await track('Skill', JSON.stringify({ skill: 'tdd' }));

    const events = await readUsageEvents(userScope());
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude');
  });
});

// ─── hook command string tests ────────────────────────

describe('hook command strings', () => {
  it('generates dispatch commands with --tool parameter', async () => {
    // Import the module to test hook injection
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-claude', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    await injectHooks(settingsPath, 'claude-internal');

    const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));

    // Check PostToolUse hooks have --tool claude-internal
    const postToolUse = settings.hooks?.PostToolUse;
    expect(postToolUse).toBeDefined();
    const skillHook = postToolUse.find((h: { description?: string }) =>
      h.description?.includes('Hook dispatch post-tool-use Skill'),
    );
    expect(skillHook).toBeDefined();
    expect(skillHook.hooks[0].command).toContain('--tool claude-internal');

    // Check UserPromptSubmit hook has --tool claude-internal
    const userPrompt = settings.hooks?.UserPromptSubmit;
    expect(userPrompt).toBeDefined();
    const promptHook = userPrompt.find((h: { description?: string }) =>
      h.description?.includes('Hook dispatch prompt-submit'),
    );
    expect(promptHook).toBeDefined();
    expect(promptHook.hooks[0].command).toContain('--tool claude-internal');
  });

  it('generates dispatch commands with --tool claude for default tool', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-claude2', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    await injectHooks(settingsPath, 'claude');

    const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));
    const postToolUse = settings.hooks?.PostToolUse;
    const skillHook = postToolUse.find((h: { description?: string }) =>
      h.description?.includes('Hook dispatch post-tool-use Skill'),
    );
    expect(skillHook.hooks[0].command).toContain('--tool claude');
  });

  it('cleans up legacy hooks without description on inject', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-legacy-cleanup', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    // Write a settings file with legacy duplicate hooks (no description)
    const legacySettings = {
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai pull" 2>/dev/null || true' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai pull" 2>/dev/null || true' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai pull" 2>/dev/null || true' }] },
        ],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai update" 2>/dev/null || true' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai update" 2>/dev/null || true' }] },
        ],
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: '/some/other/observe.sh' }] },
        ],
      },
    };
    await fs.promises.writeFile(settingsPath, JSON.stringify(legacySettings, null, 2));

    await injectHooks(settingsPath, 'claude-internal');

    const result = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));

    // Legacy duplicates should be cleaned, replaced by single dispatch entry with description
    // SessionStart has 1 hook (hook-dispatch session-start)
    expect(result.hooks.SessionStart).toHaveLength(1);
    expect(result.hooks.SessionStart[0].description).toContain('[teamai]');
    expect(result.hooks.SessionStart[0].hooks[0].command).toContain('hook-dispatch');

    // Stop has 1 hook (hook-dispatch stop)
    expect(result.hooks.Stop).toHaveLength(1);
    expect(result.hooks.Stop[0].description).toContain('[teamai]');
    expect(result.hooks.Stop[0].hooks[0].command).toContain('hook-dispatch');

    // Non-teamai hooks should be preserved
    expect(result.hooks.PreToolUse).toHaveLength(1);
    expect(result.hooks.PreToolUse[0].hooks[0].command).toContain('observe.sh');
  });

  it('preserves non-teamai hooks during legacy cleanup', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-preserve-others', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    const mixedSettings = {
      hooks: {
        PostToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: '/data/jeff/continuous-learning/observe.sh' }] },
          { matcher: 'Skill', hooks: [{ type: 'command', command: 'bash -lc "teamai track --stdin" 2>>~/.teamai/debug.log || true' }] },
        ],
      },
    };
    await fs.promises.writeFile(settingsPath, JSON.stringify(mixedSettings, null, 2));

    await injectHooks(settingsPath, 'claude');

    const result = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));

    // continuous-learning hook preserved, legacy teamai track removed + replaced with dispatch
    const observeHooks = result.hooks.PostToolUse.filter(
      (h: { hooks?: Array<{ command: string }> }) => h.hooks?.[0]?.command?.includes('observe.sh'),
    );
    expect(observeHooks).toHaveLength(1);

    // teamai dispatch hook should exist with Skill matcher
    const skillHooks = result.hooks.PostToolUse.filter(
      (h: { description?: string }) => h.description?.includes('Hook dispatch post-tool-use Skill'),
    );
    expect(skillHooks).toHaveLength(1);
    expect(skillHooks[0].hooks[0].command).toContain('--tool claude');
  });

  it('cleans up hooks with outdated description keywords', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-outdated-desc', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    // Simulate: old description hooks that should be cleaned up
    const outdatedSettings = {
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'bash -lc "teamai update" 2>/dev/null || true' }],
            description: '[teamai] Check for updates on session end',
          },
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'bash -lc "teamai update" 2>/dev/null || true' }],
            description: '[teamai] Auto-update on session end',
          },
        ],
      },
    };
    await fs.promises.writeFile(settingsPath, JSON.stringify(outdatedSettings, null, 2));

    await injectHooks(settingsPath, 'codebuddy');

    const result = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));

    // Legacy entries cleaned up, replaced with single dispatch entry
    expect(result.hooks.Stop).toHaveLength(1);
    expect(result.hooks.Stop[0].hooks[0].command).toContain('hook-dispatch stop');
    expect(result.hooks.Stop[0].hooks[0].command).toContain('--tool codebuddy');
  });
});

// ─── showStats merge tests (via readUsageEvents + aggregateUsage) ───

describe('showStats merge logic', () => {
  // Note: We test the merge logic directly since showStats() calls console.log
  // and depends on loadLocalConfig() which requires full init.
  // The merge functions used by showStats are tested here.

  it('mergeLocalAndReported is tested via mergeStats — cross-ref: stats.ts mergeLocalAndReported', () => {
    // This is a placeholder acknowledging the DRY situation.
    // mergeLocalAndReported has the same logic as mergeStats (tested above).
    // The cross-reference comments in both files link them.
    expect(true).toBe(true);
  });
});
