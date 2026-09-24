import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/**
 * The built CLI, run the way an agent runs it: through a shell, reading stdout.
 * The unit tests call the functions; this proves the packaged binary resolves
 * its own content and keeps stdout clean.
 */
describe('teamai skill get / path CLI (e2e)', () => {
  let home: string;

  function run(...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      encoding: 'utf8',
    });
  }

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-serving-e2e-'));
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('serves every skill it lists', () => {
    const listed = run('skill', 'list', '--json');
    expect(listed.status).toBe(0);

    const catalog = JSON.parse(listed.stdout) as { skills: Array<{ name: string; path: string }> };
    expect(catalog.skills.map((s) => s.name)).toEqual(['core', 'setup', 'share', 'wiki']);

    for (const skill of catalog.skills) {
      const got = run('skill', 'get', skill.name);
      expect(got.status, skill.name).toBe(0);
      expect(got.stderr, skill.name).toBe('');
      // Byte-identical to the packaged file, bar the resolved placeholder.
      const raw = fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8');
      expect(got.stdout, skill.name).toBe(raw.split('{SKILL_DIR}').join(skill.path));
      expect(got.stdout, skill.name).not.toContain('{SKILL_DIR}');
    }
  });

  it('serves every skill with --all and no name, and fails with neither', () => {
    const all = run('skill', 'get', '--all');
    expect(all.status, all.stderr).toBe(0);
    // No team config in this HOME, so the recall gate fails open and all four are served.
    expect(all.stdout.match(/^name: /gm)).toHaveLength(4);

    const none = run('skill', 'get');
    expect(none.status).toBe(1);
    expect(none.stdout).toBe('');
    expect(none.stderr).toContain('No skill name provided');
  });

  it('refuses skill path without a name, so the skill-data root is never printed', () => {
    const bare = run('skill', 'path');
    expect(bare.status).toBe(1);
    expect(bare.stdout).toBe('');
    expect(bare.stderr).toContain("missing required argument 'name'");
  });

  it('runs the wiki scripts from the directory it prints', () => {
    const printed = run('skill', 'path', 'wiki');
    expect(printed.status).toBe(0);

    const dir = printed.stdout.trim();
    for (const script of ['scan_repo.py', 'validate_kb.py']) {
      const scriptPath = path.join(dir, 'scripts', script);
      expect(fs.existsSync(scriptPath), scriptPath).toBe(true);

      const help = spawnSync('python3', [scriptPath, '--help'], {
        encoding: 'utf8',
        // Do not leave bytecode in the packaged tree the test just proved ships.
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      // A machine without python3 cannot run them; the path is what we assert there.
      if (help.error) continue;
      expect(help.status, script).toBe(0);
      expect(help.stdout, script).toContain('usage:');
    }
  });

  it('keeps content on stdout and diagnostics on stderr', () => {
    const unknown = run('skill', 'get', 'no-such-skill');
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('Skill not found: no-such-skill');

    const hallucinatedFlag = run('skill', 'get', 'core', '--not-a-flag');
    expect(hallucinatedFlag.status).toBe(0);
    expect(hallucinatedFlag.stderr).toContain('Unknown flag ignored: --not-a-flag');
    expect(hallucinatedFlag.stdout).toContain('name: core');

    const legacyName = run('skill', 'get', 'team-wiki-codebase');
    expect(legacyName.status).toBe(0);
    expect(legacyName.stdout).toContain('name: wiki');

    // Before `teamai init`, an unknown name is a not-found line, not the stack
    // trace of the init error the team lookup would have thrown.
    // `skill show` is a human command: the error is on stderr and the way out
    // is a dim line on stdout, as on the initialised not-found path.
    const shownUnknown = run('skill', 'show', 'no-such-skill');
    expect(shownUnknown.status).toBe(1);
    expect(shownUnknown.stderr).toContain('not found among the skills the installed CLI serves');
    expect(shownUnknown.stdout).toContain('Run `teamai init` first');
    expect(shownUnknown.stdout + shownUnknown.stderr).not.toContain('    at ');
  });

  it('reports an unreadable config instead of calling the machine uninitialized', () => {
    // A config that exists but does not parse is not "no team": the packaged
    // fallback and its `teamai init` hint are for a machine with no config.
    const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-broken-config-'));
    try {
      fs.mkdirSync(path.join(brokenHome, '.teamai'), { recursive: true });
      fs.writeFileSync(path.join(brokenHome, '.teamai', 'config.yaml'), 'repo: [unclosed\n');
      for (const args of [['skill', 'list'], ['skill', 'show', 'core']]) {
        const result = spawnSync(process.execPath, [CLI, ...args], {
          cwd: brokenHome,
          env: { ...process.env, HOME: brokenHome, USERPROFILE: brokenHome, FORCE_COLOR: '0' },
          encoding: 'utf8',
        });
        expect(result.status, args.join(' ')).not.toBe(0);
        // It names the file and where it breaks, which is what the member fixes.
        expect(result.stderr, args.join(' ')).toMatch(/\.teamai[\\/]config\.yaml: .* at line \d+, column \d+/);
        expect(result.stdout + result.stderr, args.join(' ')).not.toContain('Not initialized');
        expect(result.stdout + result.stderr, args.join(' ')).not.toContain('No team is set up');
      }
    } finally {
      fs.rmSync(brokenHome, { recursive: true, force: true });
    }
  });

  it('appends the nested references with --full', () => {
    const full = run('skill', 'get', 'wiki', '--full');
    expect(full.status).toBe(0);

    const separators = full.stdout.split('\n').filter((line) => line.startsWith('--- '));
    expect(separators).toContain('--- references/methodology/phase0-collection.md ---');
    expect(separators).toContain('--- references/phases/phase0-init.md ---');
    // Sorted by relative path, references before templates.
    expect([...separators].sort()).toEqual(separators);
    expect(full.stdout.length).toBeGreaterThan(run('skill', 'get', 'wiki').stdout.length);
  });
});

