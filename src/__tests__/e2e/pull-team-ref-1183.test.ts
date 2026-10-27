import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
let sandbox: string;
let attempt = 0;
const read = (file: string): string => fs.readFileSync(file, 'utf8');
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const skill = (name: string, body = name): string => `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;

function machine(init = true) {
  const root = path.join(sandbox, String(++attempt));
  const home = path.join(root, 'home');
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  const dir = path.join(root, 'app');
  const url = `https://git.example.com/team/ref-${attempt}.git`;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', FORCE_COLOR: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  function run(args: string[], cwd = dir, input?: string) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', input });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }
  function ok(args: string[], cwd = dir) {
    const r = run(args, cwd);
    expect(r.code, r.output).toBe(0);
    return r;
  }
  function git(args: string[], cwd = seed): string {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }
  write(path.join(seed, 'teamai.yaml'), `team: refs\nrepo: ${url}\nprovider: git\nreviewers: []\n`);
  write(path.join(seed, 'skills/base/SKILL.md'), skill('base'));
  write(path.join(seed, 'tags.yaml'), 'skills:\n  trial: [review]\n');
  write(path.join(seed, 'rules/style.md'), 'DEFAULT RULE\n');
  write(path.join(seed, 'claudemd/common.md'), 'DEFAULT INSTRUCTIONS\n');
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'team']);
  git(['clone', '-q', '--bare', seed, remote]);
  git(['remote', 'add', 'origin', remote]);
  git(['config', '--global', `url.${remote}.insteadOf`, url]);
  function teamCommit(files: Record<string, string | null>, branch = 'trial'): string {
    git(['checkout', '-q', branch]);
    for (const [file, content] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(seed, file), { recursive: true, force: true });
      else write(path.join(seed, file), content);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'team change']);
    git(['push', '-q', 'origin', branch]);
    return git(['rev-parse', 'HEAD']);
  }
  git(['checkout', '-q', '-b', 'trial']);
  const trial = teamCommit({ 'skills/trial/SKILL.md': skill('trial'), 'rules/style.md': 'TRIAL RULE\n', 'claudemd/common.md': 'TRIAL INSTRUCTIONS\n' });
  git(['tag', 'v1']);
  git(['push', '-q', 'origin', 'v1']);
  git(['checkout', '-q', 'main']);
  write(path.join(dir, 'README.md'), 'app\n');
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'app'], dir);
  const initArgs = ['init', url, '--provider', 'git', '--scope', 'workspace', '--agent', 'claude,codex', '--force'];
  if (init) ok(initArgs);
  function dataHome(cwd = dir): string {
    const projects = path.join(home, '.teamai/projects');
    const found = fs.readdirSync(projects).map((p) => path.join(projects, p)).find((p) => read(path.join(p, 'config.yaml')).includes(`projectRoot: ${cwd}`));
    if (!found) throw new Error('workspace partition not found');
    return found;
  }
  const configPath = () => path.join(dataHome(), 'config.yaml');
  function config() { return YAML.parse(read(configPath())); }
  function editConfig(fn: (c: ReturnType<typeof config>) => void) { const c = config(); fn(c); write(configPath(), YAML.stringify(c)); }
  const clone = () => config().repo.localPath as string;
  const copy = (name: string, cwd = dir) => path.join(cwd, '.claude/skills', name, 'SKILL.md');
  return { root, home, dir, seed, remote, url, env, trial, run, ok, git, teamCommit, dataHome, config, configPath, editConfig, clone, copy, initArgs };
}

