/**
 * E2E (#823 item 7, and the maintenance sweep beside it): git mode, user scope.
 *
 * `import --from-mr` (0.25.0 to 0.26.0-beta.3) wrote its learning into the learnings checkout and
 * never committed it. Nothing published it, and `recall maintenance` staged
 * all of `learnings/`, so the first maintenance commit swept it, or any other
 * file nobody meant to share, into a commit about something else.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
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

interface RunResult {
  code: number | null;
  output: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

const sandboxes: string[] = [];

/** A learning file with frontmatter. */
function learning(title: string, extra: string[] = []): string {
  return ['---', `title: "${title}"`, 'date: 2026-09-20', 'confidence: 0.5', ...extra, '---', `# ${title}`, ''].join('\n');
}

/**
 * A user-scope git install on a local bare team repo, with teamai-learnings
 * and teamai-reports already on origin and one `teamai pull` done. With
 * `project`, the install has that project active and it owns the learnings
 * namespace of the same name.
 */
async function setUp(opts: {
  project?: string;
  mainLearnings?: Record<string, string>;
  branchLearnings?: Record<string, string>;
  votes?: string;
} = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue823-remnants-')));
  sandboxes.push(sandbox);
  const home = path.join(sandbox, 'home');
  const remote = path.join(sandbox, 'team.git');
  const clone = path.join(home, '.teamai', 'team-repo');
  const checkout = path.join(home, '.teamai', 'learnings-wt');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

  const seed = path.join(sandbox, 'seed');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: issue-823\nrepo: https://github.com/acme/team\nprovider: github\n');
  if (opts.project) {
    fs.mkdirSync(path.join(seed, 'manifest'));
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      `  - id: ${opts.project}`,
      `    name: ${opts.project}`,
      '    resources:',
      `      learnings: [${opts.project}]`,
      '',
    ].join('\n'));
  }
  for (const [name, content] of Object.entries(opts.mainLearnings ?? {})) {
    fs.mkdirSync(path.join(seed, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'learnings', name), content);
  }
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);

  git(['checkout', '-q', '--orphan', 'teamai-learnings'], seed);
  git(['rm', '-rfq', '.'], seed);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'reports-wt/\nlearnings-wt/\nknowledge-wt/\n');
  fs.mkdirSync(path.join(seed, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'learnings', '.gitkeep'), '');
  for (const [name, content] of Object.entries(opts.branchLearnings ?? {})) {
    fs.mkdirSync(path.dirname(path.join(seed, 'learnings', name)), { recursive: true });
    fs.writeFileSync(path.join(seed, 'learnings', name), content);
  }
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'learnings branch'], seed);

  git(['checkout', '-q', '--orphan', 'teamai-reports'], seed);
  git(['rm', '-rfq', '.'], seed);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'reports-wt/\nlearnings-wt/\nknowledge-wt/\n');
  if (opts.votes) {
    fs.mkdirSync(path.join(seed, 'votes'));
    fs.writeFileSync(path.join(seed, 'votes', 'teammate.yaml'), opts.votes);
  }
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'reports branch'], seed);
  git(['checkout', '-q', 'main'], seed);

  git(['clone', '-q', '--bare', seed, remote], sandbox);
  git(['clone', '-q', remote, clone], sandbox);
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
    'repo:',
    `  localPath: ${clone}`,
    `  remote: ${remote}`,
    '  kind: git',
    'username: ci-823',
    'updatePolicy: auto',
    'scope: user',
    'enabledAgents: [claude]',
    ...(opts.project ? [`projects: [${opts.project}]`] : []),
    '',
  ].join('\n'));

  const run = (args: string[]): Promise<RunResult> => new Promise((resolve) => {
    const { CLAUDE_SESSION_ID: _s, GITHUB_TOKEN: _t, GH_TOKEN: _g, ...env } = process.env;
    const child = spawn('node', [CLI, ...args], {
      cwd: home,
      env: { ...env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', NO_COLOR: '1', TEAMAI_CONTRIBUTE_HINT_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });

  const pull = await run(['pull']);
  expect(pull.code, pull.output).toBe(0);
  expect(fs.existsSync(path.join(checkout, '.git')), pull.output).toBe(true);

  const published = (): string[] =>
    git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], remote).split('\n').filter((f) => f.endsWith('.md'));
  const show = (file: string): string => git(['show', `teamai-learnings:${file}`], remote);
  const status = (): string => git(['status', '--porcelain', '--untracked-files=all'], checkout);
  return { home, remote, checkout, run, published, show, status };
}

/** What an older import --from-mr wrote: `<date>-<title>.md`, with the MR in its frontmatter, never committed. */
const REMNANT = [
  '---',
  'title: "Quokka cache warmup before deploy"',
  'author: dev',
  'date: 2026-09-20',
  'tags: [cache, deploy]',
  'confidence: 0.85',
  'source_mr: "https://github.com/acme/app/pull/42"',
  '---',
  '## Background',
  'The quokka cache is cold after each deploy.',
  '',
].join('\n');
const REMNANT_NAME = '2026-09-20-Quokka-cache-warmup-before-deploy.md';

describe('learnings the checkout holds but never committed (#823)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("publishes an older import --from-mr learning on the next pull, in the project's namespace, and leaves the checkout clean (item 7)", async () => {
    const s = await setUp({ project: 'alpha' });
    const file = path.join(s.checkout, 'learnings', REMNANT_NAME);
    fs.writeFileSync(file, REMNANT);

    const pull = await s.run(['pull']);

    expect(pull.code, pull.output).toBe(0);
    const queued = s.published().filter((f) => /^learnings\/alpha\/quokka-cache-warmup-before-deploy-\d{4}-\d{2}-\d{2}-[a-z0-9]+\.md$/.test(f));
    expect(queued, `${s.published().join('\n')}\n${pull.output}`).toHaveLength(1);
    expect(s.show(queued[0])).toBe(REMNANT);
    expect(s.status()).toBe('');
    expect(pull.output).toContain(`Queued 1 learning(s) an older teamai import --from-mr left unpublished: ${file}`);
  });

  it('publishes only what confidence write-back changed, never a file nobody committed (maintenance sweep)', async () => {
    const recent = new Date().toISOString();
    const vote = (doc: string) => [
      `  ${doc}:`,
      '    recalled_count: 9',
      '    upvoted_count: 6',
      `    last_recalled_at: ${recent}`,
      `    last_upvoted_at: ${recent}`,
    ];
    const s = await setUp({
      mainLearnings: { 'inherited-note.md': learning('Inherited note') },
      branchLearnings: { 'tracked-note.md': learning('Tracked note') },
      votes: ['version: 2', 'votes:', ...vote('tracked-note'), ...vote('inherited-note'), ''].join('\n'),
    });
    // A draft nobody meant to share. It has no votes, so maintenance never touches it.
    const stray = path.join(s.checkout, 'learnings', 'stray-draft.md');
    fs.writeFileSync(stray, learning('Stray draft'));

    const maintenance = await s.run(['recall', 'maintenance', '--confidence-writeback']);

    expect(maintenance.code, maintenance.output).toBe(0);
    expect(maintenance.output).toContain('Published maintenance changes to the learnings branch');
    // The tracked learning it rewrote, and the new copy of the inherited one it wrote into the checkout.
    expect(s.show('learnings/tracked-note.md')).not.toContain('confidence: 0.5');
    expect(s.show('learnings/inherited-note.md')).not.toContain('confidence: 0.5');
    expect(s.published()).not.toContain('learnings/stray-draft.md');
    expect(fs.readFileSync(stray, 'utf8')).toBe(learning('Stray draft'));
  });

  it('publishes an archived prune, and still not a file nobody committed (maintenance sweep)', async () => {
    const s = await setUp({
      branchLearnings: { 'low-note.md': learning('Low note') },
      votes: ['version: 2', 'votes:', '  low-note:', '    recalled_count: 1', '    upvoted_count: 0',
        '    last_recalled_at: 2020-01-01T00:00:00.000Z', ''].join('\n'),
    });
    const stray = path.join(s.checkout, 'learnings', 'stray-draft.md');
    fs.writeFileSync(stray, learning('Stray draft'));

    const prune = await s.run(['recall', 'maintenance', '--prune', '--archive']);

    expect(prune.code, prune.output).toBe(0);
    expect(prune.output).toContain('Published maintenance changes to the learnings branch');
    expect(s.published()).toContain('learnings/_archive/low-note.md');
    expect(s.published()).not.toContain('learnings/low-note.md');
    expect(s.published()).not.toContain('learnings/stray-draft.md');
    expect(fs.existsSync(stray)).toBe(true);
  });
});

