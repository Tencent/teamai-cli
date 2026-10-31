/**
 * E2E (#1577): a copy teamai deletes leaves the checkout's delivery record in
 * the same step. Pull's sweeps go through `removeDelivered` with the pull's
 * ledger; `teamai remove` goes through it with the checkout's record and saves
 * it, so the record never names a file that is gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

describe('a deleted copy leaves the delivery record (#1577)', () => {
  let sandbox: string;
  let homeDir: string;
  let remoteRepo: string;
  let attempt = 0;

  function git(args: string[], cwd: string): void {
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
  }

  function writeFile(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  /** A fresh project checkout of the team repo, pulled once. */
  function project(): { root: string; teamai: (args: string[]) => { code: number | null; output: string } } {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, `project-${++attempt}-`)));
    const localRepo = path.join(root, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(root, '.codebuddy'), { recursive: true });
    git(['clone', '-q', remoteRepo, localRepo], sandbox);
    writeFile(path.join(root, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remoteRepo}`,
      'username: member',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${root}`,
      '',
    ].join('\n'));
    const teamai = (args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, HOME: homeDir, FORCE_COLOR: '0' },
      });
      return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const pull = teamai(['pull', '--force']);
    if (pull.code !== 0) throw new Error(`teamai pull failed: ${pull.output}`);
    return { root, teamai };
  }

  /** The files this checkout's record says teamai wrote. */
  function recorded(root: string): string[] {
    const state = JSON.parse(fs.readFileSync(path.join(root, '.teamai', 'state.json'), 'utf8')) as {
      lastPullByWorkspace?: Record<string, { delivered?: Record<string, string> }>;
    };
    return Object.values(state.lastPullByWorkspace ?? {}).flatMap((record) => Object.keys(record.delivered ?? {}));
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-remove-record-e2e-')));
    homeDir = path.join(sandbox, 'home');
    remoteRepo = path.join(sandbox, 'remote');
    fs.mkdirSync(homeDir, { recursive: true });
    writeFile(path.join(remoteRepo, 'teamai.yaml'), [
      'team: remove-record-e2e',
      `repo: ${remoteRepo}`,
      'provider: tgit',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '    rules: .claude/rules',
      '    agents: .claude/agents',
      '  codebuddy:',
      '    skills: .codebuddy/skills',
      '',
    ].join('\n'));
    writeFile(path.join(remoteRepo, 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: Cut a release\n---\n');
    writeFile(path.join(remoteRepo, 'rules', 'commit-style.md'), '# Commit style\n\nUse conventional commits.\n');
    writeFile(path.join(remoteRepo, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs\n---\n\nReview the diff.\n');
    git(['init', '-q', '-b', 'main'], remoteRepo);
    git(['add', '-A'], remoteRepo);
    git(['commit', '-q', '-m', 'fixture'], remoteRepo);
    // A non-bare remote must accept the push `teamai remove` makes.
    git(['config', 'receive.denyCurrentBranch', 'updateInstead'], remoteRepo);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pull deletes a skill the member excludes and takes it off the record', () => {
    const { root, teamai } = project();
    const dest = path.join(root, '.claude', 'skills', 'release');
    fs.appendFileSync(path.join(root, '.teamai', 'config.yaml'), 'excludedSkills:\n  - release\n');

    const pull = teamai(['pull', '--force']);

    expect(pull.code, pull.output).toBe(0);
    expect(fs.existsSync(dest)).toBe(false);
    expect(recorded(root).filter((file) => file.startsWith(`${dest}${path.sep}`))).toEqual([]);
  });

  it('a pull that is already synced deletes a tombstoned copy and takes it off the record', () => {
    const { root, teamai } = project();
    const dest = path.join(root, '.claude', 'rules', 'commit-style.md');
    const localRepo = path.join(root, '.teamai', 'team-repo');
    const stateFile = path.join(root, '.teamai', 'state.json');
    // The team tombstones the rule in a remote of this checkout's own, and an
    // older CLI moved the checkout there without deleting the copy: the
    // revision on record is the new one, so this pull takes the fast path.
    const teamRemote = path.join(sandbox, `tombstone-${attempt}`);
    git(['clone', '-q', remoteRepo, teamRemote], sandbox);
    fs.rmSync(path.join(teamRemote, 'rules', 'commit-style.md'));
    writeFile(path.join(teamRemote, 'rules', '.removed'), 'commit-style\n');
    git(['add', '-A'], teamRemote);
    git(['commit', '-q', '-m', 'tombstone commit-style'], teamRemote);
    git(['remote', 'set-url', 'origin', teamRemote], localRepo);
    git(['pull', '-q', 'origin', 'main'], localRepo);
    const config = path.join(root, '.teamai', 'config.yaml');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(`remote: ${remoteRepo}`, `remote: ${teamRemote}`));
    const state = fs.readFileSync(stateFile, 'utf8');
    const before = (JSON.parse(state) as { lastPullRev: string }).lastPullRev;
    const after = execFileSync('git', ['rev-parse', `--short=${before.length}`, 'HEAD'], { cwd: localRepo, encoding: 'utf8' }).trim();
    fs.writeFileSync(stateFile, state.replaceAll(`"${before}"`, `"${after}"`));

    const pull = teamai(['pull']);

    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toContain('Already synced');
    expect(fs.existsSync(dest)).toBe(false);
    expect(recorded(root)).not.toContain(dest);
  });

  it('uninstall --agent deletes that tool\'s copies and takes them off the record', () => {
    const { root, teamai } = project();
    const claudeDir = path.join(root, '.claude');
    expect(recorded(root).some((file) => file.startsWith(`${claudeDir}${path.sep}`))).toBe(true);

    const uninstall = teamai(['uninstall', '--agent', 'claude', '--force']);

    expect(uninstall.code, uninstall.output).toBe(0);
    expect(recorded(root).filter((file) => file.startsWith(`${claudeDir}${path.sep}`) && !fs.existsSync(file))).toEqual([]);
    expect(recorded(root).some((file) => file.startsWith(`${path.join(root, '.codebuddy')}${path.sep}`))).toBe(true);
  });

  it('a full uninstall takes the record away with the checkout\'s teamai data', () => {
    const { root, teamai } = project();

    const uninstall = teamai(['uninstall', '--force']);

    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.existsSync(path.join(root, '.teamai', 'state.json'))).toBe(false);
  });

  it.each([
    { type: 'skills', name: 'release', copy: path.join('.claude', 'skills', 'release') },
    { type: 'rules', name: 'commit-style', copy: path.join('.claude', 'rules', 'commit-style.md') },
    { type: 'agents', name: 'reviewer', copy: path.join('.claude', 'agents', 'reviewer.md') },
  ])('teamai remove $type deletes the copy and takes it off the record', ({ type, name, copy }) => {
    const { root, teamai } = project();
    const dest = path.join(root, copy);
    expect(fs.existsSync(dest)).toBe(true);
    expect(recorded(root).some((file) => file === dest || file.startsWith(`${dest}${path.sep}`))).toBe(true);

    const removal = teamai(['remove', type, name, '--force']);

    expect(removal.code, removal.output).toBe(0);
    expect(fs.existsSync(dest)).toBe(false);
    expect(recorded(root).filter((file) => file === dest || file.startsWith(`${dest}${path.sep}`))).toEqual([]);
  });
});
