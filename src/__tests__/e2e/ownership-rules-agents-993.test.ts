/**
 * E2E (#993 bugs 2 and 12): ownership of rule and agent files teamai has no
 * delivery record of.
 *
 * A file at a rule or agent destination with no record in the checkout's
 * ledger is teamai's only when it equals teamai's render of that resource at
 * some revision of the team repo's history; an older team copy is then
 * updated as before. Anything else is kept: an edited copy whose record was
 * lost (a restored or copied checkout gives `.git` a new inode, so the record
 * key changes) with the kept-edit wording, a member's own file at a team
 * resource's path with its own message, which `doctor` repeats.
 *
 * Each case gets its own team remote: a local bare repo reached through a
 * synthetic HTTPS URL (`url.<path>.insteadOf` in the sandbox HOME).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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

interface Run { code: number | null; output: string }

let sandbox: string;
let home: string;
/** Keeps a retried case off the directories its first attempt left. */
let attempt = 0;

function env(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '0',
  };
  delete base.CLAUDE_CONFIG_DIR;
  return base;
}

function run(command: string, args: string[], cwd: string): Run {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function gitOk(args: string[], cwd: string): string {
  const r = run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
  return r.output.trim();
}

const teamai = (args: string[], cwd: string): Run => run(process.execPath, [CLI, ...args], cwd);

function teamaiOk(args: string[], cwd: string): Run {
  const r = teamai(args, cwd);
  if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
  return r;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/** A team: the bare remote its synthetic URL reaches, and a way to publish to it. */
interface Team { url: string; publish(files: Record<string, string>, message: string): void }

const ROLES_YAML = [
  'version: 1',
  'roles:',
  '  - id: frontend',
  '    resources:',
  '      knowledge: [frontend]',
  '      skills: [frontend]',
  '  - id: backend',
  '    resources:',
  '      knowledge: [backend]',
  '      skills: [backend]',
  '',
].join('\n');

const agentYaml = (name: string, instructions: string): string => [
  `name: ${name}`,
  `description: ${name} fixture`,
  'targets:',
  '  - claude',
  'instructions: |',
  `  ${instructions}`,
  '',
].join('\n');

function team(base: string, files: Record<string, string>): Team {
  const name = `${base}-${++attempt}`;
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  writeFile(path.join(seed, 'teamai.yaml'), [`team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []', ''].join('\n'));
  gitOk(['init', '-q', '-b', 'main'], seed);
  const publish = (next: Record<string, string>, message: string): void => {
    for (const [rel, content] of Object.entries(next)) writeFile(path.join(seed, rel), content);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', message], seed);
    if (fs.existsSync(remote)) gitOk(['push', '-q', remote, 'main'], seed);
  };
  publish(files, 'seed');
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  return { url, publish };
}

/** A git business repo holding `files` before teamai is set up in it. */
function business(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(sandbox, `${name}-${++attempt}`);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
  return fs.realpathSync.native(dir);
}

function init(t: Team, dir: string, ...extra: string[]): Run {
  const started = teamaiOk(['init', t.url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force', ...extra], dir);
  const pulled = teamaiOk(['pull'], dir);
  return { ...pulled, output: `${started.output}${pulled.output}` };
}

/** What a restore from backup or a `cp -a` copy does to the checkout: `.git` gets a new inode. */
function giveGitNewInode(dir: string): void {
  fs.renameSync(path.join(dir, '.git'), path.join(dir, '.git.old'));
  fs.cpSync(path.join(dir, '.git.old'), path.join(dir, '.git'), { recursive: true, preserveTimestamps: true });
  fs.rmSync(path.join(dir, '.git.old'), { recursive: true, force: true });
}

/** Drop the checkout record of `file`, as for a copy an older CLI wrote: only the team history can prove it teamai's. */
function forgetRecord(file: string): void {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name === 'state.json' ? [path.join(d, e.name)] : []);
  let found = false;
  for (const stateFile of walk(path.join(home, '.teamai'))) {
    const state = JSON.parse(read(stateFile)) as { lastPullByWorkspace?: Record<string, { delivered?: Record<string, string> }> };
    for (const record of Object.values(state.lastPullByWorkspace ?? {})) {
      if (record.delivered?.[file] === undefined) continue;
      delete record.delivered[file];
      found = true;
    }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
  if (!found) throw new Error(`no delivery record of ${file}`);
}

const TEAM_RULE = '# Team rule\n';
const FE_RULE = '# Frontend rule\n';
const BE_RULE = '# Backend rule\n';

describe('ownership of unrecorded rule and agent files (#993 bugs 2 and 12)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-rule-ownership-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('after .git gets a new inode, keeps edited still-delivered copies and updates an unedited older one', () => {
    const t = team('restored', {
      'rules/team-rule.md': TEAM_RULE,
      'rules/other-rule.md': '# Other rule v1\n',
      'agents/team-agent.yaml': agentYaml('team-agent', 'Version one.'),
    });
    const dir = business('restored-biz');
    init(t, dir);
    const rule = path.join(dir, '.claude', 'rules', 'team-rule.md');
    const other = path.join(dir, '.claude', 'rules', 'other-rule.md');
    const agent = path.join(dir, '.claude', 'agents', 'team-agent.md');
    // A first install writes where no file exists.
    expect(read(rule)).toBe(TEAM_RULE);
    expect(read(other)).toBe('# Other rule v1\n');
    expect(read(agent)).toContain('Version one.');

    giveGitNewInode(dir);
    fs.appendFileSync(rule, 'member edit\n');
    fs.appendFileSync(agent, 'member edit\n');
    t.publish({ 'rules/other-rule.md': '# Other rule v2\n' }, 'other v2');

    const pulled = teamaiOk(['pull'], dir);
    expect(read(rule)).toBe(`${TEAM_RULE}member edit\n`);
    expect(read(agent)).toContain('member edit');
    expect(pulled.output).toContain(`Kept ${rule}: you changed it`);
    expect(pulled.output).toContain(`Kept ${agent}: you changed it`);
    // The unedited copy of an older team version is teamai's, and updated.
    expect(read(other)).toBe('# Other rule v2\n');
    expect(pulled.output).not.toContain(`Kept ${other}`);
  });

  it('after .git gets a new inode and a role switch, keeps an edited rule of the old role', () => {
    const t = team('restored-role', {
      'manifest/roles.yaml': ROLES_YAML,
      'rules/team-rule.md': TEAM_RULE,
      'rules/frontend/fe-rule.md': FE_RULE,
      'rules/backend/be-rule.md': BE_RULE,
    });
    const dir = business('restored-role-biz');
    init(t, dir, '--role', 'frontend');
    const feRule = path.join(dir, '.claude', 'rules', 'frontend', 'fe-rule.md');
    const beRule = path.join(dir, '.claude', 'rules', 'backend', 'be-rule.md');
    expect(read(feRule)).toBe(FE_RULE);

    giveGitNewInode(dir);
    fs.appendFileSync(feRule, 'member edit\n');
    teamaiOk(['roles', 'set', 'backend'], dir);
    const pulled = teamaiOk(['pull'], dir);

    expect(read(feRule)).toBe(`${FE_RULE}member edit\n`);
    expect(pulled.output).toContain(
      `Kept ${feRule}: teamai no longer delivers frontend/fe-rule here, but you changed this copy. Delete it when you no longer need it.`,
    );
    expect(read(beRule)).toBe(BE_RULE);
  });

  it('keeps a member\'s own rule and agent at a team resource\'s path, names them, and doctor lists them', () => {
    const t = team('own-files', {
      'rules/team-rule.md': TEAM_RULE,
      'agents/team-agent.yaml': agentYaml('team-agent', 'Team version.'),
    });
    const dir = business('own-files-biz', {
      '.claude/rules/team-rule.md': 'MY RULE\n',
      '.claude/agents/team-agent.md': 'MY AGENT\n',
    });
    const rule = path.join(dir, '.claude', 'rules', 'team-rule.md');
    const agent = path.join(dir, '.claude', 'agents', 'team-agent.md');
    const ruleMessage = `Kept ${rule}: it is not teamai's (no delivery record, and it matches no team version of rules/team-rule.md). `
      + 'Rename or delete it, then run teamai pull, to receive the team version.';
    const agentMessage = `Kept ${agent}: it is not teamai's (no delivery record, and it matches no team version of agents/team-agent.yaml). `
      + 'Rename or delete it, then run teamai pull, to receive the team version.';

    const initRun = init(t, dir);
    expect(read(rule)).toBe('MY RULE\n');
    expect(read(agent)).toBe('MY AGENT\n');
    expect(initRun.output).toContain(ruleMessage);
    expect(initRun.output).toContain(agentMessage);

    const forced = teamaiOk(['pull', '--force'], dir);
    expect(read(rule)).toBe('MY RULE\n');
    expect(read(agent)).toBe('MY AGENT\n');
    expect(forced.output).toContain(ruleMessage);
    expect(forced.output).toContain(agentMessage);

    const doctor = teamai(['doctor'], dir);
    expect(doctor.output).toContain(ruleMessage);
    expect(doctor.output).toContain(agentMessage);

    // As the message says: once the member's file is out of the way, a plain pull delivers the team version.
    fs.renameSync(rule, path.join(dir, '.claude', 'rules', 'my-rule.md'));
    fs.rmSync(agent);
    const plain = teamaiOk(['pull'], dir);
    expect(read(rule)).toBe(TEAM_RULE);
    expect(read(agent)).toContain('Team version.');
    expect(plain.output).not.toContain('it is not teamai\'s');
    // The member's renamed rule was never a team rule: the sweep leaves it alone.
    expect(read(path.join(dir, '.claude', 'rules', 'my-rule.md'))).toBe('MY RULE\n');
  });

  it('keeps a member\'s link at a team rule\'s path and never writes through it, even when its target holds an older team version', () => {
    const t = team('rule-link', { 'rules/team-rule.md': 'Old team rule.\n' });
    t.publish({ 'rules/team-rule.md': TEAM_RULE }, 'v2');
    const external = path.join(sandbox, 'rule-link-mine.md');
    writeFile(external, 'Old team rule.\n');
    const dir = business('rule-link-biz', { '.claude/rules/.keep': '' });
    const rule = path.join(dir, '.claude', 'rules', 'team-rule.md');
    fs.symlinkSync(external, rule);

    const initRun = init(t, dir);
    expect(fs.lstatSync(rule).isSymbolicLink()).toBe(true);
    expect(read(external)).toBe('Old team rule.\n');
    expect(initRun.output).toContain(
      `Kept ${rule}: it is a link of yours, so teamai does not replace it. Remove the link to receive rules/team-rule.md from the team.`,
    );
    teamaiOk(['pull', '--force'], dir);
    expect(read(external)).toBe('Old team rule.\n');
  });

  it('never writes through a member\'s link at a rule copy on an already synced pull, or deletes it on teamai remove', () => {
    const t = team('rule-link-synced', { 'rules/team-rule.md': TEAM_RULE });
    const dir = business('rule-link-synced-biz', { '.claude/rules/.keep': '' });
    teamaiOk(['init', t.url, '--provider', 'git', '--agent', 'claude,cursor', '--scope', 'project', '--force'], dir);
    teamaiOk(['pull'], dir);
    const cursorRule = path.join(dir, '.cursor', 'rules', 'team-rule.mdc');
    const claudeRule = path.join(dir, '.claude', 'rules', 'team-rule.md');
    expect(read(cursorRule)).toContain('# Team rule');
    // The member points both copies at files of their own; the team rule verbatim is what an older CLI wrote for Cursor.
    const cursorTarget = path.join(sandbox, `rule-link-synced-cursor-${attempt}.md`);
    const claudeTarget = path.join(sandbox, `rule-link-synced-claude-${attempt}.md`);
    writeFile(cursorTarget, TEAM_RULE);
    writeFile(claudeTarget, TEAM_RULE);
    forgetRecord(cursorRule);
    fs.rmSync(cursorRule);
    fs.symlinkSync(cursorTarget, cursorRule);
    fs.rmSync(claudeRule);
    fs.symlinkSync(claudeTarget, claudeRule);

    teamaiOk(['pull'], dir);
    expect(fs.lstatSync(cursorRule).isSymbolicLink()).toBe(true);
    expect(read(cursorTarget)).toBe(TEAM_RULE);

    teamaiOk(['remove', 'rules', 'team-rule', '--force'], dir);
    expect(fs.lstatSync(claudeRule).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(cursorRule).isSymbolicLink()).toBe(true);
    expect(read(claudeTarget)).toBe(TEAM_RULE);
  });

  it('delivers once the member\'s file is gone, even when the pull that kept it found the checkout at the team revision', () => {
    const t = team('kept-at-rev', { 'rules/team-rule.md': TEAM_RULE });
    const dir = business('kept-at-rev-biz');
    init(t, dir);
    const rule = path.join(dir, '.claude', 'rules', 'team-rule.md');
    // The state an older CLI leaves (no `delivered`), at the current team revision.
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name === 'state.json' ? [path.join(d, e.name)] : []);
    for (const file of walk(path.join(home, '.teamai'))) {
      const state = JSON.parse(read(file)) as { lastPullByWorkspace?: Record<string, { delivered?: unknown }> };
      for (const record of Object.values(state.lastPullByWorkspace ?? {})) delete record.delivered;
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    }
    fs.writeFileSync(rule, 'MY RULE\n');
    expect(teamaiOk(['pull', '--force'], dir).output).toContain(`Kept ${rule}: it is not teamai's`);

    fs.rmSync(rule);
    teamaiOk(['pull'], dir);

    expect(read(rule)).toBe(TEAM_RULE);
  });

  it('does not count a pull whose skill copy failed as synced: the next pull retries it', () => {
    const t = team('copy-failed', { 'skills/team-skill/SKILL.md': '# Team skill\n' });
    const dir = business('copy-failed-biz');
    init(t, dir);
    const skill = path.join(dir, '.claude', 'skills', 'team-skill');
    t.publish({ 'skills/team-skill/SKILL.md': '# Team skill, v2\n' }, 'v2');
    const copy = path.join(skill, 'SKILL.md');
    fs.chmodSync(copy, 0o444);
    fs.chmodSync(skill, 0o555);
    try {
      const failed = teamai(['pull'], dir);
      expect(failed.output).toContain('Failed to sync skill team-skill to claude');
    } finally {
      fs.chmodSync(skill, 0o755);
      fs.chmodSync(copy, 0o644);
    }
    teamaiOk(['pull'], dir);
    expect(read(copy)).toContain('# Team skill, v2');
  });

  it('keeps a member\'s entry of the other type at a delivered path, and delivers once it is gone', () => {
    const t = team('type-conflict', { 'rules/team-rule.md': TEAM_RULE, 'skills/team-skill/SKILL.md': '# Team skill\n' });
    const dir = business('type-conflict-biz', {
      '.claude/rules/team-rule.md/mine.md': 'MINE\n',
      '.claude/skills/team-skill': 'MY FILE\n',
    });
    const rule = path.join(dir, '.claude', 'rules', 'team-rule.md');
    const skill = path.join(dir, '.claude', 'skills', 'team-skill');

    const first = init(t, dir);
    expect(first.output).toContain(`Kept ${rule}: it is not teamai's`);
    expect(first.output).toContain(`Kept ${skill}: it is not teamai's`);
    expect(read(path.join(rule, 'mine.md'))).toBe('MINE\n');
    expect(read(skill)).toBe('MY FILE\n');

    fs.rmSync(rule, { recursive: true });
    fs.rmSync(skill);
    teamaiOk(['pull'], dir);

    expect(read(rule)).toBe(TEAM_RULE);
    expect(read(path.join(skill, 'SKILL.md'))).toContain('# Team skill');
  });

  it('delivers a held agent once its model alias resolves, even when the pull that held it found the checkout at the team revision', () => {
    const t = team('held-at-rev', {
      'models/aliases.yaml': 'aliases:\n  strong:\n    claude: { model: opus }\n',
      'agents/team-agent.yaml': `${agentYaml('team-agent', 'Team version.')}model: strong\n`,
    });
    // The member's override lives in HOME: changing it makes no team revision.
    const override = path.join(home, '.teamai', 'models', 'aliases.yaml');
    writeFile(override, 'aliases:\n  strong:\n    claude: { model: sonnet }\n');
    const dir = business('held-at-rev-biz');
    const agent = path.join(dir, '.claude', 'agents', 'team-agent.md');
    try {
      init(t, dir);
      expect(read(agent)).toMatch(/^model: sonnet$/m);

      // The override breaks: no `strong` resolves, so the forced pull at the team revision holds the agent.
      writeFile(override, 'aliases: [broken\n');
      expect(teamaiOk(['pull', '--force'], dir).output).toContain('Held team-agent.yaml');
      expect(read(agent)).toMatch(/^model: sonnet$/m);

      // Fixed by deleting it: `strong` resolves through the team file again, at the same revision.
      fs.rmSync(override);
      teamaiOk(['pull'], dir);

      expect(read(agent)).toMatch(/^model: opus$/m);
      expect(read(agent)).toContain('Team version.');
    } finally {
      fs.rmSync(override, { force: true });
    }
  });

  it('updates an unrecorded agent copy an older CLI rendered with another tool\'s extras (0.26.0, before #830)', () => {
    const t = team('old-agent-render', {
      'agents/reviewer.yaml': [
        'name: reviewer', 'description: Reviews code', 'targets:', '  - claude', '  - qoder',
        'instructions: |', '  Review the change.', 'tool_extras:', '  claude:', '    color: blue', '',
      ].join('\n'),
    });
    // What teamai 0.26.0 wrote for Qoder: Claude's extras (`color`), and no delivery record.
    const old = '---\nname: reviewer\ndescription: Reviews code\ncolor: blue\n---\nReview the change.\n';
    const dir = business('old-agent-render-biz', { '.qoder/agents/reviewer.md': old, '.claude/agents/.keep': '' });
    const qoder = path.join(dir, '.qoder', 'agents', 'reviewer.md');

    const started = teamaiOk(['init', t.url, '--provider', 'git', '--agent', 'claude,qoder', '--scope', 'project', '--force'], dir);
    const initRun = teamaiOk(['pull'], dir);
    initRun.output = `${started.output}${initRun.output}`;

    expect(initRun.output).not.toContain('not teamai\'s');
    expect(read(qoder)).toBe('---\nname: reviewer\ndescription: Reviews code\n---\nReview the change.\n');
  });

  it('keeps a member\'s own .md in .cursor/rules through pull, remove and uninstall, and removes a legacy teamai copy', () => {
    const t = team('cursor-legacy', {
      'rules/old-layout.md': '# Old layout v1\n',
      'rules/keeper.md': '# Keeper\n',
      'rules/doomed.md': '# Doomed\n',
    });
    t.publish({ 'rules/old-layout.md': '# Old layout v2\n' }, 'old-layout v2');
    const rules = (file: string): string => path.join(dir, '.cursor', 'rules', file);
    const dir = business('cursor-legacy-biz', {
      // The member's own notes, and a file of theirs that has a team rule's name.
      '.cursor/rules/notes.md': 'MY NOTES\n',
      '.cursor/rules/keeper.md': 'MY KEEPER\n',
      // What an older teamai wrote before Cursor got `.mdc`: an old team version, verbatim, with no record.
      '.cursor/rules/old-layout.md': '# Old layout v1\n',
    });
    teamaiOk(['init', t.url, '--provider', 'git', '--agent', 'cursor', '--scope', 'project', '--force'], dir);
    teamaiOk(['pull'], dir);

    expect(fs.existsSync(rules('old-layout.md'))).toBe(false);
    expect(read(rules('old-layout.mdc'))).toContain('# Old layout v2');
    expect(read(rules('notes.md'))).toBe('MY NOTES\n');
    expect(read(rules('keeper.md'))).toBe('MY KEEPER\n');

    teamaiOk(['pull', '--force'], dir);
    expect(read(rules('notes.md'))).toBe('MY NOTES\n');
    expect(read(rules('keeper.md'))).toBe('MY KEEPER\n');

    teamaiOk(['remove', 'rules', 'doomed', '--force'], dir);
    expect(read(rules('notes.md'))).toBe('MY NOTES\n');
    expect(read(rules('keeper.md'))).toBe('MY KEEPER\n');

    teamaiOk(['uninstall', '--force'], dir);
    expect(fs.existsSync(rules('keeper.mdc'))).toBe(false);
    expect(read(rules('notes.md'))).toBe('MY NOTES\n');
    expect(read(rules('keeper.md'))).toBe('MY KEEPER\n');
  });

  it('keeps a member\'s own rules through teamai remove, the removed rule\'s name included', () => {
    const t = team('own-remove', { 'rules/doomed.md': '# Doomed\n', 'rules/keeper.md': '# Keeper\n' });
    const dir = business('own-remove-biz', {
      '.claude/rules/doomed.md': 'MY DOOMED\n',
      '.claude/rules/keeper.md': 'MY KEEPER\n',
    });
    const doomed = path.join(dir, '.claude', 'rules', 'doomed.md');
    const keeper = path.join(dir, '.claude', 'rules', 'keeper.md');
    init(t, dir);

    const removed = teamaiOk(['remove', 'rules', 'doomed', '--force'], dir);

    expect(read(doomed)).toBe('MY DOOMED\n');
    expect(read(keeper)).toBe('MY KEEPER\n');
    expect(removed.output).toContain(`Kept ${doomed}: it is not teamai's`);
    expect(removed.output).toContain(`Kept ${keeper}: it is not teamai's`);
  });

  it('keeps a member\'s own agent through teamai remove agents, and removes teamai\'s recorded and history copies', () => {
    const t = team('own-agent-remove', {
      'agents/doomed-agent.yaml': agentYaml('doomed-agent', 'Doomed.'),
      'agents/gone-agent.yaml': agentYaml('gone-agent', 'Gone.'),
      'agents/old-agent.yaml': agentYaml('old-agent', 'Old.'),
    });
    const dir = business('own-agent-remove-biz', { '.claude/agents/doomed-agent.md': 'MY DOOMED\n' });
    const agents = (file: string): string => path.join(dir, '.claude', 'agents', file);
    init(t, dir);
    expect(read(agents('gone-agent.md'))).toContain('Gone.');
    expect(read(agents('old-agent.md'))).toContain('Old.');
    forgetRecord(agents('old-agent.md'));

    const removed = teamaiOk(['remove', 'agents', 'doomed-agent', 'gone-agent', 'old-agent', '--force'], dir);

    expect(read(agents('doomed-agent.md'))).toBe('MY DOOMED\n');
    expect(removed.output).toContain(`Kept ${agents('doomed-agent.md')}: it is not teamai's (no delivery record, `
      + 'and it matches no team version of agents/doomed-agent.yaml), so remove left it.');
    // On record, and a team version by history.
    expect(fs.existsSync(agents('gone-agent.md'))).toBe(false);
    expect(fs.existsSync(agents('old-agent.md'))).toBe(false);
  });

  it('keeps a member\'s own rule and agent through uninstall, and removes teamai\'s recorded and history copies', () => {
    const t = team('own-uninstall', {
      'rules/team-rule.md': TEAM_RULE,
      'rules/edited-rule.md': '# Edited rule\n',
      'rules/old-rule.md': '# Old rule\n',
      'agents/team-agent.yaml': agentYaml('team-agent', 'Team version.'),
      'agents/old-agent.yaml': agentYaml('old-agent', 'Old.'),
    });
    const dir = business('own-uninstall-biz', {
      '.claude/rules/team-rule.md': 'MY RULE\n',
      '.claude/agents/team-agent.md': 'MY AGENT\n',
    });
    const rules = (file: string): string => path.join(dir, '.claude', 'rules', file);
    const agents = (file: string): string => path.join(dir, '.claude', 'agents', file);
    init(t, dir);
    // A recorded copy the member edited is still teamai's to remove, as a skill directory is.
    fs.appendFileSync(rules('edited-rule.md'), 'member edit\n');
    forgetRecord(rules('old-rule.md'));
    forgetRecord(agents('old-agent.md'));
    const builtins = [rules('teamai-recall.md'), agents('teamai-recall.md')].filter((file) => fs.existsSync(file));

    const uninstalled = teamaiOk(['uninstall', '--force'], dir);

    expect(read(rules('team-rule.md'))).toBe('MY RULE\n');
    expect(read(agents('team-agent.md'))).toBe('MY AGENT\n');
    expect(uninstalled.output).toContain(`Kept ${rules('team-rule.md')}: it is not teamai's (no delivery record, `
      + 'and it matches no team version of rules/team-rule.md), so uninstall left it.');
    expect(uninstalled.output).toContain(`Kept ${agents('team-agent.md')}: it is not teamai's (no delivery record, `
      + 'and it matches no team version of agents/team-agent.yaml), so uninstall left it.');
    for (const file of [rules('edited-rule.md'), rules('old-rule.md'), agents('old-agent.md'), ...builtins]) {
      expect(fs.existsSync(file), file).toBe(false);
    }
  });
});
