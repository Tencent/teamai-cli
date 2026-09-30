/**
 * E2E (#823, items 2 and 3): push must not offer a teammate's update back as
 * the member's older copy.
 *
 * Item 2: in single-repo mode push runs against a knowledge worktree whose
 * team root is `<wt>/.teamai`, a subdirectory of the git repo. The pre-push
 * sync read each base version with a path relative to that subdirectory, which
 * `git show <rev>:<path>` resolves from the repo root, so it never found one:
 * every rule a teammate updated read as a local edit.
 *
 * Item 3: an agent this machine placed with --role/--project was compared with
 * the project's shared lastPullRev, which a pull in another checkout moves past
 * a copy a stale worktree still holds unedited (the #812 revert, for agents).
 *
 * Item 4: a user-scope install kept no push base, so after a push synced HOME's
 * copy to a teammate's update, the next push compared it with the revision the
 * last pull delivered and offered it back over the teammate's next update.
 *
 * Item 19: a project pull that inherits the user scope moves HOME's copies
 * without moving the user scope's push bases, with the same result. So did a
 * pull whose docs mirror failed, and an upgraded install whose last inherited
 * pull an older CLI ran.
 *
 * Item 10: in single-repo mode the active tree's .teamai/rules and
 * .teamai/skills are push sources themselves. On a branch behind the default
 * branch they hold an older team version nobody edited, and push listed it as
 * modified, ready to revert the teammate's update.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function requireCli(): void {
  if (!fs.existsSync(CLI)) {
    throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  }
}

describe('pre-push sync in single-repo mode (#823 items 2 and 10)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let teammate: string;

  const R1 = '# Team rule\n\nVersion one.\n';
  const R2 = '# Team rule\n\nVersion two, from a teammate.\n';
  const S1 = '---\nname: team-skill\ndescription: Team skill\n---\n\nVersion one.\n';
  const localRule = () => path.join(projectRoot, '.claude', 'rules', 'team-rule.md');
  const activeRule = () => path.join(projectRoot, '.teamai', 'rules', 'team-rule.md');
  const activeSkill = () => path.join(projectRoot, '.teamai', 'skills', 'team-skill');

  beforeEach(() => {
    requireCli();
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue823-self-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    teammate = path.join(sandbox, 'teammate');
    const remote = path.join(sandbox, 'project-remote.git');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.teamai', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.claude/skills/\n.claude/rules/\n.claude/agents/\n');
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'teamai.yaml'), [
      'team: issue-823-self-e2e',
      'repo: https://github.com/acme/project.git',
      'provider: github',
      'mode: self',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'rules', 'team-rule.md'), R1);
    fs.mkdirSync(path.join(projectRoot, '.teamai', 'skills', 'team-skill'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'skills', 'team-skill', 'SKILL.md'), S1);
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);
    git(['clone', '-q', '--bare', projectRoot, remote], sandbox);
    git(['remote', 'add', 'origin', remote], projectRoot);
    git(['fetch', '-q', 'origin'], projectRoot);
    git(['clone', '-q', remote, teammate], sandbox);

    const partition = path.join(home, '.teamai', 'projects', projectSlug(projectRoot));
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'anchor'), `${projectRoot}\n`);
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      '  kind: self',
      `  localPath: ${path.join(projectRoot, '.teamai')}`,
      "  remote: ''",
      `  businessRepoRoot: ${projectRoot}`,
      'username: ci-823-self',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (args: string[]): Promise<string> => {
    const r = await runCLI(args, projectRoot, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  it('syncs a teammate\'s update to .teamai/rules instead of listing the old copy as modified', async () => {
    await run(['pull']);
    expect(fs.readFileSync(localRule(), 'utf8')).toBe(R1);

    // A teammate lands R2 on the default branch. The member's branch takes it
    // with git, but `teamai pull` has not run, so .claude/rules still has R1.
    fs.writeFileSync(path.join(teammate, '.teamai', 'rules', 'team-rule.md'), R2);
    git(['commit', '-q', '-am', 'rule R2'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    git(['fetch', '-q', 'origin'], projectRoot);
    git(['merge', '-q', '--ff-only', 'origin/main'], projectRoot);

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(localRule(), 'utf8'), push).toBe(R2);
  });

  it('still lists a genuine local edit as modified', async () => {
    await run(['pull']);
    fs.writeFileSync(localRule(), `${R1}\nA local edit.\n`);

    const push = await run(['--dry-run', 'push']);
    expect(push).toContain('[rules] team-rule (modified)');
  });

  /** A teammate lands `content` at `file` on the default branch; the member fetches it but stays on their branch. */
  const teammateLandsOnMain = (file: string, content: string): void => {
    fs.writeFileSync(path.join(teammate, file), content);
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', `teammate: ${file}`], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    git(['fetch', '-q', 'origin'], projectRoot);
  };
  const HELD = 'which has changed on the team since';

  it('holds a stale .teamai/rules copy on a branch behind a teammate\'s update (#823 item 10)', async () => {
    await run(['pull']);
    teammateLandsOnMain('.teamai/rules/team-rule.md', R2);

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-rule (modified)');
    expect(push).toContain(`[rules] Skipped team-rule: .teamai/rules/team-rule.md is an older version of rules/team-rule.md, ${HELD}`);
    expect(fs.readFileSync(activeRule(), 'utf8')).toBe(R1);
  });

  it('still lists a genuine edit of a stale .teamai/rules copy as modified (#823 item 10)', async () => {
    await run(['pull']);
    teammateLandsOnMain('.teamai/rules/team-rule.md', R2);
    fs.writeFileSync(activeRule(), `${R1}\nA local edit.\n`);

    const push = await run(['--dry-run', 'push']);
    expect(push).toContain('[rules] team-rule (modified)');
    expect(push).not.toContain(HELD);
  });

  it('holds a stale .teamai/skills copy on a branch behind a teammate\'s update (#823 item 10)', async () => {
    await run(['pull']);
    teammateLandsOnMain('.teamai/skills/team-skill/SKILL.md', S1.replace('Version one.', 'Version two, from a teammate.'));
    // A file only the member has does not make the copy an edit.
    fs.writeFileSync(path.join(activeSkill(), 'notes.md'), 'Member notes.\n');

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-skill (modified)');
    expect(push).toContain(`[skills] Skipped team-skill: .teamai/skills/team-skill is an older version of skills/team-skill, ${HELD}`);
    expect(fs.readFileSync(path.join(activeSkill(), 'SKILL.md'), 'utf8')).toBe(S1);
  });

  it('holds a stale .teamai/skills copy that lacks a file a teammate added (#823 item 10)', async () => {
    await run(['pull']);
    teammateLandsOnMain('.teamai/skills/team-skill/reference.md', 'Added by a teammate.\n');

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-skill (modified)');
    expect(push).toContain(`[skills] Skipped team-skill: .teamai/skills/team-skill is an older version of skills/team-skill, ${HELD}`);
  });

  it('still lists a stale .teamai/skills copy whose branch file the member deleted as modified (#823 item 10)', async () => {
    await run(['pull']);
    // The member's branch has the teammate's file, then falls behind again.
    teammateLandsOnMain('.teamai/skills/team-skill/reference.md', 'On the branch.\n');
    git(['merge', '-q', '--no-edit', 'origin/main'], projectRoot);
    teammateLandsOnMain('.teamai/skills/team-skill/SKILL.md', S1.replace('Version one.', 'Version two, from a teammate.'));
    fs.rmSync(path.join(activeSkill(), 'reference.md'));

    const push = await run(['--dry-run', 'push']);
    expect(push).toContain('[skills] team-skill (modified)');
    expect(push).not.toContain(HELD);
  });

  it('still lists a genuine edit of a stale .teamai/skills copy as modified (#823 item 10)', async () => {
    await run(['pull']);
    teammateLandsOnMain('.teamai/skills/team-skill/SKILL.md', S1.replace('Version one.', 'Version two, from a teammate.'));
    fs.writeFileSync(path.join(activeSkill(), 'SKILL.md'), `${S1}\nA local edit.\n`);

    const push = await run(['--dry-run', 'push']);
    expect(push).toContain('[skills] team-skill (modified)');
    expect(push).not.toContain(HELD);
  });
});

