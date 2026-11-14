/**
 * Background work a hook starts on Windows must finish after the process that
 * started it exits. A Windows child spawned without `detached` joins a job its
 * parent holds open, and that job may end the child with the parent. Two real
 * CLI runs, each holding its background work on a gate file until the parent
 * is gone, then releasing it:
 *   (a) the WMI launch fails, so the dispatcher starts the `--bg-only` pass
 *       itself (spawnPlainDetached), and that pass must log its summary;
 *   (b) the WMI launch works, and the `workflow resume` the `--bg-only` pass
 *       starts must end its run.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { z } from 'zod';
import { encodeCwdClaude } from '../../session-flow/fs.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
const SUMMARY = '[hook-dispatch] session-start/claude background:';
const FINISHED = '7c1e0000-0000-4000-8000-000000001761';
const HOUR = 60 * 60 * 1000;

const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ProcessRows = z.array(z.object({ ProcessId: z.number(), ParentProcessId: z.number(), CommandLine: z.string().nullable() }));

/** Live processes whose command line contains `fragment`, read from WMI. */
function processesWith(fragment: string): z.infer<typeof ProcessRows> {
  const like = fragment.replace(/'/g, "''");
  const script = `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${like}*' } | Select-Object ProcessId,ParentProcessId,CommandLine)`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`Get-CimInstance failed: ${run.stderr}`);
  return ProcessRows.parse(JSON.parse(run.stdout.trim() || '[]'));
}

/** The parent WMI recorded for `pid`, which outlives that parent. */
function parentOf(pid: number): number | undefined {
  return processesWith('').find((row) => row.ProcessId === pid)?.ParentProcessId;
}

function lastLine(file: string): string {
  if (!fs.existsSync(file)) return `(no ${file})`;
  return fs.readFileSync(file, 'utf8').trim().split('\n').at(-1) ?? '(empty)';
}

/** A node script that records its own pid and parent, then waits until `gate` is removed. */
function gateScript(entered: string, gate: string): string {
  return `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(entered)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, at: new Date().toISOString() }));
while (fs.existsSync(${JSON.stringify(gate)})) await new Promise((resolve) => setTimeout(resolve, 50));
`;
}

const Entered = z.object({ pid: z.number(), ppid: z.number(), at: z.string() });
const readEntered = (file: string) => Entered.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

/** A local bare team repo, its clone in `home`, and the user-scope config that points at it. */
function teamMachine(root: string, home: string, files: Record<string, string>, teamConfig: Record<string, unknown>) {
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  const data = path.join(home, '.teamai');
  const clone = path.join(data, 'team-repo');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'), FORCE_COLOR: '0' };
  write(path.join(root, '.gitconfig'), '[user]\n\tname = TeamAI E2E\n\temail = e2e@teamai.test\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
  const git = (args: string[], cwd = seed) => {
    const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  };
  write(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'lifetime', repo: remote, provider: 'git', autoUpdate: false, usageReport: false, ...teamConfig }));
  for (const [file, content] of Object.entries(files)) write(path.join(seed, file), content);
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'team']);
  git(['clone', '-q', '--bare', seed, remote], root);
  git(['clone', '-q', remote, clone], root);
  write(path.join(data, 'config.yaml'), YAML.stringify({ repo: { localPath: clone, remote }, username: 'lifetime', scope: 'user', enabledAgents: ['claude'], updatePolicy: 'skip' }));
  return { data, env };
}

