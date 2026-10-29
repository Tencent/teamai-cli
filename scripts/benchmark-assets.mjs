import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TOOL_DIRS = { claude: '.claude', codex: '.codex', opencode: '.opencode', codebuddy: '.codebuddy' };
const TOOLS = Object.keys(TOOL_DIRS);

function command(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== 'string' || !part)) {
    throw new Error(`${field} must be a nonempty argv array`);
  }
  return value;
}

export function readSuite(file) {
  const suite = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['codeRepo', 'codeRef', 'teamRepo', 'before', 'after']) {
    if (typeof suite[key] !== 'string' || !suite[key].trim()) throw new Error(`${key} is required`);
  }
  if (!TOOLS.includes(suite.tool)) throw new Error(`tool must be one of ${TOOLS.join(', ')}`);
  if (suite.role !== undefined && (typeof suite.role !== 'string' || !suite.role)) throw new Error('role must be a nonempty string');
  if (suite.projects !== undefined && (!Array.isArray(suite.projects) || suite.projects.some((id) => typeof id !== 'string' || !id))) throw new Error('projects must be an array of nonempty strings');
  command(suite.run, 'run');
  if (suite.setup !== undefined) command(suite.setup, 'setup');
  suite.repetitions ??= 3;
  suite.timeoutMs ??= 600_000;
  for (const key of ['repetitions', 'timeoutMs']) {
    if (!Number.isSafeInteger(suite[key]) || suite[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (suite.timeoutMs > 2_147_483_647) throw new Error('timeoutMs exceeds the Node timer limit');
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) throw new Error('tasks must not be empty');
  const ids = new Set();
  for (const task of suite.tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || ids.has(task.id)) throw new Error('task ids must be unique nonempty strings');
    ids.add(task.id);
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) throw new Error(`${task.id}: prompt is required`);
    command(task.check, `${task.id}.check`);
  }
  return suite;
}

/** Run argv without a shell; a timeout stops the process tree, including the agent's children. */
function execute(argv, { cwd, env, timeoutMs, signal, input = '' }) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stopped: true, stopReason: 'interrupted', durationMs: 0, output: '' });
      return;
    }
    const start = performance.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let error;
    let stopped = false;
    let stopReason;
    const stop = (reason) => {
      if (stopped) return;
      stopped = true;
      stopReason = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const interrupt = () => stop('interrupted');
    signal?.addEventListener('abort', interrupt, { once: true });
    const collect = (data) => {
      output += data.toString();
      if (output.length > 4 * 1024 * 1024) stop('output limit');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.on('error', (cause) => { error = cause.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
      resolve({ code, stopped, stopReason, error, durationMs: Math.round(performance.now() - start), output: output.slice(-4000) });
    });
    child.stdin.end(input);
  });
}

function isolatedEnv(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(TEAMAI_|OPENCODE_CONFIG|CLAUDE_CODE_SESSION_ID$|GIT_CONFIG_|GIT_DIR$|GIT_COMMON_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$)/.test(key)) delete env[key];
  }
  return {
    ...env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    CODEBUDDY_CONFIG_DIR: path.join(home, '.codebuddy'), OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'TeamAI benchmark', GIT_AUTHOR_EMAIL: 'benchmark@teamai.test',
    GIT_COMMITTER_NAME: 'TeamAI benchmark', GIT_COMMITTER_EMAIL: 'benchmark@teamai.test',
    GIT_TERMINAL_PROMPT: '0', TEAMAI_NONINTERACTIVE: '1', FORCE_COLOR: '0',
  };
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function removeTemporary(root, temporary) {
  if (path.dirname(root) !== temporary || !path.basename(root).startsWith('teamai-asset-benchmark-')) throw new Error('Unexpected benchmark temporary directory');
  fs.rmSync(root, { recursive: true, force: true });
}

function homeAt(dir) {
  const home = path.join(dir, 'home');
  for (const name of ['.claude', '.codex', '.codebuddy', '.config/opencode']) fs.mkdirSync(path.join(home, name), { recursive: true });
  write(path.join(home, '.gitconfig'), `[core]\n hooksPath = ${JSON.stringify(path.join(home, 'no-hooks').replaceAll('\\', '/'))}\n[gc]\n auto = 0\n`);
  return isolatedEnv(home);
}

function expand(argv, suiteDir, workspace) {
  return argv.map((part) => part.replaceAll('{node}', process.execPath).replaceAll('{suite}', suiteDir).replaceAll('{workspace}', workspace));
}

async function requireSuccess(argv, options) {
  const result = await execute(argv, options);
  if (result.code !== 0 || result.stopped || result.error) throw new Error(`${argv[0]} failed: ${result.error ?? result.stopReason ?? result.output}`);
  return result.output.trim();
}

