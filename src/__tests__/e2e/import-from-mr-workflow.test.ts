/**
 * E2E: `teamai import --from-mr` runs the default workflow teamai-import-from-mr. `gh` (the MR) and `claude` (the
 * extraction) are stand-ins on PATH; the team repo is a local bare repository, and the learning is published to its
 * teamai-learnings branch as `teamai contribute` publishes one.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { hasPython, TYPED_TERMINAL } from '../helpers/in-terminal.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };

const MR7 = 'https://github.com/acme/app/pull/7';
const MR8 = 'https://github.com/acme/app/pull/8';

/** contribute's name for a published learning: <title-slug>-<date>-<random>.md under learnings/. */
const published = (slug: string): RegExp => new RegExp(`^learnings/${slug}-\\d{4}-\\d{2}-\\d{2}-[a-z0-9]+\\.md$`);

type Ran = { code: number | null; stdout: string; stderr: string };

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString().trim();
}

/** `gh` answering for PR 7 ("Retry flaky upload") and PR 8 ("Cache warmup"), with no review threads. */
const FAKE_GH = `#!/usr/bin/env bash
if [ "$1" = api ]; then echo '[]'; exit 0; fi
n="$3"
case "$1 $2" in
  "pr view") if [ "$n" = 8 ]; then t="Cache warmup"; else t="Retry flaky upload"; fi
    echo "{\\"title\\":\\"$t\\",\\"body\\":\\"Body of $t.\\",\\"author\\":{\\"login\\":\\"dev\\"},\\"mergedAt\\":\\"2026-09-20T10:00:00Z\\",\\"commits\\":[{\\"oid\\":\\"abc12345\\",\\"messageHeadline\\":\\"change $n\\"}]}" ;;
  "pr diff") printf 'diff --git a/up.ts b/up.ts\\n+retry(3)\\n' ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

/** `claude` writing "Lesson of <MR title>", logging each MR title it was asked about and the prompt's language. */
function fakeClaude(bin: string, log: string): void {
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => {
  const title = /MR (?:title|标题)[:：] ?(.*)/.exec(stdin)?.[1] ?? 'Unknown';
  fs.appendFileSync(${JSON.stringify(log)}, title + (stdin.includes('Write in English') ? ' (en)' : ' (zh)') + '\\n');
  const reply = '---\\ntitle: "Lesson of ' + title + '"\\nauthor: dev\\ndate: 2026-09-20\\ntags: [retry, s3]\\nconfidence: 0.85\\n---\\n\\n## Background\\n' + title + ' happened.\\n';
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: reply, usage: { input_tokens: 10, output_tokens: 5 } }));
});\n`, { mode: 0o755 });
}

interface Sandbox {
  root: string;
  remote: string;
  log: string;
  env: Record<string, string>;
  run: (args: string[]) => Promise<Ran>;
}