beforeAll(() => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'team-ref-e2e-')));
});
afterAll(async () => { await waitForDetachedChildren(); fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('workspace team ref (#1183)', () => {
  it('delivers branch assets, follows its tip through plain and hook pulls, and records the delivered revision', async () => {
    const m = machine();
    const pin = m.ok(['pull', '--team-ref', 'trial']);
    expect(read(m.copy('trial'))).toContain('trial');
    expect(read(path.join(m.dir, '.claude/rules/style.md'))).toContain('TRIAL RULE');
    expect(pin.output.match(/Pinned to team ref "trial"/g)).toHaveLength(1);
    expect(m.ok(['pull']).output).toContain('Already synced');
    m.ok(['tags', 'subscribe', 'review']);
    m.ok(['pull']);
    for (const tool of ['claude', 'codex']) {
      const r = m.run(['hook-dispatch', 'session-start', '--tool', tool], m.dir, JSON.stringify({ cwd: m.dir, session_id: `ref-${tool}`, source: 'startup', hook_event_name: 'SessionStart' }));
      expect(r.code, r.output).toBe(0);
      if (tool === 'claude') expect(read(path.join(m.dir, '.claude/rules/teamai-context.md'))).toContain('TRIAL INSTRUCTIONS');
      else {
        expect(r.output).toContain('TRIAL INSTRUCTIONS');
        expect(r.output).toContain('TRIAL RULE');
      }
      await waitForDetachedChildren();
      expect(read(path.join(m.dir, '.claude/rules/style.md'))).toContain('TRIAL RULE');
    }
    const tip = m.teamCommit({ 'skills/trial/SKILL.md': skill('trial', 'NEW TIP') });
    const hook = m.run(['hook-dispatch', 'post-merge', '--tool', 'git'], m.dir, '0\n');
    expect(hook.code, hook.output).toBe(0);
    await waitForDetachedChildren();
    expect(read(m.copy('trial'))).toContain('NEW TIP');
    m.ok(['pull']);
    const records = JSON.parse(read(path.join(m.dataHome(), 'state.json'))).lastPullByWorkspace;
    expect(Object.values(records).map((r) => (r as { rev: string }).rev)).toEqual([m.git(['rev-parse', '--short', tip], m.clone())]);
  });

  it.each(['v1', 'commit'])('keeps %s fixed after the default branch advances', (ref) => {
    const m = machine();
    m.ok(['pull', '--team-ref', ref === 'commit' ? m.trial : ref]);
    m.teamCommit({ 'skills/base/SKILL.md': skill('base', 'NEW DEFAULT') }, 'main');
    m.ok(['pull']);
    expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.trial);
    expect(read(m.copy('base'))).not.toContain('NEW DEFAULT');
  });

  it('unpins, removes unchanged branch-only copies, keeps edited copies with advice, and removes resources deleted by a branch', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    write(path.join(m.dir, '.codex/skills/trial/SKILL.md'), skill('trial', 'MY EDIT'));
    const unpin = m.ok(['pull', '--team-ref', 'main']);
    expect(m.config().repo.ref).toBeUndefined();
    expect(fs.existsSync(m.copy('trial')), unpin.output).toBe(false);
    expect(read(path.join(m.dir, '.codex/skills/trial/SKILL.md'))).toContain('MY EDIT');
    expect(unpin.output).toContain('"trial"\'s content');
    expect(m.git(['branch', '--show-current'], m.clone())).toBe('main');
    m.ok(['pull']);
    m.teamCommit({ 'skills/base': null, 'rules/style.md': null, 'agents/reviewer.yaml': 'name: reviewer\ndescription: Reviews\ninstructions: Review.\n' });
    m.ok(['pull', '--team-ref', 'trial']);
    expect(fs.existsSync(m.copy('base'))).toBe(false);
    expect(fs.existsSync(path.join(m.dir, '.claude/rules/style.md'))).toBe(false);
    expect(fs.existsSync(path.join(m.dir, '.claude/agents/reviewer.md'))).toBe(true);
    m.ok(['pull', '--team-ref', 'main']);
    expect(fs.existsSync(path.join(m.dir, '.claude/agents/reviewer.md'))).toBe(false);
  });

  it('shares the pin with linked worktrees and isolates another workspace and another user team', async () => {
    const m = machine();
    const other = path.join(m.root, 'other');
    m.git(['clone', '-q', m.dir, other], m.root);
    m.ok(m.initArgs, other);
    m.ok(['pull', '--team-ref', 'trial']);
    const wt = path.join(m.root, 'worktree');
    m.git(['worktree', 'add', '-q', '-b', 'linked', wt], m.dir);
    await waitForDetachedChildren();
    m.ok(['pull'], wt);
    expect(read(m.copy('trial', wt))).toContain('trial');
    expect(fs.existsSync(m.copy('trial', other))).toBe(false);
    expect(m.ok(['pull'], other).output).not.toContain('Pinned to');
    const records = JSON.parse(read(path.join(m.dataHome(), 'state.json'))).lastPullByWorkspace;
    expect(Object.values(records).map((record) => (record as { rev: string }).rev)).toEqual([
      m.git(['rev-parse', '--short', m.trial], m.clone()), m.git(['rev-parse', '--short', m.trial], m.clone()),
    ]);
    const userSeed = path.join(m.root, 'user-seed');
    const userRemote = path.join(m.root, 'user-team.git');
    const userUrl = 'https://git.example.com/team/user-only.git';
    write(path.join(userSeed, 'teamai.yaml'), `team: user-only\nrepo: ${userUrl}\nprovider: git\n`);
    m.git(['init', '-q', '-b', 'main'], userSeed);
    m.git(['add', '-A'], userSeed);
    m.git(['commit', '-qm', 'user team'], userSeed);
    m.git(['clone', '-q', '--bare', userSeed, userRemote], m.root);
    m.git(['config', '--global', `url.${userRemote}.insteadOf`, userUrl]);
    const userClone = path.join(m.home, '.teamai/team-repo');
    m.git(['clone', '-q', userUrl, userClone], m.root);
    write(path.join(m.home, '.teamai/config.yaml'), YAML.stringify({ ...m.config(), scope: 'user', projectRoot: undefined, dataHome: undefined, repo: { remote: userUrl, localPath: userClone } }));
    m.ok(['pull']);
    expect(m.git(['branch', '--show-current'], userClone)).toBe('main');
    expect(fs.existsSync(path.join(userClone, 'skills/trial'))).toBe(false);
  });

  it('rejects invalid refs and failed fetches without changing the workspace', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    m.git(['checkout', '-b', 'unreachable'], m.clone());
    write(path.join(m.clone(), 'unreachable'), 'local');
    m.git(['add', '.'], m.clone()); m.git(['commit', '-qm', 'local'], m.clone());
    const unreachable = m.git(['rev-parse', 'HEAD'], m.clone());
    m.git(['checkout', '--detach', m.trial], m.clone());
    const before = read(m.configPath());
    for (const ref of ['unknown', unreachable, 'origin/main', 'teamai-reports']) {
      const r = m.run(['pull', '--team-ref', ref]);
      expect(r.code, r.output).toBe(1);
      expect(r.output).toContain(`Team ref "${ref}" is not a branch, tag or commit of the team repo that holds teamai.yaml.`);
      expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.trial);
      expect(read(m.configPath())).toBe(before);
      expect(read(m.copy('trial'))).toBe(skill('trial'));
    }
    m.git(['remote', 'set-url', 'origin', path.join(m.root, 'missing.git')], m.clone());
    expect(m.run(['pull']).code).toBe(1);
    expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.trial);
  });

  it('requires setup without writes, then delivers a commit in a project with no remote', () => {
    const m = machine(false);
    const before = fs.readdirSync(m.dir);
    const r = m.run(['pull', '--team-ref', m.trial]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('--team-ref needs a teamai workspace here. Run teamai init --scope workspace here first.');
    expect(fs.readdirSync(m.dir)).toEqual(before);
    expect(fs.existsSync(path.join(m.home, '.teamai'))).toBe(false);
    m.ok(m.initArgs);
    m.ok(['pull', '--team-ref', m.trial]);
    expect(read(m.copy('trial'))).toContain('trial');
  });

  it.each(['same-team', 'inheritUserScope', 'self', 'http'])('refuses %s before delivery and preserves an existing pin', (kind) => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    const messages = {
      'same-team': '--team-ref pins one workspace, but this team also reaches it through user scope, where every workspace shares one copy. Remove the user-scope install, or turn off inheritUserScope, to pin a workspace.',
      inheritUserScope: '--team-ref pins one workspace, but this team also reaches it through user scope, where every workspace shares one copy. Remove the user-scope install, or turn off inheritUserScope, to pin a workspace.',
      self: "--team-ref does not apply in single-repo mode: the project's own commit decides which team assets it has.",
      http: '--team-ref needs a git team repo. This team is served over HTTP.',
    };
    if (kind === 'same-team') write(path.join(m.home, '.teamai/config.yaml'), YAML.stringify({ ...m.config(), scope: 'user' }));
    else m.editConfig((c) => { if (kind === 'inheritUserScope') c.inheritUserScope = true; else c.repo.kind = kind; });
    fs.rmSync(m.copy('trial'));
    const r = m.run(['pull']);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain(messages[kind as keyof typeof messages]);
    expect(m.config().repo.ref).toBe('trial');
    expect(fs.existsSync(m.copy('trial'))).toBe(false);
  });

  it('blocks push without changing delivered files or bases and still reports usage on pull', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    write(m.copy('trial'), skill('trial', 'MY EDIT'));
    const statePath = path.join(m.dataHome(), 'state.json');
    const before = read(statePath);
    const remoteBefore = m.git(['rev-parse', 'refs/heads/main'], m.remote);
    const pushed = m.run(['push', '--all']);
    expect(pushed.code).toBe(1);
    expect(pushed.output).toContain('This workspace is pinned to team ref "trial", so its skill, rule and agent changes were not pushed: they were made on top of "trial". Commit them to "trial" in the team repo, or make them again in a workspace that follows the default branch.');
    expect(read(statePath)).toBe(before);
    expect(read(m.copy('trial'))).toContain('MY EDIT');
    expect(m.git(['rev-parse', 'refs/heads/main'], m.remote)).toBe(remoteBefore);
    write(path.join(m.dataHome(), 'usage.jsonl'), `${JSON.stringify({ skill: 'trial', tool: 'claude', timestamp: new Date().toISOString() })}\n`);
    m.ok(['pull']);
    expect(m.git(['ls-tree', '-r', '--name-only', 'refs/heads/teamai-reports'], m.remote)).toContain('stats/');
    expect(read(path.join(m.dataHome(), 'usage.jsonl')).trim()).toBe('');
  });

  it('fails pinned pulls when docs or submodules cannot be delivered', () => {
    const docs = machine();
    docs.teamCommit({ 'docs/guide.md': 'Team guide\n' });
    write(path.join(docs.dir, '.teamai/docs'), 'a file blocks the docs directory\n');
    const blockedDocs = docs.run(['pull', '--team-ref', 'trial']);
    expect(blockedDocs.code, blockedDocs.output).toBe(1);
    expect(blockedDocs.output).toContain('Failed to sync docs');

    const sub = machine();
    sub.teamCommit({ 'teamai.yaml': `${read(path.join(sub.seed, 'teamai.yaml'))}submodules: true\n`, '.gitmodules': `[submodule "skills/broken"]\npath = skills/broken\nurl = ${path.join(sub.root, 'missing.git')}\n` });
    sub.git(['update-index', '--add', '--cacheinfo', `160000,${sub.trial},skills/broken`]);
    sub.git(['commit', '-qm', 'add submodule']);
    sub.git(['push', '-q', 'origin', 'trial']);
    const blockedSubmodule = sub.run(['pull', '--team-ref', 'trial']);
    expect(blockedSubmodule.code, blockedSubmodule.output).toBe(1);
    expect(blockedSubmodule.output).toContain('Submodule update failed');
  });

  it('status counts the pinned tree and excludes a branch-only skill from local additions', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    const r = m.ok(['status']);
    expect(r.output).toContain('Pinned to team ref "trial"');
    expect(r.output).toContain('skills: 2');
    expect(r.output.split('Local resources not yet pushed:')[1]).not.toContain('trial');
  });

  it('fails a contended or incomplete pinned delivery and recovers a stale detached clone', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    write(path.join(m.dataHome(), '.sync-lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    expect(m.run(['pull']).code).toBe(1);
    fs.rmSync(path.join(m.dataHome(), '.sync-lock'));
    m.teamCommit({ 'models/aliases.yaml': 'aliases:\n  strong:\n    claude: opus\n', 'agents/held.yaml': 'name: held\ndescription: Held\ninstructions: Hold.\nmodel: strong\n' });
    write(path.join(m.home, '.teamai/models/aliases.yaml'), 'aliases: [broken\n');
    const held = m.run(['pull']);
    expect(held.code, held.output).toBe(1);
    fs.rmSync(path.join(m.home, '.teamai/models/aliases.yaml'));
    m.editConfig((c) => { delete c.repo.ref; });
    m.ok(['pull']);
    expect(m.git(['branch', '--show-current'], m.clone())).toBe('main');
  });
});


