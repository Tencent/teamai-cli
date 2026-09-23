/**
 * Issue #649 end to end, against the built CLI and real git remotes.
 *
 * `teamai push --role/--project` used to place new SKILLS only. A new rule was
 * written to `rules/<name>.md` and a new agent to `agents/<name>.yaml`, neither
 * of which carries a namespace segment, so `pull` delivered both to every member
 * of the team. These tests drive `dist/index.js` and assert on the content of
 * the branch that reached the remote, not on CLI output alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const PUSH_AGENTS = ['claude', 'codex', 'codebuddy', 'opencode'] as const;
type PushAgent = (typeof PUSH_AGENTS)[number];

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

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function runCLI(
  args: string[],
  cwd: string,
  home: string,
  envOverrides: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0', ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

/**
 * A new agent authored in the tool's OWN format, because push reverse-parses
 * the local file before it can place the canonical `.yaml`. Codex reads TOML;
 * the others read `.md` with YAML frontmatter.
 */
function localAgentFile(agent: PushAgent): { name: string; content: string } {
  if (agent === 'codex') {
    return {
      name: 'vr.toml',
      content: 'name = "vr"\ndescription = "reviews code"\ndeveloper_instructions = "You review."\n',
    };
  }
  return {
    name: 'vr.md',
    content: '---\nname: vr\ndescription: reviews code\n---\n\nYou review.\n',
  };
}

const PROJECTS_MANIFEST = [
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
].join('\n');

const ROLES_MANIFEST = [
  'version: 1',
  'roles:',
  '  - id: backend',
  '    description: Backend',
  '    resources:',
  '      knowledge: [be-know]',
  '      skills: [be-skills]',
  '      agents: [be-agents]',
].join('\n');

interface Fixture {
  sandbox: string;
  home: string;
  projectRoot: string;
  remote: string;
  teamRepo: string;
  agent: PushAgent;
  username: string;
}

/** Seeded team repo + one member directory, with nothing pushed yet. */
function makeFixture(options: {
  agent: PushAgent;
  provider: 'git' | 'github' | 'gitlab';
  repoUrl?: string;
  username?: string;
  rolesManifest?: string;
}): Fixture {
  const { agent, provider } = options;
  const username = options.username ?? `author-${provider}`;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `teamai-ns-649-${provider}-${agent}-`));
  const home = path.join(sandbox, 'home');
  const projectRoot = path.join(sandbox, 'project');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'team.git');
  const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

  fs.mkdirSync(home, { recursive: true });
  for (const dir of ['skills', 'rules', 'agents']) {
    fs.mkdirSync(path.join(projectRoot, `.${agent}`, dir), { recursive: true });
    fs.mkdirSync(path.join(seed, dir), { recursive: true });
    fs.writeFileSync(path.join(seed, dir, '.gitkeep'), '');
  }
  fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), PROJECTS_MANIFEST);
  fs.writeFileSync(path.join(seed, 'manifest', 'roles.yaml'), options.rolesManifest ?? ROLES_MANIFEST);
  fs.writeFileSync(
    path.join(seed, 'teamai.yaml'),
    [
      'team: issue-649',
      `repo: ${options.repoUrl ?? 'https://git.example.test/team/issue-649.git'}`,
      `provider: ${provider}`,
      'reviewers: []',
      'toolPaths:',
      `  ${agent}:`,
      `    skills: .${agent}/skills`,
      `    rules: .${agent}/rules`,
      `    agents: .${agent}/agents`,
    ].join('\n'),
  );

  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], sandbox);
  git(['clone', '-q', remote, teamRepo], projectRoot);

  fs.writeFileSync(
    path.join(projectRoot, '.teamai', 'config.yaml'),
    [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      `username: ${username}`,
      'updatePolicy: auto',
      'primaryRole: backend',
      'additionalRoles: []',
      'scope: project',
      `projectRoot: ${projectRoot}`,
    ].join('\n'),
  );

  return { sandbox, home, projectRoot, remote, teamRepo, agent, username };
}

