import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  GIT_TERMINAL_PROMPT: '0',
};

function runCLI(args: string[], homeDir: string, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', HOME: homeDir, USERPROFILE: homeDir, CLAUDE_SESSION_ID: 'dry-run-900' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const fwd = (value: string): string => value.split(path.sep).join('/');

/**
 * Every file under `dir` mapped to a content hash. Git's transient lock files
 * and the CLI diagnostic log are left out: every log line appends to it,
 * preview or not, the same way the other dry-run e2e suites ignore it.
 */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !entry.name.endsWith('.lock') && entry.name !== 'gc.pid' && entry.name !== 'debug.log') {
        out[path.relative(dir, full)] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

const ROLES_YAML = 'version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [] }\n';

/** A config `init` wrote before roles: loading it bare migrates it in place (#850). */
function legacyConfig(localPath: string, remote: string): string {
  return [
    'repo:', `  localPath: ${fwd(localPath)}`, `  remote: ${fwd(remote)}`, '  kind: git',
    'username: alice', 'scope: user', '',
  ].join('\n');
}

function reportedStats(count: number): string {
  return [
    'username: alice', 'skills:', '  deploy-helper:', `    count: ${count}`, '    lastUsed: 2026-06-01T00:00:00Z', '',
  ].join('\n');
}

interface Team {
  sandbox: string;
  homeDir: string;
  remote: string;
  work: string;
  localPath: string;
  cwd: string;
  configPath: string;
}

/**
 * A user-scope git team: a remote with main (teamai.yaml, a roles manifest)
 * and a teamai-reports branch holding alice's reported stats, cloned into the
 * sandbox HOME under a legacy role-less config.
 */
function setupTeam(prefix: string): Team {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(sandbox, 'home');
  const remote = path.join(sandbox, 'remote.git');
  const work = path.join(sandbox, 'work');
  const localPath = path.join(homeDir, '.teamai', 'team-repo');
  const cwd = path.join(sandbox, 'cwd');
  fs.mkdirSync(path.join(homeDir, '.teamai'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);

  fs.mkdirSync(path.join(work, 'manifest'), { recursive: true });
  git(['init', '-q', '-b', 'main'], work);
  git(['config', 'maintenance.auto', 'false'], work);
  fs.writeFileSync(path.join(work, 'teamai.yaml'), [
    'team: c900', 'description: c900 fixture', `repo: ${fwd(remote)}`, 'provider: git', 'usageReport: false', '',
  ].join('\n'));
  fs.writeFileSync(path.join(work, 'manifest', 'roles.yaml'), ROLES_YAML);
  git(['add', '-A'], work);
  git(['commit', '-qm', 'team'], work);
  git(['remote', 'add', 'origin', remote], work);
  git(['push', '-q', 'origin', 'main'], work);

  git(['checkout', '-q', '--orphan', 'teamai-reports'], work);
  git(['rm', '-rq', '--cached', '.'], work);
  fs.rmSync(path.join(work, 'teamai.yaml'));
  fs.rmSync(path.join(work, 'manifest'), { recursive: true });
  fs.mkdirSync(path.join(work, 'stats'), { recursive: true });
  fs.writeFileSync(path.join(work, 'stats', 'alice.yaml'), reportedStats(3));
  git(['add', '-A'], work);
  git(['commit', '-qm', 'reports'], work);
  git(['push', '-q', 'origin', 'teamai-reports'], work);

  git(['clone', '-q', remote, localPath], sandbox);
  git(['config', 'maintenance.auto', 'false'], localPath);
  git(['config', 'gc.auto', '0'], localPath);
  const configPath = path.join(homeDir, '.teamai', 'config.yaml');
  fs.writeFileSync(configPath, legacyConfig(localPath, remote));
  return { sandbox, homeDir, remote, work, localPath, cwd, configPath };
}

const sandboxes: string[] = [];

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  }
});

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// `stats` reads: the scope config, the dashboard events and the team's
// reported totals. It used to load each event's directory through a bare
// loader (which migrates a legacy config in place), seed
// `~/.teamai/dashboard/session-owners.jsonl`, and refresh — or create — the
// reports checkout, all under `--dry-run` (#900, C6).
describe('stats --dry-run writes no local state (#900 C6)', () => {
  function withSession(team: Team): void {
    // A tool's own session ID with no data home key: its scope is decided by
    // loading the config its cwd resolves to.
    const dashboard = path.join(team.homeDir, '.teamai', 'dashboard');
    fs.mkdirSync(dashboard, { recursive: true });
    const at = '2026-06-01T10:00:00.000Z';
    fs.writeFileSync(path.join(dashboard, 'events.jsonl'), [
      { type: 'session_start', sessionId: 'claude-session-1', timestamp: at, cwd: team.cwd, tool: 'claude' },
      { type: 'prompt_submit', sessionId: 'claude-session-1', timestamp: at, cwd: team.cwd, tool: 'claude' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  it('without a reports checkout: creates none, seeds no owners file, migrates no config', async () => {
    const team = setupTeam('teamai-c6-');
    sandboxes.push(team.sandbox);
    withSession(team);
    const before = snapshotTree(team.sandbox);

    const { code, output } = await runCLI(['stats', '--dry-run'], team.homeDir, team.cwd);

    expect(code).toBe(0);
    expect(snapshotTree(team.sandbox)).toEqual(before);
    expect(fs.existsSync(path.join(team.homeDir, '.teamai', 'reports-wt'))).toBe(false);
    expect(fs.existsSync(path.join(team.homeDir, '.teamai', 'dashboard', 'session-owners.jsonl'))).toBe(false);
    expect(fs.readFileSync(team.configPath, 'utf-8')).not.toContain('primaryRole');
    expect(output).toContain('Sessions:');
    expect(output).toContain('[dry-run] Would migrate legacy teamai config');
  });

  it.each([false, true])('credits a legacy split session like real stats, missing other snapshots=%s', async (missingSnapshots) => {
    const team = setupTeam('teamai-c6-split-');
    sandboxes.push(team.sandbox);
    // Materialize only the reports checkout, before any snapshots can seed owners.
    expect((await runCLI(['stats'], team.homeDir, team.cwd)).code).toBe(0);
    const dataHome = path.join(team.homeDir, '.teamai');
    const dashboard = path.join(dataHome, 'dashboard');
    fs.mkdirSync(dashboard, { recursive: true });
    fs.rmSync(path.join(dashboard, 'session-owners.jsonl'), { force: true });
    if (!missingSnapshots) {
      for (const name of ['interventions', 'daily-sessions']) {
        fs.writeFileSync(path.join(dashboard, `user-reported-${name}.json`), '{}');
      }
    }
    const otherDashboard = path.join(dataHome, 'projects', 'legacy-scope', 'dashboard');
    fs.mkdirSync(otherDashboard, { recursive: true });
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const id = 'legacy-split-session';
    // Three prompts here, two in another scope, all already in team totals.
    fs.writeFileSync(path.join(dashboard, 'user-reported-prompt-tokens.json'),
      JSON.stringify({ [id]: { prompts: 3, tokens } }));
    fs.writeFileSync(path.join(otherDashboard, 'reported-prompt-tokens.json'),
      JSON.stringify({ [id]: { prompts: 2, tokens } }));
    const report = reportedStats(3) + 'prompts: 5\ninterventions: { sessions: 1, interrupt: 0, toolReject: 0, correction: 0 }\n';
    fs.writeFileSync(path.join(dataHome, 'reports-wt', 'stats', 'alice.yaml'), report);
    fs.writeFileSync(path.join(team.work, 'stats', 'alice.yaml'), report);
    git(['commit', '-qam', 'split session totals'], team.work);
    git(['push', '-q', 'origin', 'teamai-reports'], team.work);
    fs.writeFileSync(path.join(dashboard, 'events.jsonl'), Array.from({ length: 6 }, (_, i) => JSON.stringify({
      type: 'prompt_submit', sessionId: id, cwd: team.cwd, tool: 'claude',
      timestamp: `2026-06-01T10:0${i}:00.000Z`,
    })).join('\n') + '\n');
    const before = snapshotTree(team.sandbox);

    const preview = await runCLI(['stats', '--dry-run'], team.homeDir, team.cwd);

    expect(preview.code, preview.output).toBe(0);
    expect(snapshotTree(team.sandbox)).toEqual(before);
    expect(fs.existsSync(path.join(dashboard, 'session-owners.jsonl'))).toBe(false);
    const real = await runCLI(['stats'], team.homeDir, team.cwd);
    expect(real.code, real.output).toBe(0);
    expect(real.output).not.toContain('[dry-run]');
    expect(real.output).toMatch(/Conversation turns: 6\b/);
    const totals = (output: string) => output.split('\n').filter((line) => /Sessions:|Conversation turns:|Tokens \(total\):/.test(line));
    expect(totals(preview.output)).toEqual(totals(real.output));
    expect(fs.existsSync(path.join(dashboard, 'session-owners.jsonl'))).toBe(true);
  });

  it('with a stale reports checkout: reads it as it is and says so', async () => {
    const team = setupTeam('teamai-c6-');
    sandboxes.push(team.sandbox);
    withSession(team);
    // A real run materializes the reports checkout (and migrates, and seeds).
    const real = await runCLI(['stats'], team.homeDir, team.cwd);
    expect(real.code).toBe(0);
    expect(real.output).toMatch(/deploy-helper\s+3 uses/);
    // Back to the state a dry run must leave alone: legacy config, no owners
    // file, and a teammate's newer report on origin the checkout has not seen.
    fs.writeFileSync(team.configPath, legacyConfig(team.localPath, team.remote));
    fs.rmSync(path.join(team.homeDir, '.teamai', 'dashboard', 'session-owners.jsonl'), { force: true });
    fs.writeFileSync(path.join(team.work, 'stats', 'alice.yaml'), reportedStats(7));
    git(['commit', '-qam', 'newer report'], team.work);
    git(['push', '-q', 'origin', 'teamai-reports'], team.work);
    const before = snapshotTree(team.sandbox);

    const { code, output } = await runCLI(['stats', '--dry-run'], team.homeDir, team.cwd);

    expect(code).toBe(0);
    expect(snapshotTree(team.sandbox)).toEqual(before);
    expect(output).toMatch(/deploy-helper\s+3 uses/);
    expect(output).toContain('[dry-run] Reported totals come from the local reports checkout as it is; it was not refreshed.');
  });
});

// A plain `stats` is a read, so it loads its own scope as `status` and `list`
// do (#901): a legacy role config is not migrated in place (#972).
describe('stats leaves a legacy role config as it is (#972)', () => {
  it.each([false, true])('a plain run reads silently without migrating, with events=%s', async (withEvents) => {
    const team = setupTeam('teamai-972-');
    sandboxes.push(team.sandbox);
    const before = fs.readFileSync(team.configPath);
    if (withEvents) {
      const dashboard = path.join(team.homeDir, '.teamai', 'dashboard');
      fs.mkdirSync(dashboard, { recursive: true });
      fs.writeFileSync(path.join(dashboard, 'events.jsonl'), JSON.stringify({
        type: 'session_start', sessionId: 'legacy-stats', timestamp: '2026-06-01T10:00:00Z',
        cwd: team.cwd, tool: 'claude',
      }) + '\n');
    }

    const { code, output } = await runCLI(['stats'], team.homeDir, team.cwd);

    expect(code).toBe(0);
    expect(fs.readFileSync(team.configPath)).toEqual(before);
    expect(output).not.toContain('[dry-run]');
    if (withEvents) expect(output).toContain('Sessions:');
  });
});

// `recall <query> --dry-run` recorded the session's recall quality and, with
// no index or a legacy one, rebuilt the index and saved it (#900, C9).
describe('recall <query> --dry-run writes no local state (#900 C9)', () => {
  function withLearning(team: Team): void {
    const learnings = path.join(team.homeDir, '.teamai', 'learnings');
    fs.mkdirSync(learnings, { recursive: true });
    fs.writeFileSync(path.join(learnings, 'deploy-timeout.md'), [
      '---', 'title: Deployment timeout fix', 'author: alice', 'date: 2026-06-01', 'tags: [deploy, timeout]', '---', '',
      '# Deployment timeout fix', '', 'Raise the deployment timeout when the rollout waits on migrations.', '',
    ].join('\n'));
  }

  const indexPath = (team: Team) => path.join(team.homeDir, '.teamai', 'search-index.json');

  it('with no index: returns the hit, leaves no index file and records no recall quality', async () => {
    const team = setupTeam('teamai-c9-');
    sandboxes.push(team.sandbox);
    withLearning(team);
    const before = snapshotTree(team.sandbox);

    const { code, output } = await runCLI(['recall', 'deployment timeout', '--dry-run'], team.homeDir, team.cwd);

    expect(code).toBe(0);
    expect(output).toContain('Deployment timeout fix');
    expect(fs.existsSync(indexPath(team))).toBe(false);
    expect(fs.existsSync(path.join(team.homeDir, '.teamai', 'sessions'))).toBe(false);
    expect(snapshotTree(team.sandbox)).toEqual(before);
  });

  // chmod does not make a file unreadable on Windows or to root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('with a corpus it cannot read: searches the retained legacy index like a real run', async () => {
    const team = setupTeam('teamai-c9-unreadable-');
    sandboxes.push(team.sandbox);
    withLearning(team);
    // Only the entry of the file it cannot read stays; the others are of files it no longer receives.
    const learning = path.join(team.homeDir, '.teamai', 'learnings', 'deploy-timeout.md');
    const entries = Array.from({ length: 6 }, (_, i) => ({
      author: 'alice', date: '2026-06-01', type: 'learnings',
      title: i === 0 ? 'Retained deployment timeout' : `Dropped deployment timeout ${i}`,
      filename: i === 0 ? 'deploy-timeout.md' : `dropped-${i}.md`, ...(i === 0 ? { path: learning } : {}),
      tags: ['deployment', 'timeout'],
      tokens: ['title:deployment', 'title:timeout', 'tag:deployment', 'tag:timeout'], votes: 0,
    }));
    fs.writeFileSync(indexPath(team), JSON.stringify({ version: 1, builtAt: '2026-01-01T00:00:00Z', entries }));
    const before = snapshotTree(team.sandbox);
    // Unreadable only while recall runs: the snapshot reads every file.
    const recallUnreadable = async (args: string[]) => {
      fs.chmodSync(learning, 0o000);
      try {
        return await runCLI(['recall', 'deployment timeout', ...args], team.homeDir, team.cwd);
      } finally {
        fs.chmodSync(learning, 0o644);
      }
    };

    const preview = await recallUnreadable(['--dry-run']);

    expect(preview.code).toBe(0);
    expect(snapshotTree(team.sandbox)).toEqual(before);
    expect(preview.output).toContain('Search index could not read 1 path(s)');
    expect(preview.output).toContain('Retained deployment timeout');
    expect(preview.output).not.toContain('Dropped deployment timeout');
    const real = await recallUnreadable([]);
    expect(real.code).toBe(0);
    const hits = (output: string) => output.split('\n').filter((line) => line.includes('Retained deployment timeout'));
    expect(hits(preview.output)).toEqual(hits(real.output));
    const saved = JSON.parse(fs.readFileSync(indexPath(team), 'utf-8')) as { entries: Array<{ title: string }> };
    expect(saved.entries.map((entry) => entry.title)).toEqual(['Retained deployment timeout']);
  });

  it('with a legacy index: searches a fresh build and leaves the file as it was', async () => {
    const team = setupTeam('teamai-c9-');
    sandboxes.push(team.sandbox);
    withLearning(team);
    // A version-1 index: recall rebuilds it before searching.
    fs.writeFileSync(indexPath(team), JSON.stringify({ version: 1, builtAt: '2026-01-01T00:00:00Z', entries: [] }));
    const before = snapshotTree(team.sandbox);

    const { code, output } = await runCLI(['recall', 'deployment timeout', '--dry-run'], team.homeDir, team.cwd);

    expect(code).toBe(0);
    expect(output).toContain('Deployment timeout fix');
    expect(snapshotTree(team.sandbox)).toEqual(before);
  });
});