function usage(file) {
  if (!fs.existsSync(file)) return { tokens: null, costUsd: null };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['tokens', 'costUsd']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) {
      throw new Error(`runner result ${key} must be a nonnegative finite number`);
    }
  }
  return { tokens: value.tokens ?? null, costUsd: value.costUsd ?? null };
}

export function summarize(trials, planned) {
  return Object.fromEntries(['before', 'after'].map((arm) => {
    const rows = trials.filter((trial) => trial.arm === arm);
    const passed = rows.filter((trial) => trial.verdict === 'passed').length;
    const count = planned ?? rows.length;
    const total = (key) => rows.length && rows.length === count && rows.every((row) => row[key] !== null) ? rows.reduce((sum, row) => sum + row[key], 0) : null;
    const costUsd = total('costUsd');
    return [arm, {
      trials: rows.length, planned: count, notRun: count - rows.length, passed, failed: rows.filter((trial) => trial.verdict === 'failed').length,
      errors: rows.filter((trial) => trial.verdict === 'error').length,
      passRate: count ? passed / count : null, tokens: total('tokens'), costUsd,
      costPerPassed: passed && costUsd !== null ? costUsd / passed : null,
      durationMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    }];
  }));
}

export function compare(trials) {
  const pairs = new Map();
  for (const trial of trials) {
    const key = JSON.stringify([trial.task, trial.repetition]);
    if (!pairs.has(key)) pairs.set(key, { task: trial.task, repetition: trial.repetition });
    pairs.get(key)[trial.arm] = trial.verdict;
  }
  return [...pairs.values()].map((pair) => ({
    ...pair,
    change: !pair.before || !pair.after || pair.before === 'error' || pair.after === 'error' ? 'inconclusive'
      : pair.before === pair.after ? 'unchanged' : pair.after === 'passed' ? 'improved' : 'regressed',
  }));
}

function saveReport(file, report) {
  report.summary = summarize(report.trials, report.plannedTrialsPerArm);
  report.pairs = compare(report.trials);
  write(file, `${JSON.stringify(report, null, 2)}\n`);
  const cell = (value) => value === null ? 'unknown' : String(value);
  const rows = Object.entries(report.summary).map(([arm, row]) =>
    `| ${arm} | ${row.passed}/${row.planned} | ${row.failed} | ${row.errors} | ${row.notRun} | ${cell(row.tokens)} | ${cell(row.costUsd)} | ${cell(row.costPerPassed)} | ${row.durationMs} |`);
  const changes = report.pairs.filter((pair) => pair.change !== 'unchanged')
    .map((pair) => `- ${pair.change}: ${JSON.stringify(pair.task)}, repetition ${pair.repetition}`);
  write(`${file}.md`, [
    '# Team asset comparison', '',
    `Code: \`${report.codeCommit}\`; tool: \`${report.tool}\`.`,
    `Before: \`${report.teamCommits.before ?? 'none'}\`; after: \`${report.teamCommits.after ?? 'none'}\`.`, '',
    '| Arm | Passed/planned | Failed | Errors | Not run | Tokens | Cost USD | Cost/success USD | Agent time ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
    'Missing usage is unknown. Errors count in the planned-trial denominator. Results apply to these tasks and this runner.', '',
    ...changes, ...(report.error ? ['', `Run error: ${JSON.stringify(report.error)}`] : []), '',
  ].join('\n'));
}

