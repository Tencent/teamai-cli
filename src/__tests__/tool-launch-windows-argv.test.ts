import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { batchLaunchOf, spawnCommand, spawnCommandSync } from '@teamai/shared/exec';
import { runTool } from '@teamai/runtime-tools/headless';
import { executableOf, LAUNCH_ORDER, launchAdapterOf } from '../launch-registry.js';

const isWindows = process.platform === 'win32';
const BACKSLASH = String.fromCodePoint(92);

/** Arguments cmd.exe or Windows argv parsing would mangle if quoted wrongly (sandcastle's set). */
const NASTY_ARGS = [
  'plain',
  'has spaces in it',
  '',
  "single ' quote",
  'double " quote',
  `mixed 'single' and "double"`,
  '100% sure, %PATH% and %%',
  'caret ^ and ^^',
  'amp & and &&',
  'pipe | and ||',
  'redirects < > >> 2>&1',
  'parens ( ) and !bang!',
  `trailing backslash${BACKSLASH}`,
  `backslash before quote ${BACKSLASH}" here`,
  `C:${BACKSLASH}Program Files${BACKSLASH}thing${BACKSLASH}`,
  'claude-fable-5[1m]',
  '$HOME `whoami` $(id)',
  'unicode: café — 日本語',
];

const PROMPT = `Fix "the bug" in it's & | ^ %PATH% ${NASTY_ARGS.join(' ')}`;
const MULTILINE = 'Name one color.\n\nReply with only a JSON value.';

/** Each tool's real call argv for `prompt`, as teamai builds it. */
/** Why cmd.exe cannot start `executable` with `args`, or undefined when it can. */
const refusalOf = (executable: string, args: readonly string[]): string | undefined => {
  const launch = batchLaunchOf(executable, args, 'C:\\Windows\\system32\\cmd.exe');

  return launch?.ok === false ? launch.message : undefined;
};

const profiles = LAUNCH_ORDER.map((tool) => {
  const call = launchAdapterOf(tool).call;

  return { tool, executable: executableOf(tool), takes: call.prompt, args: (prompt: string) => call.args({ prompt, promptFile: 'C:\\t\\prompt.md', lastMessageFile: 'C:\\t\\last.txt', opencodeMajor: 2 }) };
});

