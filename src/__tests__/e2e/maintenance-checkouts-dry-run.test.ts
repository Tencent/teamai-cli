import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/** The team repo URL; git's insteadOf in the sandbox HOME points it at a local bare repo. */
const TEAM_URL = 'https://git.example.com/team/team.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

/** Every file under `dir` with a hash of its content; git objects and the debug log aside. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'objects') walk(full);
      } else if (entry.name !== 'debug.log') {
        files[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  return files;
}

// Maintenance resolved its paths by refreshing the reports and learnings
// checkouts, so a dry run created the teamai-learnings branch, committed to it
// and checked it out (#900).
describe('recall maintenance and promote --dry-run', () => {
  let sandbox: string;
  let home: string;
  let project: string;

  function cli(args: string[]) {
    const env: Record<string, string | undefined> = {
      ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', GIT_CONFIG_NOSYSTEM: '1',
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: project, env, encoding: 'utf8', input: '', timeout: 20_000,
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  beforeEach(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-maintenance-dry-run-')));
    home = path.join(sandbox, 'home');
    project = path.join(sandbox, 'project');
    fs.mkdirSync(home);
    const env = { ...process.env, ...GIT_ENV };
    const remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
    execFileSync('git', ['init', '-q', '-b', 'main', seed], { env });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), ['team: team', `repo: ${TEAM_URL}`, 'provider: git', ''].join('\n'));
    execFileSync('git', ['add', '-A'], { cwd: seed, env });
    execFileSync('git', ['commit', '-qm', 'team'], { cwd: seed, env });
    execFileSync('git', ['push', '-q', remote, 'main'], { cwd: seed, env });
    execFileSync('git', ['config', '--global', `url.${remote}.insteadOf`, TEAM_URL], { env: { ...env, HOME: home, USERPROFILE: home } });
    execFileSync('git', ['init', '-q', '-b', 'main', project], { env });
    const init = cli(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--force', '--scope', 'user']);
    expect(init.code, init.output).toBe(0);
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([
    [['recall', 'maintenance', '--prune']],
    [['recall', 'maintenance', '--confidence-writeback']],
    [['recall', 'promote']],
  ])('%j creates no learnings checkout and writes nothing', (args) => {
    const repo = path.join(home, '.teamai', 'team-repo');
    const before = snapshot(home);

    const result = cli([...args, '--dry-run']);

    expect(result.code, result.output).toBe(0);
    expect(execFileSync('git', ['branch', '--list', 'teamai-learnings'], { cwd: repo, encoding: 'utf8' })).toBe('');
    expect(snapshot(home)).toEqual(before);
  });
});