describe('team ref reconciliation and safe transitions', () => {
  it.each([{ flags: [] }, { flags: ['--force'] }])('removes old pin copies in another checkout on pull $flags', async ({ flags }) => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    const wt = path.join(m.root, 'worktree');
    m.git(['worktree', 'add', '-q', '-b', 'linked', wt], m.dir);
    await waitForDetachedChildren();
    m.ok(['pull'], wt);
    write(m.copy('trial', wt), skill('trial', 'MY EDIT'));
    m.teamCommit({ 'skills/extra/SKILL.md': skill('extra') });
    m.ok(['pull'], wt);
    m.ok(['pull', '--team-ref', 'main']);
    const r = m.ok(['pull', ...flags], wt);
    expect(fs.existsSync(m.copy('extra', wt)), r.output).toBe(false);
    expect(read(m.copy('trial', wt))).toContain('MY EDIT');
    expect(r.output).toMatch(/\[workspace\] Kept .*"trial"'s content/);
  });

  it('removes a namespaced branch-only skill and rule on unpin', () => {
    const m = machine();
    m.teamCommit({ 'skills/common/ns-only/SKILL.md': skill('ns-only'), 'rules/fe/branch.md': 'BRANCH RULE\n' });
    m.ok(['pull', '--team-ref', 'trial']);
    expect(fs.existsSync(m.copy('ns-only'))).toBe(true);
    expect(fs.existsSync(path.join(m.dir, '.claude/rules/fe/branch.md'))).toBe(true);
    m.ok(['pull', '--team-ref', 'main']);
    expect(fs.existsSync(m.copy('ns-only'))).toBe(false);
    expect(fs.existsSync(path.join(m.dir, '.claude/rules/fe/branch.md'))).toBe(false);
  });

  it('keeps a freshly delivered skill that only moved into a namespace', () => {
    const m = machine();
    m.teamCommit({ 'skills/base': null, 'skills/fe/base/SKILL.md': skill('base') });
    m.ok(['pull', '--team-ref', 'trial']);
    expect(read(m.copy('base'))).toBe(skill('base'));
  });

  it('removes recorded old copies after recovering an incomplete pin', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    const tip = m.teamCommit({ 'skills/collision/SKILL.md': skill('collision', 'TEAM CONTENT') });
    write(m.copy('collision'), skill('collision', 'UNRELATED LOCAL CONTENT'));
    const partial = m.run(['pull']);
    expect(partial.code, partial.output).toBe(1);
    const records = Object.values(JSON.parse(read(path.join(m.dataHome(), 'state.json'))).lastPullByWorkspace) as { rev: string; pushBaseRevs: string[] }[];
    expect(records[0].rev).toBe('');
    expect(records[0].pushBaseRevs[0]).toBe(m.git(['rev-parse', '--short', tip], m.clone()));
    fs.rmSync(path.dirname(m.copy('collision')), { recursive: true });
    m.ok(['pull', '--team-ref', 'main']);
    expect(fs.existsSync(m.copy('trial'))).toBe(false);
  });

  it('refuses a dry-run team ref before fetching or writing', () => {
    const m = machine();
    m.ok(['pull']);
    const head = m.git(['rev-parse', 'HEAD'], m.clone());
    const before = read(m.configPath());
    const fetch = read(path.join(m.clone(), '.git/FETCH_HEAD'));
    m.teamCommit({ 'skills/trial/SKILL.md': skill('trial', 'NEW TIP') });
    const r = m.run(['pull', '--team-ref', 'trial', '--dry-run']);
    expect(r.output).toContain('--team-ref cannot be previewed: a dry run would show the workspace\'s current team revision, not "trial". Run teamai pull --team-ref trial without --dry-run.');
    expect(r.code).toBe(1);
    expect(read(m.configPath())).toBe(before);
    expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(head);
    expect(read(path.join(m.clone(), '.git/FETCH_HEAD'))).toBe(fetch);
  });

  it('previews the current pinned tree without changing HEAD or config', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    const before = read(m.configPath());
    m.teamCommit({ 'skills/trial/SKILL.md': skill('trial', 'NEW TIP') });
    const r = m.run(['pull', '--dry-run']);
    expect(r.code, r.output).toBe(0);
    expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.trial);
    expect(read(m.configPath())).toBe(before);
    expect(read(m.copy('trial'))).toBe(skill('trial'));
  });

  it('preserves pending clone env edits when already following the default branch', () => {
    const m = machine();
    m.teamCommit({ 'env/env.yaml': 'variables: []\n' }, 'main');
    m.ok(['pull']);
    const envFile = path.join(m.clone(), 'env/env.yaml');
    write(envFile, 'variables:\n  - key: PENDING\n    value: mine\n');
    m.ok(['pull', '--team-ref', 'main']);
    expect(read(envFile)).toContain('PENDING');
  });

  it.each(['pin', 'repin', 'unpin', 'recover'])('refuses to %s a dirty team clone', (mode) => {
    const m = machine();
    m.teamCommit({ 'env/env.yaml': 'variables: []\n' });
    if (mode !== 'pin') m.ok(['pull', '--team-ref', 'trial']);
    else { m.teamCommit({ 'env/env.yaml': 'variables: []\n' }, 'main'); m.ok(['pull']); }
    if (mode === 'recover') m.editConfig((c) => { delete c.repo.ref; });
    const envFile = path.join(m.clone(), 'env/env.yaml');
    write(envFile, 'variables:\n  - key: PENDING\n    value: mine\n');
    const before = read(m.configPath());
    const head = m.git(['rev-parse', 'HEAD'], m.clone());
    const ref = mode === 'pin' ? 'trial' : mode === 'repin' ? 'v1' : 'main';
    const r = m.run(mode === 'recover' ? ['pull'] : ['pull', '--team-ref', ref]);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain(`The team repo has uncommitted changes, so it was not switched to "${ref}": env/env.yaml. Share them with teamai push, or discard them, then pull again.`);
    expect(read(envFile)).toContain('PENDING');
    expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(head);
    expect(read(m.configPath())).toBe(before);
  });

  it('keeps default-branch rule placements across pin and unpin', () => {
    const m = machine();
    m.teamCommit({ 'rules/fe/placed.md': 'PLACED RULE\n' }, 'main');
    m.ok(['pull']);
    const file = path.join(m.dataHome(), 'state.json');
    const state = JSON.parse(read(file));
    state.placedRules = { placed: 'rules/fe/placed.md' };
    write(file, JSON.stringify(state));
    m.ok(['pull', '--team-ref', 'v1']);
    expect(JSON.parse(read(file)).placedRules).toEqual(state.placedRules);
    m.ok(['pull', '--team-ref', 'main']);
    expect(JSON.parse(read(file)).placedRules).toEqual(state.placedRules);
  });

  it.each([true, false])('retries a failed rule write when pinned=%s', (pinned) => {
    const m = machine();
    m.ok(['pull']);
    if (!pinned) m.teamCommit({ 'rules/style.md': 'NEW DEFAULT RULE\n' }, 'main');
    const style = path.join(m.dir, '.claude/rules/style.md');
    fs.chmodSync(style, 0o444);
    try {
      const r = m.run(pinned ? ['pull', '--team-ref', 'trial'] : ['pull']);
      expect(r.output).toContain('Failed to sync rule style');
      if (pinned) expect(r.code, r.output).toBe(1);
      const retry = m.run(['pull']);
      expect(retry.output).not.toContain('Already synced');
      if (pinned) expect(retry.code, retry.output).toBe(1);
    } finally { fs.chmodSync(style, 0o644); }
    m.ok(['pull']);
    expect(read(style)).toContain(pinned ? 'TRIAL RULE' : 'NEW DEFAULT RULE');
  });

  it('keeps an edited pinned skill and succeeds after the branch advances', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    write(m.copy('trial'), skill('trial', 'MY EDIT'));
    m.teamCommit({ 'skills/trial/SKILL.md': skill('trial', 'NEW TIP') });
    const r = m.ok(['pull']);
    expect(r.code).toBe(0);
    expect(read(m.copy('trial'))).toContain('MY EDIT');
  });

  it.each([false, true])('reports stale detached recovery once with silent=%s', (silent) => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    m.editConfig((c) => { delete c.repo.ref; });
    const notice = 'The team repo was checked out at a fixed commit with no pin in this workspace\'s config, so it follows the default branch "main" again.';
    const r = m.ok(['pull', ...(silent ? ['--silent'] : [])]);
    expect(r.output.split(notice).length - 1).toBe(silent ? 0 : 1);
    expect(read(path.join(m.home, '.teamai/debug.log')).split(notice).length - 1).toBe(1);
    expect(m.git(['branch', '--show-current'], m.clone())).toBe('main');
    expect(m.ok(['pull']).output).not.toContain(notice);
  });

  it('prints the detached-clone advice on its own when reinitializing a pinned workspace', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    m.git(['remote', 'set-url', 'origin', m.url], m.clone());
    m.git(['config', '--global', '--unset', `url.${m.remote}.insteadOf`]);
    const r = m.run(m.initArgs);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain('The team repo is checked out at a fixed commit (a team ref pin, or an interrupted switch), so this command cannot change it. Run teamai pull --team-ref main to follow the default branch again.');
    expect(r.output).not.toContain('Failed to refresh existing clone');
    expect(r.output).not.toContain('Fix network/auth or resolve divergence');
    expect(m.config().repo.ref).toBe('trial');
    expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.trial);
  });

  it('initializes an empty team remote with its first commit', () => {
    const m = machine(false);
    const empty = path.join(m.root, 'empty.git');
    const url = 'https://git.example.com/team/empty.git';
    m.git(['init', '--bare', '-b', 'main', empty], m.root);
    m.git(['config', '--global', `url.${empty}.insteadOf`, url]);
    m.ok(['init', url, '--provider', 'git', '--scope', 'workspace', '--agent', 'claude', '--force']);
    expect(m.git(['show', 'main:teamai.yaml'], empty)).toContain('team:');
    expect(m.git(['branch', '--show-current'], m.clone())).toBe('main');
  });

  it('persists a silent pin blocker without console output', () => {
    const m = machine();
    m.ok(['pull', '--team-ref', 'trial']);
    m.editConfig((c) => { c.inheritUserScope = true; });
    const r = m.run(['pull', '--silent']);
    expect(r.code).toBe(1);
    expect(r.output).toBe('');
    expect(read(path.join(m.home, '.teamai/debug.log'))).toContain('--team-ref pins one workspace');
  });
});