/** Author a new rule, skill and agent at each tool directory's root. */
function writeLocalResources(fixture: Fixture, ruleBody = '# Rule v1\n'): void {
  const { projectRoot, agent } = fixture;
  fs.writeFileSync(path.join(projectRoot, `.${agent}/rules`, 'my-rule.md'), ruleBody);
  fs.mkdirSync(path.join(projectRoot, `.${agent}/skills`, 'my-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, `.${agent}/skills/my-skill`, 'SKILL.md'),
    '---\nname: my-skill\ndescription: a skill\n---\n\n# Skill\n',
  );
  const agentFile = localAgentFile(agent);
  fs.writeFileSync(path.join(projectRoot, `.${agent}/agents`, agentFile.name), agentFile.content);
}

/** Resolve once the wall clock has moved to the next second. */
function nextSecond(): Promise<void> {
  const started = Math.floor(Date.now() / 1000);
  return new Promise((resolve) => {
    const tick = () => (Math.floor(Date.now() / 1000) > started ? resolve() : setTimeout(tick, 50));
    tick();
  });
}

/** Files on the single push branch this fixture's remote received. */
function branchFiles(fixture: Fixture): { branch: string; files: string[] } {
  const branch = git(
    ['for-each-ref', '--format=%(refname:short)', `refs/heads/teamai/push/${fixture.username}/`],
    fixture.remote,
  ).split('\n').filter(Boolean).at(-1) ?? '';
  const files = branch
    ? git(['ls-tree', '-r', '--name-only', branch], fixture.remote).split('\n').filter(Boolean)
    : [];
  return { branch, files };
}

function readState(fixture: Fixture): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(fixture.projectRoot, '.teamai', 'state.json'), 'utf8'));
}

/** Land a branch on the remote's default branch and drop it, as a merged PR does. */
function mergeBranch(fixture: Fixture, branch: string): void {
  const clone = path.join(fixture.sandbox, `merge-${Date.now()}`);
  git(['clone', '-q', fixture.remote, clone], fixture.sandbox);
  git(['merge', '--no-edit', '-q', `origin/${branch}`], clone);
  git(['push', '-q', 'origin', 'main'], clone);
  git(['push', '-q', 'origin', '--delete', branch], clone);
  fs.rmSync(clone, { recursive: true, force: true });
  // The member's own clone keeps the branch it pushed. Once the PR is merged
  // and the remote branch is gone, that local ref is stale — and `push`/`remove`
  // generate branch names at one-second resolution, so a run in the same second
  // would collide with it.
  git(['checkout', '-q', 'main'], fixture.teamRepo);
  git(['branch', '-q', '-D', branch], fixture.teamRepo);
}

/** Commit a file straight onto the remote's default branch, as a teammate would. */
function commitOnMain(fixture: Fixture, relPath: string, content: string): void {
  const clone = path.join(fixture.sandbox, `mate-${Date.now()}`);
  git(['clone', '-q', fixture.remote, clone], fixture.sandbox);
  fs.mkdirSync(path.dirname(path.join(clone, relPath)), { recursive: true });
  fs.writeFileSync(path.join(clone, relPath), content);
  git(['add', '-A'], clone);
  git(['commit', '-q', '-m', `teammate: ${relPath}`], clone);
  git(['push', '-q', 'origin', 'main'], clone);
  fs.rmSync(clone, { recursive: true, force: true });
}

/** Delete a file straight off the remote's default branch, as a teammate would. */
function deleteOnMain(fixture: Fixture, relPath: string): void {
  const clone = path.join(fixture.sandbox, `mate-rm-${Date.now()}`);
  git(['clone', '-q', fixture.remote, clone], fixture.sandbox);
  git(['rm', '-q', relPath], clone);
  git(['commit', '-q', '-m', `teammate: delete ${relPath}`], clone);
  git(['push', '-q', 'origin', 'main'], clone);
  fs.rmSync(clone, { recursive: true, force: true });
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) {
    fs.rmSync(cleanups.pop()!, { recursive: true, force: true });
  }
});

function track(fixture: Fixture): Fixture {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  cleanups.push(fixture.sandbox);
  return fixture;
}

