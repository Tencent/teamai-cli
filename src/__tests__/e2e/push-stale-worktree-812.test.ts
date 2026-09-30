/**
 * E2E (#812): push from a worktree that last pulled an older team revision
 * does not offer a teammate's newer rule back as the old version.
 *
 * Before scanning, push syncs every rule and skill the member never edited to
 * the team repo's version. "Never edited" means equal to the version at the
 * revision this checkout last synced. state.json is shared by every worktree,
 * so push used to compare with the project's shared lastPullRev, which a pull
 * in another checkout had already moved: the stale copy read as an edit and
 * push listed it as modified, ready to revert the teammate's change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateSchema } from '../../types.js';
import { projectSlug } from '../../utils/partition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], cwd: string, home: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

function findStateFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => path.basename(rel) === 'state.json')
    .map((rel) => path.join(dir, rel));
}

describe('push from a stale linked worktree (#812)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let worktree: string;
  let teammate: string;

  const R1 = '# Team rule\n\nVersion one.\n';
  const R2 = '# Team rule\n\nVersion two, from a teammate.\n';
  const ruleIn = (root: string) => path.join(root, '.claude', 'rules', 'team-rule.md');
  const projectState = () => {
    const files = [...findStateFiles(path.join(home, '.teamai')), ...findStateFiles(path.join(projectRoot, '.teamai'))];
    const withRecords = files
      .map((file) => ({ file, state: StateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) }))
      .filter(({ state }) => state.lastPullByWorkspace !== undefined);
    expect(withRecords, files.join('\n')).toHaveLength(1);
    return withRecords[0];
  };
  const workspaceRecords = () => projectState()?.state.lastPullByWorkspace ?? {};
  const workspaceKeys = (): string[] => Object.keys(workspaceRecords());

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue812-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    worktree = path.join(sandbox, 'wt-b');
    teammate = path.join(sandbox, 'teammate');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: issue-812-e2e',
      'repo: https://example.com/team.git',
      'provider: tgit',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'rules', 'team-rule.md'), R1);
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, teammate], sandbox);

    // The business repo is a real git repo, so it can have linked worktrees.
    // Its .claude/ is tracked, so every worktree starts with one.
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(
      path.join(projectRoot, '.gitignore'),
      '.teamai/\n.claude/skills/\n.claude/rules/\n.claude/agents/\n',
    );
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);

    fs.mkdirSync(path.join(projectRoot, '.teamai'), { recursive: true });
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ci-812',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (args: string[], cwd: string): Promise<string> => {
    const r = await runCLI(args, cwd, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };
  const dryRunPush = (cwd: string) => run(['--dry-run', 'push'], cwd);
  const teammatePublishes = (rule: string): void => {
    fs.writeFileSync(path.join(teammate, 'rules', 'team-rule.md'), rule);
    git(['commit', '-q', '-am', 'rule update'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
  };

  let worktreeKey: string | undefined;

  it('syncs a teammate\'s update into a stale worktree instead of offering the old copy as modified', async () => {
    // Both checkouts pull R1.
    await run(['pull'], projectRoot);
    const mainKeys = workspaceKeys();
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-b'], projectRoot);
    await run(['pull'], worktree);
    expect(fs.readFileSync(ruleIn(worktree), 'utf8')).toBe(R1);
    worktreeKey = workspaceKeys().find((key) => !mainKeys.includes(key));
    expect(worktreeKey).toBeDefined();

    // A teammate pushes R2, and only the main checkout pulls it.
    fs.writeFileSync(path.join(teammate, 'rules', 'team-rule.md'), R2);
    git(['commit', '-q', '-am', 'rule R2'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    await run(['pull'], projectRoot);
    expect(fs.readFileSync(ruleIn(projectRoot), 'utf8')).toBe(R2);

    const push = await dryRunPush(worktree);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(ruleIn(worktree), 'utf8'), push).toBe(R2);
  });

  it('still lists a genuine local edit in the worktree as modified', async () => {
    fs.writeFileSync(ruleIn(worktree), `${R2}\nA local edit.\n`);

    const push = await dryRunPush(worktree);
    expect(push).toContain('[rules] team-rule (modified)');
    fs.writeFileSync(ruleIn(worktree), R2);
  });

  it('compares the next push with the revision the last push synced, and leaves pull\'s record alone', async () => {
    // B's copy is R2 from the push above, while its pull record still says R1.
    // A teammate publishes R3, with a new rule only a pull delivers, and the
    // main checkout pulls it, so the shared lastPullRev is R3.
    const R3 = '# Team rule\n\nVersion three, from a teammate.\n';
    fs.writeFileSync(path.join(teammate, 'rules', 'team-rule.md'), R3);
    fs.writeFileSync(path.join(teammate, 'rules', 'new-rule.md'), '# New rule\n');
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', 'rule R3'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    await run(['pull'], projectRoot);

    const push = await dryRunPush(worktree);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(ruleIn(worktree), 'utf8'), push).toBe(R3);

    // Push did not advance the revision pull records, so B's next pull is a
    // full sync and delivers what the pre-push sync does not.
    const pull = await run(['pull'], worktree);
    expect(pull).not.toContain('Already synced');
    expect(fs.existsSync(path.join(worktree, '.claude', 'rules', 'new-rule.md')), pull).toBe(true);
  });

  it('still syncs a copy whose edit was undone after a push left it alone', async () => {
    // B pulled R3 above. A teammate publishes R4, B edits the rule, and a push
    // leaves the edited copy alone while moving B's push base to R4.
    const pulled = fs.readFileSync(ruleIn(worktree), 'utf8');
    teammatePublishes('# Team rule\n\nVersion four, from a teammate.\n');
    await run(['pull'], projectRoot);
    fs.writeFileSync(ruleIn(worktree), `${pulled}\nA local edit.\n`);
    expect(await dryRunPush(worktree)).toContain('[rules] team-rule (modified)');

    // The member undoes the edit, back to the copy B pulled, and a teammate
    // publishes R5 before B pulls again.
    fs.writeFileSync(ruleIn(worktree), pulled);
    const R5 = '# Team rule\n\nVersion five, from a teammate.\n';
    teammatePublishes(R5);
    await run(['pull'], projectRoot);

    const push = await dryRunPush(worktree);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(ruleIn(worktree), 'utf8'), push).toBe(R5);
  });

  it('still syncs a copy undone to the version an earlier push synced it to', async () => {
    // A push syncs B's copy to a teammate's version; B edits it; a push against
    // a later revision leaves the edit alone; the member undoes the edit back to
    // the version the first push synced; a teammate publishes again.
    const synced = '# Team rule\n\nVersion synced by a push.\n';
    teammatePublishes(synced);
    await dryRunPush(worktree);
    expect(fs.readFileSync(ruleIn(worktree), 'utf8')).toBe(synced);
    fs.writeFileSync(ruleIn(worktree), `${synced}\nA local edit.\n`);
    teammatePublishes('# Team rule\n\nVersion pushed during the edit.\n');
    expect(await dryRunPush(worktree)).toContain('[rules] team-rule (modified)');
    fs.writeFileSync(ruleIn(worktree), synced);
    const latest = '# Team rule\n\nVersion published after the undo.\n';
    teammatePublishes(latest);

    const push = await dryRunPush(worktree);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(ruleIn(worktree), 'utf8'), push).toBe(latest);
  });

  it('keeps at most 20 push bases between pulls, newest first', async () => {
    for (let i = 1; i <= 21; i++) {
      teammatePublishes(`# Team rule\n\nCap version ${i}.\n`);
      await dryRunPush(worktree);
    }
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: teammate }).toString().trim();
    const bases = worktreeKey ? workspaceRecords()[worktreeKey]?.pushBaseRevs : undefined;
    expect(bases).toHaveLength(20);
    expect(bases?.[0]).toBe(head);
  }, 120_000);

  it('drops a removed worktree\'s record on the next full sync in another checkout', async () => {
    expect(workspaceKeys()).toContain(worktreeKey);

    git(['worktree', 'remove', '--force', worktree], projectRoot);
    await run(['pull', '--force'], projectRoot);

    const keys = workspaceKeys();
    expect(keys).toHaveLength(1);
    expect(keys).not.toContain(worktreeKey);
  });

  it('still forces a full sync on every checkout after exclude clears lastPullRev', async () => {
    const other = path.join(sandbox, 'wt-c');
    git(['worktree', 'add', '-q', other, '-b', 'wt-c'], projectRoot);
    await run(['pull'], other);
    expect(await run(['pull'], other)).toContain('Already synced');

    // The main checkout's pull after exclude is a forced full sync; it resets
    // the other checkout's record, so that checkout's next pull is one too.
    await run(['skill', 'exclude', 'add', 'no-such-skill'], projectRoot);
    await run(['pull'], projectRoot);
    expect(await run(['pull'], other)).not.toContain('Already synced');
    expect(await run(['pull'], other)).toContain('Already synced');
  });

  it('keeps a stale worktree\'s push base through a forced full sync in another checkout', async () => {
    // wt-c pulled above. A teammate publishes a new version, then exclude
    // clears lastPullRev and the main checkout's pull is a forced full sync.
    const other = path.join(sandbox, 'wt-c');
    const next = '# Team rule\n\nVersion six, from a teammate.\n';
    teammatePublishes(next);
    await run(['skill', 'exclude', 'remove', 'no-such-skill'], projectRoot);
    await run(['pull'], projectRoot);

    const push = await dryRunPush(other);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(ruleIn(other), 'utf8'), push).toBe(next);
  });

  it('refuses to push a team rule from a checkout no pull has recorded, until it pulls', async () => {
    await run(['pull'], projectRoot);

    // A new rule of its own goes through: nothing in the team repo to revert.
    const withOwnRule = path.join(sandbox, 'wt-h');
    git(['worktree', 'add', '-q', withOwnRule, '-b', 'wt-h'], projectRoot);
    fs.mkdirSync(path.dirname(ruleIn(withOwnRule)), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(ruleIn(withOwnRule)), 'own-rule.md'), '# Own rule\n');
    expect(await dryRunPush(withOwnRule)).toContain('[rules] own-rule (new)');

    const unrecorded = path.join(sandbox, 'wt-f');
    git(['worktree', 'add', '-q', unrecorded, '-b', 'wt-f'], projectRoot);
    fs.mkdirSync(path.dirname(ruleIn(unrecorded)), { recursive: true });

    // An older copy of the team rule and no per-checkout entry, as a CLI that
    // kept no such entries would leave it, while the main checkout has already
    // pulled a teammate's newer version.
    fs.copyFileSync(ruleIn(projectRoot), ruleIn(unrecorded));
    const older = fs.readFileSync(ruleIn(unrecorded), 'utf8');
    const latest = '# Team rule\n\nVersion pulled only by the main checkout.\n';
    teammatePublishes(latest);
    await run(['pull'], projectRoot);

    const refused = await runCLI(['push', '--all'], unrecorded, home);
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain('This checkout has no pull record yet');
    expect(refused.output).toContain('[rules] team-rule');
    expect(refused.output).toContain('copy them somewhere safe');
    expect(refused.output).not.toContain('Pushed branch');
    expect(fs.readFileSync(ruleIn(unrecorded), 'utf8')).toBe(older);
    const pushed = execFileSync('git', ['ls-remote', '--heads', path.join(sandbox, 'team-remote.git'), 'teamai/*'])
      .toString().trim();
    expect(pushed).toBe('');

    // After a pull, its first push works and has nothing to offer.
    await run(['pull'], unrecorded);
    const push = await dryRunPush(unrecorded);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(ruleIn(unrecorded), 'utf8'), push).toBe(latest);
  });

  it('still refuses it after exclude clears the shared lastPullRev', async () => {
    // An unrecorded worktree with an older copy of the team rule; the main
    // checkout pulls a teammate's newer version, then exclude clears the shared
    // lastPullRev, so the sync has no revision to compare with at all.
    await run(['pull'], projectRoot);
    const unrecorded = path.join(sandbox, 'wt-i');
    git(['worktree', 'add', '-q', unrecorded, '-b', 'wt-i'], projectRoot);
    fs.mkdirSync(path.dirname(ruleIn(unrecorded)), { recursive: true });
    fs.copyFileSync(ruleIn(projectRoot), ruleIn(unrecorded));
    teammatePublishes('# Team rule\n\nVersion pulled before exclude cleared lastPullRev.\n');
    await run(['pull'], projectRoot);
    await run(['skill', 'exclude', 'add', 'another-missing-skill'], projectRoot);

    const refused = await runCLI(['push', '--all'], unrecorded, home);
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain('This checkout has no pull record yet');
    const pushed = execFileSync('git', ['ls-remote', '--heads', path.join(sandbox, 'team-remote.git'), 'teamai/*'])
      .toString().trim();
    expect(pushed).toBe('');

    await run(['skill', 'exclude', 'remove', 'another-missing-skill'], projectRoot);
    await run(['pull'], projectRoot);
  });

  it.skipIf(process.getuid?.() === 0)('records the push base when the sync stops partway', async () => {
    // A teammate adds a skill, and a new worktree pulls it with the rule.
    const skillDir = path.join(teammate, 'skills', 'team-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: team-skill\ndescription: Team skill\n---\n\nv1\n');
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', 'skill'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    const partial = path.join(sandbox, 'wt-g');
    git(['worktree', 'add', '-q', partial, '-b', 'wt-g'], projectRoot);
    await run(['pull'], partial);

    // A teammate updates both. The rule sync writes the new rule, then the
    // skill sync fails to overwrite a local copy it cannot write.
    const synced = '# Team rule\n\nVersion written before the sync failed.\n';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: team-skill\ndescription: Team skill\n---\n\nv2\n');
    teammatePublishes(synced);
    const localSkill = path.join(partial, '.claude', 'skills', 'team-skill');
    fs.chmodSync(path.join(localSkill, 'SKILL.md'), 0o444);
    fs.chmodSync(localSkill, 0o555);
    try {
      const failed = await runCLI(['--dry-run', 'push'], partial, home);
      expect(failed.output).toContain('Could not bring the team\'s latest rules and skills');
    } finally {
      fs.chmodSync(localSkill, 0o755);
      fs.chmodSync(path.join(localSkill, 'SKILL.md'), 0o644);
    }
    expect(fs.readFileSync(ruleIn(partial), 'utf8')).toBe(synced);

    const latest = '# Team rule\n\nVersion after the partial sync.\n';
    teammatePublishes(latest);
    const push = await dryRunPush(partial);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(ruleIn(partial), 'utf8'), push).toBe(latest);
  });

  it.skipIf(process.getuid?.() === 0)('stops the push when the synced revision cannot be recorded', async () => {
    const partial = path.join(sandbox, 'wt-g');
    teammatePublishes('# Team rule\n\nVersion synced while the state file refuses writes.\n');
    const stateFile = projectState()?.file;
    expect(stateFile).toBeDefined();
    if (!stateFile) return;
    // state.json is saved through writeJsonAtomic, so a chmod on the file
    // cannot force the failure: the writer stages a temp sibling and renames,
    // and rename needs only the writable directory (a read-only target is
    // replaced just fine). Inject the failure at the write call instead, like
    // the atomic-save unit tests do: a preload hook fails every fs.writeFile
    // targeting the staged temp of this state file inside the CLI process.
    const hook = path.join(sandbox, 'fail-state-write.cjs');
    fs.writeFileSync(hook, [
      "'use strict';",
      `const TARGET = ${JSON.stringify(stateFile)};`,
      "const fs = require('node:fs');",
      "const hit = (p) => typeof p === 'string' && p.startsWith(TARGET + '.') && p.endsWith('.tmp');",
      'const fail = (p) => { throw new Error(`simulated state write failure: ${p}`); };',
      'const writeFile = fs.writeFile.bind(fs);',
      'fs.writeFile = (p, ...rest) => (hit(p) ? fail(p) : writeFile(p, ...rest));',
      'const writeFileSync = fs.writeFileSync.bind(fs);',
      'fs.writeFileSync = (p, ...rest) => (hit(p) ? fail(p) : writeFileSync(p, ...rest));',
      'const pWriteFile = fs.promises.writeFile.bind(fs.promises);',
      'fs.promises.writeFile = (p, ...rest) => (hit(p) ? fail(p) : pWriteFile(p, ...rest));',
    ].join('\n'));
    try {
      const r = await runCLI(['--dry-run', 'push'], partial, home, { NODE_OPTIONS: `--require ${hook}` });
      expect(r.code, r.output).toBe(1);
      expect(r.output).toContain('Nothing was pushed');
      expect(r.output).not.toContain('Scanning local resources');
    } finally {
      fs.rmSync(hook, { force: true });
    }
  });
});

describe('forced full sync in single-repo mode, worktrees at an older commit (#812)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let worktreeB: string;
  let worktreeD: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    // In single-repo mode each checkout's revision is its own HEAD, so two
    // worktrees can both be at an older commit than the main checkout.
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue812-self-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    worktreeB = path.join(sandbox, 'wt-b');
    worktreeD = path.join(sandbox, 'wt-d');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.teamai', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.claude/skills/\n.claude/rules/\n.claude/agents/\n');
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'teamai.yaml'), [
      'team: issue-812-self-e2e',
      'repo: https://github.com/acme/project.git',
      'provider: github',
      'mode: self',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'rules', 'team-rule.md'), '# Team rule\n\nOld commit.\n');
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'old'], projectRoot);
    git(['worktree', 'add', '-q', worktreeB, '-b', 'wt-b'], projectRoot);
    git(['worktree', 'add', '-q', worktreeD, '-b', 'wt-d'], projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'rules', 'team-rule.md'), '# Team rule\n\nNew commit.\n');
    git(['commit', '-q', '-am', 'new'], projectRoot);

    const partition = path.join(home, '.teamai', 'projects', projectSlug(projectRoot));
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'anchor'), `${projectRoot}\n`);
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      '  kind: self',
      `  localPath: ${path.join(projectRoot, '.teamai')}`,
      "  remote: ''",
      `  businessRepoRoot: ${projectRoot}`,
      'username: ci-812-self',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (args: string[], cwd: string): Promise<string> => {
    const r = await runCLI(args, cwd, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  it('reaches a worktree whose commit another worktree\'s pull made the shared revision again', async () => {
    await run(['pull'], projectRoot);
    await run(['pull'], worktreeB);
    await run(['pull'], worktreeD);
    expect(await run(['pull'], worktreeB)).toContain('Already synced');

    // Exclude clears lastPullRev, so the main checkout's pull is a forced full
    // sync. D's pull then sets the shared revision back to the older commit B
    // is also at; B must still do its own full sync.
    await run(['skill', 'exclude', 'add', 'no-such-skill'], projectRoot);
    await run(['pull'], projectRoot);
    await run(['pull'], worktreeD);
    expect(await run(['pull'], worktreeB)).not.toContain('Already synced');
    expect(await run(['pull'], worktreeB)).toContain('Already synced');
  });
});
