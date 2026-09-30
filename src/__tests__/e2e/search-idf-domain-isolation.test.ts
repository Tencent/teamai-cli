import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEARCH_INDEX_VERSION } from '../../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEAMAI_CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TEAMAI_CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('recall CLI domain-isolated IDF', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;
  let teamRepo: string;

  beforeAll(() => {
    if (!fs.existsSync(TEAMAI_CLI)) {
      throw new Error(`TeamAI CLI not found at ${TEAMAI_CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-idf-e2e-'));
    homeDir = path.join(sandbox, 'home');
    teamRepo = path.join(sandbox, 'team-repo');
    projectRoot = path.join(sandbox, 'project');
    fs.mkdirSync(path.join(homeDir, '.teamai'), { recursive: true });
    fs.mkdirSync(path.join(teamRepo, 'learnings'), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    fs.writeFileSync(
      path.join(teamRepo, 'teamai.yaml'),
      [
        'team: idf-e2e',
        'description: Local recall IDF verification',
        'repo: https://example.invalid/teamai.git',
        'provider: github',
        'sharing:',
        '  recall:',
        '    enabled: true',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(homeDir, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: '${teamRepo.replace(/\\/g, '/')}'`,
        '  remote: https://example.invalid/teamai.git',
        '  kind: http',
        '  url: https://example.invalid',
        'username: idf-e2e',
        'scope: user',
      ].join('\n'),
    );

    const technical = [
      '---',
      'title: API timeout retry guide',
      'author: test',
      'date: 2026-09-29',
      'tags: [api, typescript, retry]',
      '---',
      '',
      'Technical timeout retry guidance.',
    ].join('\n');
    fs.writeFileSync(path.join(teamRepo, 'learnings', 'technical.md'), technical);

    for (let i = 0; i < 12; i++) {
      const ops = [
        '---',
        `title: Deployment incident runbook ${i}`,
        'author: test',
        'date: 2026-09-29',
        'tags: [deploy, k8s, operations]',
        '---',
        '',
        'Timeout retry operations and infrastructure checklist.',
      ].join('\n');
      fs.writeFileSync(path.join(teamRepo, 'learnings', `ops-${i}.md`), ops);
    }
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('builds isolated IDF stats and keeps technical recall relevant', async () => {
    const indexPath = path.join(homeDir, '.teamai', 'search-index.json');
    fs.writeFileSync(indexPath, JSON.stringify({
      version: SEARCH_INDEX_VERSION - 1,
      builtAt: '2026-09-01T00:00:00Z',
      elapsedMs: 1,
      entries: [],
      df: {},
    }));

    const result = await runCli(
      ['recall', '--check', 'timeout retry api'],
      { HOME: homeDir, USERPROFILE: homeDir },
      projectRoot,
    );

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('RELEVANT');

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      version: number;
      dfByDomain: { technical?: Record<string, number>; ops?: Record<string, number> };
    };
    expect(index.version).toBe(SEARCH_INDEX_VERSION);
    expect(index.dfByDomain.technical?.timeout).toBe(1);
    expect(index.dfByDomain.ops?.timeout).toBe(12);
  }, 30_000);

  it('keeps a relevant technical hit after the raw top-five cutoff', async () => {
    const entry = (filename: string, title: string, domain: 'technical' | 'ops', tokens: string[]) => ({
      filename, title, domain, tokens, author: 'test', date: '2026-09-29',
      tags: [], votes: 0, type: 'learnings',
    });
    const index = {
      version: SEARCH_INDEX_VERSION,
      builtAt: new Date().toISOString(),
      elapsedMs: 0,
      entries: [
        entry('technical.md', 'API Technical Reference', 'technical', ['title:api', 'tag:api', 'api']),
        ...Array.from({ length: 5 }, (_, i) => entry(`ops-hit-${i}.md`, `API Ops ${i}`, 'ops', ['title:api'])),
        ...Array.from({ length: 195 }, (_, i) => entry(`ops-other-${i}.md`, `Ops Other ${i}`, 'ops', [])),
      ],
      df: { 'title:api': 6, 'tag:api': 1, api: 1 },
      dfByDomain: {
        technical: { 'title:api': 1, 'tag:api': 1, api: 1 },
        ops: { 'title:api': 5 },
      },
    };
    fs.writeFileSync(path.join(homeDir, '.teamai', 'search-index.json'), JSON.stringify(index));

    const result = await runCli(['recall', '--check', 'api'], { HOME: homeDir, USERPROFILE: homeDir }, projectRoot);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/^RELEVANT /);
    expect(result.output).toContain('title="API Technical Reference"');
  }, 30_000);
});