it('releases the scope lock when the pin notice cannot read HEAD', () => {
  const m = machine();
  m.ok(['pull', '--team-ref', 'trial']);
  const bin = path.join(m.root, 'bin');
  const counter = path.join(m.root, 'head-reads');
  const shim = path.join(bin, 'git');
  write(shim, `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --short ] && [ "$3" = HEAD ]; then
  count=0
  [ ! -f '${counter}' ] || count=$(cat '${counter}')
  count=$((count + 1))
  echo "$count" > '${counter}'
  if [ "$count" -eq 2 ]; then echo 'HEAD unreadable' >&2; exit 128; fi
fi
exec /usr/bin/git "$@"
`);
  fs.chmodSync(shim, 0o755);
  m.env.PATH = `${bin}${path.delimiter}${m.env.PATH}`;
  const r = m.run(['pull']);
  expect(read(counter).trim()).toBe('2');
  expect(fs.existsSync(path.join(m.dataHome(), '.sync-lock')), r.output).toBe(false);
  expect(r.code, r.output).toBe(0);
  expect(r.output).not.toContain('Pinned to team ref');
});

it('removes skills delivered by a pin whose docs phase failed', () => {
  const m = machine();
  m.ok(['pull']);
  m.teamCommit({ 'docs/guide.md': 'Team guide\n' });
  write(path.join(m.dir, '.teamai/docs'), 'blocker\n');
  const partial = m.run(['pull', '--team-ref', 'trial']);
  expect(partial.code, partial.output).toBe(1);
  expect(partial.output).toContain('Failed to sync docs');
  expect(fs.existsSync(m.copy('trial'))).toBe(true);
  fs.rmSync(path.join(m.dir, '.teamai/docs'));
  const unpin = m.ok(['pull', '--team-ref', 'main']);
  expect(fs.existsSync(m.copy('trial')), unpin.output).toBe(false);
});

it.each(['workspace', 'user'])('keeps an attached unpinned %s pull successful when its remote is unavailable', (scope) => {
  const m = machine(scope === 'workspace');
  if (scope === 'user') m.ok(['init', m.url, '--provider', 'git', '--scope', 'user', '--agent', 'claude', '--force']);
  const clone = scope === 'workspace' ? m.clone() : YAML.parse(read(path.join(m.home, '.teamai/config.yaml'))).repo.localPath;
  m.git(['remote', 'set-url', 'origin', path.join(m.root, 'missing.git')], clone);
  const result = m.run(['pull']);
  expect(result.output).toContain('Pull failed:');
  expect(result.code, result.output).toBe(0);
});

