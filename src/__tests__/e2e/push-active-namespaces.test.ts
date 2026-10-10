/**
 * Where `teamai push` sends a project scope's resources, through the built CLI
 * and a local bare team repo. Destinations are read from the branch that
 * reached the remote, not from CLI output alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;
let project: string;
let origin: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = sandbox): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env, encoding: 'utf8', timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`;
}

function setConfig(patch: Record<string, unknown>): void {
  const file = path.join(project, '.teamai', 'config.yaml');
  writeFile(file, YAML.stringify({ ...YAML.parse(fs.readFileSync(file, 'utf8')), ...patch }));
}

function recordDeliveredCopies(entries: Record<string, string>): void {
  const file = path.join(project, '.teamai', 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    lastPullByWorkspace: Record<string, { delivered?: Record<string, string> }>;
  };
  const record = Object.values(state.lastPullByWorkspace)[0];
  if (!record) throw new Error('project delivery record is missing');
  record.delivered = { ...record.delivered, ...entries };
  writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Commit a file (null: its removal) straight onto the remote's default branch, as a teammate would. */
function commitOnTeam(relPath: string, content: string | null): void {
  const teammate = fs.mkdtempSync(path.join(sandbox, 'teammate-'));
  git(['clone', '-q', origin, teammate]);
  if (content === null) git(['rm', '-rq', relPath], teammate);
  else writeFile(path.join(teammate, relPath), content);
  git(['add', '.'], teammate);
  git(['commit', '-qm', `teammate: ${relPath}`], teammate);
  git(['push', '-q', 'origin', 'main'], teammate);
}

/** Merge one teammate change to the default branch, preserving its merge diff. */
function mergeOnTeam(relPath: string, content: string | null): void {
  const teammate = fs.mkdtempSync(path.join(sandbox, 'teammate-merge-'));
  git(['clone', '-q', origin, teammate]);
  git(['switch', '-q', '-c', 'teammate-change'], teammate);
  if (content === null) git(['rm', '-rq', relPath], teammate);
  else writeFile(path.join(teammate, relPath), content);
  git(['add', '.'], teammate);
  git(['commit', '-qm', `teammate: ${relPath}`], teammate);
  git(['switch', '-q', 'main'], teammate);
  git(['merge', '-q', '--no-ff', '-m', `merge teammate: ${relPath}`, 'teammate-change'], teammate);
  git(['push', '-q', 'origin', 'main'], teammate);
}

