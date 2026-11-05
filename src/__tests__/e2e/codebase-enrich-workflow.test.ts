import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

type Ran = { code: number | null; stdout: string; stderr: string };

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const fwd = (value: string): string => value.split(path.sep).join('/');

/**
 * A `claude` that logs `start <label>` for each prompt, the module it names or `domain`, and answers as AI enrich
 * asks. It fails the labels in FAKE_FAIL.
 */
function fakeClaude(bin: string, log: string): void {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => {
  const named = /模块名: (\\S+)/.exec(stdin);
  const label = named ? named[1] : stdin.includes('项目名') ? 'domain' : 'other';
  fs.appendFileSync(${JSON.stringify(log)}, 'start ' + label + '\\n');
  if ((process.env.FAKE_FAIL || '').split(',').includes(label)) { process.stderr.write('Authentication failed\\n'); process.exit(2); }
  const reply = label === 'domain'
    ? { domain: 'UI kit', description: 'renders widgets', keywords: ['widget'] }
    : { domain: 'widgets', responsibilities: ['run ' + label], layer: label === 'lib' ? 'data' : 'service', summary: label + ' module' };
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(reply), usage: { input_tokens: 10, output_tokens: 5 } }));
});\n`, { mode: 0o755 });
}

interface Sandbox {
  evidence: string;
  log: string;
  enrich: (extra?: Record<string, string>) => Promise<Ran>;
}

/** An initialized home, and a checkout of two five-class modules that `import --dir --skip-enrich --output` extracted. */
async function sandbox(): Promise<Sandbox> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-enrich-workflow-'));
  sandboxes.push(root);
  const home = path.join(root, 'home');
  const remote = path.join(root, 'team.git');
  const work = path.join(root, 'work');
  const localPath = path.join(home, '.teamai', 'team-repo');
  const code = path.join(root, 'code');
  const out = path.join(root, 'out');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'claude.log');
  fakeClaude(bin, log);

  git(['init', '-q', '--bare', '-b', 'main', remote], root);
  git(['init', '-q', '-b', 'main', work], root);
  fs.writeFileSync(path.join(work, 'teamai.yaml'), ['team: wiki', 'description: wiki fixture', `repo: ${fwd(remote)}`, 'provider: git', 'usageReport: false', ''].join('\n'));
  git(['add', '-A'], work);
  git(['commit', '-qm', 'team'], work);
  git(['remote', 'add', 'origin', remote], work);
  git(['push', '-q', 'origin', 'main'], work);
  git(['clone', '-q', remote, localPath], root);
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
    'repo:', `  localPath: ${fwd(localPath)}`, `  remote: ${fwd(remote)}`, '  kind: git',
    'username: alice', 'updatePolicy: auto', 'additionalRoles: []', 'scope: user', '',
  ].join('\n'));

  const classes = (prefix: string) => Array.from({ length: 5 }, (_, index) => `export class ${prefix}${index} { run() { return ${index}; } }`).join('\n') + '\n';
  fs.mkdirSync(path.join(code, 'src'), { recursive: true });
  fs.writeFileSync(path.join(code, 'src', 'main.ts'), `import { Util0 } from '../lib/main';\n${classes('App')}`);
  fs.mkdirSync(path.join(code, 'lib'));
  fs.writeFileSync(path.join(code, 'lib', 'main.ts'), classes('Util'));
  git(['init', '-q', '-b', 'main'], code);
  git(['add', '-A'], code);
  git(['commit', '-qm', 'code'], code);

  const run = (args: string[], extra: Record<string, string> = {}): Promise<Ran> => new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TEAMAI_AI_TOOL: '', ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: root,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdin.end();
    child.on('close', (exit) => resolve({ code: exit, stdout, stderr }));
  });

  const imported = await run(['import', '--dir', code, '--skip-enrich', '--output', out]);

  if (imported.code !== 0) throw new Error(`import failed: ${imported.stderr}`);
  const wikiRoot = path.join(out, 'teamwiki');

  return {
    evidence: path.join(wikiRoot, 'evidence', 'code', 'code'),
    log,
    enrich: (extra) => run(['workflow', 'start', 'teamai-codebase-enrich', '--driver', 'local', '--inputs', JSON.stringify({ wiki_root: wikiRoot, project: 'code' })], extra),
  };
}

const doneOf = (ran: Ran): { outcome: string; end?: string; outputs: Record<string, unknown> } => {
  const parsed = JSON.parse(ran.stdout) as { data: { done: { outcome: string; end?: string; outputs: Record<string, unknown> } } };

  return parsed.data.done;
};

const asked = (box: Sandbox): string[] => (fs.existsSync(box.log) ? fs.readFileSync(box.log, 'utf8').trim().split('\n') : []).sort();

describe('teamai-codebase-enrich', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  it('asks about each module and the domain, and writes the manifest and domains import publishes', async () => {
    const box = await sandbox();

    const ran = await box.enrich();

    expect(ran.code, ran.stderr).toBe(0);
    expect(doneOf(ran)).toMatchObject({ outcome: 'succeeded', outputs: { modules: 2, domain: 'UI kit' } });
    expect(asked(box)).toEqual(['start domain', 'start lib', 'start src']);
    const manifest = JSON.parse(fs.readFileSync(path.join(box.evidence, '_manifest.json'), 'utf8')) as { components: Array<{ slug: string; category: string }>; edges: Array<{ from: string; to: string }> };
    expect(manifest.components.map((component) => [component.slug, component.category])).toEqual([['lib', 'data'], ['src', 'service']]);
    expect(manifest.edges.map((edge) => [edge.from, edge.to])).toEqual([['src', 'lib']]);
    expect(JSON.parse(fs.readFileSync(path.join(box.evidence, '_domains.json'), 'utf8'))).toEqual({ domain: 'UI kit', description: 'renders widgets', keywords: ['widget'], components: ['lib', 'src'] });
  });

  it('keeps the manifest the extract wrote when the tool fails on a module', async () => {
    const box = await sandbox();
    const before = fs.readFileSync(path.join(box.evidence, '_manifest.json'), 'utf8');

    const ran = await box.enrich({ FAKE_FAIL: 'lib' });

    expect(ran.code, ran.stderr).toBe(0);
    expect(doneOf(ran)).toMatchObject({ outcome: 'succeeded', outputs: { modules: 0, domain: '' } });
    expect(ran.stdout).toContain('enrichWithAI: module analysis failed (non-blocking): 1 AI task(s) failed');
    expect(fs.readFileSync(path.join(box.evidence, '_manifest.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(box.evidence, '_domains.json'))).toBe(false);
  });

  it('fails with nothing asked or written when ai.tool names a tool teamai cannot run', async () => {
    const box = await sandbox();
    const before = fs.readFileSync(path.join(box.evidence, '_manifest.json'), 'utf8');

    const ran = await box.enrich({ TEAMAI_AI_TOOL: 'gemini' });

    expect(ran.code).toBe(1);
    expect(doneOf(ran)).toMatchObject({ outcome: 'failed', end: 'unconfigured-tool' });
    expect(ran.stderr).toContain('failed with tool_unconfigured');
    expect(asked(box)).toEqual([]);
    expect(fs.readFileSync(path.join(box.evidence, '_manifest.json'), 'utf8')).toBe(before);
  });
});