it('fails stale-detached recovery when its remote is unavailable', () => {
  const m = machine();
  m.ok(['pull', '--team-ref', 'trial']);
  m.editConfig((c) => { delete c.repo.ref; });
  m.git(['remote', 'set-url', 'origin', path.join(m.root, 'missing.git')], m.clone());
  const result = m.run(['pull']);
  expect(result.output).toContain('Pull failed:');
  expect(result.code, result.output).toBe(1);
  expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.trial);
});

it('fails stale-detached recovery when an untracked file blocks default checkout', () => {
  const m = machine();
  m.teamCommit({ 'skills/base/SKILL.md': null });
  m.ok(['pull', '--team-ref', 'trial']);
  m.editConfig((c) => { delete c.repo.ref; });
  write(path.join(m.clone(), 'skills/base/SKILL.md'), 'MY UNTRACKED FILE\n');
  const r = m.run(['pull']);
  expect(r.output).toContain('untracked working tree files would be overwritten by checkout');
  expect(read(path.join(m.clone(), 'skills/base/SKILL.md'))).toBe('MY UNTRACKED FILE\n');
  expect(m.git(['rev-parse', 'HEAD'], m.clone())).not.toBe(m.git(['rev-parse', 'refs/heads/main'], m.remote));
  expect(r.code).toBe(1);
});

it('fails pinning when team hooks cannot be resolved', () => {
  const m = machine();
  m.teamCommit({ 'hooks/hooks.yaml': 'hooks: [broken\n' });
  const r = m.run(['pull', '--team-ref', 'trial']);

  expect(r.code, r.output).toBe(1);
});

it('retains another checkout pin label when a forced marker is reset on unpin', async () => {
  const m = machine();
  m.ok(['pull', '--team-ref', 'trial']);
  const wt = path.join(m.root, 'worktree');
  m.git(['worktree', 'add', '-q', '-b', 'linked', wt], m.dir);
  await waitForDetachedChildren();
  m.ok(['pull'], wt);
  expect(fs.existsSync(m.copy('trial', wt))).toBe(true);
  m.ok(['tags', 'subscribe', 'review']);
  m.ok(['pull', '--team-ref', 'main']);
  const r = m.ok(['pull'], wt);
  expect(fs.existsSync(m.copy('trial', wt)), r.output).toBe(false);
});

it('fails a repeated pinned pull when a real submodule checkout is blocked', () => {
  const m = machine();
  const sub = path.join(m.root, 'sub');
  m.git(['config', '--global', 'protocol.file.allow', 'always']);
  write(path.join(sub, 'SKILL.md'), skill('sub', 'OLD SUBMODULE'));
  m.git(['init', '-q', '-b', 'main'], sub);
  m.git(['add', '-A'], sub);
  m.git(['commit', '-qm', 'first'], sub);
  const first = m.git(['rev-parse', 'HEAD'], sub);
  write(path.join(sub, 'SKILL.md'), skill('sub', 'NEW SUBMODULE'));
  m.git(['add', '-A'], sub);
  m.git(['commit', '-qm', 'second'], sub);
  m.git(['checkout', 'trial']);
  m.git(['submodule', 'add', sub, 'skills/sub']);
  m.teamCommit({ 'teamai.yaml': `${read(path.join(m.seed, 'teamai.yaml'))}submodules: true\n` });
  m.ok(['pull', '--team-ref', 'trial']);
  expect(m.ok(['pull']).output).toContain('Already synced');
  const subClone = path.join(m.clone(), 'skills/sub');
  m.git(['checkout', '--detach', first], subClone);
  write(path.join(m.clone(), '.git/modules/skills/sub/index.lock'), 'existing lock\n');
  const r = m.run(['pull']);
  expect(r.output).toContain('Submodule update failed');
  expect(r.output).toContain('index.lock');
  expect(r.output).toContain('Already synced');
  expect(r.code, r.output).toBe(1);
});

it('rejects a missing ref on an unborn clone with the team ref advice', () => {
  const m = machine();
  const clone = m.clone();
  fs.rmSync(clone, { recursive: true, force: true });
  fs.mkdirSync(clone);
  m.git(['init', '-q', '-b', 'main'], clone);
  m.git(['remote', 'add', 'origin', m.remote], clone);
  const before = read(m.configPath());
  const r = m.run(['pull', '--team-ref', 'missing']);
  expect(r.code, r.output).toBe(1);
  expect(r.output).toContain('Team ref "missing" is not a branch, tag or commit of the team repo that holds teamai.yaml.');
  expect(r.output).not.toContain("ambiguous argument 'HEAD'");
  expect(read(m.configPath())).toBe(before);
  expect(m.git(['symbolic-ref', '-q', 'HEAD'], clone)).toBe('refs/heads/main');
});

it.each([
  ['remove', 'skills', 'trial', '--force'],
  ['roles', 'add', 'preview', '--namespaces', 'preview'],
])('refuses a pinned admin preview for %s before fetching or writing', (...args) => {
  const m = machine();
  m.ok(['pull', '--team-ref', 'trial']);
  const before = {
    config: read(m.configPath()), state: read(path.join(m.dataHome(), 'state.json')),
    head: m.git(['rev-parse', 'HEAD'], m.clone()), skill: read(m.copy('trial')),
    fetched: fs.statSync(path.join(m.clone(), '.git/FETCH_HEAD')).mtimeMs,
    status: m.git(['status', '--porcelain'], m.clone()),
  };
  const r = m.run([...args, '--dry-run']);
  expect(r.output).toContain('The team repo is checked out at a fixed commit (a team ref pin, or an interrupted switch), so this command cannot change it. Run teamai pull --team-ref main to follow the default branch again.');
  expect(r.code, r.output).toBe(1);
  expect({
    config: read(m.configPath()), state: read(path.join(m.dataHome(), 'state.json')),
    head: m.git(['rev-parse', 'HEAD'], m.clone()), skill: read(m.copy('trial')),
    fetched: fs.statSync(path.join(m.clone(), '.git/FETCH_HEAD')).mtimeMs,
    status: m.git(['status', '--porcelain'], m.clone()),
  }).toEqual(before);
});

it('keeps a pinned workspace usable after one failed submodule update', () => {
  const m = machine();
  const sub = path.join(m.root, 'sub');
  m.git(['config', '--global', 'protocol.file.allow', 'always']);
  write(path.join(sub, 'SKILL.md'), skill('sub', 'FIRST'));
  m.git(['init', '-q', '-b', 'main'], sub);
  m.git(['add', '-A'], sub);
  m.git(['commit', '-qm', 'first'], sub);
  write(path.join(sub, 'SKILL.md'), skill('sub', 'SECOND'));
  m.git(['add', '-A'], sub);
  m.git(['commit', '-qm', 'second'], sub);
  const second = m.git(['rev-parse', 'HEAD'], sub);
  m.git(['checkout', '-q', 'trial']);
  m.git(['submodule', 'add', '-q', sub, 'skills/sub']);
  const seedSub = path.join(m.seed, 'skills/sub');
  m.git(['checkout', '-q', 'HEAD~1'], seedSub);
  m.teamCommit({ 'teamai.yaml': `${read(path.join(m.seed, 'teamai.yaml'))}submodules: true\n` });
  m.ok(['pull', '--team-ref', 'trial']);
  m.git(['checkout', '-q', second], seedSub);
  m.teamCommit({});
  const lock = path.join(m.clone(), '.git/modules/skills/sub/index.lock');
  write(lock, 'held\n');
  const failed = m.run(['pull']);
  expect(failed.output).toContain('Submodule update failed');
  fs.rmSync(lock);
  m.teamCommit({ 'skills/trial/SKILL.md': skill('trial', 'ADVANCED') });
  const next = m.run(['pull']);
  m.ok(['pull']);
  expect(next.output).not.toContain('uncommitted changes');
  expect(next.code, next.output).toBe(0);
  expect(read(m.copy('trial'))).toContain('ADVANCED');
  expect(read(m.copy('sub'))).toContain('SECOND');
  m.ok(['pull', '--team-ref', 'main']);
});