/** Every file on the push branches the remote received, newest branch last. */
function pushedFiles(): string[] {
  const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], origin)
    .split('\n').filter(Boolean);
  return branches.flatMap((branch) => git(['diff', '--name-only', 'main', branch], origin).split('\n').filter(Boolean));
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-active-ns-'));
  const home = path.join(sandbox, 'home');
  const seed = path.join(sandbox, 'seed');
  project = path.join(sandbox, 'project');
  origin = path.join(sandbox, 'origin.git');
  const clone = path.join(project, '.teamai', 'team-repo');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  env = {
    ...process.env,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'member', GIT_AUTHOR_EMAIL: 'member@example.invalid',
    GIT_COMMITTER_NAME: 'member', GIT_COMMITTER_EMAIL: 'member@example.invalid',
    GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', TEAMAI_NONINTERACTIVE: '1',
  };
  writeFile(path.join(seed, 'teamai.yaml'), YAML.stringify({
    team: 'push-active-ns', repo: origin, provider: 'git', usageReport: false,
  }));
  writeFile(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify({
    version: 1,
    projects: [
      { id: 'svc-a', resources: { skills: ['svc-a', 'payments'], knowledge: ['svc-a'], learnings: ['svc-a'] } },
      { id: 'svc-b', resources: { skills: ['svc-b', 'payments'], knowledge: ['svc-b'], learnings: ['svc-b'] } },
      { id: 'platform', resources: { skills: ['platform'], knowledge: ['platform'], learnings: ['platform'] } },
    ],
  }));
  for (const [ns, name] of [['svc-a', 'a-skill'], ['svc-b', 'b-skill'], ['payments', 'pay-skill'], ['platform', 'plat-skill']]) {
    writeFile(path.join(seed, 'skills', ns, name, 'SKILL.md'), skillMd(name));
  }
  writeFile(path.join(seed, 'rules', 'svc-a', 'a-rule.md'), '# a rule\n');
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '.'], seed);
  git(['commit', '-qm', 'fixture'], seed);
  git(['clone', '-q', '--bare', seed, origin]);
  git(['clone', '-q', origin, clone]);
  writeFile(path.join(project, '.teamai', 'config.yaml'), YAML.stringify({
    repo: { localPath: clone, remote: origin, kind: 'git' },
    username: 'member', scope: 'project', projectRoot: project,
    updatePolicy: 'skip', additionalRoles: [], projects: ['svc-a'], enabledAgents: ['claude'],
  }));
  const pulled = run(['pull']);
  expect(pulled.code, pulled.output).toBe(0);
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe('push an edit of a skill pull kept after a project switch (#1020)', () => {
  it('pushes two tool edits to their distinct delivered destinations', () => {
    const svcB = `${skillMd('a-skill')}\nThe svc-b version.\n`;
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', svcB);
    commitOnTeam('teamai.yaml', [
      'team: push-active-ns',
      `repo: ${origin}`,
      'provider: git',
      'usageReport: false',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '  codex:',
      '    skills: .codex/skills',
      '',
    ].join('\n'));
    git(['pull', '-q', 'origin', 'main'], path.join(project, '.teamai', 'team-repo'));
    const codexSkill = path.join(project, '.codex', 'skills', 'a-skill');
    writeFile(path.join(codexSkill, 'SKILL.md'), `${svcB}\nCodex edit.\n`);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nClaude edit.\n');
    recordDeliveredCopies({ [path.join(codexSkill, 'SKILL.md')]: contentHash(svcB) });
    setConfig({ enabledAgents: ['claude', 'codex'] });
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushedFiles(), pushed.output).toEqual(expect.arrayContaining([
      'skills/svc-a/a-skill/SKILL.md', 'skills/svc-b/a-skill/SKILL.md',
    ]));
  });

  it('updates the open PR of one destination and opens another for a same-named skill elsewhere', () => {
    const svcB = `${skillMd('a-skill')}\nThe svc-b version.\n`;
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', svcB);
    commitOnTeam('teamai.yaml', [
      'team: push-active-ns',
      `repo: ${origin}`,
      'provider: git',
      'usageReport: false',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '  codex:',
      '    skills: .codex/skills',
      '',
    ].join('\n'));
    git(['pull', '-q', 'origin', 'main'], path.join(project, '.teamai', 'team-repo'));
    const codexSkill = path.join(project, '.codex', 'skills', 'a-skill');
    writeFile(path.join(codexSkill, 'SKILL.md'), `${svcB}\nCodex edit.\n`);
    recordDeliveredCopies({ [path.join(codexSkill, 'SKILL.md')]: contentHash(svcB) });
    setConfig({ enabledAgents: ['claude', 'codex'] });
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    // A bare local remote cannot open a PR; the branch and its record are what count here.
    run(['push', '--all']);
    const [openBranch] = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], origin).split('\n');

    fs.appendFileSync(path.join(codexSkill, 'SKILL.md'), '\nSecond codex edit.\n');
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nClaude edit.\n');
    const pushed = run(['push', '--all']);

    const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], origin)
      .split('\n').filter(Boolean);
    const filesOn = (branch: string) => git(['diff', '--name-only', 'main', branch], origin).split('\n')
      .filter((file) => file.endsWith('/SKILL.md'));
    expect(branches, pushed.output).toHaveLength(2);
    expect(filesOn(openBranch!), pushed.output).toEqual(['skills/svc-b/a-skill/SKILL.md']);
    expect(git(['show', `${openBranch}:skills/svc-b/a-skill/SKILL.md`], origin)).toContain('Second codex edit.');
    expect(filesOn(branches.find((b) => b !== openBranch)!), pushed.output).toEqual(['skills/svc-a/a-skill/SKILL.md']);
  });

  it('resolves a legacy delivered duplicate against every namespace, not only the first', () => {
    commitOnTeam('skills/z-archive/a-skill/SKILL.md', `${skillMd('a-skill')}\nDelivered from z-archive.\n`);
    commitOnTeam('manifest/projects.yaml', null);
    setConfig({ projects: [], primaryRole: undefined });

    const pulled = run(['pull']);
    expect(pulled.code, pulled.output).toBe(0);
    const localSkill = path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md');
    expect(fs.readFileSync(localSkill, 'utf8')).toContain('Delivered from z-archive.');
    fs.appendFileSync(localSkill, '\nEdited after the legacy pull.\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/z-archive/a-skill');
    expect(pushedFiles()).toContain('skills/z-archive/a-skill/SKILL.md');
    expect(pushedFiles()).not.toContain('skills/svc-a/a-skill/SKILL.md');

    commitOnTeam('skills/a-archive/member-owned/SKILL.md', skillMd('member-owned'));
    commitOnTeam('skills/z-archive/member-owned/SKILL.md', skillMd('member-owned'));
    writeFile(path.join(project, '.claude', 'skills', 'member-owned', 'SKILL.md'), skillMd('member-owned'));
    const unrecorded = run(['push', '--all']);

    expect(unrecorded.output).toContain('no delivery record proves which one this copy came from');
    expect(pushedFiles()).not.toContain('skills/a-archive/member-owned/SKILL.md');
    expect(pushedFiles()).not.toContain('skills/z-archive/member-owned/SKILL.md');
  });

  it('offers the edit with --all and sends it back to the namespace it came from', () => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    const pulled = run(['pull']);
    expect(pulled.output).toContain('Kept skill "a-skill"');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).toContain('skills/svc-a/a-skill/SKILL.md');
  });

  it('sends the edit to its namespace, not to a shared-root skill of the same name', () => {
    commitOnTeam('skills/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe shared catalog version.\n`);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).toContain('skills/svc-a/a-skill/SKILL.md');
    expect(pushedFiles()).not.toContain('skills/a-skill/SKILL.md');
  });

  it('pushes nothing for an unedited copy whose team skill changed since teamai delivered it', () => {
    commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nA teammate's update.\n`);
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('No new or modified resources to push');
    expect(pushedFiles()).toEqual([]);
  });

  it('sends an edit to its namespace when both it and a shared-root skill changed since delivery', () => {
    commitOnTeam('skills/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe shared catalog version.\n`);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);
    commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nA teammate's update.\n`);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).not.toContain('skills/a-skill/SKILL.md');
  });

  it('says once that pull kept the edited skill', () => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);

    const pulled = run(['pull']);

    expect(pulled.output.match(/Kept skill "a-skill"/g), pulled.output).toHaveLength(1);
  });

  it('sends the edit to the inactive namespace it came from, not the active one holding the same name', () => {
    commitOnTeam('skills/svc-a/dup-skill/SKILL.md', `${skillMd('dup-skill')}\nThe svc-a version.\n`);
    commitOnTeam('skills/svc-b/dup-skill/SKILL.md', `${skillMd('dup-skill')}\nThe svc-b version.\n`);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'dup-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).output).toContain('Kept');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/svc-a/dup-skill');
    expect(pushedFiles()).toContain('skills/svc-a/dup-skill/SKILL.md');
    expect(pushedFiles()).not.toContain('skills/svc-b/dup-skill/SKILL.md');
  });

  it.each([
    ['in an inactive namespace', 'skills/platform/a-skill'],
    ['at the shared root', 'skills/a-skill'],
    ['in an active namespace', 'skills/svc-b/a-skill'],
  ])('leaves an unrelated skill %s alone when the one the edit came from was deleted', (_where, unrelated) => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    commitOnTeam('skills/svc-a/a-skill', null);
    commitOnTeam(`${unrelated}/SKILL.md`, `${skillMd('a-skill')}\nAn unrelated skill.\n`);
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain(`Skipped a-skill: teamai delivered this copy, but its record matches no version of ${unrelated}`);
    expect(pushedFiles()).toEqual([]);
  });

  it('opens its own PR instead of replacing an open one for another namespace\'s skill of the same name', () => {
    commitOnTeam('skills/svc-a/dup-skill/SKILL.md', `${skillMd('dup-skill')}\nThe svc-a version.\n`);
    commitOnTeam('skills/svc-b/dup-skill/SKILL.md', `${skillMd('dup-skill')}\nThe svc-b version.\n`);
    const local = path.join(project, '.claude', 'skills', 'dup-skill');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(local, 'SKILL.md'), '\nEdited while on svc-b.\n');
    run(['push', '--all']);
    const [svcBBranch] = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], origin).split('\n');
    fs.rmSync(local, { recursive: true });
    expect(run(['projects', 'set', 'svc-a']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(local, 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).output).toContain('Kept');
    // Push branch names carry a one-second timestamp; a second push in the same second reuses the name.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

    const pushed = run(['push', '--all']);

    // Another namespace's skill is another resource: no collision with its PR.
    expect(pushed.output).not.toContain('awaiting review');
    expect(git(['show', `${svcBBranch}:skills/svc-b/dup-skill/SKILL.md`], origin)).toContain('Edited while on svc-b.');
    expect(pushedFiles()).toContain('skills/svc-a/dup-skill/SKILL.md');
  });

  it('names both namespaces and pushes nothing when two inactive namespaces hold the name', () => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', skillMd('a-skill'));
    expect(run(['projects', 'set', 'platform']).code).toBe(0);
    expect(run(['pull']).output).toContain('Kept skill "a-skill"');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushed.output).toContain('skills/svc-a/a-skill and skills/svc-b/a-skill');
    expect(pushedFiles()).toEqual([]);
  });

  it.each([
    { flag: ['--project', 'svc-b'], rule: 'rules/svc-b/new-rule.md' },
    { flag: ['--role', 'platform'], rule: 'rules/platform/new-rule.md' },
  ])('keeps the edit\'s namespace when $flag places new resources', ({ flag, rule }) => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all', ...flag]);

    expect(pushedFiles(), pushed.output).toEqual(expect.arrayContaining(['skills/svc-a/a-skill/SKILL.md', rule]));
    expect(pushedFiles().filter((file) => file.endsWith('a-skill/SKILL.md'))).toEqual(['skills/svc-a/a-skill/SKILL.md']);
  });

  it('says nothing about an unedited copy two inactive namespaces hold', () => {
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', skillMd('a-skill'));
    expect(run(['projects', 'set', 'platform']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).not.toContain('Skipped a-skill');
    expect(pushedFiles()).toEqual([]);
  });

  it('leaves out a member\'s own skill that only shares its name with an inactive namespace', () => {
    writeFile(path.join(project, '.claude', 'skills', 'b-skill', 'SKILL.md'), skillMd('b-skill') + '\nMy own.\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('No new or modified resources to push');
    expect(pushedFiles()).toEqual([]);
  });

  it.each([
    { label: '--role', flags: (_skillPath: string) => ['--role', 'platform'] },
    { label: '--project', flags: (_skillPath: string) => ['--project', 'platform'] },
    { label: '--skill with --role', flags: (skillPath: string) => ['--skill', skillPath, '--role', 'platform'] },
    { label: '--skill with --project', flags: (skillPath: string) => ['--skill', skillPath, '--project', 'platform'] },
  ])('does not route an ambiguous delivered origin with $label', ({ flags }) => {
    const skillPath = path.join(project, '.claude', 'skills', 'a-skill');
    fs.appendFileSync(path.join(skillPath, 'SKILL.md'), '\nEdited after delivery.\n');
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', skillMd('a-skill'));

    const pushed = run(['push', '--all', ...flags(skillPath)]);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushed.output).toContain('copy it under a new name and push that');
    expect(pushedFiles()).toEqual([]);
  });
});