describe('push places new rules and agents in a namespace (issue #649)', () => {
  it.each(PUSH_AGENTS)('--project resolves each type from its own axis for %s', async (agent) => {
    const fixture = track(makeFixture({ agent, provider: 'git' }));
    writeLocalResources(fixture);

    const result = await runCLI(
      ['push', '--project', 'front-app', '--all'],
      fixture.projectRoot,
      fixture.home,
    );

    // The generic git provider cannot open a PR; the branch is still pushed.
    expect(result.output).toContain('[rules] my-rule → rules/fe-know/my-rule.md');
    expect(result.output).toContain('[agents] vr → agents/fe-agents/vr.yaml');

    const { branch, files } = branchFiles(fixture);
    expect(branch, result.output).not.toBe('');
    expect(files).toContain('rules/fe-know/my-rule.md');
    expect(files).toContain('skills/fe-skills/my-skill/SKILL.md');
    expect(files).toContain('agents/fe-agents/vr.yaml');
    // The shared root is what shipped the rule to the whole team before #649.
    expect(files).not.toContain('rules/my-rule.md');
    expect(files).not.toContain('agents/vr.yaml');

    // The author's copy stays at the tool's rules root, so push marks where it
    // put it on the pending PR entry; the record itself is written once the
    // PR merges (see the next case), so a PR closed unmerged leaves none.
    const state = readState(fixture) as { placedRules?: unknown; pendingPushes: Array<{ items: Array<Record<string, unknown>> }> };
    expect(state.placedRules ?? {}).toEqual({});
    expect(state.pendingPushes.at(-1)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'rules', name: 'my-rule', relativePath: 'rules/fe-know/my-rule.md', placed: true }),
      expect.objectContaining({ type: 'agents', name: 'vr', relativePath: 'agents/fe-agents/vr.yaml', placed: true }),
    ]));
  }, 60_000);

  it('sends an edit of the root copy back to the same namespace after the PR merges', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);

    const unchanged = await runCLI(
      ['push', '--project', 'front-app', '--all'],
      fixture.projectRoot,
      fixture.home,
    );
    expect(unchanged.output).toContain('No new or modified resources to push');
    // That run found the file on the default branch, so the placement is a record now.
    expect(readState(fixture).placedRules).toEqual({ 'my-rule': 'rules/fe-know/my-rule.md' });

    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), '# Rule v2\n');
    const edited = await runCLI(
      ['push', '--project', 'front-app', '--all'],
      fixture.projectRoot,
      fixture.home,
    );

    expect(edited.output).toContain('[rules] my-rule (modified)');
    const { branch, files } = branchFiles(fixture);
    expect(files).toContain('rules/fe-know/my-rule.md');
    expect(files).not.toContain('rules/my-rule.md');
    expect(git(['show', `${branch}:rules/fe-know/my-rule.md`], fixture.remote)).toContain('Rule v2');
  }, 60_000);

  it('never matches another member\'s root rule to a namespaced team rule by basename', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git', username: 'member-b' }));
    // The team already has the namespaced rule, but THIS machine never pushed it.
    commitOnMain(fixture, 'rules/fe-know/my-rule.md', '# Author version\n');
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), '# Unrelated\n');

    const result = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    expect(result.output).toContain('[rules] my-rule (new)');
    const { branch, files } = branchFiles(fixture);
    expect(files).toContain('rules/be-know/my-rule.md');
    // The author's rule is untouched: a shared basename is not evidence.
    expect(git(['show', `${branch}:rules/fe-know/my-rule.md`], fixture.remote))
      .toContain('# Author version');
  }, 60_000);

  it('syncs a teammate\'s newer namespaced rule instead of pushing the stale root copy over it', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);
    // A pull is what records lastPullRev, which the three-way check needs.
    const pulled = await runCLI(['pull'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);

    commitOnMain(fixture, 'rules/fe-know/my-rule.md', '# Teammate v2\n');

    const result = await runCLI(
      ['push', '--project', 'front-app', '--all'],
      fixture.projectRoot,
      fixture.home,
    );

    // The root copy is the author's own, placed under rules/fe-know/. Without
    // the placedRules redirect in the pre-push sync it stayed at v1, read as a
    // local modification, and reverted the teammate's update. (The pull above
    // also installs the CLI's built-in `teamai` skill, which this run does
    // push — the assertion is about the rule.)
    expect(result.output).not.toContain('[rules] my-rule');
    expect(fs.readFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), 'utf8'))
      .toContain('Teammate v2');
    const { branch } = branchFiles(fixture);
    expect(git(['show', `${branch}:rules/fe-know/my-rule.md`], fixture.remote)).toContain('Teammate v2');
    expect(git(['show', 'main:rules/fe-know/my-rule.md'], fixture.remote)).toContain('Teammate v2');
  }, 60_000);

  it('lets the author keep editing an agent they published into an inactive namespace', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);

    // `front-app` is never activated in this directory, so `fe-agents` is not
    // an active namespace: without the placedAgents record the edit below is
    // skipped as "no active source" and the agent cannot be maintained.
    fs.writeFileSync(
      path.join(fixture.projectRoot, '.claude/agents', 'vr.md'),
      '---\nname: vr\ndescription: reviews code\n---\n\nYou review twice.\n',
    );
    const result = await runCLI(
      ['push', '--project', 'front-app', '--all'],
      fixture.projectRoot,
      fixture.home,
    );

    expect(result.output).not.toContain('no active source');
    expect(result.output).toContain('[agents] vr (modified)');
    const { branch } = branchFiles(fixture);
    expect(git(['show', `${branch}:agents/fe-agents/vr.yaml`], fixture.remote))
      .toContain('You review twice.');
  }, 60_000);

  it('removes the published rule even when the author\'s root copy has local edits', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);

    // With edits, the LOCAL scan contributes the bare name too. Taking that
    // match deletes the local copy, reports success, and leaves the namespaced
    // team file published — the author believes the rule is gone (#649 review).
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), '# Edited\n');
    const result = await runCLI(
      ['remove', 'rules', 'my-rule', '--force'],
      fixture.projectRoot,
      fixture.home,
    );

    expect(result.output).toContain('my-rule was published as fe-know/my-rule');
    const { branch, files } = branchFiles(fixture);
    expect(branch, result.output).not.toBe('');
    expect(files).not.toContain('rules/fe-know/my-rule.md');
    expect(fs.existsSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'))).toBe(false);
  }, 60_000);

  it('publishes an agent into the requested namespace despite the same stem elsewhere', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    // A team agent of the same name in a namespace this directory never
    // activates. Without the requested destination taking part in candidate
    // selection, it blocks the push entirely with "no active source".
    commitOnMain(fixture, 'agents/other-ns/vr.yaml',
      'name: vr\ndescription: somebody else\'s reviewer\ninstructions: Read other-ns.\n');
    fs.writeFileSync(
      path.join(fixture.projectRoot, '.claude/agents', 'vr.md'),
      '---\nname: vr\ndescription: reviews code\n---\n\nYou review the front end.\n',
    );

    const result = await runCLI(
      ['push', '--project', 'front-app', '--all'],
      fixture.projectRoot,
      fixture.home,
    );

    expect(result.output).not.toContain('no active source');
    expect(result.output).toContain('[agents] vr → agents/fe-agents/vr.yaml');
    const { branch, files } = branchFiles(fixture);
    expect(files).toContain('agents/fe-agents/vr.yaml');
    // The other namespace's agent is a different agent, and stays untouched.
    expect(git(['show', `${branch}:agents/other-ns/vr.yaml`], fixture.remote))
      .toContain('Read other-ns.');
  }, 60_000);

  it('refuses to place a new rule onto a team rule that already holds the name', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    // The destination the author's role resolves to is already taken by
    // somebody else's rule. Theirs is NEW here — no record maps it to anything
    // — so placing it there would replace that file in a run nobody reviewed.
    commitOnMain(fixture, 'rules/be-know/foo.md', '# The team rule\n');
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'foo.md'), '# My own foo\n');

    const result = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    expect(result.code, result.output).toBe(2);
    expect(result.output).toContain('rules/be-know/foo.md already exists');
    expect(branchFiles(fixture).branch).toBe('');
    expect(git(['show', 'main:rules/be-know/foo.md'], fixture.remote)).toContain('The team rule');
  }, 60_000);

  it('pull delivers a published agent from an inactive namespace and keeps it', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);

    // `front-app` is never activated here: only the placement record keeps this
    // agent. Delivery and revocation run in the SAME pull, so if only one of
    // them knows about the record, the file is written and deleted again.
    const pulled = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);

    const deployed = path.join(fixture.projectRoot, '.claude/agents', 'vr.md');
    expect(fs.existsSync(deployed), pulled.output).toBe(true);

    // And it survives a second pull, which is when a revoke would show up.
    const again = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(again.code, again.output).toBe(0);
    expect(fs.existsSync(deployed), again.output).toBe(true);
  }, 60_000);

  it('pull updates the author\'s root copy of a placed rule instead of writing a second one', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    // be-know is the backend role's knowledge namespace, so it IS active here
    // and pull delivers the rule — which used to land at rules/be-know/ beside
    // the author's own copy at the root, the same rule twice for a tool that
    // loads rules recursively.
    await runCLI(['push', '--role', 'be-know', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);
    commitOnMain(fixture, 'rules/be-know/my-rule.md', '# Rule v2, edited by a teammate\n');

    const pulled = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);

    const rulesDir = path.join(fixture.projectRoot, '.claude/rules');
    expect(fs.readFileSync(path.join(rulesDir, 'my-rule.md'), 'utf8')).toContain('Rule v2');
    expect(fs.existsSync(path.join(rulesDir, 'be-know', 'my-rule.md')), pulled.output).toBe(false);
  }, 60_000);

  it('leaves a shared-root PR untouched when the next push names a namespace', async () => {
    // No knowledge namespace on the role, so the first push goes to the shared root.
    const fixture = track(makeFixture({
      agent: 'claude',
      provider: 'git',
      rolesManifest: ROLES_MANIFEST.replace('knowledge: [be-know]', 'knowledge: []'),
    }));
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), '# Rule v1\n');
    const first = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);
    const { branch: sharedBranch, files: sharedFiles } = branchFiles(fixture);
    expect(sharedFiles, first.output).toContain('rules/my-rule.md');

    // The PR is still open. Naming a namespace now must not rebuild it. Branch
    // names carry a one-second timestamp, so a second push inside the same
    // second would be given the pending branch's name and land on it for that
    // reason alone; wait the second out so the test sees the conflict check.
    await nextSecond();
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), '# Rule v2\n');
    const second = await runCLI(['push', '--role', 'fe-know', '--all'], fixture.projectRoot, fixture.home);

    expect(second.output).toContain('awaiting review at rules/my-rule.md');
    expect(second.output).toContain('separate PR');
    const branches = git(
      ['for-each-ref', '--format=%(refname:short)', `refs/heads/teamai/push/${fixture.username}/`],
      fixture.remote,
    ).split('\n').filter(Boolean);
    expect(branches, second.output).toHaveLength(2);
    const other = branches.find((name) => name !== sharedBranch) ?? '';
    expect(git(['ls-tree', '-r', '--name-only', other], fixture.remote)).toContain('rules/fe-know/my-rule.md');
    // The review at the shared root still holds exactly what it did.
    expect(git(['ls-tree', '-r', '--name-only', sharedBranch], fixture.remote)).toContain('rules/my-rule.md');
    expect(git(['show', `${sharedBranch}:rules/my-rule.md`], fixture.remote)).toContain('Rule v1');
  }, 60_000);

  it('places by the projects manifest the pull just fetched, not the one from the last pull', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    // The remote renames the project's knowledge namespace after this clone
    // was made. Read before the pull, the manifest still says fe-know.
    commitOnMain(fixture, 'manifest/projects.yaml', PROJECTS_MANIFEST.replace('knowledge: [fe-know]', 'knowledge: [fe-know-v2]'));

    const result = await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);

    expect(result.output).toContain('[rules] my-rule → rules/fe-know-v2/my-rule.md');
    const { files } = branchFiles(fixture);
    expect(files, result.output).toContain('rules/fe-know-v2/my-rule.md');
    expect(files).not.toContain('rules/fe-know/my-rule.md');
  }, 60_000);

  it('refuses a --project push when the team clone cannot be refreshed', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    // The clone's manifest is whatever the last pull left. Point origin
    // somewhere unreachable so this run cannot refresh it.
    git(['remote', 'set-url', 'origin', path.join(fixture.sandbox, 'nowhere.git')], fixture.teamRepo);

    const result = await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('could not be refreshed');
    expect(branchFiles(fixture).branch).toBe('');
  }, 60_000);

  it('refuses to remove when the team clone cannot be refreshed', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    commitOnMain(fixture, 'agents/other-ns/vr.yaml',
      'name: vr\ndescription: somebody else\'s\ninstructions: Read other-ns.\n');
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    // The placement merges, but this clone never sees it: fetching fails while
    // pushing still works, so a removal resolved from the stale tree would land.
    mergeBranch(fixture, branchFiles(fixture).branch);
    git(['remote', 'set-url', 'origin', path.join(fixture.sandbox, 'nowhere.git')], fixture.teamRepo);
    git(['remote', 'set-url', '--push', 'origin', fixture.remote], fixture.teamRepo);

    const result = await runCLI(['remove', 'agents', 'vr', '--force'], fixture.projectRoot, fixture.home);

    // Stale, `vr` resolves to no record and falls back to the bare stem, which
    // would remove other-ns/vr as well.
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('could not be refreshed');
    expect(result.output).toContain('Nothing was removed');
    expect(branchFiles(fixture).branch).toBe('');
  }, 60_000);

  it('pull drops the placement record of a rule the team has since deleted', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--role', 'be-know', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);
    const landed = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(readState(fixture).placedRules, landed.output).toEqual({ 'my-rule': 'rules/be-know/my-rule.md' });
    deleteOnMain(fixture, 'rules/be-know/my-rule.md');

    const pulled = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);

    // Left in place, the record would claim the next `rules/be-know/my-rule.md`
    // anybody creates as this author's, and their root copy would push over it.
    expect(readState(fixture).placedRules ?? {}).toEqual({});

    // And when somebody does create it, the placement — already recorded once,
    // and still on the pending entry — must not come back as a record.
    commitOnMain(fixture, 'rules/be-know/my-rule.md', '# Somebody else\'s rule\n');
    const again = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(again.code, again.output).toBe(0);
    expect(readState(fixture).placedRules ?? {}).toEqual({});
    expect(fs.readFileSync(path.join(fixture.projectRoot, '.claude/rules/be-know', 'my-rule.md'), 'utf8'))
      .toContain("Somebody else's rule");
  }, 60_000);

  it('never records a placement whose PR was closed without merging, even with the branch kept', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--role', 'be-know', '--all'], fixture.projectRoot, fixture.home);
    expect(branchFiles(fixture).files).toContain('rules/be-know/my-rule.md');

    // Nothing merges. The branch stays on the remote, as a closed PR's often does.
    const pulled = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);
    expect(readState(fixture).placedRules ?? {}).toEqual({});

    // A teammate later publishes an unrelated rule at that very path.
    commitOnMain(fixture, 'rules/be-know/my-rule.md', '# Somebody else\'s rule\n');
    const again = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(again.code, again.output).toBe(0);
    // Delivered to its namespace directory; the author's root copy is untouched.
    expect(fs.readFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), 'utf8')).toBe('# Rule v1\n');
    expect(fs.readFileSync(path.join(fixture.projectRoot, '.claude/rules/be-know', 'my-rule.md'), 'utf8'))
      .toContain("Somebody else's rule");
  }, 60_000);

  it('withdraws a placement record when a shared-root rule takes the name', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--role', 'be-know', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);
    await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(readState(fixture).placedRules).toEqual({ 'my-rule': 'rules/be-know/my-rule.md' });

    commitOnMain(fixture, 'rules/my-rule.md', '# Shared rule for everyone\n');
    const pulled = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);

    expect(pulled.output).toContain('rules/my-rule.md now exists at the shared root');
    expect(readState(fixture).placedRules ?? {}).toEqual({});
    const rulesDir = path.join(fixture.projectRoot, '.claude/rules');
    expect(fs.readFileSync(path.join(rulesDir, 'my-rule.md'), 'utf8')).toContain('Shared rule');
    expect(fs.readFileSync(path.join(rulesDir, 'be-know', 'my-rule.md'), 'utf8')).toContain('Rule v1');
    // And the next push does not follow the withdrawn record onto the namespaced file.
    fs.writeFileSync(path.join(rulesDir, 'my-rule.md'), '# Shared rule, edited here\n');
    await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);
    const { branch, files } = branchFiles(fixture);
    expect(files, branch).toContain('rules/my-rule.md');
    expect(git(['show', `${branch}:rules/be-know/my-rule.md`], fixture.remote)).toContain('Rule v1');
  }, 60_000);

  it('removes only the published agent, through the real remove command', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    // A second agent of the same name in another namespace, and the author's
    // own, published through --project.
    commitOnMain(fixture, 'agents/other-ns/vr.yaml',
      'name: vr\ndescription: somebody else\'s\ninstructions: Read other-ns.\n');
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);

    const result = await runCLI(
      ['remove', 'agents', 'vr', '--force'],
      fixture.projectRoot,
      fixture.home,
    );

    // The bare stem is what the author knows; it has to resolve to what push
    // published, or removal falls back to the stem and takes every namespace.
    expect(result.output).toContain('vr was published as fe-agents/vr');
    const { branch, files } = branchFiles(fixture);
    expect(branch, result.output).not.toBe('');
    expect(files).not.toContain('agents/fe-agents/vr.yaml');
    // Somebody else's agent of the same name survives.
    expect(git(['show', `${branch}:agents/other-ns/vr.yaml`], fixture.remote))
      .toContain('Read other-ns.');
    // And the tombstone names only the published agent: a bare `vr` would
    // suppress other-ns/vr for anyone who activates that namespace.
    const tombstones = git(['show', `${branch}:agents/.removed`], fixture.remote).split('\n');
    expect(tombstones).toContain('fe-agents/vr');
    expect(tombstones).not.toContain('vr');
  }, 60_000);

  it('refuses a roles manifest namespace that is not a single path segment', async () => {
    const fixture = track(makeFixture({
      agent: 'claude',
      provider: 'git',
      rolesManifest: ROLES_MANIFEST.replace('knowledge: [be-know]', 'knowledge: [foo/bar]'),
    }));
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), '# Rule\n');

    const result = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    // Two levels is a depth pull never looks at for agents, and reads back as
    // the wrong namespace for a rule.
    expect(result.code, result.output).toBe(2);
    expect(result.output).toContain('foo/bar');
    expect(branchFiles(fixture).branch).toBe('');
  }, 60_000);

  it('removes a rule by the bare name it was published under a namespace with', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);

    // The author's copy is at the rules root, so `my-rule` is the name they know.
    const result = await runCLI(
      ['remove', 'rules', 'my-rule', '--force'],
      fixture.projectRoot,
      fixture.home,
    );

    expect(result.output).toContain('my-rule was published as fe-know/my-rule');
    const { branch, files } = branchFiles(fixture);
    expect(branch, result.output).not.toBe('');
    // The namespaced team file is gone from the branch, not just the local copy.
    expect(files).not.toContain('rules/fe-know/my-rule.md');
    // And the author's own copy went with it, or the next push re-publishes it.
    expect(fs.existsSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'))).toBe(false);
    // The removal is only on its branch, so the record still resolves a retry;
    // it goes once the default branch no longer has the file.
    expect(readState(fixture).placedRules).toEqual({ 'my-rule': 'rules/fe-know/my-rule.md' });
    mergeBranch(fixture, branch);
    const pulled = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);
    expect(readState(fixture).placedRules ?? {}).toEqual({});
  }, 60_000);

  it('does not republish a removed agent from the copy an excluded tool kept', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    // Codex is configured for the team but excluded on this machine, and holds
    // its own copy of the agent the author publishes and then removes.
    commitOnMain(fixture, 'teamai.yaml', [
      fs.readFileSync(path.join(fixture.teamRepo, 'teamai.yaml'), 'utf8'),
      '  codex:',
      '    agents: .codex/agents',
    ].join('\n'));
    fs.appendFileSync(path.join(fixture.projectRoot, '.teamai', 'config.yaml'), '\nenabledAgents:\n  - claude\n');
    writeLocalResources(fixture);
    fs.mkdirSync(path.join(fixture.projectRoot, '.codex/agents'), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectRoot, '.codex/agents', 'vr.toml'), localAgentFile('codex').content);

    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);
    await nextSecond();
    await runCLI(['remove', 'agents', 'vr', '--force'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);
    await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);

    // `remove` leaves an excluded tool's copy alone, by design.
    expect(fs.existsSync(path.join(fixture.projectRoot, '.codex/agents', 'vr.toml'))).toBe(true);
    await nextSecond();
    const again = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    expect(again.output).toContain('Scanning local resources');
    expect(again.output).not.toContain('[agents] vr');
    // Both merged branches are gone from the remote, so any branch is this push's.
    expect(branchFiles(fixture).files.filter((f) => /^agents\/(.+\/)?vr\./.test(f))).toEqual([]);
  }, 60_000);

  it('cleans the flattened copy of a removed namespaced agent on pull, and never republishes it', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);
    await nextSecond();
    await runCLI(['remove', 'agents', 'vr', '--force'], fixture.projectRoot, fixture.home);
    const removal = branchFiles(fixture).branch;
    const agentCopy = path.join(fixture.projectRoot, '.claude/agents', 'vr.md');
    expect(fs.existsSync(agentCopy)).toBe(false);

    // While the removal is under review the agent is still on main, and the
    // record still delivers it — as a pending removal of any agent would.
    await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(fs.existsSync(agentCopy)).toBe(true);

    // Merged: the only tombstone is `fe-agents/vr`, but the copy is `vr.md`.
    mergeBranch(fixture, removal);
    const pulled = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);
    expect(fs.existsSync(agentCopy)).toBe(false);

    // And a copy that comes back anyway is not a new agent to publish.
    fs.writeFileSync(agentCopy, localAgentFile('claude').content);
    await nextSecond();
    const again = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);
    expect(again.output).toContain('Scanning local resources');
    expect(again.output).not.toContain('[agents] vr');
    expect(branchFiles(fixture).files.filter((f) => /^agents\/(.+\/)?vr\./.test(f))).toEqual([]);
  }, 60_000);

  it('resolves a retried agent removal through the record while the first removal is unmerged', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    commitOnMain(fixture, 'agents/other-ns/vr.yaml',
      'name: vr\ndescription: somebody else\'s\ninstructions: Read other-ns.\n');
    writeLocalResources(fixture);
    await runCLI(['push', '--project', 'front-app', '--all'], fixture.projectRoot, fixture.home);
    mergeBranch(fixture, branchFiles(fixture).branch);
    await runCLI(['remove', 'agents', 'vr', '--force'], fixture.projectRoot, fixture.home);
    const first = branchFiles(fixture).branch;

    // The first removal PR is still open. Dropping the record there sent the
    // retry to the bare stem, which removes `vr` from every namespace.
    await nextSecond();
    const retry = await runCLI(['remove', 'agents', 'vr', '--force'], fixture.projectRoot, fixture.home);

    expect(retry.output).toContain('vr was published as fe-agents/vr');
    const { branch, files } = branchFiles(fixture);
    expect(branch, retry.output).not.toBe(first);
    expect(files).not.toContain('agents/fe-agents/vr.yaml');
    expect(files).toContain('agents/other-ns/vr.yaml');

    mergeBranch(fixture, branch);
    const pulled = await runCLI(['pull', '--force'], fixture.projectRoot, fixture.home);
    expect(pulled.code, pulled.output).toBe(0);
    expect(readState(fixture).placedAgents ?? {}).toEqual({});
  }, 60_000);

  it('stops the push when the roles manifest exists but cannot be parsed', async () => {
    const fixture = track(makeFixture({
      agent: 'claude',
      provider: 'git',
      rolesManifest: 'version: 1\nroles:\n  - id: backend\n   bad indentation: [\n',
    }));
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), '# Rule\n');

    const result = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    // Falling back here would publish the rule to the whole team.
    expect(result.code, result.output).toBe(2);
    expect(result.output).toContain('Cannot resolve where new rules should go');
    expect(branchFiles(fixture).branch).toBe('');
  }, 60_000);

  it('--dry-run reports the destinations and pushes nothing', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    writeLocalResources(fixture);

    const result = await runCLI(
      ['push', '--project', 'front-app', '--dry-run'],
      fixture.projectRoot,
      fixture.home,
    );

    expect(result.output).toContain('[rules] my-rule → rules/fe-know/my-rule.md');
    expect(result.output).toContain('[agents] vr → agents/fe-agents/vr.yaml');
    expect(result.output).toContain('Dry run');
    expect(branchFiles(fixture).branch).toBe('');
  }, 60_000);

  it('--dry-run fails on a project axis the real push would refuse', async () => {
    const fixture = track(makeFixture({ agent: 'claude', provider: 'git' }));
    fs.writeFileSync(
      path.join(fixture.teamRepo, 'manifest', 'projects.yaml'),
      PROJECTS_MANIFEST.replace('knowledge: [fe-know]', 'knowledge: []'),
    );
    git(['commit', '-q', '-am', 'drop the knowledge axis'], fixture.teamRepo);
    git(['push', '-q', 'origin', 'main'], fixture.teamRepo);
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', 'my-rule.md'), '# Rule\n');

    const result = await runCLI(
      ['push', '--project', 'front-app', '--dry-run'],
      fixture.projectRoot,
      fixture.home,
    );

    expect(result.code, result.output).toBe(2);
    expect(result.output).toContain('declares no knowledge namespace');
  }, 60_000);
});

