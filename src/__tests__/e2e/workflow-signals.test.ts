/**
 * Real CLI: with `workflows.max_parallel: 2`, the local driver runs commands in
 * process groups of their own. A SIGINT to the driver stops every group,
 * children included, and the driver exits with the signal. A terminal's Ctrl-C
 * goes to the foreground group: at 2 only the driver is in it and stops the
 * groups; at 1 the command is in it and gets the signal directly, as before.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import { hasPython, IN_TERMINAL, TYPED_TERMINAL } from '../helpers/in-terminal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/** Starts a child that holds none of its output, so only a group kill stops it, then writes both pids to `<argv[2]>.pids` and waits. */
const HOLD = `const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync(process.argv[2] + '.pids', process.pid + ' ' + child.pid);
setInterval(() => {}, 1000);
`;

/**
 * A fake interactive `claude`: opened with the step's prompt, it marks that it
 * started, records a Ctrl-C instead of exiting on it, and exits once the person
 * types `done`. Any other invocation, such as a version check, exits at once.
 */
const INTERACTIVE_TOOL = `#!/usr/bin/env node
if (!process.argv.slice(2).some((arg) => arg.startsWith('Pair with me.'))) process.exit(0);
const fs = require('fs');
process.on('SIGINT', () => fs.writeFileSync('tool.interrupted', ''));
process.stdin.on('data', (chunk) => { if (String(chunk).includes('done')) process.exit(0); });
fs.writeFileSync('tool.started', '');
`;

function runCLI(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env: process.env, stdio: 'pipe' });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; !check(); waited += 50) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