describe('push gives each local copy one team destination, whatever its scan status', () => {
  const pushBranches = () => git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], origin)
    .split('\n').filter(Boolean);
  const skillFilesOn = (branch: string) => git(['diff', '--name-only', 'main', branch], origin).split('\n')
    .filter((file) => file.endsWith('/SKILL.md'));
  const localSkill = (name: string) => path.join(project, '.claude', 'skills', name);

  /**
   * New skills pushed to `platform` and still awaiting review, then a
   * teammate's unrelated shared-root `skills/foo`: from here the scan calls
   * the local `foo` an edit of that shared skill.
   */
  function awaitReviewThenShareFooAtRoot(names: string[]): string {
    expect(run(['projects', 'set', 'platform']).code).toBe(0);
    for (const name of names) writeFile(path.join(localSkill(name), 'SKILL.md'), skillMd(name));
    run(['push', '--all']);
    const [openBranch] = pushBranches();
    commitOnTeam('skills/foo/SKILL.md', `${skillMd('foo')}\nA teammate's shared skill.\n`);
    fs.appendFileSync(path.join(localSkill('foo'), 'SKILL.md'), '\nSecond edit.\n');
    // Push branch names carry a one-second timestamp; a second push in the same second reuses the name.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    return openBranch!;
  }

  /**
   * A new resource pushed by `open` and still awaiting review, its record as
   * an earlier version wrote it — no `namespace` field — and then edited after
   * switching the active project to platform.
   */
  function awaitReviewInOlderRecordThenSwitchProject(local: string, open: () => ReturnType<typeof run>): string {
    const opened = open();
    const [openBranch] = pushBranches();
    expect(openBranch, opened.output).toBeDefined();
    const file = path.join(project, '.teamai', 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      pendingPushes: { items: { namespace?: string }[] }[];
    };
    for (const entry of state.pendingPushes) for (const item of entry.items) delete item.namespace;
    writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
    expect(run(['projects', 'set', 'platform']).code).toBe(0);
    fs.appendFileSync(local, '\nSecond edit.\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    return openBranch!;
  }

  const untouchedSharedRoot = () => {
    for (const branch of pushBranches()) expect(skillFilesOn(branch)).not.toContain('skills/foo/SKILL.md');
  };

  /**
   * Edits of team skill svc-a/a-skill from Claude and Codex. Only the
   * `recorded` tool's copy has a delivery record; `newer` holds the newer edit.
   */
  function editFromTwoTools(recorded: 'claude' | 'codex', newer: 'claude' | 'codex'): string {
    commitOnTeam('teamai.yaml', [
      'team: push-active-ns', `repo: ${origin}`, 'provider: git', 'usageReport: false',
      'toolPaths:', '  claude:', '    skills: .claude/skills', '  codex:', '    skills: .codex/skills', '',
    ].join('\n'));
    git(['pull', '-q', 'origin', 'main'], path.join(project, '.teamai', 'team-repo'));
    setConfig({ enabledAgents: ['claude', 'codex'] });
    const copies = { claude: localSkill('a-skill'), codex: path.join(project, '.codex', 'skills', 'a-skill') };
    writeFile(path.join(copies.codex, 'SKILL.md'), `${skillMd('a-skill')}\nCodex edit.\n`);
    fs.appendFileSync(path.join(copies.claude, 'SKILL.md'), '\nClaude edit.\n');
    if (recorded === 'codex') {
      const file = path.join(project, '.teamai', 'state.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        lastPullByWorkspace: Record<string, { delivered?: Record<string, string> }>;
      };
      for (const record of Object.values(state.lastPullByWorkspace)) {
        for (const dest of Object.keys(record.delivered ?? {})) {
          if (dest.includes(`${path.sep}.claude${path.sep}skills${path.sep}a-skill`)) delete record.delivered![dest];
        }
      }
      writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
      recordDeliveredCopies({ [path.join(fs.realpathSync(copies.codex), 'SKILL.md')]: contentHash(skillMd('a-skill')) });
    }
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(copies[newer], 'SKILL.md'), later, later);
    return copies.codex;
  }

  it.each([
    {
      site: 'candidate dedup: two tools edit one destination and only one copy has a delivery record',
      check: () => {
        const codexSkill = editFromTwoTools('claude', 'claude');

        const pushed = run(['push', '--all']);

        const [branch] = pushBranches();
        expect(skillFilesOn(branch!), pushed.output).toEqual(['skills/svc-a/a-skill/SKILL.md']);
        const sent = git(['show', `${branch}:skills/svc-a/a-skill/SKILL.md`], origin);
        expect(sent, pushed.output).toContain('Claude edit.');
        expect(sent).not.toContain('Codex edit.');
        expect(pushed.output).toContain(`Skipped a-skill at ${fs.realpathSync(codexSkill)}: another edited copy`);
      },
    },
    ...([['claude', 'codex'], ['codex', 'claude']] as const).map(([recorded, newer]) => ({
      site: `candidate dedup with --role: the newer unrecorded ${newer} copy still goes to the destination ${recorded}'s record proves`,
      check: () => {
        editFromTwoTools(recorded, newer);

        const pushed = run(['push', '--all', '--role', 'platform']);

        const [branch] = pushBranches();
        expect(skillFilesOn(branch!), pushed.output).toEqual(['skills/svc-a/a-skill/SKILL.md']);
        expect(git(['show', `${branch}:skills/svc-a/a-skill/SKILL.md`], origin))
          .toContain(newer === 'codex' ? 'Codex edit.' : 'Claude edit.');
      },
    })),
    {
      site: 'open-PR matching, pruning, grouping and write namespace: the open PR is updated in place',
      check: () => {
        const openBranch = awaitReviewThenShareFooAtRoot(['foo']);

        const pushed = run(['push', '--all']);

        expect(pushBranches(), pushed.output).toEqual([openBranch]);
        expect(skillFilesOn(openBranch)).toEqual(['skills/platform/foo/SKILL.md']);
        expect(git(['show', `${openBranch}:skills/platform/foo/SKILL.md`], origin)).toContain('Second edit.');
        untouchedSharedRoot();
      },
    },
    ...[
      { scope: 'an inactive namespace', projects: ['platform'], openFlags: [], teammate: ['skills/svc-b/foo'] },
      { scope: 'several legacy namespaces', projects: [], openFlags: ['--role', 'platform'], teammate: ['skills/svc-a/foo', 'skills/svc-b/foo'] },
    ].map(({ scope, projects, openFlags, teammate }) => ({
      site: `open-PR record before team tree: a teammate adds the name only in ${scope}`,
      check: () => {
        setConfig({ projects });
        writeFile(path.join(localSkill('foo'), 'SKILL.md'), skillMd('foo'));
        const opened = run(['push', '--all', ...openFlags]);
        const [openBranch] = pushBranches();
        expect(openBranch, opened.output).toBeDefined();
        expect(skillFilesOn(openBranch!)).toEqual(['skills/platform/foo/SKILL.md']);
        for (const dir of teammate) commitOnTeam(`${dir}/SKILL.md`, `${skillMd('foo')}\nA teammate's skill.\n`);
        fs.appendFileSync(path.join(localSkill('foo'), 'SKILL.md'), '\nSecond edit.\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

        const pushed = run(['push', '--all']);

        expect(pushBranches(), pushed.output).toEqual([openBranch]);
        expect(skillFilesOn(openBranch!), pushed.output).toEqual(['skills/platform/foo/SKILL.md']);
        expect(git(['show', `${openBranch}:skills/platform/foo/SKILL.md`], origin), pushed.output).toContain('Second edit.');
        for (const dir of teammate) {
          expect(git(['show', `${openBranch}:${dir}/SKILL.md`], origin)).toContain('A teammate\'s skill.');
        }
      },
    })),
    {
      site: '--skill on a copy the scan left out: the same open-PR destination as push --all',
      check: () => {
        const openBranch = awaitReviewThenShareFooAtRoot(['foo']);
        commitOnTeam('teamai.yaml', [
          'team: push-active-ns', `repo: ${origin}`, 'provider: git', 'usageReport: false',
          'toolPaths:', '  claude:', '    skills: .claude/skills', '  codex:', '    skills: .codex/skills', '',
        ].join('\n'));
        git(['pull', '-q', 'origin', 'main'], path.join(project, '.teamai', 'team-repo'));
        setConfig({ enabledAgents: ['claude', 'codex'] });
        // Codex's own, older copy: the scan keeps Claude's newer one for the open PR's destination.
        const codexFoo = path.join(project, '.codex', 'skills', 'foo');
        writeFile(path.join(codexFoo, 'SKILL.md'), `${skillMd('foo')}\nCodex copy.\n`);
        const earlier = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(codexFoo, 'SKILL.md'), earlier, earlier);
        expect(run(['push', '--dry-run']).output).toContain('to:   skills/platform/foo');

        const pushed = run(['push', '--all', '--skill', codexFoo]);

        expect(pushed.output).toContain(`Skipped foo at ${fs.realpathSync(codexFoo)}: another edited copy for skills/platform/foo`);
        expect(pushBranches(), pushed.output).toEqual([openBranch]);
        expect(skillFilesOn(openBranch), pushed.output).toEqual(['skills/platform/foo/SKILL.md']);
        const sent = git(['show', `${openBranch}:skills/platform/foo/SKILL.md`], origin);
        expect(sent, pushed.output).toContain('Codex copy.');
        expect(sent).not.toContain('Second edit.');
        untouchedSharedRoot();
      },
    },
    ...[
      { run: 'push --all', role: null },
      ...(['svc-a', 'platform'] as const).map((role) => ({ run: `--skill <path> --role ${role}`, role })),
    ].map(({ run: label, role }) => ({
      site: `open PRs at two destinations for one name: ${label}`,
      check: () => {
        const platformBranch = awaitReviewThenShareFooAtRoot(['foo']);
        run(['push', '--all', '--role', 'svc-a']);
        const svcABranch = pushBranches().find((b) => b !== platformBranch)!;
        expect(skillFilesOn(svcABranch)).toEqual(['skills/svc-a/foo/SKILL.md']);
        commitOnTeam('teamai.yaml', [
          'team: push-active-ns', `repo: ${origin}`, 'provider: git', 'usageReport: false',
          'toolPaths:', '  claude:', '    skills: .claude/skills', '  codex:', '    skills: .codex/skills', '',
        ].join('\n'));
        git(['pull', '-q', 'origin', 'main'], path.join(project, '.teamai', 'team-repo'));
        setConfig({ enabledAgents: ['claude', 'codex'] });
        writeFile(path.join(project, '.codex', 'skills', 'foo', 'SKILL.md'), `${skillMd('foo')}\nCodex copy.\n`);
        fs.appendFileSync(path.join(localSkill('foo'), 'SKILL.md'), '\nThird edit.\n');
        const tips = () => [platformBranch, svcABranch].map((b) => git(['rev-parse', b], origin));
        const before = tips();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

        const pushed = run(['push', '--all', ...role === null ? [] : ['--skill', localSkill('foo'), '--role', role]]);

        expect(pushBranches().sort(), pushed.output).toEqual([platformBranch, svcABranch].sort());
        if (role === null) {
          for (const copy of [localSkill('foo'), path.join(project, '.codex', 'skills', 'foo')]) {
            expect(pushed.output).toContain(`Skipped foo: ${fs.realpathSync(copy)} is awaiting review at several destinations: `);
          }
          expect(pushed.output).toContain(`skills/platform/foo (branch ${platformBranch})`);
          expect(pushed.output).toContain(`skills/svc-a/foo (branch ${svcABranch})`);
          expect(pushed.output).toContain('teamai push --skill');
          expect(tips(), pushed.output).toEqual(before);
          // The records survive: the next run holds the copies back again.
          const again = run(['push', '--all']);
          expect(again.output).toContain('is awaiting review at several destinations');
          expect(pushBranches().sort(), again.output).toEqual([platformBranch, svcABranch].sort());
          expect(tips(), again.output).toEqual(before);
        } else {
          const [updated, untouched] = role === 'svc-a' ? [svcABranch, platformBranch] : [platformBranch, svcABranch];
          expect(git(['rev-parse', untouched], origin), pushed.output).toBe(before[role === 'svc-a' ? 0 : 1]);
          expect(skillFilesOn(updated), pushed.output).toEqual([`skills/${role}/foo/SKILL.md`]);
          const sent = git(['show', `${updated}:skills/${role}/foo/SKILL.md`], origin);
          expect(sent, pushed.output).toContain('Third edit.');
          expect(sent).not.toContain('Codex copy.');
        }
        untouchedSharedRoot();
      },
    })),
    ...[
      { label: '--skill <path> without --role', args: (skill: string) => ['--skill', skill] },
      { label: '--skill <path> --role svc-a', args: (skill: string) => ['--skill', skill, '--role', 'svc-a'] },
      { label: '--skill <path> --role svc-b, which neither PR uses', args: (skill: string) => ['--skill', skill, '--role', 'svc-b'] },
      { label: 'push --all --role svc-b, which neither PR uses', args: (_skill: string) => ['--role', 'svc-b'] },
    ].map(({ label, args }) => ({
      site: `open PRs at two destinations for one name, explicit choice: ${label}`,
      check: () => {
        const platformBranch = awaitReviewThenShareFooAtRoot(['foo']);
        run(['push', '--all', '--role', 'svc-a']);
        const svcABranch = pushBranches().find((b) => b !== platformBranch)!;
        expect(skillFilesOn(svcABranch)).toEqual(['skills/svc-a/foo/SKILL.md']);
        fs.appendFileSync(path.join(localSkill('foo'), 'SKILL.md'), '\nThird edit.\n');
        const tips = () => [platformBranch, svcABranch].map((b) => git(['rev-parse', b], origin));
        const before = tips();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

        const pushed = run(['push', '--all', ...args(localSkill('foo'))]);

        if (label.includes('without --role')) {
          expect(pushed.code, pushed.output).toBe(2);
          expect(pushed.output).toContain(`skills/platform/foo (branch ${platformBranch})`);
          expect(pushed.output).toContain(`skills/svc-a/foo (branch ${svcABranch})`);
          expect(pushBranches().sort(), pushed.output).toEqual([platformBranch, svcABranch].sort());
          expect(tips(), pushed.output).toEqual(before);
        } else if (label.includes('svc-a')) {
          // The flag picks the PR in the scan itself: no skip, and no advice to run this very command.
          expect(pushed.output).not.toContain('is awaiting review at several destinations');
          expect(git(['rev-parse', platformBranch], origin), pushed.output).toBe(before[0]);
          expect(skillFilesOn(svcABranch), pushed.output).toEqual(['skills/svc-a/foo/SKILL.md']);
          expect(git(['show', `${svcABranch}:skills/svc-a/foo/SKILL.md`], origin), pushed.output).toContain('Third edit.');
        } else {
          // A namespace neither PR uses is a new destination: its own PR, both open ones untouched.
          expect(pushed.output).not.toContain('is awaiting review at several destinations');
          expect(tips(), pushed.output).toEqual(before);
          const added = pushBranches().filter((b) => b !== platformBranch && b !== svcABranch);
          expect(added, pushed.output).toHaveLength(1);
          expect(skillFilesOn(added[0]!), pushed.output).toEqual(['skills/svc-b/foo/SKILL.md']);
          expect(git(['show', `${added[0]}:skills/svc-b/foo/SKILL.md`], origin)).toContain('Third edit.');
        }
        untouchedSharedRoot();
      },
    })),
    ...(['codex', 'claude'] as const).map((newer) => ({
      site: `candidate dedup: an open PR's copy and the ${newer === 'codex' ? 'newer ' : 'older '}delivered copy of a new shared skill keep their destinations`,
      check: () => {
        const openBranch = awaitReviewThenShareFooAtRoot(['foo']);
        commitOnTeam('teamai.yaml', [
          'team: push-active-ns', `repo: ${origin}`, 'provider: git', 'usageReport: false',
          'toolPaths:', '  claude:', '    skills: .claude/skills', '  codex:', '    skills: .codex/skills', '',
        ].join('\n'));
        git(['pull', '-q', 'origin', 'main'], path.join(project, '.teamai', 'team-repo'));
        setConfig({ enabledAgents: ['claude', 'codex'] });
        // Codex holds a delivered copy of the shared skill.
        const sharedContent = `${skillMd('foo')}\nA teammate's shared skill.\n`;
        const codexFoo = path.join(project, '.codex', 'skills', 'foo', 'SKILL.md');
        writeFile(codexFoo, sharedContent);
        recordDeliveredCopies({ [fs.realpathSync(codexFoo)]: contentHash(sharedContent) });
        fs.appendFileSync(codexFoo, '\nCodex edit.\n');
        const later = new Date(Date.now() + 5_000);
        fs.utimesSync(newer === 'codex' ? codexFoo : path.join(localSkill('foo'), 'SKILL.md'), later, later);

        const pushed = run(['push', '--all']);

        expect(skillFilesOn(openBranch), pushed.output).toEqual(['skills/platform/foo/SKILL.md']);
        const platformFoo = git(['show', `${openBranch}:skills/platform/foo/SKILL.md`], origin);
        expect(platformFoo, pushed.output).toContain('Second edit.');
        expect(platformFoo).not.toContain('Codex edit.');
        const shared = pushBranches().filter((b) => b !== openBranch);
        expect(shared.map(skillFilesOn), pushed.output).toEqual([['skills/foo/SKILL.md']]);
        const sharedFoo = git(['show', `${shared[0]}:skills/foo/SKILL.md`], origin);
        expect(sharedFoo).toContain('Codex edit.');
        expect(sharedFoo).not.toContain('Second edit.');
      },
    })),
    {
      site: 'preview: the copy is listed at its open PR destination',
      check: () => {
        awaitReviewThenShareFooAtRoot(['foo']);

        const pushed = run(['push', '--dry-run']);

        expect(pushed.output).toContain('to:   skills/platform/foo');
        expect(pushed.output).toContain('awaiting review');
      },
    },
    {
      site: 'conflict check: --role naming another namespace opens a separate PR',
      check: () => {
        const openBranch = awaitReviewThenShareFooAtRoot(['foo']);

        const pushed = run(['push', '--all', '--role', 'svc-a']);

        expect(pushed.output).toContain('foo is awaiting review at skills/platform/foo');
        expect(git(['show', `${openBranch}:skills/platform/foo/SKILL.md`], origin)).not.toContain('Second edit.');
        expect(skillFilesOn(pushBranches().find((b) => b !== openBranch)!), pushed.output)
          .toEqual(['skills/svc-a/foo/SKILL.md']);
        untouchedSharedRoot();
      },
    },
    {
      site: 'partial selection: --skill picks one of the open PR\'s resources',
      check: () => {
        const openBranch = awaitReviewThenShareFooAtRoot(['foo', 'bar']);

        const pushed = run(['push', '--skill', localSkill('foo')]);

        expect(pushed.output).toContain('Only part of');
        expect(skillFilesOn(pushBranches().find((b) => b !== openBranch)!), pushed.output)
          .toEqual(['skills/platform/foo/SKILL.md']);
        untouchedSharedRoot();
      },
    },
    ...[
      {
        at: 'svc-a skill',
        local: () => path.join(localSkill('foo'), 'SKILL.md'),
        destination: 'skills/svc-a/foo/SKILL.md',
        open: () => {
          writeFile(path.join(localSkill('foo'), 'SKILL.md'), skillMd('foo'));
          return run(['push', '--all', '--role', 'svc-a']);
        },
      },
      {
        at: 'root rule',
        local: () => path.join(project, '.claude', 'rules', 'foo.md'),
        destination: 'rules/foo.md',
        open: () => {
          setConfig({ projects: [] });
          writeFile(path.join(project, '.claude', 'rules', 'foo.md'), '# foo rule\n');
          return run(['push', '--all']);
        },
      },
    ].map(({ at, local, destination, open }) => ({
      // An open PR's destination is its recorded path, once the active project names another namespace.
      site: `reuse: ${at}, no namespace`,
      check: () => {
        const openBranch = awaitReviewInOlderRecordThenSwitchProject(local(), open);
        const filesOn = (branch: string) => git(['diff', '--name-only', 'main', branch], origin).split('\n')
          .filter((file) => file.endsWith('.md'));
        expect(filesOn(openBranch)).toEqual([destination]);

        const pushed = run(['push', '--all']);

        expect(pushBranches(), pushed.output).toEqual([openBranch]);
        expect(filesOn(openBranch), pushed.output).toEqual([destination]);
        expect(git(['show', `${openBranch}:${destination}`], origin), pushed.output).toContain('Second edit.');
      },
    })),
  ])('$site', ({ check }) => check());
});

