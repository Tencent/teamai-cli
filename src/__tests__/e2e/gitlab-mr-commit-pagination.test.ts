import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist/index.js');
const COMMITS = Array.from({ length: 101 }, (_, i) => ({ id: `sha-${i + 1}`, title: `Change ${i + 1}` }));

describe('import --from-mr with GitLab commit pages', () => {
  let sandbox: string;
  let preload: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitlab-commits-'));
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: pagination\nrepo: https://example.com/team.git\nprovider: git\nlanguage: en\n');
    fs.mkdirSync(path.join(sandbox, '.teamai'));
    fs.writeFileSync(path.join(sandbox, '.teamai/config.yaml'), [
      'repo:', `  localPath: ${JSON.stringify(repo)}`, '  remote: https://example.com/team.git',
      'username: test-user', 'scope: user', '',
    ].join('\n'));
    const ai = path.join(sandbox, 'ai.cjs');
    fs.writeFileSync(ai, `process.stdout.write(${JSON.stringify('---\ntitle: Preserved history\n---\nFixture learning.\n')});\n`);
    preload = path.join(sandbox, 'ai-fixture.mjs');
    fs.writeFileSync(preload, `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (command, args, ...rest) => {
  if ((command === 'where' || command === 'which') && args[0] === 'claude'
    || (command === 'bash' || command === 'zsh') && args[1] === 'command -v claude') return process.execPath;
  return execFileSync(command, args, ...rest);
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === process.execPath && args[0] === '-p') {
    fs.writeFileSync(process.env.PROMPT_FILE, args[1]);
    return spawn(process.execPath, [${JSON.stringify(ai)}], options);
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`);
  });

  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  it.each([false, true])('passes all commits to extraction (second page fails: %s)', async (failSecondPage) => {
    const pages: number[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname.endsWith('/commits')) {
        const page = Number(url.searchParams.get('page') ?? 1);
        pages.push(page);
        if (failSecondPage && page === 2) {
          res.writeHead(429);
          res.end('busy');
          return;
        }
        const start = (page - 1) * 50;
        const batch = COMMITS.slice(start, start + 50);
        if (start + 50 < COMMITS.length) res.setHeader('x-next-page', String(page + 1));
        res.end(JSON.stringify(batch));
      } else if (url.pathname.endsWith('/changes')) {
        res.end(JSON.stringify({ changes: [{ diff: '+fixed' }] }));
      } else if (url.pathname.endsWith('/7')) {
        res.end(JSON.stringify({ title: 'Preserved history', description: '', author: { username: 'dev' }, merged_at: null }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const promptFile = path.join(sandbox, 'prompt.txt');
      const outputDir = path.join(sandbox, 'output');
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          '--import', pathToFileURL(preload).href, CLI, 'import', '--from-mr', `${origin}/group/repo/-/merge_requests/7`,
          '--all', '--no-discussions', '--output', outputDir,
        ], {
          cwd: sandbox,
          env: {
            ...process.env, HOME: sandbox, USERPROFILE: sandbox, FORCE_COLOR: '0',
            GITLAB_URL: origin, TEAMAI_GITLAB_HOST: `127.0.0.1:${address.port}`,
            GITLAB_API_PREFIX: 'api/v4', GITLAB_TOKEN: 'fixture-token', PROMPT_FILE: promptFile,
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
      expect(result.code, result.output).toBe(0);
      expect(pages).toEqual(failSecondPage ? [1, 2] : [1, 2, 3]);
      const prompt = fs.readFileSync(promptFile, 'utf8');
      if (failSecondPage) {
        expect(prompt).not.toContain('Change 1');
        expect(prompt).not.toContain('Change 51');
      } else {
        expect(prompt.match(/^- [^:]+: Change \d+$/gm)).toHaveLength(101);
        expect(prompt).toContain('Change 51');
        expect(prompt).toContain('Change 101');
      }
      expect(fs.readFileSync(path.join(outputDir, 'learning.md'), 'utf8')).toContain('Fixture learning.');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  });
});