describe('push namespace placement reaches the PR providers (issue #649)', () => {
  it.each(PUSH_AGENTS)('creates a GitHub PR for the namespaced branch for %s', async (agent) => {
    const fixture = track(makeFixture({
      agent,
      provider: 'github',
      repoUrl: 'https://github.com/team/issue-649.git',
    }));
    const binDir = path.join(fixture.sandbox, 'bin');
    const ghLog = path.join(fixture.sandbox, 'gh.log');
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, 'gh'),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$TEAMAI_FAKE_GH_LOG"\n'
      + 'printf "%s\\n" "https://github.com/team/issue-649/pull/649"\n',
      { mode: 0o755 },
    );
    writeLocalResources(fixture);

    const result = await runCLI(
      ['push', '--project', 'front-app', '--all'],
      fixture.projectRoot,
      fixture.home,
      { PATH: `${binDir}:${process.env.PATH ?? ''}`, TEAMAI_FAKE_GH_LOG: ghLog },
    );

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Pull Request created: https://github.com/team/issue-649/pull/649');
    expect(fs.readFileSync(ghLog, 'utf8')).toContain('pr create -R team/issue-649');
    const { files } = branchFiles(fixture);
    expect(files).toContain('rules/fe-know/my-rule.md');
    expect(files).toContain('agents/fe-agents/vr.yaml');
    expect(files).not.toContain('rules/my-rule.md');
  }, 60_000);

  it.each(PUSH_AGENTS)('creates a GitLab MR for the namespaced branch for %s', async (agent) => {
    const requestPaths: string[] = [];
    const server = http.createServer((request, response) => {
      requestPaths.push(request.url ?? '');
      request.on('data', () => {});
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          iid: 649,
          web_url: 'https://gitlab.example.test/team/issue-649/-/merge_requests/649',
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Failed to start the fake GitLab API server.');
    }
    const gitlabUrl = `http://127.0.0.1:${address.port}`;
    const fixture = track(makeFixture({
      agent,
      provider: 'gitlab',
      repoUrl: `${gitlabUrl}/team/issue-649.git`,
    }));
    writeLocalResources(fixture);

    try {
      const result = await runCLI(
        ['push', '--project', 'front-app', '--all'],
        fixture.projectRoot,
        fixture.home,
        { GITLAB_URL: gitlabUrl, GITLAB_TOKEN: 'test-token' },
      );

      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(
        'Pull Request created: https://gitlab.example.test/team/issue-649/-/merge_requests/649',
      );
      expect(requestPaths).toEqual(['/api/v4/projects/team%2Fissue-649/merge_requests']);
      const { files } = branchFiles(fixture);
      expect(files).toContain('rules/fe-know/my-rule.md');
      expect(files).toContain('agents/fe-agents/vr.yaml');
      expect(files).not.toContain('rules/my-rule.md');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 60_000);
});