describe('push --skill sends a skill to the team skill it came from', () => {
  it('does not fall back to another tool when the requested delivered copy has no proven origin', () => {
    const requested = path.join(project, '.claude', 'skills', 'a-skill');
    fs.appendFileSync(path.join(requested, 'SKILL.md'), '\nEdited before the old origin was replaced.\n');
    commitOnTeam('skills/svc-a/a-skill', null);
    commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nAn unrelated recreated skill.\n`);
    expect(run(['pull']).output).toContain('Kept ');
    commitOnTeam('teamai.yaml', [
      'team: push-active-ns',
      `repo: ${origin}`,
      'provider: git',
      'usageReport: false',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '  codex:',
      '    skills: .codex/skills',
      '',
    ].join('\n'));
    writeFile(path.join(project, '.codex', 'skills', 'a-skill', 'SKILL.md'), `${skillMd('a-skill')}\nAnother tool's pushable copy.\n`);

    const pushed = run(['push', '--all', '--skill', requested]);

    expect(pushed.output).toContain(`Skipped a-skill at ${requested}: teamai delivered this copy`);
    expect(pushed.output).toContain('record matches no version of skills/svc-a/a-skill');
    expect(pushedFiles()).toEqual([]);
  });

  it('names a skill selected through a symlink after the directory it points to', () => {
    expect(run(['projects', 'set', 'platform']).code).toBe(0);
    const real = path.join(sandbox, 'elsewhere', 'my-skill');
    writeFile(path.join(real, 'SKILL.md'), skillMd('my-skill'));
    const alias = path.join(sandbox, 'alias');
    fs.symlinkSync(real, alias, 'dir');

    const pushed = run(['push', '--all', '--skill', alias]);

    expect(pushedFiles(), pushed.output).toContain('skills/platform/my-skill/SKILL.md');
    expect(pushedFiles().filter((file) => file.includes('alias'))).toEqual([]);
  });

  it('pushes a skill through a symlink whose own name is not a valid skill name', () => {
    expect(run(['projects', 'set', 'platform']).code).toBe(0);
    const real = path.join(sandbox, 'elsewhere', 'my-skill');
    writeFile(path.join(real, 'SKILL.md'), skillMd('my-skill'));
    const alias = path.join(sandbox, 'my alias');
    fs.symlinkSync(real, alias, 'dir');

    const pushed = run(['push', '--all', '--skill', alias]);

    expect(pushed.output).not.toContain('Invalid --skill argument');
    expect(pushedFiles(), pushed.output).toContain('skills/platform/my-skill/SKILL.md');
  });

  it('finds the delivery record of a copy whose skills directory is a symlink', () => {
    // The skills directory is a link, as pull wrote through it: the record keeps the path pull wrote.
    const skillsDir = path.join(project, '.claude', 'skills');
    const store = path.join(sandbox, 'skills-store');
    fs.renameSync(skillsDir, store);
    fs.symlinkSync(store, skillsDir, 'dir');
    expect(run(['pull']).code).toBe(0);
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe svc-b version.\n`);
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);

    const pushed = run(['push', '--all', '--skill', path.join(skillsDir, 'a-skill')]);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles(), pushed.output).not.toContain('skills/svc-b/a-skill/SKILL.md');
    expect(pushed.output).not.toContain('skills/svc-b/a-skill');
    expect(git(['show', 'main:skills/svc-b/a-skill/SKILL.md'], origin)).toContain('The svc-b version.');
  });

  it('leaves another namespace\'s skill of the same name untouched', () => {
    commitOnTeam('skills/archive/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe archived version.\n`);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'a-skill')]);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).not.toContain('skills/archive/a-skill/SKILL.md');
  });

  it('keeps an inactive delivered skill at its origin with --role', () => {
    commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe svc-a version.\n`);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited after svc-a became inactive.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).output).toContain('Kept skill "a-skill"');
    writeFile(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), `${skillMd('a-skill')}\nThe svc-a version.\n`);
    writeFile(path.join(project, '.claude', 'skills', 'a-skill', 'CONTRIBUTORS'), 'testuser\n');

    const pushed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'a-skill'), '--role', 'platform']);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).toContain('skills/svc-a/a-skill/CONTRIBUTORS');
    expect(pushedFiles()).not.toContain('skills/platform/a-skill/SKILL.md');
  });

  it('asks for --role instead of guessing when several namespaces hold a name it never delivered', () => {
    commitOnTeam('skills/archive/x-skill/SKILL.md', skillMd('x-skill'));
    commitOnTeam('skills/svc-b/x-skill/SKILL.md', skillMd('x-skill'));
    writeFile(path.join(project, '.claude', 'skills', 'x-skill', 'SKILL.md'), `${skillMd('x-skill')}\nMy own.\n`);

    const guessed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'x-skill')]);

    expect(guessed.code).toBe(2);
    expect(guessed.output).toContain('no record of delivering this copy from skills/archive/x-skill or skills/svc-b/x-skill');
    expect(pushedFiles()).toEqual([]);

    const named = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'x-skill'), '--role', 'platform']);

    expect(pushedFiles(), named.output).toEqual(expect.arrayContaining(['skills/platform/x-skill/SKILL.md']));
  });
});

describe('push --skill refuses a copy its record does not tie to a team skill', () => {
  const selectors = [
    { label: 'without flags', flags: (_skillPath: string) => [] as string[] },
    { label: 'with --role', flags: (_skillPath: string) => ['--role', 'platform'] },
    { label: 'with --project', flags: (_skillPath: string) => ['--project', 'platform'] },
    { label: 'with --skill', flags: (skillPath: string) => ['--skill', skillPath] },
    { label: 'with --skill and --role', flags: (skillPath: string) => ['--skill', skillPath, '--role', 'platform'] },
    { label: 'with --skill and --project', flags: (skillPath: string) => ['--skill', skillPath, '--project', 'platform'] },
  ];
  const unprovenOrigins = (['deleted', 'recreated', 'ambiguous'] as const).flatMap((state) =>
    selectors.map((selector) => ({ state, ...selector })));

  it('asks for --role for a copy it never delivered whose name only an inactive namespace holds', () => {
    writeFile(path.join(project, '.claude', 'skills', 'b-skill', 'SKILL.md'), `${skillMd('b-skill')}\nMy own.\n`);

    const pushed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'b-skill')]);

    expect(pushed.code, pushed.output).toBe(2);
    expect(pushed.output).toContain('no record of delivering this copy from skills/svc-b/b-skill');
    expect(pushedFiles()).toEqual([]);
  });

  it('does not overwrite a skill recreated after a merge deletion', () => {
    const skillPath = path.join(project, '.claude', 'skills', 'a-skill');
    fs.appendFileSync(path.join(skillPath, 'SKILL.md'), '\nMember edit after delivery.\n');
    mergeOnTeam('skills/svc-a/a-skill', null);
    expect(run(['pull']).code).toBe(0);
    mergeOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nUnrelated recreated skill.\n`);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushed.output).toContain('its record matches no version of skills/svc-a/a-skill');
    expect(pushed.output).toContain('copy it under a new name and push that');
    expect(pushedFiles()).toEqual([]);
    expect(git(['show', 'main:skills/svc-a/a-skill/SKILL.md'], origin)).toContain('Unrelated recreated skill.');
  });

  it.each(unprovenOrigins)('does not route a $state delivered origin $label', ({ state, flags }) => {
    const skillPath = path.join(project, '.claude', 'skills', 'a-skill');
    fs.appendFileSync(path.join(skillPath, 'SKILL.md'), '\nEdited after delivery.\n');
    if (state === 'deleted' || state === 'recreated') commitOnTeam('skills/svc-a/a-skill', null);
    if (state === 'recreated') {
      commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nUnrelated recreated skill.\n`);
    }
    if (state === 'ambiguous') commitOnTeam('skills/svc-b/a-skill/SKILL.md', skillMd('a-skill'));

    const pushed = run(['push', '--all', ...flags(skillPath)]);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushed.output).toContain('copy it under a new name and push that');
    expect(pushedFiles()).toEqual([]);
  });
});

describe('push places a new resource by the active projects (#1021)', () => {
  it('puts a new rule in the active project\'s knowledge namespace', () => {
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('[rules] new-rule → rules/svc-a/new-rule.md');
    expect(pushedFiles()).toEqual(['rules/svc-a/new-rule.md']);
  });

  it('puts a new skill in the namespace of a project that declares one', () => {
    expect(run(['projects', 'set', 'platform']).code).toBe(0);
    writeFile(path.join(project, '.claude', 'skills', 'new-skill', 'SKILL.md'), skillMd('new-skill'));

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('[skills] new-skill → skills/platform/new-skill');
    expect(pushedFiles()).toContain('skills/platform/new-skill/SKILL.md');
  });

  it('offers only the active projects\' namespaces when they declare several', () => {
    writeFile(path.join(project, '.claude', 'skills', 'new-skill', 'SKILL.md'), skillMd('new-skill'));

    const pushed = run(['push', '--all']);

    expect(pushed.code).toBe(2);
    expect(pushed.output).toContain('Several skills namespaces could take new skills (svc-a, payments)');
    expect(pushedFiles()).toEqual([]);
  });

  it('offers the role\'s namespaces beside the active projects\'', () => {
    commitOnTeam('manifest/roles.yaml', YAML.stringify({
      version: 1,
      roles: [{ id: 'backend', description: '', resources: { knowledge: ['be-know'], skills: ['be-skills'] } }],
    }));
    setConfig({ primaryRole: 'backend' });
    expect(run(['pull']).code).toBe(0);
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('Several knowledge namespaces could take new rules (be-know, svc-a)');
    expect(pushedFiles()).toEqual([]);
  });

  it('stops instead of sharing with everyone when an active project is not in the manifest', () => {
    setConfig({ projects: ['retired'] });
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.code).toBe(2);
    expect(pushed.output).toContain('Unknown project "retired"');
    expect(pushedFiles()).toEqual([]);
  });

  it('stops instead of sharing with everyone when the projects manifest is gone', () => {
    commitOnTeam('manifest/projects.yaml', null);
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.code).toBe(2);
    expect(pushed.output).toContain('manifest/projects.yaml');
    expect(pushedFiles()).toEqual([]);
  });

  it('keeps a new rule at the shared root with no active project', () => {
    setConfig({ projects: [] });
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('[rules] new-rule → rules/new-rule.md (shared with everyone: no namespace resolved)');
    expect(pushedFiles()).toEqual(['rules/new-rule.md']);
  });
});

describe('push stops when the active projects cannot be resolved', () => {
  const unresolved: [string, () => void, string][] = [
    ['the projects manifest is gone', () => commitOnTeam('manifest/projects.yaml', null), 'no manifest/projects.yaml'],
    ['an active project is not in the manifest', () => setConfig({ projects: ['svc-b', 'retired'] }), 'Unknown project "retired"'],
  ];
  const pushes: [string, () => string[]][] = [
    ['a new rule', () => {
      writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');
      return ['push', '--all'];
    }],
    ['a new skill named like another project\'s', () => {
      writeFile(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), `${skillMd('a-skill')}\nMy own.\n`);
      return ['push', '--all'];
    }],
    ['--skill on a skill named like another project\'s', () => {
      writeFile(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), `${skillMd('a-skill')}\nMy own.\n`);
      return ['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'a-skill')];
    }],
    ['a new agent', () => {
      writeFile(path.join(project, '.claude', 'agents', 'new-agent.md'), '---\nname: new-agent\ndescription: new agent\n---\n\nHelp.\n');
      return ['push', '--all'];
    }],
  ];

  describe.each(unresolved)('when %s', (_state, breakProjects, reason) => {
    it.each(pushes)('pushes nothing for %s', (_resource, prepare) => {
      setConfig({ projects: ['svc-b'] });
      expect(run(['pull']).code).toBe(0);
      breakProjects();

      const pushed = run(prepare());

      expect(pushed.code, pushed.output).toBe(2);
      expect(pushed.output).toContain(reason);
      expect(pushedFiles()).toEqual([]);
    });

    it('sends an edit back to the project it came from under --role, and a new skill to the role', () => {
      setConfig({ projects: ['svc-b'] });
      expect(run(['pull']).code).toBe(0);
      breakProjects();
      fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
      writeFile(path.join(project, '.claude', 'skills', 'new-skill', 'SKILL.md'), skillMd('new-skill'));

      const pushed = run(['push', '--all', '--role', 'platform']);

      expect(pushedFiles(), pushed.output).toEqual(expect.arrayContaining([
        'skills/svc-a/a-skill/SKILL.md', 'skills/platform/new-skill/SKILL.md',
      ]));
      expect(pushedFiles()).not.toContain('skills/platform/a-skill/SKILL.md');
    });
  });
});