/**
 * The gate the deployment restriction became. The HOME above has no team
 * config, so every call there fails open; this one carries a team whose recall
 * is off (the default for a fresh team), the case a member actually hits.
 */
describe('teamai skill recall gate CLI (e2e)', () => {
  let home: string;

  function run(...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      encoding: 'utf8',
    });
  }

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-recall-e2e-'));
    const repo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), [
      'team: recall-gate-e2e',
      `repo: ${repo}`,
      'provider: git',
      'usageReport: false',
      'sharing:',
      '  env:',
      '    injectShellProfile: false',
    ].join('\n'));
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${repo}`,
      `  remote: ${repo}`,
      'username: e2e-user',
      'updatePolicy: skip',
      'scope: user',
    ].join('\n'));
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('withholds share on every content path while recall is off, and serves it once enabled', () => {
    const status = run('recall', 'status');
    expect(status.stdout, status.stderr).toContain('Recall: disabled');

    const byName = run('skill', 'get', 'share');
    expect(byName.status).toBe(1);
    expect(byName.stdout).toBe('');
    expect(byName.stderr).toContain('share needs recall');
    expect(byName.stderr).toContain('teamai recall enable');

    const all = run('skill', 'get', '--all');
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout.match(/^name: /gm)).toEqual(['name: ', 'name: ', 'name: ']);
    expect(all.stdout).not.toContain('name: share');
    expect(all.stderr).toContain('Skipped share');

    const dir = run('skill', 'path', 'share');
    expect(dir.status).toBe(1);
    expect(dir.stdout).toBe('');
    expect(dir.stderr).toContain('share needs recall');

    const shown = run('skill', 'show', 'share');
    expect(shown.status).toBe(1);
    expect(shown.stdout).not.toContain('skill: share');
    expect(shown.stdout).not.toContain('skill-data');

    const core = run('skill', 'show', 'core');
    expect(core.status, core.stderr).toBe(0);
    expect(core.stdout).toContain('Source       : [builtin]');
    expect(core.stdout).toContain('Read it with : teamai skill get core');

    const listed = run('skill', 'list', '--json');
    expect(listed.status).toBe(0);
    const catalog = JSON.parse(listed.stdout) as { skills: Array<{ name: string; path: string | null; blockedBy: string | null }> };
    expect(catalog.skills.find((s) => s.name === 'share')).toMatchObject({ blockedBy: 'recall', path: null });
    expect(catalog.skills.filter((s) => s.name !== 'share').every((s) => s.blockedBy === null && s.path !== null)).toBe(true);

    const enable = run('recall', 'enable');
    expect(enable.status, enable.stderr).toBe(0);

    expect(run('skill', 'get', 'share').stdout).toContain('name: share');
    expect(run('skill', 'get', '--all').stdout.match(/^name: /gm)).toHaveLength(4);
    const servedDir = run('skill', 'path', 'share').stdout.trim();
    expect(fs.existsSync(path.join(servedDir, 'SKILL.md'))).toBe(true);
    expect(run('skill', 'show', 'share').stdout).toContain(`Package dir  : ${servedDir}/`);
    const after = JSON.parse(run('skill', 'list', '--json').stdout) as { skills: Array<{ name: string; path: string | null; blockedBy: string | null }> };
    expect(after.skills.find((s) => s.name === 'share')).toMatchObject({ blockedBy: null, path: servedDir });
  });
});
