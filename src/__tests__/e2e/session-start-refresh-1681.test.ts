import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
let sandbox: string;
let attempt = 0;
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

function machine() {
  const root = path.join(sandbox, String(++attempt));
  const home = path.join(root, 'home');
  const data = path.join(home, '.teamai');
  const clone = path.join(data, 'team-repo');
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  const cwd = path.join(root, 'app');
  const gate = path.join(root, 'gate');
  const entered = path.join(root, 'entered');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const git = (args: string[], dir = seed) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  write(path.join(seed, 'teamai.yaml'), YAML.stringify({
    team: 'refresh', repo: remote, provider: 'git', autoUpdate: false, usageReport: false,
    scripts: { prePull: { path: 'pre-pull.mjs' } },
  }));
  write(path.join(seed, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: Refresh fixture\n---\nHello.\n');
  write(path.join(seed, 'pre-pull.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(entered)}, 'entered');\nwhile (fs.existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 20));\n`);
  write(path.join(home, '.gitconfig'), '[user]\nname = Fixture\nemail = fixture@example.invalid\n[gc]\nauto = 0\n[maintenance]\nauto = false\n');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(cwd);
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
  git(['clone', '-q', '--bare', seed, remote]);
  git(['clone', '-q', remote, clone]);
  const config = { repo: { localPath: clone, remote }, username: 'fixture', scope: 'user', enabledAgents: ['claude'], updatePolicy: 'skip' };
  const configFile = path.join(data, 'config.yaml');
  write(configFile, YAML.stringify(config));
  let calls = 0;
  const hookArgs = ['hook-dispatch', 'session-start', '--tool', 'claude', '--bg-only'];
  function invocation(args: string[], dir = cwd) {
    const trace = path.join(root, `trace-${++calls}.jsonl`);
    return { args: [CLI, ...args], env: { ...env, GIT_TRACE2_EVENT: trace }, trace, input: JSON.stringify({ cwd: dir, session_id: `repro-${calls}` }) };
  }
  function pullCount(trace: string): number {
    return fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter((event) => event.event === 'start' && event.argv?.includes('pull')).length;
  }
  function run(args = hookArgs, dir = cwd) {
    const call = invocation(args, dir);
    const r = spawnSync(process.execPath, call.args, { cwd: dir, env: call.env, input: call.input, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    return pullCount(call.trace);
  }
  function start() {
    const call = invocation(hookArgs);
    const child = spawn(process.execPath, call.args, { cwd, env: call.env, stdio: ['pipe', 'ignore', 'ignore'] });
    const done = new Promise<number>((resolve, reject) => {
      child.on('error', reject).on('close', (code) => {
        if (code === 0) resolve(pullCount(call.trace));
        else reject(new Error(`session-start exited ${code}`));
      });
    });
    child.stdin.end(call.input);
    return done;
  }
  const stamp = path.join(data, 'last-fetch.json');
  const age = () => write(stamp, JSON.stringify({ lastFetch: new Date(Date.now() - 61_000).toISOString() }));
  return { root, home, cwd, remote, clone, gate, entered, config, configFile, stamp, age, run, start, git };
}

beforeAll(() => { sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-refresh-e2e-'))); });
afterAll(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('session-start refresh cooldown (#1681)', () => {
  it('reuses one refresh across three starts and still delivers to a newly enabled tool', () => {
    const m = machine();
    expect(m.run(['pull'])).toBe(1);
    const stamp = fs.readFileSync(m.stamp, 'utf8');
    expect([m.run(), m.run(), m.run()]).toEqual([0, 0, 0]);
    expect(fs.readFileSync(m.stamp, 'utf8')).toBe(stamp);

    fs.mkdirSync(path.join(m.home, '.cursor'));
    m.config.enabledAgents.push('cursor');
    write(m.configFile, YAML.stringify(m.config));
    expect(m.run()).toBe(0);
    expect(fs.readFileSync(path.join(m.home, '.cursor/skills/hello/SKILL.md'), 'utf8')).toContain('Hello.');
  });

  it('delivers a new hookless checkout from the recent clone, and keeps explicit ref pulls fresh', () => {
    const m = machine();
    const url = 'https://git.example.com/team/checkout.git';
    m.git(['config', '--global', `url.${m.remote}.insteadOf`, url]);
    write(path.join(m.cwd, 'README.md'), 'app\n');
    m.git(['init', '-q', '-b', 'main'], m.cwd);
    m.git(['add', '-A'], m.cwd);
    m.git(['commit', '-q', '-m', 'app'], m.cwd);
    fs.rmSync(m.configFile);
    m.run(['init', url, '--provider', 'git', '--scope', 'workspace', '--agent', 'claude', '--force']);
    m.run(['pull']);
    expect(m.run(['pull', '--team-ref', 'main'])).toBe(1);

    const checkout = path.join(m.root, 'new-checkout');
    m.git(['worktree', 'add', '-q', '--no-checkout', '--detach', checkout, 'HEAD'], m.cwd);
    m.git(['reset', '-q', '--hard'], checkout);
    expect(fs.existsSync(path.join(checkout, '.claude/skills/hello/SKILL.md'))).toBe(false);
    expect(m.run(undefined, checkout)).toBe(0);
    expect(fs.readFileSync(path.join(checkout, '.claude/skills/hello/SKILL.md'), 'utf8')).toContain('Hello.');
  });

  it('refreshes after expiry and on manual and forced pulls', () => {
    const m = machine();
    expect(m.run()).toBe(1);
    m.age();
    expect(m.run()).toBe(1);
    expect(m.run(['pull'])).toBe(1);
    expect(m.run(['pull', '--force'])).toBe(1);
    expect(m.run()).toBe(0);
  });

  it('retries a failed refresh and does not share freshness with another repository', () => {
    const m = machine();
    expect(m.run()).toBe(1);
    m.age();
    const aged = fs.readFileSync(m.stamp, 'utf8');
    fs.renameSync(m.remote, `${m.remote}.away`);
    try {
      m.run();
      expect(fs.readFileSync(m.stamp, 'utf8')).toBe(aged);
    } finally {
      fs.renameSync(`${m.remote}.away`, m.remote);
    }
    expect(m.run()).toBe(1);
    expect(machine().run()).toBe(1);
  });

  it('waits for the in-flight refresh and reuses it after taking the same scope lock', async () => {
    const m = machine();
    write(m.gate, 'hold prePull under the sync lock');
    const first = m.start();
    let second: Promise<number> | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(m.entered) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(m.entered)).toBe(true);
      second = m.start();
      // Give the second dispatcher time to reach the lock while the first holds it.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      fs.rmSync(m.gate, { force: true });
      await Promise.all([first, second]);
    }
    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(m.run()).toBe(0);
    expect(fs.existsSync(path.join(m.home, '.claude/skills/hello/SKILL.md'))).toBe(true);
  });
});
