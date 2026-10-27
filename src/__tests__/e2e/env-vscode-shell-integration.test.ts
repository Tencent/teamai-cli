import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── bash under VS Code / CodeBuddy shell integration, through the real CLI ──
//
// The integration's init file sources ~/.bashrc, where `teamai pull` put the env
// loader, then saves the scalar PROMPT_COMMAND the loader set and replaces it
// with its own hook, which evaluates the saved one and then reports the end of
// the command (OSC 633;D). The loader's first prompt wraps that hook in turn: the
// two evaluated each other until the shell hung after its first command.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const bashes = [...new Set(['/bin/bash', 'bash'])].filter((bash) => spawnSync(bash, ['-c', 'true']).status === 0);

// The parts of VS Code's shellIntegration-bash.sh that set PROMPT_COMMAND.
const INTEGRATION = [
  '. ~/.bashrc',
  '__vsc_prompt_cmd_original() {',
  '  __vsc_status="$?"',
  '  builtin eval "${__vsc_original_prompt_command:-}"',
  '  builtin printf "done:%s\\n" "$__vsc_status"',
  '}',
  '__vsc_original_prompt_command=${PROMPT_COMMAND:-}',
  'PROMPT_COMMAND=__vsc_prompt_cmd_original',
  '',
].join('\n');

describe.skipIf(bashes.length === 0)('bash under VS Code shell integration through the real CLI', () => {
  let sandbox: string;
  let home: string;
  let project: string;
  let integration: string;

  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: '/bin/bash', FORCE_COLOR: '0' };
    for (const key of Object.keys(e)) if (key.startsWith('__TEAMAI_ENV_') || key === 'BASH_ENV' || key === 'PROMPT_COMMAND') delete e[key];
    return e;
  };
  const git = (args: string[], cwd: string): void => {
    execFileSync('git', args, { cwd, env: env(), stdio: 'pipe' });
  };
  const teamai = (args: string[], cwd: string): { code: number | null; output: string } => {
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: 'utf-8' });
    return { code: run.status, output: `${run.stdout}${run.stderr}` };
  };

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-env-vscode-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.copyFileSync(path.join(process.env.HOME!, '.gitconfig'), path.join(home, '.gitconfig'));
    git(['config', '--global', 'protocol.file.allow', 'always'], sandbox);

    const url = 'https://git.example.com/team/vscode.git';
    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(path.join(seed, 'env'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), `team: team-vscode\nrepo: ${url}\nprovider: git\nreviewers: []\n`);
    fs.writeFileSync(path.join(seed, 'env', 'env.yaml'), 'variables:\n  - key: MARKER\n    value: from-team\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    const remote = path.join(sandbox, 'vscode.git');
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);

    project = path.join(sandbox, 'work');
    fs.mkdirSync(project, { recursive: true });
    git(['init', '-q', '-b', 'main'], project);
    const init = teamai(['init', url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], project);
    expect(init.code, init.output).toBe(0);
    const pull = teamai(['pull'], project);
    expect(pull.code, pull.output).toBe(0);
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8')).toContain('env-loader.sh');

    integration = path.join(sandbox, 'shellIntegration-bash.sh');
    fs.writeFileSync(integration, INTEGRATION);
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // An interactive bash ignores SIGTERM: a hang is killed, and fails on run.error.
  it.each(bashes)('%s reaches the end of every command and keeps the team env', (bash) => {
    const run = spawnSync(bash, ['--init-file', integration, '-i'], {
      cwd: project, env: env(), encoding: 'utf-8', timeout: 20_000, killSignal: 'SIGKILL',
      input: 'printf "env:%s\\n" "$MARKER"\nfalse\nexit 0\n',
    });

    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.split('\n').filter((line) => /^(env|done):/.test(line))).toEqual(['done:0', 'env:from-team', 'done:0', 'done:1']);
  });
});
