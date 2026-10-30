/**
 * E2E (#1501 part 1): turning recall off removes what an earlier pull installed.
 *
 * With recall off, `pull` stopped writing the `teamai-recall` agent and rule
 * but left the copies it had written, so the agent kept calling recall. The
 * team remote is a local bare repo reached through a synthetic HTTPS URL
 * (`url.<path>.insteadOf` in the sandbox HOME).
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

function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '0',
    ...extraEnv,
  };
  delete base.CLAUDE_CONFIG_DIR;
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: base, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function gitOk(args: string[], cwd: string): void {
  const r = run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
}

function teamaiOk(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const r = run(process.execPath, [CLI, ...args], cwd, extraEnv);
  if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
  return r;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('recall off removes the recall agent and rule (#1501 part 1)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-off-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('TEAMAI_RECALL_DISABLED=1 then pull removes both, and pulling without it writes them back', () => {
    const url = 'https://git.example.com/team/recall-off.git';
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'recall-off.git');
    writeFile(path.join(seed, 'teamai.yaml'), [
      'team: recall-off', `repo: ${url}`, 'provider: git', 'reviewers: []',
      'sharing:', '  recall:', '    enabled: true', '',
    ].join('\n'));
    writeFile(path.join(seed, 'rules', 'team-rule.md'), '# Team rule\n');
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'seed'], seed);
    gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
    gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);

    const dir = path.join(sandbox, 'biz');
    writeFile(path.join(dir, 'README.md'), '# app\n');
    gitOk(['init', '-q', '-b', 'main'], dir);
    gitOk(['add', '-A'], dir);
    gitOk(['commit', '-q', '-m', 'app'], dir);
    fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });

    teamaiOk(['init', url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], dir);
    teamaiOk(['pull'], dir);
    const agent = path.join(dir, '.claude', 'agents', 'teamai-recall.md');
    const rule = path.join(dir, '.claude', 'rules', 'teamai-recall.md');
    expect(fs.existsSync(agent)).toBe(true);
    expect(fs.existsSync(rule)).toBe(true);

    teamaiOk(['pull'], dir, { TEAMAI_RECALL_DISABLED: '1' });
    expect(fs.existsSync(agent)).toBe(false);
    expect(fs.existsSync(rule)).toBe(false);
    // The team's own rule is untouched.
    expect(fs.existsSync(path.join(dir, '.claude', 'rules', 'team-rule.md'))).toBe(true);

    teamaiOk(['pull'], dir);
    expect(fs.existsSync(agent)).toBe(true);
    expect(fs.existsSync(rule)).toBe(true);
  });

  it('keeps recall copies the repository tracks', () => {
    const dir = path.join(sandbox, 'biz');
    const agent = path.join(dir, '.claude', 'agents', 'teamai-recall.md');
    const rule = path.join(dir, '.claude', 'rules', 'teamai-recall.md');
    teamaiOk(['pull'], dir);
    expect(fs.existsSync(agent)).toBe(true);
    expect(fs.existsSync(rule)).toBe(true);
    gitOk(['add', '-f', agent, rule], dir);
    gitOk(['commit', '-q', '-m', 'track recall copies'], dir);

    teamaiOk(['pull'], dir, { TEAMAI_RECALL_DISABLED: '1' });
    expect(fs.existsSync(agent)).toBe(true);
    expect(fs.existsSync(rule)).toBe(true);
  });
});