describe.runIf(process.platform === 'win32')('background work on Windows outlives its parent', () => {
  it('(a0) control: with its parent alive, a --bg-only pass under the same unusable temp path reaches its prePull script', async () => {
    // Separates (a)'s two possible causes: if this pass gets to prePull under the
    // unusable temp path while its parent lives, a pass that does not in (a) died
    // with the dispatcher rather than failing on the temp path.
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lifetime-a0-')));
    const home = path.join(root, 'home');
    const app = path.join(root, 'app');
    const gate = path.join(root, 'gate');
    const entered = path.join(root, 'entered.json');
    fs.mkdirSync(app, { recursive: true });
    const { data, env } = teamMachine(root, home, { 'pre-pull.mjs': gateScript(entered, gate) }, { scripts: { prePull: { path: 'pre-pull.mjs' } } });
    const unusableTemp = path.join(root, 'temp-is-a-file');
    write(unusableTemp, 'not a directory');
    write(gate, 'hold the --bg-only pass while the test checks it');
    const bg = spawn(process.execPath, [CLI, 'hook-dispatch', 'session-start', '--tool', 'claude', '--bg-only'], {
      cwd: app, env: { ...env, TEMP: unusableTemp, TMP: unusableTemp }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
    });
    bg.stdin.end(JSON.stringify({ cwd: app, session_id: 'lifetime-a0' }));
    try {
      const reached = await until(() => fs.existsSync(entered), 60_000);
      expect(reached, `(a0) the --bg-only pass never reached prePull under an unusable temp path with its parent alive, so (a) cannot tell a dead pass from a failed one; exit code: ${bg.exitCode}; debug.log last line: ${lastLine(path.join(data, 'debug.log'))}`).toBe(true);
    } finally {
      fs.rmSync(gate, { force: true });
    }
    await until(() => bg.exitCode !== null, 60_000);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }, 150_000);

  it('(a) WMI launch fails: the --bg-only pass the dispatcher starts finishes its handlers after the dispatcher exits', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lifetime-a-')));
    const home = path.join(root, 'home');
    const app = path.join(root, 'app');
    const gate = path.join(root, 'gate');
    const entered = path.join(root, 'entered.json');
    fs.mkdirSync(app, { recursive: true });
    // prePull runs inside the --bg-only pass's pull handler, before its summary line.
    const { data, env } = teamMachine(root, home, { 'pre-pull.mjs': gateScript(entered, gate) }, { scripts: { prePull: { path: 'pre-pull.mjs' } } });
    const debugLog = path.join(data, 'debug.log');
    write(gate, 'hold the --bg-only pass until the dispatcher has exited');

    // trySpawnDetachedViaWmi writes the payload to os.tmpdir() before it starts
    // PowerShell. A temp path that is a file fails that write (a missing temp
    // dir does not: the dispatcher creates it first), and the dispatcher falls
    // back to spawnPlainDetached, as when WMI is unavailable.
    const unusableTemp = path.join(root, 'temp-is-a-file');
    write(unusableTemp, 'not a directory');
    const dispatch = spawnSync(process.execPath, [CLI, 'hook-dispatch', 'session-start', '--tool', 'claude'], {
      cwd: app, env: { ...env, TEMP: unusableTemp, TMP: unusableTemp }, input: JSON.stringify({ cwd: app, session_id: 'lifetime-a' }), encoding: 'utf8', timeout: 60_000,
    });
    const dispatcherExitedAt = new Date().toISOString();
    expect(dispatch.status, `(a) the dispatcher failed: ${dispatch.stdout}${dispatch.stderr}`).toBe(0);
    expect(isRunning(dispatch.pid ?? 0), `(a) dispatcher ${dispatch.pid} still running after spawnSync returned`).toBe(false);

    try {
      const reached = await until(() => fs.existsSync(entered), 30_000);
      expect(reached, `(a) the --bg-only pass never reached its pull's prePull script (a pass started through WMI would run under the runner's own profile, not this HOME). Dispatcher exited at ${dispatcherExitedAt}; debug.log last line: ${lastLine(debugLog)}`).toBe(true);
      const bg = readEntered(entered).ppid;
      expect(parentOf(bg), `(a) the --bg-only pass ${bg} was not started by dispatcher ${dispatch.pid}, so the WMI launch did not fall back`).toBe(dispatch.pid);
      expect(isRunning(bg), `(a) the --bg-only pass ${bg} died with its parent: dispatcher exited at ${dispatcherExitedAt}; debug.log last line: ${lastLine(debugLog)}`).toBe(true);
    } finally {
      fs.rmSync(gate, { force: true });
    }

    const summarized = await until(() => fs.existsSync(debugLog) && fs.readFileSync(debugLog, 'utf8').includes(SUMMARY), 60_000);
    expect(summarized, `(a) the --bg-only pass never logged its summary after its gate opened. Dispatcher exited at ${dispatcherExitedAt}; debug.log last line: ${lastLine(debugLog)}`).toBe(true);
    const summary = fs.readFileSync(debugLog, 'utf8').split('\n').find((line) => line.includes(SUMMARY)) ?? '';
    expect(summary.split(' ')[0] > dispatcherExitedAt, `(a) the summary predates the dispatcher's exit at ${dispatcherExitedAt}: ${summary}`).toBe(true);
    expect(summary, '(a) the summary names the pull handler that held on the gate').toContain('pull=');
    await until(() => !isRunning(readEntered(entered).ppid), 10_000);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }, 150_000);

  it('(b) WMI launch works: the workflow resume the --bg-only pass starts ends its run after that pass exits', async (ctx) => {
    // A process WMI creates does not inherit the caller's environment, so the
    // --bg-only pass resolves the account's real profile, not a sandbox HOME.
    // Only a throwaway CI runner may have that profile written to.
    if (!process.env.GITHUB_ACTIONS) ctx.skip('writes ~/.teamai in the real Windows profile, so it runs on GitHub Actions only');
    const home = os.userInfo().homedir;
    const data = path.join(home, '.teamai');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lifetime-b-')));
    const app = path.join(root, 'app');
    const gate = path.join(root, 'gate');
    const entered = path.join(root, 'entered.json');
    const gateFile = path.join(root, 'gate.mjs');
    const project = path.join(home, '.claude', 'projects', encodeCwdClaude(app));
    fs.mkdirSync(app, { recursive: true });
    write(gateFile, gateScript(entered, gate));
    // Earlier steps of the same CI job leave a ~/.teamai behind; set it aside
    // last, so a failed setup never leaves it moved.
    const kept = `${data}.before-lifetime-b`;
    if (fs.existsSync(data)) fs.renameSync(data, kept);

    try {
      // The team's teamai-finished-sessions replaces the default with one step
      // that holds on the gate, so the run outlives the pass that started it.
      const posix = (file: string) => file.replace(/\\/g, '/');
      const workflow = YAML.stringify({
        schemaVersion: 'v1alpha1', name: 'teamai-finished-sessions', description: 'Hold until the test opens the gate.', invoke: 'deny', private: true, timeout: '30m',
        inputs: { publish: 'policy | always | never', scorers: ['string'] },
        steps: [{ id: 'hold', command: `'${posix(process.execPath)}' '${posix(gateFile)}'` }],
      });
      const scorer = '---\nlabels:\n  - { value: done, score: 1, description: Did it }\n  - { value: not-done, score: 0, description: Did not }\npassingScore: 0.5\nsamplingRate: 100\nsessions: true\n---\nJudge the session.\n';
      const { env } = teamMachine(root, home, { 'workflows/teamai-finished-sessions.yaml': workflow, 'scorers/done.md': scorer }, {});
      fs.appendFileSync(path.join(data, 'config.yaml'), 'scoring:\n  sessions: true\n');
      const debugLog = path.join(data, 'debug.log');
      const pull = spawnSync(process.execPath, [CLI, 'pull'], { cwd: app, env, encoding: 'utf8', timeout: 60_000 });
      expect(pull.status, `(b) teamai pull failed: ${pull.stdout}${pull.stderr}`).toBe(0);

      // A session that ended seven hours ago, so a teamai-finished-sessions run has work.
      const transcript = path.join(project, `${FINISHED}.jsonl`);
      write(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, cwd: app, sessionId: FINISHED, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries.' } })}\n`);
      const ended = new Date(Date.now() - 7 * HOUR);
      fs.utimesSync(transcript, ended, ended);
      write(path.join(data, 'sessions', 'captures', 'claude-code', FINISHED, '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e1761.json'), JSON.stringify({
        captureId: '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e1761', platform: 'claude-code', sessionId: FINISHED, capturedAt: ended.toISOString(),
        agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: transcript,
      }));
      write(gate, 'hold the workflow resume until the --bg-only pass has exited');

      const dispatch = spawnSync(process.execPath, [CLI, 'hook-dispatch', 'session-start', '--tool', 'claude'], {
        cwd: app, env, input: JSON.stringify({ cwd: app, session_id: 'lifetime-b' }), encoding: 'utf8', timeout: 60_000,
      });
      expect(dispatch.status, `(b) the dispatcher failed: ${dispatch.stdout}${dispatch.stderr}`).toBe(0);

      const runs = path.join(data, 'workflows', 'runs');
      const Run = z.object({ id: z.string(), name: z.string(), status: z.string() });
      const finishedRuns = () => (fs.existsSync(runs) ? fs.readdirSync(runs) : []).filter((name) => name.endsWith('.json'))
        .map((name) => Run.parse(JSON.parse(fs.readFileSync(path.join(runs, name), 'utf8'))))
        .filter((run) => run.name === 'teamai-finished-sessions');

      let parentExitedAt = '(not observed)';
      try {
        const reached = await until(() => fs.existsSync(entered), 60_000);
        expect(reached, reached ? '' : `(b) the run never reached its hold step; workflow resume processes alive: ${processesWith('workflow resume').length}. Runs: ${JSON.stringify(finishedRuns())}; debug.log last line: ${lastLine(debugLog)}`).toBe(true);
        const [run] = finishedRuns();
        const resumeOf = `workflow resume ${run?.id ?? '(no run)'}`;
        expect(processesWith(resumeOf), `(b) no workflow resume process is alive for run ${run?.id} once its hold step started; debug.log last line: ${lastLine(debugLog)}`).not.toEqual([]);
        // Every --bg-only process gone means the pass that started the resume has exited.
        const parentGone = await until(() => processesWith('--bg-only').length === 0, 60_000);
        parentExitedAt = new Date().toISOString();
        expect(parentGone, `(b) the --bg-only pass that started ${resumeOf} never exited`).toBe(true);
        expect(processesWith(resumeOf), `(b) ${resumeOf} died with the --bg-only pass, gone by ${parentExitedAt}; debug.log last line: ${lastLine(debugLog)}`).not.toEqual([]);
      } finally {
        fs.rmSync(gate, { force: true });
      }

      const runEnded = await until(() => finishedRuns().length > 0 && finishedRuns().every((run) => run.status !== 'running'), 60_000);
      expect(runEnded,`(b) the run never ended after its gate opened. Parent exited by ${parentExitedAt}; runs: ${JSON.stringify(finishedRuns())}; debug.log last line: ${lastLine(debugLog)}`).toBe(true);
      expect(finishedRuns(), `(b) parent exited by ${parentExitedAt}; debug.log last line: ${lastLine(debugLog)}`).toEqual([expect.objectContaining({ status: 'succeeded' })]);
      await until(() => processesWith('workflow resume').length === 0, 10_000);
    } finally {
      fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
      if (fs.existsSync(kept)) fs.renameSync(kept, data);
      fs.rmSync(project, { recursive: true, force: true, maxRetries: 5 });
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 240_000);
});
