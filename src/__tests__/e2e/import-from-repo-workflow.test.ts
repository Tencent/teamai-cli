import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };

const URL_A = 'https://git.example.com/team/svc-a.git';
const URL_B = 'https://git.example.com/team/svc-b.git';
const URL_MISSING = 'https://git.example.com/team/missing.git';

type Ran = { code: number | null; stdout: string; stderr: string };

const sandboxes: string[] = [];
const servers: http.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString().trim();
}

/**
 * A `claude` that answers every prompt an import asks, logging `start <label> <ms>` and `end <label> <ms>`. With
 * FAKE_WAIT=<n> a call waits (up to 5 s) until n calls started; while the file FAKE_HOLD names exists, a call waits.
 */
function fakeClaude(bin: string, log: string): void {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', async () => {
  let label = 'other'; let reply = '# other\\n';
  const comp = /模块: (\\S+)/.exec(stdin); const mod = /模块名: (\\S+)/.exec(stdin);
  if (stdin.includes('codebase.md 技术全景文档')) { label = 'codebase-md'; reply = '# Codebase 概览\\n\\nfixture narrative\\n'; }
  else if (mod) { label = 'module:' + mod[1]; reply = JSON.stringify({ domain: 'kit', responsibilities: ['r1'], layer: 'service', summary: 'does ' + mod[1] }); }
  else if (stdin.includes('判断该仓库整体属于哪个业务域')) { label = 'domain'; reply = JSON.stringify({ domain: 'UI kit', description: 'kit', keywords: ['a', 'b'] }); }
  else if (comp) { label = 'component:' + comp[1]; reply = '# ' + comp[1] + ' doc\\n'; }
  else if (stdin.includes('技术架构总览')) { label = 'architecture'; reply = '# architecture doc\\n'; }
  else if (stdin.includes('sequenceDiagram')) { label = 'g5'; reply = '# g5 doc\\n'; }
  const log = ${JSON.stringify(log)};
  fs.appendFileSync(log, 'start ' + label + ' ' + Date.now() + '\\n');
  const wait = Number(process.env.FAKE_WAIT || 0);
  const until = Date.now() + 5000;
  while (wait > 0 && Date.now() < until && fs.readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('start ')).length < wait) await new Promise((r) => setTimeout(r, 20));
  while (process.env.FAKE_HOLD && fs.existsSync(process.env.FAKE_HOLD)) await new Promise((r) => setTimeout(r, 20));
  fs.appendFileSync(log, 'end ' + label + ' ' + Date.now() + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: reply, usage: { input_tokens: 10, output_tokens: 5 } }));
});\n`, { mode: 0o755 });
}

/** A committed source checkout with two modules. */
function sourceRepo(dir: string, name: string): void {
  for (const mod of ['src', 'lib']) {
    fs.mkdirSync(path.join(dir, mod), { recursive: true });

    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, mod, `${mod}${i}.ts`), `export function ${mod}Alpha${i}(x: number): number { return x + ${i}; }\n`
        + `export function ${mod}Beta${i}(s: string): string { return s + '${name}'; }\nexport class ${mod.toUpperCase()}Thing${i} { run(): void {} }\n`);
    }
  }

  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'seed'], dir);
}

interface Sandbox {
  root: string;
  home: string;
  log: string;
  /** The team repo's bare remote, when the sandbox has a teamai init. */
  remote: string;
  run: (args: string[], options?: { cwd?: string; env?: Record<string, string> }) => Promise<Ran>;
  /** Starts the CLI as `run` does, and gives the process with what it ended with. */
  start: (args: string[], options?: { cwd?: string; env?: Record<string, string> }) => { child: ChildProcess; ran: Promise<Ran> };
}

/**
 * A home with no teamai init, or (`init`) one whose team repo is a local bare remote; two repositories the clone of
 * URL_A and URL_B reaches; a list of URL_A, URL_B and URL_MISSING, whose clone fails; and the fake tool on PATH.
 */
function sandbox({ init = false }: { init?: boolean } = {}): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-workflow-')));
  sandboxes.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gitconfig'), '[gc]\n\tauto = 0\n[user]\n\tname = t\n\temail = t@t\n');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'claude.log');
  fakeClaude(bin, log);
  const a = path.join(root, 'svc-a');
  const b = path.join(root, 'svc-b');
  sourceRepo(a, 'svc-a');
  sourceRepo(b, 'svc-b');
  fs.mkdirSync(path.join(root, 'project'));
  fs.writeFileSync(path.join(root, 'repos.yaml'), `version: 1\nrepos:\n  - url: ${URL_A}\n  - url: ${URL_B}\n  - url: ${URL_MISSING}\n`);
  const remote = path.join(root, 'team.git');
  const teamRepo = path.join(home, '.teamai', 'team-repo');

  if (init) {
    const work = path.join(root, 'team-work');
    git(['init', '-q', '--bare', '-b', 'main', remote], root);
    git(['init', '-q', '-b', 'main', work], root);
    fs.writeFileSync(path.join(work, 'teamai.yaml'), ['team: wiki', 'description: wiki fixture', `repo: ${remote}`, 'provider: git', 'usageReport: false', ''].join('\n'));
    git(['add', '-A'], work);
    git(['commit', '-qm', 'team'], work);
    git(['remote', 'add', 'origin', remote], work);
    git(['push', '-q', 'origin', 'main'], work);
    git(['clone', '-q', remote, teamRepo], root);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${teamRepo}`, `  remote: ${remote}`, '  kind: git',
      'username: alice', 'updatePolicy: auto', 'additionalRoles: []', 'scope: user', '',
    ].join('\n'));
  }

  const env = {
    HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LC_ALL: 'C.UTF-8', FORCE_COLOR: '0', TEAMAI_AI_TOOL: '',
    TEAMAI_CACHE_DIR: path.join(root, 'cache'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'file', ...GIT_ENV,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.file://${a}.insteadOf`, GIT_CONFIG_VALUE_0: URL_A,
    GIT_CONFIG_KEY_1: `url.file://${b}.insteadOf`, GIT_CONFIG_VALUE_1: URL_B,
  };

  const start = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): { child: ChildProcess; ran: Promise<Ran> } => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd ?? path.join(root, 'project'), env: { ...env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    return { child, ran: new Promise((resolve) => { child.on('close', (code) => resolve({ code, stdout, stderr })); }) };
  };

  const run = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Ran> => start(args, options).ran;

  return { root, home, log, remote, run, start };
}