it.each(['deadbeef1', 'no-config'])('reports team ref %s with the spec message under non-English git stderr', (ref) => {
  const m = machine();
  const binary = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(m.root, 'bin');
  fs.mkdirSync(bin);
  const shim = path.join(bin, 'git');
  write(shim, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: ['inherit', 'inherit', 'pipe'] });
if (result.stderr?.length) process.stderr.write('Ошибка Git\\n');
process.exit(result.status ?? 1);
`);
  fs.chmodSync(shim, 0o755);
  m.env.PATH = `${bin}${path.delimiter}${m.env.PATH}`;
  const probe = spawnSync('git', ['rev-parse', '--verify', 'deadbeef1^{commit}'], { cwd: m.seed, env: m.env, encoding: 'utf8' });
  expect(probe.status).toBe(128);
  expect(probe.stderr).toBe('Ошибка Git\n');
  m.git(['checkout', '-q', '-b', 'no-config', 'main']);
  m.git(['rm', '-q', 'teamai.yaml']);
  m.git(['commit', '-qm', 'no config']);
  m.git(['push', '-q', 'origin', 'no-config']);
  m.git(['checkout', '-q', 'main']);
  m.ok(['pull']);
  m.env.LANG = 'zh_CN.UTF-8';
  m.env.LC_ALL = 'zh_CN.UTF-8';
  const result = m.run(['pull', '--team-ref', ref]);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(`Team ref "${ref}" is not a branch, tag or commit of the team repo that holds teamai.yaml. Branches: main, no-config, trial. Push it, or check the name.`);
});

it('pins after a plain dry run moved a submodule pointer', () => {
  const m = machine();
  const sub = path.join(m.root, 'sub');
  m.git(['config', '--global', 'protocol.file.allow', 'always']);
  write(path.join(sub, 'SKILL.md'), skill('sub', 'FIRST'));
  m.git(['init', '-q', '-b', 'main'], sub);
  m.git(['add', '-A'], sub);
  m.git(['commit', '-qm', 'first'], sub);
  write(path.join(sub, 'SKILL.md'), skill('sub', 'SECOND'));
  m.git(['add', '-A'], sub);
  m.git(['commit', '-qm', 'second'], sub);
  const second = m.git(['rev-parse', 'HEAD'], sub);
  m.git(['submodule', 'add', '-q', sub, 'skills/sub']);
  const seedSub = path.join(m.seed, 'skills/sub');
  m.git(['checkout', '-q', 'HEAD~1'], seedSub);
  m.teamCommit({ 'teamai.yaml': `${read(path.join(m.seed, 'teamai.yaml'))}submodules: true\n` }, 'main');
  m.ok(['pull']);
  m.git(['checkout', '-q', second], seedSub);
  m.teamCommit({}, 'main');
  const stamp = path.join(m.dataHome(), 'last-fetch.json');
  write(stamp, JSON.stringify({ lastFetch: '2000-01-01T00:00:00.000Z' }));
  m.ok(['pull', '--dry-run']);
  expect(m.git(['status', '--porcelain'], m.clone())).toBe('');
  expect(JSON.parse(read(stamp)).lastFetch).not.toBe('2000-01-01T00:00:00.000Z');
  const pin = m.run(['pull', '--team-ref', 'trial']);
  expect(pin.output).not.toContain('uncommitted changes');
  expect(pin.code, pin.output).toBe(0);
});

it.each(['add', 'remove'])('refuses source %s on a pinned clone before changing files', (command) => {
  const m = machine();
  m.teamCommit({ 'teamai.yaml': `${read(path.join(m.seed, 'teamai.yaml'))}sources:\n  - name: extra\n    repo: ${m.url}\n` });
  m.ok(['pull', '--team-ref', 'trial']);
  const before = read(path.join(m.clone(), 'teamai.yaml'));
  const result = m.run(command === 'add'
    ? ['source', 'add', m.remote, '--name', 'another'] : ['source', 'remove', 'extra']);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('The team repo is checked out at a fixed commit (a team ref pin, or an interrupted switch), so this command cannot change it. Run teamai pull --team-ref main to follow the default branch again.');
  expect(read(path.join(m.clone(), 'teamai.yaml'))).toBe(before);
  expect(m.git(['status', '--porcelain'], m.clone())).toBe('');
});

it.each(['dir', 'repo'])('reports detached-clone refusal when publishing an import from %s', (mode) => {
  const m = machine();
  m.ok(['pull', '--team-ref', 'trial']);
  write(path.join(m.dir, 'src/main.ts'), 'export const greeting = "hello";\n');
  m.git(['add', '-A'], m.dir);
  m.git(['commit', '-qm', 'source'], m.dir);
  const sourceUrl = 'https://git.example.com/team/source.git';
  m.git(['config', '--global', `url.${m.dir}.insteadOf`, sourceUrl]);
  const result = m.run(['import', mode === 'dir' ? '--dir' : '--from-repo', mode === 'dir' ? m.dir : sourceUrl, '--skip-enrich']);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('The team repo is checked out at a fixed commit (a team ref pin, or an interrupted switch), so this command cannot change it. Run teamai pull --team-ref main to follow the default branch again.');
  expect(result.output).not.toContain('Branch pushed to team knowledge repo');
  expect(result.output).not.toContain('Pushed to team knowledge repo');
  expect(result.output).not.toContain('Fetch complete');
  expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.trial);
});


it.each(['dir', 'repo', 'list'])('refuses an import from %s before changing a pinned published wiki', (mode) => {
  const m = machine();
  write(path.join(m.dir, 'src/main.ts'), 'export const greeting = "hello";\n');
  m.git(['add', '-A'], m.dir);
  m.git(['commit', '-qm', 'source'], m.dir);
  const sourceUrl = 'https://git.example.com/team/source.git';
  m.git(['config', '--global', `url.${m.dir}.insteadOf`, sourceUrl]);
  const list = path.join(m.root, 'repos.yaml');
  write(list, YAML.stringify({ version: 1, repos: [{ url: sourceUrl }] }));
  const args = mode === 'dir' ? ['--dir', m.dir]
    : mode === 'repo' ? ['--from-repo', sourceUrl] : ['--from-repo-list', list];
  const output = path.join(m.root, 'output');
  m.ok(['import', ...args, '--output', output, '--skip-enrich']);
  m.git(['checkout', '-q', 'trial']);
  fs.cpSync(path.join(output, 'teamwiki'), path.join(m.seed, 'teamwiki'), { recursive: true });
  m.teamCommit({});
  m.ok(['pull', '--team-ref', 'trial']);
  write(path.join(m.dir, 'src/main.ts'), 'export function greet(name: string) { return `Hello ${name}`; }\n');
  m.git(['add', '-A'], m.dir);
  m.git(['commit', '-qm', 'change source'], m.dir);
  const result = m.run(['import', ...args, '--skip-enrich']);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('The team repo is checked out at a fixed commit (a team ref pin, or an interrupted switch), so this command cannot change it. Run teamai pull --team-ref main to follow the default branch again.');
  expect(result.output).not.toContain('Fetch complete');
  expect(m.git(['status', '--porcelain'], m.clone())).toBe('');
  m.ok(['pull', '--team-ref', 'main']);
  expect(m.config().repo.ref).toBeUndefined();
});


it.each(['reconcile', 'deep-enrich', 'hidden'])('refuses %s before writing into a pinned wiki', (command) => {
  const m = machine();
  m.teamCommit({
    'teamwiki/evidence/code/app/_manifest.json': JSON.stringify({ components: [] }),
    'teamwiki/source-manifest.json': JSON.stringify({ files: [] }),
    'teamwiki/index.md': '# Team wiki\n',
  });
  m.ok(['pull', '--team-ref', 'trial']);
  expect(m.ok(['codebase', '--status']).output).toContain('Knowledge-base baseline');
  expect(m.run(['codebase', '--lint']).output).not.toContain('checked out at a fixed commit');
  const args = command === 'hidden' ? ['deep-enrich', '--project', 'app']
    : ['codebase', `--${command}`, '--project', 'app'];
  const result = m.run(args);
  expect(result.code, result.output).toBe(1);
  expect(result.output).not.toContain('DetachedTeamRepoError');
  expect(result.output).toContain('The team repo is checked out at a fixed commit (a team ref pin, or an interrupted switch), so this command cannot change it. Run teamai pull --team-ref main to follow the default branch again.');
  expect(m.git(['status', '--porcelain'], m.clone())).toBe('');
});

it('records the pinned team commit as a workflow step agent team revision', () => {
  const m = machine();
  const workflow = 'schemaVersion: v1alpha1\nname: check\ndescription: Check.\nsteps:\n  - id: review\n    prompt: Review.\n';
  m.teamCommit({ 'workflows/check.yaml': workflow }, 'main');
  const pinned = m.teamCommit({ 'workflows/check.yaml': workflow });
  const bin = path.join(m.root, 'bin');
  write(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.301 (Claude Code)'); process.exit(0); }
fs.mkdirSync(require('node:path').dirname(process.env.TEAMAI_WORKFLOW_RESULT), { recursive: true });
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({}));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-claude', session_id: 's' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: 's' }) + '\\n');
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  m.env.PATH = `${bin}${path.delimiter}${m.env.PATH}`;
  const recorded = (): string | undefined => {
    const started = m.ok(['workflow', 'start', 'check', '--driver', 'local', '--tools', 'default=claude']);
    const envelope = JSON.parse(started.output.trim().split('\n').filter((line) => line.startsWith('{')).at(-1)!);
    const run = String(envelope.data.done.run);
    const record = JSON.parse(m.git(['show', `teamai-reports:workflows/runs/${run}.json`], m.remote));
    return record.steps[0].agent?.team?.revision;
  };
  m.ok(['pull', '--team-ref', 'trial']);
  expect(recorded()).toBe(pinned);
  const tip = m.teamCommit({ 'skills/trial/SKILL.md': skill('trial', 'NEW TIP') });
  m.ok(['pull']);
  expect(recorded()).toBe(tip);
  m.ok(['pull', '--team-ref', 'main']);
  m.ok(['pull']);
  expect(recorded()).toBe(m.git(['rev-parse', 'refs/heads/main'], m.remote));
});

function pinSubmoduleSkill() {
  const m = machine();
  const sub = path.join(m.root, 'sub');
  m.git(['config', '--global', 'protocol.file.allow', 'always']);
  write(path.join(sub, 'SKILL.md'), skill('sub'));
  m.git(['init', '-q', '-b', 'main'], sub);
  m.git(['add', '-A'], sub);
  m.git(['commit', '-qm', 'first'], sub);
  const config = `${read(path.join(m.seed, 'teamai.yaml'))}submodules: true\n`;
  m.teamCommit({ 'teamai.yaml': config }, 'main');
  m.git(['checkout', '-q', 'trial']);
  m.git(['submodule', 'add', '-q', sub, 'skills/sub']);
  m.teamCommit({ 'teamai.yaml': config });
  m.ok(['pull', '--team-ref', 'trial']);
  expect(read(m.copy('sub'))).toBe(skill('sub'));
  return m;
}

it('drops a submodule skill the unpinned revision lacks, also on a forced pull', () => {
  const m = pinSubmoduleSkill();
  const unpin = m.ok(['pull', '--team-ref', 'main']);
  const forced = m.ok(['pull', '--force']);
  expect(fs.existsSync(path.join(m.clone(), 'skills/sub')), unpin.output).toBe(false);
  expect(fs.existsSync(m.copy('sub')), forced.output).toBe(false);
});

it('keeps a skill the default branch tracks as files where the pinned branch had a submodule', () => {
  const m = pinSubmoduleSkill();
  m.git(['checkout', '-q', 'main']);
  fs.rmSync(path.join(m.seed, 'skills/sub'), { recursive: true, force: true });
  m.teamCommit({ 'skills/sub/SKILL.md': skill('sub', 'FILES ON MAIN') }, 'main');
  const unpin = m.ok(['pull', '--team-ref', 'main']);
  expect(read(path.join(m.clone(), 'skills/sub/SKILL.md')), unpin.output).toBe(skill('sub', 'FILES ON MAIN'));
  expect(m.git(['status', '--porcelain'], m.clone())).toBe('');
  expect(read(m.copy('sub'))).toBe(skill('sub', 'FILES ON MAIN'));
});

it.each([false, true])('pins a branch that tracks a submodule skill as files (submodule edited: %s)', (edited) => {
  const m = pinSubmoduleSkill();
  m.git(['checkout', '-q', '-b', 'files', 'main']);
  fs.rmSync(path.join(m.seed, 'skills/sub'), { recursive: true, force: true });
  m.teamCommit({ 'skills/sub/SKILL.md': skill('sub', 'FILES BRANCH') }, 'files');
  const file = path.join(m.clone(), 'skills/sub/SKILL.md');
  if (edited) write(file, skill('sub', 'MY EDIT'));
  const r = m.run(['pull', '--team-ref', 'files']);
  if (edited) {
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain('The team repo has uncommitted changes, so it was not switched to "files": skills/sub. Share them with teamai push, or discard them, then pull again.');
    expect(read(file)).toBe(skill('sub', 'MY EDIT'));
  } else {
    expect(r.code, r.output).toBe(0);
    expect(read(file)).toBe(skill('sub', 'FILES BRANCH'));
    expect(m.git(['status', '--porcelain'], m.clone())).toBe('');
    expect(read(m.copy('sub'))).toBe(skill('sub', 'FILES BRANCH'));
  }
});

it('refuses to unpin while a submodule the default branch lacks has local changes', () => {
  const m = pinSubmoduleSkill();
  const edited = path.join(m.clone(), 'skills/sub/SKILL.md');
  write(edited, skill('sub', 'MY EDIT'));
  const before = read(m.configPath());
  const r = m.run(['pull', '--team-ref', 'main']);
  expect(r.code, r.output).toBe(1);
  expect(r.output).toContain('The team repo has uncommitted changes, so it was not switched to "main": skills/sub. Share them with teamai push, or discard them, then pull again.');
  expect(read(edited)).toBe(skill('sub', 'MY EDIT'));
  expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.git(['rev-parse', 'refs/heads/trial'], m.remote));
  expect(read(m.configPath())).toBe(before);
});

it.each([
  'local files at a deinitialized path',
  'an embedded git directory',
  'an unpushed submodule commit',
  'an edited copy of another submodule worktree',
  'a nested repository with an unpushed commit',
])('refuses to unpin over %s where the default branch lacks the submodule', (kind) => {
  const m = pinSubmoduleSkill();
  const sub = path.join(m.clone(), 'skills/sub');
  const commitIn = (dir: string, body: string) => {
    write(path.join(dir, 'SKILL.md'), skill('sub', body));
    m.git(['add', '-A'], dir);
    m.git(['commit', '-qm', 'local only'], dir);
  };
  let kept = path.join(sub, 'SKILL.md');
  if (kind === 'local files at a deinitialized path') {
    m.git(['submodule', 'deinit', '-f', '--', 'skills/sub'], m.clone());
    kept = path.join(sub, 'notes.txt');
    write(kept, 'local notes\n');
  } else if (kind === 'an embedded git directory') {
    m.git(['submodule', 'deinit', '-f', '--', 'skills/sub'], m.clone());
    fs.rmSync(sub, { recursive: true, force: true });
    m.git(['clone', '-q', path.join(m.root, 'sub'), sub], m.clone());
    commitIn(sub, 'LOCAL COMMIT');
    kept = path.join(sub, '.git');
  } else if (kind === 'an unpushed submodule commit') {
    commitIn(sub, 'LOCAL COMMIT');
  } else if (kind === 'an edited copy of another submodule worktree') {
    m.git(['submodule', 'add', '-q', path.join(m.root, 'sub'), 'skills/other']);
    m.teamCommit({});
    m.ok(['pull']);
    m.git(['submodule', 'deinit', '-f', '--', 'skills/sub'], m.clone());
    fs.rmSync(sub, { recursive: true, force: true });
    fs.cpSync(path.join(m.clone(), 'skills/other'), sub, { recursive: true });
    write(kept, skill('sub', 'LOCAL EDIT'));
  } else {
    const nested = path.join(sub, 'nested');
    m.git(['clone', '-q', path.join(m.root, 'sub'), nested], m.clone());
    commitIn(nested, 'NESTED COMMIT');
    m.git(['add', 'nested'], sub);
    m.git(['commit', '-qm', 'nested'], sub);
    kept = path.join(nested, '.git');
  }
  const before = fs.readFileSync(kept.endsWith('.git') ? path.join(kept, 'HEAD') : kept, 'utf8');
  const r = m.run(['pull', '--team-ref', 'main']);
  expect(r.code, r.output).toBe(1);
  expect(r.output).toContain('The team repo has uncommitted changes, so it was not switched to "main": skills/sub. Share them with teamai push, or discard them, then pull again.');
  expect(fs.readFileSync(kept.endsWith('.git') ? path.join(kept, 'HEAD') : kept, 'utf8')).toBe(before);
  expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.git(['rev-parse', 'refs/heads/trial'], m.remote));
});

it('refuses to switch while a leaving submodule directory cannot be emptied, and clears it once it can', () => {
  const m = pinSubmoduleSkill();
  const sub = path.join(m.clone(), 'skills/sub');
  fs.chmodSync(sub, 0o555);
  try {
    const r = m.run(['pull', '--team-ref', 'main']);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain('The team repo has uncommitted changes, so it was not switched to "main": skills/sub. Share them with teamai push, or discard them, then pull again.');
    expect(m.git(['rev-parse', 'HEAD'], m.clone())).toBe(m.git(['rev-parse', 'refs/heads/trial'], m.remote));
  } finally { fs.chmodSync(sub, 0o755); }
  m.ok(['pull', '--team-ref', 'main']);
  m.ok(['pull', '--force']);
  expect(fs.existsSync(path.join(sub, 'SKILL.md'))).toBe(false);
  expect(fs.existsSync(m.copy('sub'))).toBe(false);
});

it('keeps a regular file at a dropped gitlink path when repinning', () => {
  const m = pinSubmoduleSkill();
  m.git(['branch', 'no-sub', 'main']);
  m.git(['push', '-q', 'origin', 'no-sub']);
  const sub = path.join(m.clone(), 'skills/sub');
  m.git(['submodule', 'deinit', '-f', '--', 'skills/sub'], m.clone());
  fs.rmSync(sub, { recursive: true, force: true });
  write(sub, 'local notes\n');
  m.run(['pull', '--team-ref', 'no-sub']);
  expect(read(sub)).toBe('local notes\n');
});

it.each([true, false])('exits 1 only when pinned=%s and a valid team hook cannot be written', (pinned) => {
  const m = machine();
  const hooks = 'hooks:\n  - id: team-stop\n    description: Team stop\n    event: Stop\n    command: echo team-hook\n';
  m.teamCommit({ 'hooks/hooks.yaml': hooks }, pinned ? 'trial' : 'main');
  const local = path.join(m.dir, '.claude/settings.local.json');
  write(local, 'not json\n');
  const r = m.run(pinned ? ['pull', '--team-ref', 'trial'] : ['pull']);
  expect(r.output).toContain('Failed to reconcile hooks for claude');
  expect(read(local)).toBe('not json\n');
  expect(r.code, r.output).toBe(pinned ? 1 : 0);
});

it('says why an unpin exits 1 when the co-author policy cannot be written', () => {
  const m = machine();
  m.ok(['pull', '--team-ref', 'trial']);
  const local = path.join(m.dir, '.claude/settings.local.json');
  write(local, '{}\n');
  fs.chmodSync(local, 0o444);
  m.teamCommit({ 'teamai.yaml': `${read(path.join(m.seed, 'teamai.yaml'))}sharing:\n  coAuthor:\n    enabled: false\n` }, 'main');
  try {
    const r = m.run(['pull', '--team-ref', 'main']);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain(`[workspace] The co-author setting was not written to ${local}: EACCES`);
  } finally { fs.chmodSync(local, 0o644); }
});

it.each([true, false])('exits 1 only when pinned=%s and the team co-author policy cannot be written', (pinned) => {
  const m = machine();
  m.ok(pinned ? ['pull', '--team-ref', 'trial'] : ['pull']);
  const local = path.join(m.dir, '.claude/settings.local.json');
  write(local, '{}\n');
  fs.chmodSync(local, 0o444);
  m.teamCommit({ 'teamai.yaml': `${read(path.join(m.seed, 'teamai.yaml'))}sharing:\n  coAuthor:\n    enabled: false\n` }, pinned ? 'trial' : 'main');
  try {
    const r = m.run(['pull', '--verbose']);
    expect(r.output).toContain('[coauthor] claude: skipped');
    expect(r.output).toContain('EACCES');
    expect(read(local)).toBe('{}\n');
    if (pinned) expect(r.output).toContain(`[workspace] The co-author setting was not written to ${local}: EACCES`);
    else expect(r.output).not.toContain('The co-author setting was not written');
    expect(r.code, r.output).toBe(pinned ? 1 : 0);
  } finally { fs.chmodSync(local, 0o644); }
});