/** Developer harness over the existing pull CLI; no benchmark CLI or workflow schema is introduced. */
export async function benchmarkAssets(suiteFile, reportFile) {
  const suite = readSuite(suiteFile);
  const suiteDir = path.dirname(path.resolve(suiteFile));
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, 'teamai-asset-benchmark-')));
  const report = {
    schemaVersion: 1, tool: suite.tool, runner: suite.run,
    suiteSha256: createHash('sha256').update(fs.readFileSync(suiteFile)).digest('hex'),
    plannedTrialsPerArm: suite.tasks.length * suite.repetitions,
    codeCommit: '', teamCommits: {}, baselines: [], trials: [],
  };
  const env = homeAt(root);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const options = { cwd: root, env, timeoutMs: suite.timeoutMs, signal: controller.signal };
  const git = (...args) => requireSuccess(['git', ...args], options);
  const source = (repo) => /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.startsWith('git@') ? repo : path.resolve(suiteDir, repo);
  const codeMirror = path.join(root, 'code.git');
  const teamMirror = path.join(root, 'team.git');
  try {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before benchmarking');
    await git('clone', '-q', '--bare', '--no-local', '--', source(suite.codeRepo), codeMirror);
    await git('clone', '-q', '--bare', '--no-local', '--', source(suite.teamRepo), teamMirror);
    const commit = (repo, ref) => git('-C', repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
    report.codeCommit = await commit(codeMirror, suite.codeRef);
    for (const arm of ['before', 'after']) report.teamCommits[arm] = suite[arm] === 'none' ? null : await commit(teamMirror, suite[arm]);

    const prepare = async (dir, teamCommit) => {
      const trialEnv = homeAt(dir);
      const workspace = path.join(dir, 'workspace');
      const trialOptions = { cwd: dir, env: trialEnv, timeoutMs: suite.timeoutMs, signal: controller.signal };
      await requireSuccess(['git', 'clone', '-q', '--no-local', '--', codeMirror, workspace], trialOptions);
      await requireSuccess(['git', '-C', workspace, 'checkout', '-q', '--detach', report.codeCommit], trialOptions);
      await requireSuccess(['git', '-C', workspace, 'remote', 'remove', 'origin'], trialOptions);
      const config = path.join(workspace, '.teamai', 'config.yaml');
      if (fs.existsSync(config)) throw new Error('codeRef already contains a TeamAI config; use an uninitialized task fixture');
      const running = { ...trialOptions, cwd: workspace };
      if (suite.setup) await requireSuccess(expand(suite.setup, suiteDir, workspace), running);
      if (teamCommit) {
        fs.mkdirSync(path.join(workspace, TOOL_DIRS[suite.tool]), { recursive: true });
        const clone = path.join(dir, 'team-clone');
        await requireSuccess(['git', 'clone', '-q', '--', teamMirror, clone], trialOptions);
        write(config, JSON.stringify({
          repo: { kind: 'git', localPath: clone, remote: teamMirror }, username: 'benchmark',
          scope: 'project', projectRoot: workspace, enabledAgents: [suite.tool], updatePolicy: 'skip', additionalRoles: [],
          usageReportEnabled: false, ...(suite.role ? { primaryRole: suite.role } : {}),
          ...(suite.projects ? { projects: suite.projects } : {}),
        }));
        await requireSuccess([process.execPath, CLI, 'pull', '--silent', '--force', '--team-ref', teamCommit], running);
      }
      return running;
    };

    for (let index = 0; index < suite.tasks.length; index++) {
      const task = suite.tasks[index];
      const baseline = await prepare(path.join(root, `baseline-${index}`), null);
      const checked = await execute(expand(task.check, suiteDir, baseline.cwd), baseline);
      if (checked.error || checked.stopped || checked.code === null || checked.code === 0) {
        throw new Error(`${task.id}: the check must run and fail on codeRef before any agent works`);
      }
      report.baselines.push({ task: task.id, code: checked.code });
      for (let repetition = 1; repetition <= suite.repetitions; repetition++) {
        for (const arm of repetition % 2 ? ['before', 'after'] : ['after', 'before']) {
          const trial = { task: task.id, repetition, arm, verdict: 'error', durationMs: 0, tokens: null, costUsd: null };
          try {
            const dir = path.join(root, `trial-${index}-${repetition}-${arm}`);
            const running = await prepare(dir, report.teamCommits[arm]);
            const resultFile = path.join(dir, 'usage.json');
            running.env.TEAMAI_BENCHMARK_RESULT = resultFile;
            const result = await execute(expand(suite.run, suiteDir, running.cwd), { ...running, input: task.prompt });
            trial.durationMs = result.durationMs;
            Object.assign(trial, usage(resultFile));
            if (result.error || result.stopped || result.code !== 0) throw new Error(`runner failed: ${result.error ?? result.stopReason ?? result.output}`);
            const outcome = await execute(expand(task.check, suiteDir, running.cwd), running);
            if (outcome.error || outcome.stopped || outcome.code === null) throw new Error(`check could not run: ${outcome.error ?? outcome.output}`);
            trial.verdict = outcome.code === 0 ? 'passed' : 'failed';
          } catch (error) {
            trial.error = error.message;
          }
          report.trials.push(trial);
          saveReport(reportFile, report);
          if (controller.signal.aborted) throw new Error('Benchmark interrupted');
        }
      }
    }
  } catch (error) {
    report.error = error.message;
  } finally {
    try { saveReport(reportFile, report); }
    finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      removeTemporary(root, temporary);
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/benchmark-assets.mjs <suite.json> <report.json>');
    process.exitCode = 1;
  } else {
    try {
      const report = await benchmarkAssets(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
      console.log(JSON.stringify(report.summary));
      if (report.error || report.trials.some((trial) => trial.verdict === 'error')) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