/** The labels of the tool calls in the order they started. */
function calls(log: string): string[] {
  return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('start ')).map((line) => line.split(' ')[1] ?? '');
}

/** stdout with the sandbox, run ids and scratch names replaced, so it compares with the recorded output. */
function normalized(stdout: string, root: string): string[] {
  return stdout.replaceAll(root, '<sb>').replace(/\b[0-9a-f]{8}\b/g, '<sha8>').replace(/  Output: .*\/scratch\/import-\w+\/teamwiki/g, '  Output: <stage>/teamwiki')
    .split('\n').filter((line) => line !== '');
}

describe('teamai import through teamai-import-from-repo', { timeout: 120_000 }, () => {
  it('imports a repository into an --output teamwiki with no teamai init, saying what it always said', async () => {
    const sb = sandbox();

    const ran = await sb.run(['import', '--from-repo', URL_A, '--output', './out']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    // The output recorded before the import was a workflow, with the AI enrich line after the extract summary.
    expect(normalized(ran.stdout, sb.root).filter((line) => !line.includes('Import remote repository') && !line.startsWith('› Repository'))).toEqual([
      'ℹ Importing remote repo: team/svc-a (provider: git)',
      'ℹ Shallow clone to cache: <sb>/cache/git/team/svc-a',
      'ℹ Clone/Fetch complete: SHA=<sha8>, branch=main',
      'ℹ Scanning repository...',
      '  [AST: ast: 18 symbols, 0 imports (0 resolved), 0 calls (0 resolved), 0 edges]',
      '[extract] git__team__svc-a complete',
      '  Files: 6',
      '  Facts: 18 (component:18)',
      '  Graph: 20 nodes, 1 edges',
      '  Output: <stage>/teamwiki',
      'ℹ AI enrich: 2 modules, domain=UI kit',
      'ℹ ✓ teamwiki/ knowledge graph updated: git__team__svc-a',
      'ℹ   reconcile: 0 mappings, 5 gaps, 0 MAPS_TO edges',
      'ℹ deep-enrich[git__team__svc-a]: Starting deep knowledge generation, evidenceDir=<sb>/project/out/teamwiki/evidence/code/git__team__svc-a',
      'ℹ deep-enrich[git__team__svc-a]: Phase 1 — Generating 2 component design docs',
      'ℹ deep-enrich[git__team__svc-a]: Phase 2 — Generating architecture overview',
      'ℹ deep-enrich[git__team__svc-a]: Phase 3 — Generating deterministic graph docs',
      'ℹ deep-enrich[git__team__svc-a]: Phase 4 — Generating AI graph docs (G5/G6)',
      'ℹ deep-enrich[git__team__svc-a]: Phase 5 — Index enhancement',
      '✔ deep-enrich[git__team__svc-a]: Deep knowledge generation complete',
      'ℹ Deep enrich complete: git__team__svc-a',
      'ℹ global graph-index.json aggregated (20 nodes, 1 edges)',
      'ℹ ✓ Repo team/svc-a import complete',
    ]);
    expect(ran.stderr).toBe('');
    const evidence = path.join(sb.root, 'project', 'out', 'teamwiki', 'evidence', 'code', 'git__team__svc-a');
    expect(fs.readFileSync(path.join(evidence, 'overview.md'), 'utf8')).toContain('fixture narrative');
    expect(new Set(calls(sb.log))).toEqual(new Set(['codebase-md', 'module:src', 'module:lib', 'domain', 'component:src', 'component:lib', 'architecture', 'g5']));
    expect(fs.existsSync(path.join(sb.home, '.teamai', 'workflows'))).toBe(false);
  });

  it('imports a local checkout into an --output teamwiki with no teamai init', async () => {
    const sb = sandbox();
    const checkout = path.join(sb.root, 'svc-a');

    const ran = await sb.run(['import', '--dir', '.', '--output', './wiki'], { cwd: checkout });

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toContain(`Scanning local directory: ${checkout} (project: svc-a)`);
    expect(ran.stdout).toContain(`Output written: ${path.join(checkout, 'wiki', 'teamwiki')}`);
    expect(ran.stdout).toContain('Local directory svc-a import complete');
    expect(fs.existsSync(path.join(checkout, 'wiki', 'teamwiki', 'evidence', 'code', 'svc-a', 'docs', 'architecture.md'))).toBe(true);
    expect(git(['status', '--porcelain'], checkout)).toBe('?? wiki/');
  });

  it('imports the rest of a list when one repository fails, sums the batch up, and exits 1', async () => {
    const sb = sandbox();

    const ran = await sb.run(['import', '--from-repo-list', '../repos.yaml', '--output', './out']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(1);
    expect(ran.stdout).toContain(`⚠ import failed: ${URL_MISSING}`);
    expect(ran.stdout).toContain('Batch import complete: 2 succeeded, 1 failed, 0 skipped');
    expect(ran.stderr).toContain('✖ Step "imports[2].stage" failed: command exited with status 1');
    const evidence = path.join(sb.root, 'project', 'out', 'teamwiki', 'evidence', 'code');
    expect(fs.readdirSync(evidence).sort()).toEqual(['git__team__svc-a', 'git__team__svc-b']);
  });

  it('exits 1 from --from-org when one repository of the organization fails', async () => {
    const sb = sandbox();
    const server = http.createServer((req, res) => {
      const page = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('page') ?? '1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(page > 1 ? [] : [URL_A, URL_MISSING].map((url, id) => ({ id, name: path.basename(url, '.git'), path_with_namespace: `g/${path.basename(url, '.git')}`, http_url_to_repo: url }))));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('The GitLab fixture has no port');
    const origin = `http://127.0.0.1:${address.port}`;

    const ran = await sb.run(['import', '--from-org', `${origin}/g`, '--output', './out'], {
      env: { GITLAB_URL: origin, TEAMAI_GITLAB_HOST: `127.0.0.1:${address.port}`, GITLAB_API_PREFIX: 'api/v4', GITLAB_TOKEN: 'fixture-token' },
    });

    expect(ran.code, ran.stdout + ran.stderr).toBe(1);
    expect(ran.stdout).toContain('Batch import complete: 1 succeeded, 1 failed, 0 skipped');
    expect(ran.stdout).toContain(`⚠ import failed: ${URL_MISSING}`);
  });

  it('refuses a second import into a teamwiki another import is writing', async () => {
    const sb = sandbox();
    const hold = path.join(sb.root, 'hold');
    fs.writeFileSync(hold, '');

    const first = sb.run(['import', '--from-repo', URL_A, '--output', './out'], { env: { FAKE_HOLD: hold } });
    await expect.poll(() => fs.existsSync(sb.log) && calls(sb.log).length > 0, { timeout: 60_000 }).toBe(true);
    const second = await sb.run(['import', '--from-repo', URL_B, '--output', './out']);
    fs.rmSync(hold);
    const firstRan = await first;

    expect(second.code, second.stdout + second.stderr).toBe(1);
    expect(second.stdout + second.stderr).toContain('Another teamai import is writing this teamwiki');
    expect(firstRan.code, firstRan.stdout + firstRan.stderr).toBe(0);
    expect(fs.readdirSync(path.join(sb.root, 'project', 'out', 'teamwiki', 'evidence', 'code'))).toEqual(['git__team__svc-a']);
  });

  it('refuses to write the teamwiki from a resumed import while another import holds its lock', async () => {
    const sb = sandbox({ init: true });
    const hold = path.join(sb.root, 'hold');
    fs.writeFileSync(hold, '');
    const first = sb.start(['import', '--from-repo', URL_A], { env: { FAKE_HOLD: hold } });
    await expect.poll(() => fs.existsSync(sb.log) && calls(sb.log).length > 0, { timeout: 60_000 }).toBe(true);
    first.child.kill('SIGKILL');
    await first.ran;
    fs.rmSync(hold);
    const listed = await sb.run(['workflow', 'resume']);
    const run = /teamai workflow resume (r[0-9a-f]{16})/.exec(listed.stdout + listed.stderr)?.[1];
    expect(run, listed.stdout + listed.stderr).toBeDefined();
    const teamRepo = path.join(sb.home, '.teamai', 'team-repo');
    const other = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), teamRepo };
    const lock = path.join(sb.home, '.teamai', 'locks', `import-${createHash('sha256').update(path.resolve(teamRepo)).digest('hex').slice(0, 16)}.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify(other));

    const resumed = await sb.run(['workflow', 'resume', run ?? '']);

    expect(resumed.stdout + resumed.stderr).toContain('Another teamai import is writing this teamwiki');
    expect(fs.existsSync(path.join(teamRepo, 'teamwiki', 'evidence', 'code', 'git__team__svc-a'))).toBe(false);
  });

  it('does not say a branch was pushed when the push to the team repo fails', async () => {
    const sb = sandbox({ init: true });
    const hook = path.join(sb.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "push refused by the fixture" >&2\nexit 1\n', { mode: 0o755 });

    const ran = await sb.run(['import', '--from-repo', URL_A]);

    const output = ran.stdout + ran.stderr;
    // Publishing is non-blocking: the import ends, saying the push failed.
    expect(ran.code, output).toBe(0);
    expect(output).toContain('autoPushViaMR failed (non-blocking)');
    expect(output).not.toContain('Branch pushed');
    expect(output).not.toContain('has been pushed');
  });

  it('says the pull request lines on stderr and the rest on stdout, as the command did before it ran as a workflow', async () => {
    const sb = sandbox({ init: true });

    // The team repo's remote is a local path, so the branch is pushed and no pull request can be opened.
    const ran = await sb.run(['import', '--from-repo', URL_A]);

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    const stderr = ran.stderr.split('\n');
    expect(stderr).toContain('- Creating Pull Request...');
    expect(stderr.some((line) => line.startsWith('✖ Failed to create PR: Invalid Git repo URL'))).toBe(true);
    expect(ran.stdout).not.toContain('Creating Pull Request');
    expect(ran.stdout).not.toContain('Failed to create PR');
    expect(ran.stdout).toMatch(/ℹ Branch teamai\/push\/alice\/\S+ has been pushed\. You can create a PR manually\./);
    expect(ran.stderr).not.toContain('has been pushed');
  });

  it('asks the tool for two repositories at once with --concurrency 2', async () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.root, 'repos.yaml'), `version: 1\nrepos:\n  - url: ${URL_A}\n  - url: ${URL_B}\n`);

    // The first narrative waits until another call started, up to 5 s: it ends once the second began only when they overlap.
    const ran = await sb.run(['import', '--from-repo-list', '../repos.yaml', '--output', './out', '--concurrency', '2'], { env: { FAKE_WAIT: '2' } });

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    const times = fs.readFileSync(sb.log, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' '));
    const at = (event: string, nth: number): number => Number(times.filter(([kind, label]) => kind === event && label === 'codebase-md')[nth]?.[2]);
    expect(at('start', 1)).toBeLessThanOrEqual(at('end', 0));
    expect(at('end', 0) - at('start', 0)).toBeLessThan(4_000);
  });
});
