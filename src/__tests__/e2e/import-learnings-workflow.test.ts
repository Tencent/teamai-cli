import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { hasPython, TYPED_TERMINAL } from '../helpers/in-terminal.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };

const TODAY = new Date().toISOString().slice(0, 10);

type Ran = { code: number | null; stdout: string; stderr: string };

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString().trim();
}

/**
 * A `claude` that classifies a file by the `MARK-<kind>` it holds (rule, doc, personal, learn), logging each kind it
 * was asked about, and answers the iWiki dual prompt with two sections. FAKE_FAIL=<kind> fails that file's call.
 */
function fakeClaude(bin: string, log: string): void {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => {
  if (stdin.includes('三类知识')) {
    fs.appendFileSync(${JSON.stringify(log)}, 'dual\\n');
    const sections = JSON.stringify({ 'business-api': '| orders | GET /api/v1/orders |', 'external-knowledge': 'Payments live in the billing system.', glossary: '' });
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: sections, usage: { input_tokens: 10, output_tokens: 5 } }));
    return;
  }
  const marker = /MARK-(\\w+)/.exec(stdin);
  const kind = marker ? marker[1] : 'other';
  const kinds = { rule: ['rule', 'Deploy rule', false], doc: ['doc', 'API guide', false], personal: ['learning', 'My env', true], learn: ['learning', 'Retry lesson', false] };
  const [type, title, isPersonal] = kinds[kind] || ['learning', 'Other', false];
  fs.appendFileSync(${JSON.stringify(log)}, kind + '\\n');
  if (process.env.FAKE_FAIL === kind) { process.stderr.write('Authentication failed\\n'); process.exit(2); }
  const reply = JSON.stringify({ type, title, summary: 'Summary of ' + title, tags: ['t1', 't2'], confidence: 0.9, isPersonal });
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: reply, usage: { input_tokens: 10, output_tokens: 5 } }));
});\n`, { mode: 0o755 });
}

interface Sandbox {
  root: string;
  home: string;
  teamRepo: string;
  remote: string;
  log: string;
  env: Record<string, string>;
  run: (args: string[], options?: { env?: Record<string, string>; cwd?: string }) => Promise<Ran>;
}

/** A member with a teamai init whose team repo has a local bare remote, Claude rules in ~/.claude/rules, and the fake tool on PATH. */
function sandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-learnings-')));
  sandboxes.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gitconfig'), '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n[user]\n\tname = t\n\temail = t@t\n');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'claude.log');
  fakeClaude(bin, log);
  const rules = path.join(home, '.claude', 'rules');
  fs.mkdirSync(path.join(rules, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(rules, 'deploy.md'), '# Deploy\nMARK-rule Always deploy on weekdays.\n');
  fs.writeFileSync(path.join(rules, 'ops', 'api.md'), '# API\nMARK-doc The orders API.\n');
  fs.writeFileSync(path.join(rules, 'mine.md'), '# Mine\nMARK-personal my token lives in ~/x.\n');
  const remote = path.join(root, 'team.git');
  const work = path.join(root, 'team-work');
  const teamRepo = path.join(home, '.teamai', 'team-repo');
  git(['init', '-q', '--bare', '-b', 'main', remote], root);
  git(['init', '-q', '-b', 'main', work], root);
  fs.writeFileSync(path.join(work, 'teamai.yaml'), ['team: wiki', 'description: import fixture', `repo: ${remote}`, 'provider: git', 'usageReport: false', ''].join('\n'));
  git(['add', '-A'], work);
  git(['commit', '-qm', 'team'], work);
  git(['remote', 'add', 'origin', remote], work);
  git(['push', '-q', 'origin', 'main'], work);
  git(['clone', '-q', remote, teamRepo], root);
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
    'repo:', `  localPath: ${teamRepo}`, `  remote: ${remote}`, '  kind: git',
    'username: alice', 'updatePolicy: auto', 'additionalRoles: []', 'scope: user', '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'project'));

  const env = {
    HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LC_ALL: 'C.UTF-8', FORCE_COLOR: '0', TEAMAI_AI_TOOL: '',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_ENV,
  };

  const run = (args: string[], options: { env?: Record<string, string>; cwd?: string } = {}): Promise<Ran> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd ?? path.join(root, 'project'), env: { ...env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  return { root, home, teamRepo, remote, log, env, run };
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; !check(); waited += 50) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return true;
}

/**
 * Points the iWiki client's MCP requests at a local server: loaded with `node --import`, it sends what the client asks
 * prod.mcp.it.woa.com to FAKE_IWIKI_PORT.
 */
const IWIKI_REDIRECT = `import http from 'node:http';
import https from 'node:https';
const original = https.request;
https.request = function (options, callback) {
  if (options && options.hostname === 'prod.mcp.it.woa.com') return http.request({ ...options, hostname: '127.0.0.1', port: Number(process.env.FAKE_IWIKI_PORT), protocol: 'http:' }, callback);
  return original.apply(this, arguments);
};
`;

/** An iWiki whose space 900 holds a deploy rule (901) and an API guide (902), answering as its MCP server does. */
async function fakeIwiki(): Promise<{ server: http.Server; port: string }> {
  const pages: Record<string, [string, string]> = { 901: ['Deploy rules', '# Deploy\nMARK-rule Always deploy with deployService.'], 902: ['API guide', '# API\nMARK-doc /api/v1/orders returns orders.'] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const rpc = JSON.parse(body) as { id: number; params: { name: string; arguments: { parentid?: string; docid?: string } } };
      const { name, arguments: args } = rpc.params;
      const page = pages[String(args.docid)];
      const text = name === 'getSpacePageTree'
        ? JSON.stringify(args.parentid === '900' ? [{ docid: 901, title: 'Deploy rules' }, { docid: 902, title: 'API guide' }] : [])
        : name === 'metadata' ? JSON.stringify({ title: page?.[0] ?? '' }) : page?.[1] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text }] } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();

  if (address === null || typeof address === 'string') throw new Error(`The fake iWiki listens on ${String(address)}, not a TCP port.`);

  return { server, port: String(address.port) };
}

/** The driver's question for each choice, as the local driver prints it. */
const CHOICE_PROMPT = 'Choice, followed by an optional note: ';

/** The lines of `text` with the sandbox and run ids replaced, as the command printed them. */
function lines(text: string, root: string): string[] {
  return text.replaceAll(root, '<sb>').replace(/\br[0-9a-f]{16}\b/g, '<run>').split('\n').filter((line) => line !== '');
}

/** The subject of the newest commit on the team repo's main branch, and the files it changed. */
function published(sb: Sandbox): { subject: string; files: string[] } {
  return {
    subject: git(['log', '-1', '--format=%s', 'main'], sb.remote),
    files: git(['show', '--name-only', '--format=', 'main'], sb.remote).split('\n').filter(Boolean),
  };
}

describe('teamai import of rules and learnings through teamai-import-rules', { timeout: 120_000 }, () => {
  it('imports Claude\'s rules with --from-claude --all, saying what it said before, each in the directory of its type', async () => {
    const sb = sandbox();

    const ran = await sb.run(['import', '--from-claude', '--all']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(lines(ran.stdout, sb.root)).toEqual([
      `ℹ Wrote: <sb>/home/.teamai/team-repo/rules/${TODAY}-deploy-rule.md`,
      `ℹ Wrote: <sb>/home/.teamai/team-repo/docs/${TODAY}-api-guide.md`,
      '✔ Import complete',
    ]);
    // The run ended, so there is nothing to continue.
    expect(lines(ran.stderr, sb.root)).toEqual([]);
    expect(published(sb)).toEqual({ subject: '[teamai] Import from local: tool rules', files: [`docs/${TODAY}-api-guide.md`, `rules/${TODAY}-deploy-rule.md`] });
    expect(fs.readFileSync(path.join(sb.teamRepo, 'rules', `${TODAY}-deploy-rule.md`), 'utf8')).toBe([
      '---', 'title: "Deploy rule"', 'type: rule', 'author: import', `date: ${TODAY}`, 'tags: ["t1", "t2"]', '---', '', 'Summary of Deploy rule', '',
    ].join('\n'));
    expect(fs.readFileSync(sb.log, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['doc', 'personal', 'rule']);
  });

  it('imports the rules of every tool with --from-tools: Claude\'s and CodeBuddy\'s', async () => {
    const sb = sandbox();
    fs.mkdirSync(path.join(sb.home, '.codebuddy', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(sb.home, '.codebuddy', 'rules', 'retry.md'), 'MARK-learn Retry a flaky deploy twice.\n');

    const ran = await sb.run(['import', '--from-tools', '--all']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(lines(ran.stdout, sb.root)).toEqual([
      `ℹ Wrote: <sb>/home/.teamai/team-repo/rules/${TODAY}-deploy-rule.md`,
      `ℹ Wrote: <sb>/home/.teamai/team-repo/docs/${TODAY}-api-guide.md`,
      `ℹ Wrote: <sb>/home/.teamai/team-repo/learnings/${TODAY}-retry-lesson.md`,
      '✔ Import complete',
    ]);
    expect(published(sb).files).toEqual([`docs/${TODAY}-api-guide.md`, `learnings/${TODAY}-retry-lesson.md`, `rules/${TODAY}-deploy-rule.md`]);
  });

  it('publishes the rules it imports when run from inside the team checkout, and leaves that checkout clean', async () => {
    const sb = sandbox();

    const ran = await sb.run(['import', '--from-tools', '--all'], { cwd: sb.teamRepo });

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(lines(ran.stderr, sb.root)).toEqual([]);
    expect(published(sb).files).toEqual([`docs/${TODAY}-api-guide.md`, `rules/${TODAY}-deploy-rule.md`]);
    expect(git(['status', '--porcelain'], sb.teamRepo)).toBe('');
    expect(git(['rev-parse', 'HEAD'], sb.teamRepo)).toBe(git(['rev-parse', 'main'], sb.remote));
  });

  it('fails with exit 1 and writes nothing when the AI tool cannot classify a file', async () => {
    const sb = sandbox();
    const before = git(['rev-parse', 'main'], sb.remote);

    const ran = await sb.run(['import', '--from-claude', '--all'], { env: { FAKE_FAIL: 'doc' } });

    expect(ran.code, ran.stdout + ran.stderr).toBe(1);
    expect(ran.stderr).toMatch(/✖ Step "learnings\.classify\[\d\]\.ask" failed/);
    expect(ran.stdout).not.toContain('Import complete');
    expect(fs.readdirSync(sb.teamRepo).sort()).toEqual(['.git', 'teamai.yaml']);
    expect(git(['rev-parse', 'main'], sb.remote)).toBe(before);
  });

  it('refuses, before any AI call, an import whose review nobody can answer, and says how to run it', async () => {
    const sb = sandbox();

    const ran = await sb.run(['import', '--from-claude']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(1);
    expect(lines(ran.stderr, sb.root)).toEqual([
      '✖ This import asks a person to accept, edit or skip each item it found, and nobody can answer here: it runs inside a workflow step, or its input is not a terminal. Run it in your own terminal, or pass --all to accept every item.',
    ]);
    expect(fs.existsSync(sb.log)).toBe(false);
  });

  it('fails a workflow step that runs the import without --all, saying how to run it, and asks no AI tool', async () => {
    const sb = sandbox();
    const workflows = path.join(sb.teamRepo, 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'nightly-import.yaml'), [
      'schemaVersion: v1alpha1', 'name: nightly-import', 'description: Imports the tool rules.', 'steps:', '  - id: import', '    command: teamai import --from-tools', '',
    ].join('\n'));
    fs.writeFileSync(path.join(sb.root, 'bin', 'teamai'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
    git(['add', '-A'], sb.teamRepo);
    git(['commit', '-qm', 'nightly import'], sb.teamRepo);
    git(['push', '-q', 'origin', 'main'], sb.teamRepo);
    const pulled = await sb.run(['pull']);
    expect(pulled.code, pulled.stdout + pulled.stderr).toBe(0);

    const ran = await sb.run(['workflow', 'start', 'nightly-import', '--driver', 'local']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(1);
    expect(ran.stdout + ran.stderr).toContain('nobody can answer here: it runs inside a workflow step, or its input is not a terminal. Run it in your own terminal, or pass --all to accept every item.');
    expect(fs.existsSync(sb.log)).toBe(false);
  });

  it.skipIf(!hasPython)('asks a person in a terminal to accept, edit or skip each item, and writes what they chose', async () => {
    const sb = sandbox();
    fs.mkdirSync(path.join(sb.home, '.codebuddy', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(sb.home, '.codebuddy', 'rules', 'retry.md'), 'MARK-learn Retry a flaky deploy twice.\n');
    const [pid, output, input] = ['terminal.pid', 'terminal.out', 'terminal.in'].map((file) => path.join(sb.root, file)) as [string, string, string];
    const printed = (): string => (fs.existsSync(output) ? fs.readFileSync(output, 'utf8').replaceAll('\r', '') : '');
    const terminal = spawn('python3', ['-c', TYPED_TERMINAL, pid, output, input, process.execPath, CLI, 'import', '--from-tools'], {
      cwd: path.join(sb.root, 'project'), env: { ...sb.env, TEAMAI_MODE: 'attended' }, stdio: 'ignore',
    });
    const ended = new Promise<number | null>((resolve) => { terminal.on('close', (code) => resolve(code)); });
    const answers: Record<string, string> = { 'Deploy rule': 'edit Weekday deploys', 'API guide': 'skip', 'Retry lesson': 'accept' };
    const asked: string[] = [];

    try {
      for (let answered = 0; answered < 3; answered += 1) {
        expect(await waitFor(() => printed().split(CHOICE_PROMPT).length > answered + 1, 30_000), printed()).toBe(true);
        const question = printed().split(CHOICE_PROMPT)[answered] ?? '';
        const title = Object.keys(answers).find((candidate) => question.includes(`${candidate} (`));

        expect(title, question).toBeDefined();
        asked.push(title ?? '');
        fs.appendFileSync(input, `${answers[title ?? ''] ?? ''}\n`);
      }

      expect(await ended, printed()).toBe(0);
    } finally {
      if (terminal.exitCode === null && terminal.signalCode === null) terminal.kill('SIGKILL');
    }

    expect(asked.sort()).toEqual(['API guide', 'Deploy rule', 'Retry lesson']);
    expect(printed()).toMatch(/Deploy rule \(rule\) from \S+\/\.claude\/rules\/deploy\.md\nSummary: Summary of Deploy rule\nTags: \["t1","t2"\]\naccept writes it; edit writes it with your note as its title; skip leaves it out\.\nOptions: accept, edit, skip/);
    expect(published(sb).files).toEqual([`learnings/${TODAY}-retry-lesson.md`, `rules/${TODAY}-weekday-deploys.md`]);
    expect(fs.readFileSync(path.join(sb.teamRepo, 'rules', `${TODAY}-weekday-deploys.md`), 'utf8')).toContain('title: "Weekday deploys"\ntype: rule\n');
  });

  it('imports the pages of an iWiki space by type with --from-iwiki --iwiki-dual, then writes the sections it found', async () => {
    const sb = sandbox();
    fs.rmSync(path.join(sb.home, '.claude'), { recursive: true });
    const redirect = path.join(sb.root, 'iwiki-redirect.mjs');
    fs.writeFileSync(redirect, IWIKI_REDIRECT);
    const { server, port } = await fakeIwiki();

    try {
      const ran = await sb.run(['import', '--from-iwiki', '900', '--all', '--iwiki-dual'], { env: { TAI_PAT_TOKEN: 'token', FAKE_IWIKI_PORT: port, NODE_OPTIONS: `--import ${redirect}` } });

      expect(ran.code, ran.stdout + ran.stderr).toBe(0);
      expect(lines(ran.stdout, sb.root)).toEqual([
        `ℹ Wrote: <sb>/home/.teamai/team-repo/rules/${TODAY}-deploy-rule.md`,
        `ℹ Wrote: <sb>/home/.teamai/team-repo/docs/${TODAY}-api-guide.md`,
        '✔ iWiki import complete',
        '⚠ iWiki dual import: Section "glossary" is empty; skipped.',
        'ℹ iWiki dual-path complete: sections updated [business-api, external-knowledge]',
      ]);
      expect(published(sb)).toEqual({ subject: '[teamai] Import from iWiki: Deploy rules, API guide', files: [`docs/${TODAY}-api-guide.md`, `rules/${TODAY}-deploy-rule.md`] });
      const sections = fs.readFileSync(path.join(sb.root, 'project', 'docs', 'team-codebase', 'external-knowledge.md'), 'utf8');
      expect(sections).toContain('<!-- managed-by: import --from-iwiki, section: business-api, source: iwiki://900, syncedAt: ');
      expect(sections).toContain('| orders | GET /api/v1/orders |');
      expect(fs.readFileSync(sb.log, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['doc', 'dual', 'rule']);
    } finally {
      server.close();
    }
  });
});