/** A member with a teamai init in git mode on a local bare team repo, that has pulled, with the fake tools on PATH. */
async function sandbox(teamYaml: string[] = []): Promise<Sandbox> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-from-mr-')));
  sandboxes.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.gitconfig'), '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n[user]\n\tname = t\n\temail = t@t\n');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const log = path.join(root, 'claude.log');
  fakeClaude(bin, log);
  const remote = path.join(root, 'team.git');
  const work = path.join(root, 'team-work');
  const teamRepo = path.join(home, '.teamai', 'team-repo');
  git(['init', '-q', '--bare', '-b', 'main', remote], root);
  git(['init', '-q', '-b', 'main', work], root);
  fs.writeFileSync(path.join(work, 'teamai.yaml'), ['team: mr', 'description: mr fixture', `repo: ${remote}`, 'provider: git', 'usageReport: false', ...teamYaml, ''].join('\n'));
  git(['add', '-A'], work);
  git(['commit', '-qm', 'team'], work);
  git(['remote', 'add', 'origin', remote], work);
  git(['push', '-q', 'origin', 'main'], work);
  git(['clone', '-q', remote, teamRepo], root);
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
    'repo:', `  localPath: ${teamRepo}`, `  remote: ${remote}`, '  kind: git',
    'username: alice', 'updatePolicy: auto', 'additionalRoles: []', 'scope: user', 'enabledAgents: [claude]', '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'project'));

  const env = {
    HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LC_ALL: 'C.UTF-8', FORCE_COLOR: '0', NO_COLOR: '1', TEAMAI_AI_TOOL: '',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', TEAMAI_CONTRIBUTE_HINT_DISABLED: '1', ...GIT_ENV,
  };

  const run = (args: string[]): Promise<Ran> => new Promise((resolve) => {
    const { CLAUDE_SESSION_ID: _session, GITHUB_TOKEN: _token, GH_TOKEN: _gh, ...inherited } = process.env;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: path.join(root, 'project'), env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  const pulled = await run(['pull']);

  if (pulled.code !== 0) throw new Error(`teamai pull failed: ${pulled.stdout}${pulled.stderr}`);

  return { root, remote, log, env, run };
}

/** The lines of `text` with the sandbox, run ids and contribute's file names made stable. */
function lines(text: string, root: string): string[] {
  return text.replaceAll(root, '<sb>').replace(/\br[0-9a-f]{16}\b/g, '<run>').replace(/-\d{4}-\d{2}-\d{2}-[a-z0-9]+\.md/g, '-<date>-<id>.md')
    .split('\n').filter((line) => line !== '');
}

/** The learnings on the team's teamai-learnings branch. */
function learnings(sb: Sandbox): string[] {
  try {
    return git(['ls-tree', '-r', '--name-only', 'teamai-learnings', 'learnings'], sb.remote).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function asked(sb: Sandbox): string[] {
  return fs.existsSync(sb.log) ? fs.readFileSync(sb.log, 'utf8').split('\n').filter(Boolean) : [];
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; !check(); waited += 50) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return true;
}

describe('teamai import --from-mr through teamai-import-from-mr', { timeout: 120_000 }, () => {
  it('publishes the learning of one MR with --all, saying what it said before', async () => {
    const sb = await sandbox();

    const ran = await sb.run(['import', '--from-mr', MR7, '--all']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(lines(ran.stdout, sb.root)).toEqual([
      'ℹ ✅ Learning draft generated: Lesson of Retry flaky upload',
      'ℹ    Tags: retry, s3',
      'ℹ Learning written: <sb>/home/.teamai/pending-learnings/lesson-of-retry-flaky-upload-<date>-<id>.md',
      '✔ Learning published',
      'ℹ Incremental teamwiki update skipped: no existing evidence for github__acme__app',
      'ℹ Push changes via MR skipped: no teamwiki changes to push',
    ]);
    expect(lines(ran.stderr, sb.root)).toEqual([
      '- Fetching MR data...',
      '✔ MR data fetched',
    ]);
    expect(learnings(sb)).toEqual([expect.stringMatching(published('lesson-of-retry-flaky-upload'))]);
    expect(asked(sb)).toEqual(['Retry flaky upload (zh)']);
  });

  it('writes the learning in English when teamai.yaml sets language: en (#1187)', async () => {
    const sb = await sandbox(['language: en']);

    const ran = await sb.run(['import', '--from-mr', MR7, '--all']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(asked(sb)).toEqual(['Retry flaky upload (en)']);
  });

  it('previews with --dry-run: says the draft and writes and pushes nothing', async () => {
    const sb = await sandbox();

    const ran = await sb.run(['import', '--from-mr', MR7, '--dry-run']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(lines(ran.stdout, sb.root)).toEqual(['ℹ ✅ Learning draft generated: Lesson of Retry flaky upload', 'ℹ    Tags: retry, s3']);
    expect(learnings(sb)).toEqual([]);
  });

  it('refuses, before any AI call, a review nobody can answer, and says how to run it', async () => {
    const sb = await sandbox();

    const ran = await sb.run(['import', '--from-mr', MR7]);

    expect(ran.code, ran.stdout + ran.stderr).toBe(1);
    expect(lines(ran.stderr, sb.root)).toEqual([
      '✖ This import asks a person to accept, edit or skip each item it found, and nobody can answer here: it runs inside a workflow step, or its input is not a terminal. Run it in your own terminal, or pass --all to accept every item.',
    ]);
    expect(asked(sb)).toEqual([]);
  });

  it('names the step that failed and exits 1 when the only MR cannot be read', async () => {
    const sb = await sandbox();

    const ran = await sb.run(['import', '--from-mr', 'https://example.test/not-an-mr', '--all']);

    expect(ran.code, ran.stdout + ran.stderr).toBe(1);
    expect(ran.stderr).toContain('Unsupported MR URL: https://example.test/not-an-mr. Only GitHub, TGit and GitLab are supported');
    expect(ran.stderr).toMatch(/✖ Step "extract\[0\]\.fetch" failed/);
    expect(ran.stdout).toBe('');
    expect(asked(sb)).toEqual([]);
  });

  it.skipIf(!hasPython)('asks a person in a terminal to accept, edit or skip each draft, and publishes what they chose', async () => {
    const sb = await sandbox();
    const [pid, output, input] = ['terminal.pid', 'terminal.out', 'terminal.in'].map((file) => path.join(sb.root, file)) as [string, string, string];
    const printed = (): string => (fs.existsSync(output) ? fs.readFileSync(output, 'utf8').replaceAll('\r', '') : '');
    const terminal = spawn('python3', ['-c', TYPED_TERMINAL, pid, output, input, process.execPath, CLI, 'import', '--from-mr', MR7, MR8], {
      cwd: path.join(sb.root, 'project'), env: { ...sb.env, TEAMAI_MODE: 'attended' }, stdio: 'ignore',
    });
    const ended = new Promise<number | null>((resolve) => { terminal.on('close', (code) => resolve(code)); });
    const prompt = 'Choice, followed by an optional note: ';

    try {
      expect(await waitFor(() => printed().includes(prompt), 60_000), printed()).toBe(true);
      fs.appendFileSync(input, 'edit Retry uploads three times\n');
      expect(await waitFor(() => printed().split(prompt).length > 2, 30_000), printed()).toBe(true);
      fs.appendFileSync(input, 'skip\n');
      expect(await ended, printed()).toBe(0);
    } finally {
      if (terminal.exitCode === null && terminal.signalCode === null) terminal.kill('SIGKILL');
    }

    expect(lines(printed(), sb.root).join('\n')).toContain([
      `Step "review[0].ask": Lesson of Retry flaky upload from ${MR7}`,
      'Tags: ["retry","s3"]',
      'Overlapping learnings: []',
    ].join('\n'));
    expect(printed()).toContain('accept publishes it; edit publishes it with your note as its title; skip leaves it out.\nOptions: accept, edit, skip');
    expect(printed()).toContain('Import from MR complete: 2 succeeded, 0 failed');
    const files = learnings(sb);
    expect(files).toEqual([expect.stringMatching(published('retry-uploads-three-times'))]);
    expect(git(['show', `teamai-learnings:${files[0] ?? ''}`], sb.remote)).toMatch(/^---\ntitle: "Retry uploads three times"\nauthor: dev\ndate: 2026-09-20\n/);
  });
});
