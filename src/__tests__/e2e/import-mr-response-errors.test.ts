import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist/index.js');
const URLS = [41, 42].map((n) => `https://github.com/team/repo/pull/${n}`);

describe('import --from-mr with interrupted GitHub responses', () => {
  let sandbox: string;
  let preload: string;

  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mr-response-'));
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: response-errors\nrepo: https://example.com/team.git\nprovider: git\n');
    fs.mkdirSync(path.join(sandbox, '.teamai'));
    fs.writeFileSync(path.join(sandbox, '.teamai/config.yaml'), [
      'repo:', `  localPath: ${JSON.stringify(repo)}`, '  remote: https://example.com/team.git',
      'username: test-user', 'scope: user', '',
    ].join('\n'));
    preload = path.join(sandbox, 'github-fixture.mjs');
    // Only replace the external boundaries: the built CLI reads real HTTP
    // responses, including IncomingMessage's error after a socket closes early.
    fs.writeFileSync(preload, `
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const execSync = childProcess.execSync;
childProcess.execSync = (command, ...args) => {
  if (command.startsWith('gh pr ')) throw new Error('gh unavailable in fixture');
  return execSync(command, ...args);
};
const request = https.request;
https.request = (options, callback) => options.hostname === 'api.github.com'
  ? http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: process.env.FIXTURE_PORT }, callback)
  : request(options, callback);
syncBuiltinESMExports();
`);
  });

  afterAll(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

  it.each(['metadata', 'commits', 'diff'])(
    'reports an interrupted %s response and continues to the next PR', async (endpoint) => {
      const interrupted: string[] = [];
      const server = http.createServer((req, res) => {
        const stage = req.headers.accept?.includes('.diff') ? 'diff'
          : req.url?.includes('/commits?') ? 'commits' : 'metadata';
        if (stage === endpoint) {
          interrupted.push(req.url!);
          res.writeHead(200, { 'Content-Length': '10000' });
          res.write('partial response');
          setImmediate(() => res.destroy());
          return;
        }
        res.end(JSON.stringify(stage === 'metadata'
          ? { title: 'Test PR', body: '', user: { login: 'dev' }, merged_at: null }
          : [{ sha: 'abc123', commit: { message: 'Test commit' } }]));
      });
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
        const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [
            '--import', pathToFileURL(preload).href, CLI, 'import', '--from-mr', ...URLS,
            '--all', '--output', path.join(sandbox, 'output'),
          ], {
            cwd: sandbox,
            env: {
              ...process.env, HOME: sandbox, USERPROFILE: sandbox, FORCE_COLOR: '0',
              GITHUB_TOKEN: '', GH_TOKEN: '', FIXTURE_PORT: String(address.port),
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
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain('Import from MR complete: 0 succeeded, 2 failed');
        for (const url of URLS) expect(result.output).toContain(`import from MR failed: ${url}`);
        expect(result.output).not.toContain("Unhandled 'error' event");
        expect(result.output).not.toContain('AI analysis in progress');
        expect(interrupted).toHaveLength(2);
        expect(fs.existsSync(path.join(sandbox, 'output'))).toBe(false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
      }
    },
  );
});