describe('push base in user scope (#823 item 4)', () => {
  let sandbox: string;
  let home: string;
  let work: string;
  let teammate: string;

  const R1 = '# Team rule\n\nVersion one.\n';
  const localRule = () => path.join(home, '.claude', 'rules', 'team-rule.md');
  const userState = () => StateSchema.parse(JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'state.json'), 'utf8')));

  beforeEach(() => {
    requireCli();
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue823-user-e2e-')));
    home = path.join(sandbox, 'home');
    work = path.join(sandbox, 'work');
    teammate = path.join(sandbox, 'teammate');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');
    const teamRepo = path.join(home, '.teamai', 'team-repo');

    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: issue-823-user-e2e',
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
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ci-823-user',
      'updatePolicy: auto',
      'scope: user',
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (args: string[]): Promise<string> => {
    const r = await runCLI(args, work, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };
  const teammatePublishes = (rule: string): void => {
    fs.writeFileSync(path.join(teammate, 'rules', 'team-rule.md'), rule);
    git(['commit', '-q', '-am', 'rule update'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
  };

  it('compares the next push with the revision the last push synced HOME\'s copy to', async () => {
    await run(['pull']);
    expect(fs.readFileSync(localRule(), 'utf8')).toBe(R1);
    expect(await run(['pull'])).toContain('Already synced');

    // A push syncs the unedited copy to a teammate's R2; a teammate then
    // publishes R3 before any pull.
    teammatePublishes('# Team rule\n\nVersion two, from a teammate.\n');
    await run(['--dry-run', 'push']);
    expect(fs.readFileSync(localRule(), 'utf8')).toContain('Version two');
    const R3 = '# Team rule\n\nVersion three, from a teammate.\n';
    teammatePublishes(R3);

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(localRule(), 'utf8'), push).toBe(R3);
    // HOME is the user scope's one checkout: one record, holding both bases.
    const records = Object.values(userState().lastPullByWorkspace ?? {});
    expect(records).toHaveLength(1);
    expect(records[0]?.pushBaseRevs).toHaveLength(2);
  });

  const dropUserRecord = (): void => {
    const { lastPullByWorkspace: _dropped, ...rest } = userState();
    fs.writeFileSync(path.join(home, '.teamai', 'state.json'), `${JSON.stringify(rest, null, 2)}\n`);
  };

  it.each([
    ['a user-scope pull recorded HOME', 'never'],
    ['no pull has recorded HOME (upgraded install)', 'before'],
    ['a CLI that kept no record ran that pull (upgraded install)', 'after'],
  ] as const)('compares the next push with the revision an inheriting project\'s pull moved HOME\'s copy to, when %s (#823 item 19)', async (_case, dropRecord) => {
    await run(['pull']);
    if (dropRecord === 'before') dropUserRecord();
    const project = path.join(sandbox, 'project');
    const projectTeamRepo = path.join(project, '.teamai', 'team-repo');
    git(['clone', '-q', path.join(sandbox, 'team-remote.git'), projectTeamRepo], sandbox);
    fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${projectTeamRepo}`,
      `  remote: ${path.join(sandbox, 'team-remote.git')}`,
      'username: ci-823-project',
      'scope: project',
      `projectRoot: ${project}`,
      'inheritUserScope: true',
      'enabledAgents: [claude]',
      '',
    ].join('\n'));

    // The project's pull inherits the user scope and moves HOME's copy to R2;
    // a teammate then publishes R3 before any user-scope pull.
    teammatePublishes('# Team rule\n\nVersion two, from a teammate.\n');
    const inherited = await runCLI(['pull'], project, home);
    expect(inherited.code, inherited.output).toBe(0);
    expect(fs.readFileSync(localRule(), 'utf8'), inherited.output).toContain('Version two');
    // lastPullRev still names R1 and lastInheritedPullRev R2, the revision
    // HOME's copy is at.
    if (dropRecord === 'after') dropUserRecord();
    const R3 = '# Team rule\n\nVersion three, from a teammate.\n';
    teammatePublishes(R3);

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(localRule(), 'utf8'), push).toBe(R3);
  });

  it('compares the next push with the revision a pull moved HOME\'s copy to when its docs mirror failed', async () => {
    fs.mkdirSync(path.join(teammate, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(teammate, 'docs', 'guide.md'), '# Guide\n');
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', 'docs'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    await run(['pull']);
    expect(fs.readFileSync(localRule(), 'utf8')).toBe(R1);

    // The next pull updates the rule to a teammate's R2, then fails to mirror
    // the docs (a file stands where the docs directory goes); a teammate then
    // publishes R3 before any other pull.
    fs.rmSync(path.join(home, '.teamai', 'docs'), { recursive: true, force: true });
    fs.writeFileSync(path.join(home, '.teamai', 'docs'), 'not a directory\n');
    teammatePublishes('# Team rule\n\nVersion two, from a teammate.\n');
    const pull = await runCLI(['pull'], work, home);
    expect(pull.output).toContain('Failed to sync docs');
    expect(fs.readFileSync(localRule(), 'utf8'), pull.output).toContain('Version two');
    const R3 = '# Team rule\n\nVersion three, from a teammate.\n';
    teammatePublishes(R3);

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(localRule(), 'utf8'), push).toBe(R3);
    // The failed mirror still leaves the revision marker cleared for a retry.
    expect(userState().lastPullRev).toBeNull();
  });

  it('keeps comparing with the last pull\'s revision in an install no pull has recorded', async () => {
    await run(['pull']);
    // An install upgraded from a CLI that kept no user-scope record.
    const statePath = path.join(home, '.teamai', 'state.json');
    const { lastPullByWorkspace: _dropped, ...unrecorded } = userState();
    fs.writeFileSync(statePath, `${JSON.stringify(unrecorded, null, 2)}\n`);
    expect(await run(['pull'])).toContain('Already synced');

    const R2 = '# Team rule\n\nVersion two, from a teammate.\n';
    teammatePublishes(R2);
    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-rule (modified)');
    expect(push).not.toContain('no pull record yet');
    expect(fs.readFileSync(localRule(), 'utf8'), push).toBe(R2);

    // HOME is the user scope's only checkout, so lastPullRev is its own: an
    // edit is pushed, not refused as it is in an unrecorded project checkout.
    fs.writeFileSync(localRule(), `${R2}\nA local edit.\n`);
    const edited = await run(['--dry-run', 'push']);
    expect(edited).toContain('[rules] team-rule (modified)');
  });

  it('records the revision a push synced HOME\'s copy to in an install no pull has recorded', async () => {
    await run(['pull']);
    const { lastPullByWorkspace: _dropped, ...unrecorded } = userState();
    fs.writeFileSync(path.join(home, '.teamai', 'state.json'), `${JSON.stringify(unrecorded, null, 2)}\n`);

    // The first push syncs the unedited copy from R1 to a teammate's R2; a
    // teammate then publishes R3 before any pull.
    teammatePublishes('# Team rule\n\nVersion two, from a teammate.\n');
    await run(['--dry-run', 'push']);
    expect(fs.readFileSync(localRule(), 'utf8')).toContain('Version two');
    const R3 = '# Team rule\n\nVersion three, from a teammate.\n';
    teammatePublishes(R3);

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(localRule(), 'utf8'), push).toBe(R3);
    // The record starts from the last pull's revision and keeps both pushes'.
    const records = Object.values(userState().lastPullByWorkspace ?? {});
    expect(records).toHaveLength(1);
    expect(records[0]?.rev).toBe(unrecorded.lastPullRev);
    expect(records[0]?.pushBaseRevs).toHaveLength(2);
  });
});

describe('placed agent in a stale linked worktree (#823 item 3)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let worktree: string;
  let remote: string;
  let teamRepo: string;

  const A1 = '---\nname: vr\ndescription: reviews code\n---\n\nYou review.\n';
  const agentIn = (root: string) => path.join(root, '.claude', 'agents', 'vr.md');

  /** Commit on the remote's default branch through a throwaway clone, as a teammate or a merged PR does. */
  const onMain = (change: (clone: string) => void): void => {
    const clone = fs.mkdtempSync(path.join(sandbox, 'mate-'));
    git(['clone', '-q', remote, clone], sandbox);
    change(clone);
    git(['push', '-q', 'origin', 'main'], clone);
    fs.rmSync(clone, { recursive: true, force: true });
  };

  beforeEach(() => {
    requireCli();
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue823-agent-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    worktree = path.join(sandbox, 'wt-b');
    remote = path.join(sandbox, 'team-remote.git');
    teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
    const seed = path.join(sandbox, 'seed');

    fs.mkdirSync(home, { recursive: true });
    for (const dir of ['skills', 'rules', 'agents']) {
      fs.mkdirSync(path.join(seed, dir), { recursive: true });
      fs.writeFileSync(path.join(seed, dir, '.gitkeep'), '');
    }
    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: front-app',
      '    name: Front App',
      '    description: Front end',
      '    resources:',
      '      knowledge: [fe-know]',
      '      skills: [fe-skills]',
      '      learnings: []',
      '      agents: [fe-agents]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: issue-823-agent-e2e',
      'repo: https://example.com/team.git',
      'provider: tgit',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

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
      'username: ci-823',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
    fs.mkdirSync(path.dirname(agentIn(projectRoot)), { recursive: true });
    fs.writeFileSync(agentIn(projectRoot), A1);
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (args: string[], cwd: string): Promise<string> => {
    const r = await runCLI(args, cwd, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  /**
   * The author publishes the agent into front-app's namespace, never activated
   * here, and the PR merges. A local bare remote has no PR API, so the push
   * exits 1 after pushing the branch.
   */
  const placeAndMerge = async (): Promise<void> => {
    const published = await runCLI(['push', '--project', 'front-app', '--all'], projectRoot, home);
    expect(published.output).toContain('[agents] vr → agents/fe-agents/vr.yaml');
    const branch = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/'], remote)
      .split('\n').filter(Boolean).at(-1) ?? '';
    expect(branch).not.toBe('');
    onMain((clone) => {
      git(['merge', '--no-edit', '-q', `origin/${branch}`], clone);
      git(['push', '-q', 'origin', '--delete', branch], clone);
    });
  };
  const teammateRewrites = (): void => onMain((clone) => {
    const file = path.join(clone, 'agents', 'fe-agents', 'vr.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('You review.', 'A teammate rewrote this.'));
    git(['commit', '-q', '-am', 'teammate: rewrite vr'], clone);
  });
  const HELD = 'changed on the team since this checkout last synced it';

  it('holds a placed agent a teammate changed that only another checkout has pulled', async () => {
    await placeAndMerge();

    // Both checkouts pull it; the worktree gets the agent from the record.
    await run(['pull'], projectRoot);
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-b'], projectRoot);
    await run(['pull'], worktree);
    const pulled = fs.readFileSync(agentIn(worktree), 'utf8');
    expect(pulled).toContain('You review.');

    // A teammate rewrites it, and only the main checkout pulls the rewrite.
    teammateRewrites();
    await run(['pull'], projectRoot);

    const push = await run(['--dry-run', 'push'], worktree);
    expect(push).toContain(HELD);
    expect(fs.readFileSync(agentIn(worktree), 'utf8')).toBe(pulled);
  }, 60_000);

  it('holds a placed agent a teammate changed after it landed, before this checkout pulled', async () => {
    // The checkout's last pull predates the placement, so no pull revision has
    // the file. Push records the team HEAD as a base before the scan, and the
    // file there is the teammate's version, so only the version it was added
    // with shows the author's copy is stale.
    await run(['pull'], projectRoot);
    await placeAndMerge();
    teammateRewrites();

    const push = await run(['--dry-run', 'push'], projectRoot);
    expect(push).toContain(HELD);
    expect(fs.readFileSync(agentIn(projectRoot), 'utf8')).toBe(A1);
  }, 60_000);
});

describe('skills a pull held on a namespace collision (#823)', () => {
  let sandbox: string;
  let home: string;
  let teammate: string;

  const skillMd = (body: string): string => `---\nname: team-skill\ndescription: Team skill\n---\n\n${body}\n`;
  const S1 = skillMd('Version one.');

  beforeEach(() => {
    requireCli();
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue823-held-e2e-')));
    home = path.join(sandbox, 'home');
    teammate = path.join(sandbox, 'teammate');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');

    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'skills', 'alpha', 'team-skill'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: issue-823-held-e2e',
      'repo: https://example.com/team.git',
      'provider: tgit',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: dev',
      '    resources:',
      '      knowledge: []',
      '      skills: [alpha, beta]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'skills', 'alpha', 'team-skill', 'SKILL.md'), S1);
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, teammate], sandbox);
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** Clone the team repo for `scope` and return where the scope runs and delivers. */
  const install = (scope: 'user' | 'project'): { cwd: string; skill: string } => {
    const remote = path.join(sandbox, 'team-remote.git');
    const cwd = scope === 'user' ? path.join(sandbox, 'work') : path.join(sandbox, 'project');
    const dataHome = scope === 'user' ? path.join(home, '.teamai') : path.join(cwd, '.teamai');
    const teamRepo = path.join(dataHome, 'team-repo');
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ci-823-held',
      'updatePolicy: auto',
      `scope: ${scope}`,
      ...(scope === 'project' ? [`projectRoot: ${cwd}`] : []),
      'primaryRole: dev',
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
    const skillsHome = scope === 'user' ? home : cwd;
    return { cwd, skill: path.join(skillsHome, '.claude', 'skills', 'team-skill', 'SKILL.md') };
  };
  const teammateCommits = (message: string, change: () => void): void => {
    change();
    git(['add', '-A'], teammate);
    git(['commit', '-q', '-m', message], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
  };

  it.each(['user', 'project'] as const)('keeps the base of a %s-scope skill a pull held, so push does not list it as modified', async (scope) => {
    const { cwd, skill } = install(scope);
    const run = async (args: string[]): Promise<string> => {
      const r = await runCLI(args, cwd, home);
      expect(r.code, r.output).toBe(0);
      return r.output;
    };
    const first = await run(['pull']);
    expect(fs.existsSync(skill), first).toBe(true);
    expect(fs.readFileSync(skill, 'utf8')).toBe(S1);

    // A teammate updates the skill and adds a second one of the same name to
    // another active namespace: the next pull holds skills, so the copy stays
    // at S1 while the pull records the new revision.
    teammateCommits('update and collide', () => {
      fs.writeFileSync(path.join(teammate, 'skills', 'alpha', 'team-skill', 'SKILL.md'), skillMd('Version two.'));
      fs.mkdirSync(path.join(teammate, 'skills', 'beta', 'team-skill'), { recursive: true });
      fs.writeFileSync(path.join(teammate, 'skills', 'beta', 'team-skill', 'SKILL.md'), skillMd('Another one.'));
    });
    const held = await run(['pull']);
    expect(held).toContain('Skills were not updated this run');
    expect(fs.readFileSync(skill, 'utf8')).toBe(S1);

    // The teammate resolves the collision and updates the skill again.
    const S3 = skillMd('Version three.');
    teammateCommits('resolve collision', () => {
      fs.rmSync(path.join(teammate, 'skills', 'beta'), { recursive: true, force: true });
      fs.writeFileSync(path.join(teammate, 'skills', 'alpha', 'team-skill', 'SKILL.md'), S3);
    });

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-skill (modified)');
    expect(fs.readFileSync(skill, 'utf8'), push).toBe(S3);
  }, 60_000);
});
