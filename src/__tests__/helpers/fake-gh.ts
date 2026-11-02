import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { z } from 'zod';
import * as cliPath from '../../utils/cli-path.js';

const CallSchema = z.object({ args: z.array(z.string()), cwd: z.string(), prompt: z.string().optional() });
export type GhCall = z.infer<typeof CallSchema>;
const PullSchema = z.object({ html_url: z.string(), body: z.string().optional(), head: z.object({ ref: z.string() }) });

/**
 * How the fake answers. `lookup: 'fail'` fails every `gh api`. `create: 'fail'` fails `gh pr create` and opens nothing;
 * `'fail-after-open'` opens the request and still fails, as a create that timed out after GitHub took it. `open`
 * replaces the open requests. `hold` waits inside that call, a create once it recorded the request, until a file named
 * `release` is in the fake's directory, or 20 seconds passed; while it waits, `<hold>.held` there holds the pid of the
 * process that called it. `checks` answers the check runs and the combined status of any commit: no status by default.
 */
export interface FakeGhOptions {
  lookup?: 'fail';
  create?: 'fail' | 'fail-after-open';
  open?: unknown[];
  hold?: 'lookup' | 'create';
  checks?: { runs: unknown[]; status?: { state: string; total_count: number; statuses: Array<{ state: string }> } };
}

function script(dir: string): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return fallback; } };
const args = process.argv.slice(2);
const options = read('options.json', {});
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, cwd: process.cwd(), prompt: process.env.GIT_TERMINAL_PROMPT }) + '\\n');
const open = read('open.json', []);
const hold = (call) => {
  if (options.hold !== call) return;
  fs.writeFileSync(path.join(dir, call + '.held'), String(process.ppid));
  for (const until = Date.now() + 20000; !fs.existsSync(path.join(dir, 'release')) && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
};
if (args[0] === '--version') { console.log('gh version 2.62.0 (fake)'); process.exit(0); }
if (args[0] === 'api' && args[1] === 'user') { console.log('member'); process.exit(0); }
if (args[0] === 'api') {
  if (options.lookup === 'fail') { console.error('HTTP 401: Bad credentials for token ghp_fake_secret'); process.exit(1); }
  hold('lookup');
  const checks = options.checks || { runs: [] };
  if (String(args[1]).includes('/check-runs')) { console.log(JSON.stringify({ total_count: checks.runs.length, check_runs: checks.runs })); process.exit(0); }
  if (String(args[1]).includes('/status')) { console.log(JSON.stringify(checks.status || { state: 'pending', total_count: 0, statuses: [] })); process.exit(0); }
  console.log(JSON.stringify(open));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const repo = value('-R');
  const pull = { state: 'open', html_url: 'https://github.com/' + repo + '/pull/' + (open.length + 1), body: value('-b'), head: { ref: value('-H'), repo: { full_name: repo } }, base: { ref: value('-B'), repo: { full_name: repo } } };
  if (options.create !== 'fail') fs.writeFileSync(path.join(dir, 'open.json'), JSON.stringify([...open, pull]));
  hold('create');
  if (options.create) { console.error('pull request create failed for token ghp_fake_secret'); process.exit(1); }
  console.log(pull.html_url);
  process.exit(0);
}
if (args[0] === 'pr' && (args[1] === 'view' || args[1] === 'edit')) {
  const at = open.findIndex((pull) => pull.html_url.endsWith('/pull/' + args[2]));
  if (at === -1) { console.error('no pull request ' + args[2]); process.exit(1); }
  if (args[1] === 'view') { process.stdout.write((open[at].body ?? '') + '\\n'); process.exit(0); }
  open[at] = { ...open[at], body: fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') };
  fs.writeFileSync(path.join(dir, 'open.json'), JSON.stringify(open));
  process.exit(0);
}
console.error('unexpected gh call: ' + args.join(' '));
process.exit(9);
`;
}

export interface FakeGh {
  /** The executable, named `gh`. */
  bin: string;
  configure(next: FakeGhOptions): void;
  calls(): GhCall[];
  /** The open pull requests, each with its head branch and body. */
  pulls(): Array<{ url: string; head: string; body: string }>;
}

/**
 * A `gh` that keeps open pull requests under `dir` and logs each call with its cwd and GIT_TERMINAL_PROMPT. It answers
 * `gh --version`, `gh api user` with the login `member`, `gh api` with every open request and `gh pr create` with a new one; `gh pr view <n> --json body -q .body` prints the
 * request's body and `gh pr edit <n> --body-file <file>` replaces it, and its failures print a token, so a test can
 * show none is kept. teamai resolves `gh` to it until the test's mocks are restored.
 */
export function fakeGh(dir: string, options: FakeGhOptions = {}): FakeGh {
  const fake = fakeGhHost(dir, options);
  resolveGh(fake.bin);
  return fake;
}

/** The same `gh` for a process this test spawns, which finds it first on its PATH. */
export function fakeGhHost(dir: string, options: FakeGhOptions = {}): FakeGh {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(bin, script(dir), { mode: 0o755 });
  const fake = {
    bin,
    configure(next: FakeGhOptions): void {
      fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify(next));
      if (next.open) fs.writeFileSync(path.join(dir, 'open.json'), JSON.stringify(next.open));
    },
    calls(): GhCall[] {
      const log = path.join(dir, 'calls.jsonl');
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => CallSchema.parse(JSON.parse(line)));
    },
    pulls() {
      const file = path.join(dir, 'open.json');
      if (!fs.existsSync(file)) return [];
      return z.array(PullSchema).parse(JSON.parse(fs.readFileSync(file, 'utf8'))).map((pull) => ({ url: pull.html_url, head: pull.head.ref, body: pull.body ?? '' }));
    },
  };
  fake.configure(options);
  return fake;
}

/** Makes teamai find `gh` at `bin`, or find none, whatever this machine has installed. */
export function resolveGh(bin: string | null): void {
  const resolve = cliPath.resolveCliPath;
  vi.spyOn(cliPath, 'resolveCliPath').mockImplementation((cmd, platform) => (cmd === 'gh' ? bin : resolve(cmd, platform)));
}