describe('pull --dry-run and the contribution queue (#823 item 20)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('says what it would publish and publishes nothing, leaving the learning queued for the next pull', async () => {
    const s = await setUp();
    const note = path.join(s.home, 'otter.md');
    fs.writeFileSync(note, '# Otter note\nOtters hold hands while they sleep.\n');
    // Origin rejects the push, so the contribution stays queued.
    const hook = path.join(s.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by the #823 test" >&2\nexit 1\n', { mode: 0o755 });
    const contribute = await s.run(['contribute', '--title', 'otter', '--file', note]);
    fs.rmSync(hook);
    expect(contribute.output).toContain('Saved locally');
    const queue = path.join(s.home, '.teamai', 'pending-learnings');
    const queued = fs.readdirSync(queue).filter((f) => f.endsWith('.md'));
    expect(queued, contribute.output).toHaveLength(1);
    const before = s.published();

    const dryRun = await s.run(['pull', '--dry-run']);

    expect(dryRun.code, dryRun.output).toBe(0);
    expect(s.published(), dryRun.output).toEqual(before);
    expect(fs.readdirSync(queue).filter((f) => f.endsWith('.md'))).toEqual(queued);
    expect(dryRun.output).toContain('[dry-run] Would publish 1 queued learning(s)');
    expect(dryRun.output).not.toContain('Published 1 queued learning(s)');
    expect(dryRun.output).not.toContain('written locally but not published');

    const pull = await s.run(['pull']);

    expect(pull.output).toContain('Published 1 queued learning(s)');
    expect(s.published()).toContain(`learnings/${queued[0]}`);
  });
});
