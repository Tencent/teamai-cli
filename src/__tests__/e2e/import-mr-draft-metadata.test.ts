import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
const drafts = [
  '---\ntitle: Retry budget\ntags: agent\n---\nKeep the retry budget in one place.',
  '---\ntitle: Backoff\ntags: [agent, retry]\n---\nApply backoff after throttling.',
];

describe('import --from-mr AI draft metadata (real CLI)', () => {
  it('saves a draft with scalar tags and the next normal draft without changing their contents', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mr-metadata-'));
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const number = req.url!.match(/merge_requests\/(\d+)/)?.[1];
      res.end(JSON.stringify(req.url!.includes('/commits?') ? []
        : req.url!.endsWith('/changes') ? { changes: [] }
        : { title: `MR ${number}`, description: '', author: { username: 'dev' } }));
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const repo = path.join(sandbox, 'repo');
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: draft-metadata\nrepo: https://example.com/team.git\nprovider: git\nlanguage: en\n');
      fs.mkdirSync(path.join(sandbox, '.teamai'));
      fs.writeFileSync(path.join(sandbox, '.teamai/config.yaml'), [
        'repo:', `  localPath: ${JSON.stringify(repo)}`, '  remote: https://example.com/team.git',
        'username: test-user', 'scope: user', '',
      ].join('\n'));
      const ai = path.join(sandbox, 'ai.cjs');
      // Answers as `claude -p --output-format json` does: the prompt on stdin, the reply in a result record.
      fs.writeFileSync(ai, `const drafts = ${JSON.stringify(drafts)};
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', result: drafts[prompt.includes('MR 1') ? 0 : 1] }));
});
`);
      const preload = path.join(sandbox, 'ai-fixture.mjs');
      // Replace only AI CLI discovery and launch. MR fetching, parsing and file
      // writes run through the built CLI, with real local HTTP responses.
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
      const outputDir = path.join(sandbox, 'output');
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          '--import', pathToFileURL(preload).href, CLI, 'import', '--from-mr',
          ...[1, 2].map((number) => `${origin}/group/repo/-/merge_requests/${number}`),
          '--all', '--no-discussions', '--output', outputDir,
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
        const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI did not finish: ${output}`)); }, 20_000);
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
      });
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('Import from MR complete: 2 succeeded, 0 failed');
      for (const [index, draft] of drafts.entries()) {
        expect(fs.readFileSync(path.join(outputDir, `learning-${index + 1}.md`), 'utf8')).toBe(draft);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