describe('arguments for an npm .cmd shim', () => {
  it.each(profiles)('lets $tool pass any prompt and nasty arguments that hold no newline', ({ executable, args }) => {
    expect(refusalOf(`C:\\npm\\${executable}.cmd`, [...args(PROMPT), ...NASTY_ARGS])).toBeUndefined();
  });

  it.each(profiles.filter((profile) => profile.takes === 'argv'))('refuses a multi-line prompt $tool takes as an argument, naming stdin', ({ executable, args }) => {
    expect(refusalOf(`C:\\npm\\${executable}.cmd`, args(MULTILINE))).toBe(
      `${executable}.cmd is a batch file, which runs under cmd.exe, and cmd.exe cannot pass an argument containing a newline. Pass that text on stdin, or run the tool's .exe instead of its npm shim.`,
    );
  });

  it.each(profiles.filter((profile) => profile.takes !== 'argv'))('takes a multi-line prompt to $tool off the command line', ({ executable, args }) => {
    expect(refusalOf(`C:\\npm\\${executable}.cmd`, args(MULTILINE))).toBeUndefined();
  });

  it('refuses a command line over the cmd.exe limit once escaped', () => {
    expect(refusalOf('C:\\npm\\copilot.cmd', ['-p', '%'.repeat(2100)])).toMatch(/^The command line for copilot\.cmd is too long for cmd\.exe: \d+ characters once escaped, over its 8191-character limit\./);
  });

  it('starts a batch file through cmd.exe with delayed expansion off, and leaves an .exe to cross-spawn', () => {
    expect({
      shim: batchLaunchOf('C:\\npm\\claude.cmd', ['-p'], 'C:\\Windows\\system32\\cmd.exe'),
      exe: batchLaunchOf('C:\\tools\\claude.exe', [MULTILINE, 'x'.repeat(9000)], 'cmd.exe'),
    }).toEqual({ shim: { ok: true, command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', expect.stringMatching(/^"C:\\npm\\claude\.cmd .*-p.*"$/)] }, exe: undefined });
  });

  it('writes the batch file with backslashes, as cmd.exe needs them', () => {
    const launch = batchLaunchOf('C:/npm/claude.cmd', ['-p'], 'cmd.exe');

    expect(launch?.ok && launch.args.at(-1)).toMatch(/^"C:\\npm\\claude\.cmd /);
  });
});

/** The shim npm's cmd-shim writes for a JS bin, pointed at a printer of its argv. */
const NPM_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\argv.js" %*',
  '',
].join('\r\n');

const Printed = z.object({ argv: z.array(z.string()), stdin: z.string() });

describe.runIf(isWindows)('each launch profile through an npm .cmd shim on Windows', () => {
  let dir = '';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cmd-argv-'));
    fs.writeFileSync(path.join(dir, 'argv.js'), "const fs = require('node:fs'); process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(profiles)('delivers $tool its real arguments and prompt verbatim', async ({ executable, takes, args }) => {
    const shim = path.join(dir, `${executable}.cmd`);

    fs.writeFileSync(shim, NPM_CMD_SHIM);
    const argv = [...args(PROMPT), ...NASTY_ARGS];

    const run = await runTool({ executable: shim, args: argv, cwd: dir, env: process.env, stdin: takes === 'stdin' ? MULTILINE : '', timeoutMs: 30_000, detached: false });

    expect(run).toMatchObject({ code: 0, stderr: '' });
    expect(Printed.parse(JSON.parse(run.stdout))).toEqual({ argv, stdin: takes === 'stdin' ? MULTILINE : '' });
  });

  it('starts the shim with the system cmd.exe when the tool runs with an environment that has no ComSpec', async () => {
    const shim = path.join(dir, 'claude.cmd');

    fs.writeFileSync(shim, NPM_CMD_SHIM);
    const { ComSpec: _comspec, COMSPEC: _upper, ...confined } = process.env;

    const run = await runTool({ executable: shim, args: ['-p'], cwd: dir, env: confined, stdin: '', timeoutMs: 30_000, detached: false });

    expect(Printed.parse(JSON.parse(run.stdout))).toEqual({ argv: ['-p'], stdin: '' });
  });

  it('delivers a step launch or env exec through spawnCommand its arguments verbatim', async () => {
    const shim = path.join(dir, 'claude.cmd');

    fs.writeFileSync(shim, NPM_CMD_SHIM);
    const child = spawnCommand(shim, [PROMPT, ...NASTY_ARGS], { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';

    child.stdout?.setEncoding('utf8').on('data', (text: string) => { stdout += text; });
    child.stdin?.end('');
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));

    expect(code).toBe(0);
    expect(Printed.parse(JSON.parse(stdout))).toEqual({ argv: [PROMPT, ...NASTY_ARGS], stdin: '' });
  });

  it('finds the .cmd shim of a bare name on the child\'s PATH, past npm\'s extensionless sh shim, and delivers its arguments verbatim', async () => {
    const bin = path.join(dir, 'npm-global');

    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), 'npm\'s sh shim, which cmd.exe cannot start\n');
    fs.writeFileSync(path.join(bin, 'claude.cmd'), NPM_CMD_SHIM);
    fs.copyFileSync(path.join(dir, 'argv.js'), path.join(bin, 'argv.js'));
    const child = spawnCommand('claude', [PROMPT, ...NASTY_ARGS], { cwd: dir, env: { ...process.env, PATH: `${bin};${process.env.PATH ?? ''}` }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';

    child.stdout?.setEncoding('utf8').on('data', (text: string) => { stdout += text; });
    child.stdin?.end('');
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));

    expect(code).toBe(0);
    expect(Printed.parse(JSON.parse(stdout))).toEqual({ argv: [PROMPT, ...NASTY_ARGS], stdin: '' });
  });

  it('runs a tool named by its bare name through the .cmd shim on the child\'s PATH, past npm\'s extensionless sh shim', async () => {
    const bin = path.join(dir, 'npm-global-run');

    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), 'npm\'s sh shim, which cmd.exe cannot start\n');
    fs.writeFileSync(path.join(bin, 'claude.cmd'), NPM_CMD_SHIM);
    fs.copyFileSync(path.join(dir, 'argv.js'), path.join(bin, 'argv.js'));

    const run = await runTool({ executable: 'claude', args: [PROMPT, ...NASTY_ARGS], cwd: dir, env: { ...process.env, PATH: `${bin};${process.env.PATH ?? ''}` }, stdin: '', timeoutMs: 30_000, detached: false });

    expect(run).toMatchObject({ code: 0, stderr: '' });
    expect(Printed.parse(JSON.parse(run.stdout))).toEqual({ argv: [PROMPT, ...NASTY_ARGS], stdin: '' });
  });

  it('delivers a command run to its end through spawnCommandSync its arguments verbatim, and refuses a newline as a failed spawn', () => {
    const shim = path.join(dir, 'gh.cmd');

    fs.writeFileSync(shim, NPM_CMD_SHIM);
    const ran = spawnCommandSync(shim, [PROMPT, ...NASTY_ARGS], { cwd: dir, env: process.env, encoding: 'utf8', input: '', windowsHide: true });

    expect(ran.status).toBe(0);
    expect(Printed.parse(JSON.parse(String(ran.stdout)))).toEqual({ argv: [PROMPT, ...NASTY_ARGS], stdin: '' });
    expect(spawnCommandSync(shim, ['-p', MULTILINE], { cwd: dir })).toMatchObject({ status: null, stderr: expect.stringContaining('cannot pass an argument containing a newline') });
  });

  it('throws the refusal from spawnCommand, as a failed spawn, when an argument holds a newline', () => {
    expect(() => spawnCommand(path.join(dir, 'copilot.cmd'), ['-p', MULTILINE], { cwd: dir })).toThrow('cannot pass an argument containing a newline');
  });

  it('refuses before starting the shim when a prompt argument holds a newline', async () => {
    const shim = path.join(dir, 'copilot.cmd');

    fs.writeFileSync(shim, NPM_CMD_SHIM);

    const run = await runTool({ executable: shim, args: ['-p', MULTILINE, '-s'], cwd: dir, env: process.env, stdin: '', timeoutMs: 30_000, detached: false });

    expect(run).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('cannot pass an argument containing a newline') });
  });
});