describe.skipIf(process.platform === 'win32')('workflow local driver signals', () => {
  let repo: string;
  let pidRoot: string;
  let configPath: string;
  let bin: string;

  function setMaxParallel(max: number): void {
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(configPath, YAML.stringify({ ...config, workflows: { max_parallel: max } }));
  }

  beforeAll(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-signals-e2e-')));
    fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', 'README.md'], repo);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'app'], repo);
    git(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], repo);
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'shipped\ntool.started\ntool.interrupted\n');
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
    configPath = path.join(await resolveProjectDataHome(repo), 'config.yaml');
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(repo, 'hold.js'), HOLD);
    git(['add', 'hold.js'], repo);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'hold'], repo);
    pidRoot = path.join(path.dirname(repo), `${path.basename(repo)}-pids`);
    fs.mkdirSync(pidRoot);
    fs.writeFileSync(path.join(workflows, 'hold.yaml'), `schemaVersion: v1alpha1
name: hold
description: Two commands that run until they are stopped.
steps:
  - id: one
    needs: []
    workspace: new
    command: node hold.js ${pidRoot}/one
  - id: two
    needs: []
    workspace: new
    command: node hold.js ${pidRoot}/two
`);
    fs.writeFileSync(path.join(workflows, 'once.yaml'), `schemaVersion: v1alpha1
name: once
description: A command that runs until it is stopped the first time, and ends at once after that.
steps:
  - id: once
    command: test -f ${pidRoot}/once.pids || node hold.js ${pidRoot}/once
`);
    fs.writeFileSync(path.join(workflows, 'pair.yaml'), `schemaVersion: v1alpha1
name: pair
description: An interactive step beside a HITL request.
steps:
  - id: pair
    interactive: true
    prompt: Pair with me.
  - id: ship
    needs: []
    approve: Ship it?
    command: node -e "require('fs').writeFileSync('shipped', '')"
`);
    bin = path.join(repo, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), INTERACTIVE_TOOL);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('stops every command and its children on SIGINT, then exits with the signal', async () => {
    setMaxParallel(2);
    const pidFiles = ['one.pids', 'two.pids'].map((file) => path.join(pidRoot, file));
    for (const file of pidFiles) fs.rmSync(file, { force: true });
    const driver = spawn(process.execPath, [CLI, 'workflow', 'start', 'hold', '--driver', 'local'], {
      cwd: repo, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    driver.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      driver.on('close', (code, signal) => resolve({ code, signal }));
    });
    let pids: number[] = [];
    try {
      expect(await waitFor(() => pidFiles.every((file) => fs.existsSync(file)), 20_000), stderr).toBe(true);
      pids = pidFiles.flatMap((file) => fs.readFileSync(file, 'utf8').trim().split(' ').map(Number));
      expect(pids.every(alive)).toBe(true);

      driver.kill('SIGINT');

      expect(await ended).toEqual({ code: null, signal: 'SIGINT' });
      expect(await waitFor(() => !pids.some(alive), 2000), `still running: ${pids.filter(alive).join(' ')}`).toBe(true);
    } finally {
      for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
      if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    }
  });

  it.each(['SIGTERM', 'SIGHUP'] as const)('stops its one command and its children on a %s to the driver alone, and the run resumes', async (signal) => {
    setMaxParallel(1);
    const pidFile = path.join(pidRoot, 'once.pids');
    fs.rmSync(pidFile, { force: true });
    const driver = spawn(process.execPath, [CLI, 'workflow', 'start', 'once', '--driver', 'local'], {
      cwd: repo, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    driver.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      driver.on('close', (code, signal) => resolve({ code, signal }));
    });
    let pids: number[] = [];
    try {
      expect(await waitFor(() => fs.existsSync(pidFile), 20_000), stderr).toBe(true);
      pids = fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
      expect(pids.every(alive)).toBe(true);

      driver.kill(signal);

      expect(await ended).toEqual({ code: null, signal });
      expect(await waitFor(() => !pids.some(alive), 2000), `still running: ${pids.filter(alive).join(' ')}`).toBe(true);
      const runId = /Run (\S+) started/.exec(stderr)?.[1];
      expect(runId, stderr).toBeDefined();
      const resumed = await runCLI(['workflow', 'resume', String(runId)], repo);
      expect(resumed.code, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      expect(JSON.parse(resumed.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    } finally {
      for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
      if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    }
  });

  it.skipIf(!hasPython).each([2, 1])("stops every command and its children on a terminal's Ctrl-C with max_parallel %i", async (max) => {
    setMaxParallel(max);
    const pidFiles = ['one.pids', 'two.pids'].map((file) => path.join(pidRoot, file));
    for (const file of pidFiles) fs.rmSync(file, { force: true });
    const terminalPid = path.join(repo, 'terminal.pid');
    fs.rmSync(terminalPid, { force: true });
    const wrapper = spawn('python3', ['-c', IN_TERMINAL, terminalPid, process.execPath, CLI, 'workflow', 'start', 'hold', '--driver', 'local'], {
      cwd: repo, env: { ...process.env, FORCE_COLOR: '0' }, stdio: 'ignore',
    });
    const ended = new Promise<void>((resolve) => { wrapper.on('close', () => resolve()); });
    const started = max === 2 ? pidFiles : pidFiles.slice(0, 1);
    let pids: number[] = [];
    try {
      expect(await waitFor(() => fs.existsSync(terminalPid) && started.every((file) => fs.existsSync(file)), 20_000)).toBe(true);
      pids = started.flatMap((file) => fs.readFileSync(file, 'utf8').trim().split(' ').map(Number));
      expect(pids.every(alive)).toBe(true);

      process.kill(-Number(fs.readFileSync(terminalPid, 'utf8')), 'SIGINT');

      await ended;
      expect(await waitFor(() => !pids.some(alive), 2000), `still running: ${pids.filter(alive).join(' ')}`).toBe(true);
      expect(max === 1 && fs.existsSync(pidFiles[1]!), 'the second command started after Ctrl-C').toBe(false);
    } finally {
      for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
    }
  });

  it.skipIf(!hasPython)('gives Ctrl-C to an interactive tool and asks a HITL request only after the tool exits', async () => {
    setMaxParallel(1);
    const files = ['terminal.pid', 'terminal.out', 'terminal.in', 'tool.started', 'tool.interrupted', 'shipped'].map((file) => path.join(repo, file));
    const [terminalPid, output, input, started, interrupted, shipped] = files as [string, string, string, string, string, string];
    for (const file of files) fs.rmSync(file, { force: true });
    const printed = (): string => (fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '');
    const type = (text: string): void => fs.appendFileSync(input, text);
    const wrapper = spawn('python3', ['-c', TYPED_TERMINAL, terminalPid, output, input,
      process.execPath, CLI, 'workflow', 'start', 'pair', '--driver', 'local', '--tools', 'default=claude'], {
      cwd: repo, env: { ...process.env, FORCE_COLOR: '0', PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }, stdio: 'ignore',
    });
    const ended = new Promise<number | null>((resolve) => { wrapper.on('close', (code) => resolve(code)); });
    try {
      expect(await waitFor(() => fs.existsSync(started), 20_000), printed()).toBe(true);
      type('\x03');

      expect(await waitFor(() => fs.existsSync(interrupted), 5000), printed()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(alive(Number(fs.readFileSync(terminalPid, 'utf8'))), printed()).toBe(true);
      expect(printed()).not.toContain('Choice, followed by an optional note');

      type('done\n');

      expect(await waitFor(() => printed().includes('Choice, followed by an optional note'), 10_000), printed()).toBe(true);
      expect(printed()).toContain('Ship it?');

      type('yes\n');

      expect(await ended, printed()).toBe(0);
      expect(fs.existsSync(shipped), printed()).toBe(true);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
    }
  });
});
