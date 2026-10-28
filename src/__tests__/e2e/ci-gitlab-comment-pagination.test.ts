import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

describe('ci extract-mr GitLab comment pagination (real CLI)', () => {
  it.each([true, false])('handles an MR with more than 20 note pages (marker present: %s)', async (markerPresent) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ci-notes-'));
    const pages: number[] = [];
    const writes: string[] = [];
    let updatedBody = '';
    const notes = Array.from({ length: 2_500 }, (_, i) => ({
      id: 100 + i,
      body: `chat ${i}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString(),
      updated_at: new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString(),
    }));
    if (markerPresent) {
      // Editing the original pipeline's comment does not change created_at.
      for (const [index, id] of [9, 8].entries()) {
        notes[index] = { ...notes[index], id, body: '<!-- teamai:ci-extract -->\nold content',
          updated_at: new Date(Date.UTC(2026, 9, 26) - index * 1_000).toISOString() };
      }
    }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'PUT' && url.pathname.endsWith('/notes/9')) {
        writes.push('PUT');
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => { updatedBody += chunk; });
        req.on('end', () => { res.end('{}'); });
      } else if (req.method !== 'GET') {
        writes.push(req.method!);
        res.writeHead(500).end('{}');
      } else if (url.pathname.endsWith('/notes')) {
        const page = Number(url.searchParams.get('page'));
        pages.push(page);
        const orderBy = url.searchParams.get('order_by') === 'updated_at' ? 'updated_at' : 'created_at';
        const direction = url.searchParams.get('sort') === 'asc' ? 1 : -1;
        const sorted = [...notes].sort((a, b) => direction * a[orderBy].localeCompare(b[orderBy]));
        if (page * 100 < notes.length) res.setHeader('x-next-page', String(page + 1));
        res.end(JSON.stringify(sorted.slice((page - 1) * 100, page * 100)));
      } else if (url.pathname.endsWith('/commits')) res.end('[]');
      else if (url.pathname.endsWith('/changes')) res.end('{"changes":[]}');
      else if (url.pathname.endsWith('/7')) {
        res.end(JSON.stringify({ title: 'Pagination', description: '', author: { username: 'dev' } }));
      } else res.writeHead(404).end('{}');
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const ai = path.join(sandbox, 'ai.cjs');
      // Answers as `claude -p --output-format json` does: a result record on stdout.
      fs.writeFileSync(ai, `process.stdout.write(JSON.stringify({ type: 'result', result: '---\\ntitle: Pagination\\n---\\nFixture learning.' }));\n`);
      const preload = path.join(sandbox, 'ai-fixture.mjs');
      // Replace only AI discovery and launch; GitLab HTTP and comment writes
      // run through the built CLI against the local API fixture.
      fs.writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (command, args, ...rest) => {
  if ((command === 'where' || command === 'which') && args[0] === 'claude'
    || (command === 'bash' || command === 'zsh') && args[1] === 'command -v claude') return process.execPath;
  return execFileSync(command, args, ...rest);
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => command === process.execPath && args[0] === '-p'
  ? spawn(process.execPath, [${JSON.stringify(ai)}], options)
  : spawn(command, args, options);
syncBuiltinESMExports();
`);
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          '--import', pathToFileURL(preload).href, CLI, 'ci', 'extract-mr',
          '--url', `${origin}/group/repo/-/merge_requests/7`, '--mode', 'comment', '--no-discussions',
        ], {
          cwd: sandbox,
          env: {
            ...process.env, HOME: sandbox, USERPROFILE: sandbox, FORCE_COLOR: '0',
            GITLAB_URL: origin, TEAMAI_GITLAB_HOST: `127.0.0.1:${address.port}`,
            GITLAB_API_PREFIX: 'api/v4', GITLAB_TOKEN: 'fixture-token',
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
      if (markerPresent) {
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('MR comment updated');
        expect(pages).toEqual([1]);
        expect(writes).toEqual(['PUT']);
        expect(JSON.parse(updatedBody).body).toContain('Fixture learning.');
      } else {
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain('GitLab note list has more than 20 pages');
        expect(pages).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
        expect(writes).toEqual([]);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
