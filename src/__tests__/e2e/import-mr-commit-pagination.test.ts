import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist/index.js');
const PR = '/repos/team/repo/pulls/42';
const COMMITS = Array.from({ length: 101 }, (_, i) => ({
  sha: `commit-${i + 1}`, commit: { message: `Change ${i + 1}\n\nDetails` },
}));

describe('import --from-mr with paginated GitHub commits', () => {
  let sandbox: string;
  let preload: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mr-commits-'));
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: pagination\nrepo: https://example.com/team.git\nprovider: git\nlanguage: en\n');
    fs.mkdirSync(path.join(sandbox, '.teamai'));
    fs.writeFileSync(path.join(sandbox, '.teamai/config.yaml'), [
      'repo:', `  localPath: ${JSON.stringify(repo)}`, '  remote: https://example.com/team.git',
      'username: test-user', 'scope: user', '',
    ].join('\n'));
    const ai = path.join(sandbox, 'ai.cjs');
    // Answers as `claude -p --output-format json` does: the prompt on stdin, the reply in a result record.
    fs.writeFileSync(ai, `let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  require('node:fs').writeFileSync(process.env.PROMPT_FILE, prompt);
  process.stdout.write(JSON.stringify({ type: 'result', result: ${JSON.stringify('---\ntitle: Preserved history\n---\nFixture learning.\n')} }));
});
`);
    preload = path.join(sandbox, 'github-fixture.mjs');
    // External boundaries only: actual HTTP responses and the packaged CLI's
    // extraction prompt, with a deterministic subprocess replacing the AI CLI.
    fs.writeFileSync(preload, `
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (command, args, ...rest) => {
  const tool = command === 'where' ? args[0].replace(/^\\$PATH:/, '')
    : command === 'which' ? args[0] : args.at(-1);
  if (tool === 'gh') {
    if (process.env.USE_GH !== '1') throw new Error('gh unavailable in fixture');
    return process.execPath;
  }
  if (tool === 'claude') return process.execPath;
  return execFileSync(command, args, ...rest);
};
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (command !== process.execPath || !['pr', 'api'].includes(args[0])) return spawnSync(command, args, options);
  const commits = ${JSON.stringify(COMMITS)};
  let stdout;
  if (args[0] === 'pr' && args[1] === 'view') stdout = JSON.stringify({
    title: 'Preserved history', body: '', author: { login: 'dev' }, mergedAt: null,
    commits: commits.slice(0, 100).map((c) => ({ oid: c.sha, messageHeadline: c.commit.message.split('\\n')[0] })),
  });
  else if (args[0] === 'pr' && args[1] === 'diff') stdout = 'diff --git a/a b/a\\n+fixed\\n';
  else if (args[0] === 'api') {
    const page = Number(new URL(args[1], 'https://api.github.com').searchParams.get('page'));
    fs.appendFileSync(process.env.GH_PAGES_FILE, page + '\\n');
    if (process.env.FAIL_SECOND_PAGE === '1' && page === 2) return { status: 1, stdout: '', stderr: 'HTTP 429' };
    stdout = JSON.stringify(commits.slice((page - 1) * 100, page * 100));
  } else throw new Error('Unexpected gh call: ' + args);
  return { status: 0, stdout, stderr: '' };
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === process.execPath && args[0] === '-p') return spawn(process.execPath, [${JSON.stringify(ai)}], options);
  return spawn(command, args, options);
};
const request = https.request;
https.request = (options, callback) => options.hostname === 'api.github.com'
  ? http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: process.env.FIXTURE_PORT }, callback)
  : request(options, callback);
syncBuiltinESMExports();
`);
  });

  afterEach(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

  it.each([[false, false], [false, true], [true, false], [true, true]])('reads later commits before extraction (gh: %s, second page fails: %s)', async (useGh, failSecondPage) => {
    const pages: number[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === `${PR}/commits`) {
        const page = Number(url.searchParams.get('page') ?? 1);
        const size = Number(url.searchParams.get('per_page'));
        pages.push(page);
        if (failSecondPage && page === 2) {
          res.writeHead(429);
          res.end(JSON.stringify({ message: 'Too many requests' }));
        } else {
          res.end(JSON.stringify(COMMITS.slice((page - 1) * size, page * size)));
        }
      } else if (req.headers.accept?.includes('.diff')) {
        res.end('diff --git a/a b/a\n+fixed\n');
      } else if (url.pathname === PR) {
        res.end(JSON.stringify({ title: 'Preserved history', body: '', user: { login: 'dev' }, merged_at: null }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const promptFile = path.join(sandbox, 'prompt.txt');
      const ghPagesFile = path.join(sandbox, 'gh-pages.txt');
      const outputDir = path.join(sandbox, 'output');
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          CLI, 'import', '--from-mr', 'https://github.com/team/repo/pull/42',
          '--all', '--no-discussions', '--output', outputDir,
        ], {
          cwd: sandbox,
          env: {
            ...process.env, HOME: sandbox, USERPROFILE: sandbox, FORCE_COLOR: '0',
            GITHUB_TOKEN: '', GH_TOKEN: '', FIXTURE_PORT: String(address.port), PROMPT_FILE: promptFile,
            USE_GH: useGh ? '1' : '0', GH_PAGES_FILE: ghPagesFile, FAIL_SECOND_PAGE: failSecondPage ? '1' : '0',
            // Each step of the run is a process of its own, which loads the fixture too.
            NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${output}`)); }, 20_000);
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
      });
      expect(result.code, result.output).toBe(failSecondPage ? 1 : 0);
      expect(pages).toEqual(useGh && !failSecondPage ? [] : [1, 2]);
      if (useGh) expect(fs.readFileSync(ghPagesFile, 'utf8')).toBe('1\n2\n');
      if (failSecondPage) {
        expect(result.output).toContain('GitHub API error 429');
        expect(fs.existsSync(promptFile)).toBe(false);
        expect(fs.existsSync(outputDir)).toBe(false);
      } else {
        const prompt = fs.readFileSync(promptFile, 'utf8');
        expect(prompt.match(/^- [^:]+: Change \d+$/gm)).toHaveLength(101);
        expect(prompt).toContain('Change 51');
        expect(prompt).toContain('Change 101');
        expect(fs.readFileSync(path.join(outputDir, 'learning.md'), 'utf8')).toContain('Fixture learning.');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  });
});
