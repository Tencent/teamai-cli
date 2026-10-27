/**
 * E2E (#1138 items 1 and 3): Cursor CLI's two roots follow the record.
 *
 * Cursor CLI keeps its transcripts under `CURSOR_DATA_DIR` and the
 * `cli-config.json` the co-author setting goes into under `CURSOR_CONFIG_DIR`,
 * each falling back to `~/.cursor` (the config root also to
 * `$XDG_CONFIG_HOME/cursor`) — read off the cursor-agent 2026.09.28 bundle.
 * Neither variable may be recorded as the root the tool's `toolPaths` entry
 * hangs off: the user `mcp.json`, `rules/` and `commands/` stay in `~/.cursor`
 * whatever the variables say.
 *
 * So `init` records the two under `cursor-data` and `cursor-config`, and every
 * later run resolves the store from that record rather than from the shell the
 * process happens to start in — the promise `CLAUDE_CONFIG_DIR` and
 * `CODEX_HOME` already have. Run the real CLI for it: the record has to survive
 * a run with the variables unset, which is the whole point.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
import { projectSlug } from '../../utils/partition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

/** Where each root is parked, relative to HOME. A root outside HOME is refused. */
const DEFAULT_ROOT = '.cursor';
const DATA_ROOT = 'cursordata';
const CONFIG_ROOT = 'cursorconfig';

interface Run {
  code: number | null;
  output: string;
}

describe('Cursor tool roots (#1138)', () => {
  let sandbox: string;
  let home: string;
  let counter = 0;

  /**
   * `extra` overrides the base environment for one run. A variable it does not
   * name is deleted rather than inherited: the developer's own CURSOR_DATA_DIR
   * must not decide what these cases record.
   */
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ENV,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      FORCE_COLOR: '0',
      ...extra,
    };
    delete base.GIT_CONFIG_GLOBAL;
    delete base.CLAUDE_CONFIG_DIR;
    delete base.CODEX_HOME;
    for (const name of ['CURSOR_DATA_DIR', 'CURSOR_CONFIG_DIR']) {
      if (!(name in extra)) delete base[name];
    }
    return base;
  };
  /** stdin is a pipe, never a terminal. A run past `timeout` ms is killed and reports code null. */
  const run = (command: string, args: string[], cwd: string, extra?: NodeJS.ProcessEnv, timeout?: number): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(extra), input: '', timeout });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output;
  };
  const teamai = (args: string[], cwd: string, extra?: NodeJS.ProcessEnv, timeout?: number): Run =>
    run('node', [CLI, ...args], cwd, extra, timeout);

  /**
   * A business repo with one commit and an https origin on a closed local port:
   * init parses the remote, and the self-heal skips one it cannot parse.
   */
  const project = (): string => {
    const repo = path.join(sandbox, `cursor-roots-${++counter}`);
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# project\n');
    gitOk(['init', '-q', '-b', 'main'], repo);
    gitOk(['add', '-A'], repo);
    gitOk(['commit', '-q', '-m', 'project'], repo);
    gitOk(['remote', 'add', 'origin', `https://127.0.0.1:9/team/cursor-roots-${counter}.git`], repo);
    return repo;
  };

  /** The roots saved in the member's project config, as `teamai` reads them. */
  const toolRoots = (repo: string): Record<string, string> | undefined => {
    const configPath = path.join(home, '.teamai', 'projects', projectSlug(repo), 'config.yaml');
    return YAML.parse(fs.readFileSync(configPath, 'utf8')).toolRoots;
  };

  /** One Cursor transcript under `<root>/projects`, in the shape the adapter lists. */
  const plantTranscript = (root: string, workspace: string, id: string): string => {
    const dir = path.join(root, 'projects', workspace, 'agent-transcripts', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })}\n`);
    return file;
  };

  /** `session platforms` lists Cursor when the store it resolves to exists. */
  const cursorInstalled = (repo: string): boolean => {
    const listed = teamai(['session', 'platforms'], repo);
    expect(listed.code, listed.output).toBe(0);
    return listed.output.split('\n').some((line) => line.trim() === 'cursor: ✓ installed');
  };

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`Build first: ${CLI} is missing`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cursor-roots-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, DEFAULT_ROOT), { recursive: true });
  });

  afterAll(async () => {
    await waitForDetachedChildren();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('records both roots under cursor-data and cursor-config, never under cursor', () => {
    const repo = project();
    const data = path.join(home, DATA_ROOT);
    const config = path.join(home, CONFIG_ROOT);

    const init = teamai(
      ['init', '.', '--provider', 'git', '--agent', 'cursor'],
      repo,
      { CURSOR_DATA_DIR: data, CURSOR_CONFIG_DIR: config },
    );

    expect(init.code, init.output).toBe(0);
    expect(init.output).toContain(`Recorded CURSOR_DATA_DIR as the Cursor transcripts root: ${data}`);
    expect(init.output).toContain(`Recorded CURSOR_CONFIG_DIR as the Cursor config root: ${config}`);
    // A `cursor` key would move toolPaths.cursor, which has to stay at ~/.cursor.
    expect(toolRoots(repo)).toEqual({ 'cursor-data': data, 'cursor-config': config });
  }, 120_000);

  it('resolves the transcript store from the record, not from the variable or ~/.cursor', () => {
    const repo = project();
    const data = path.join(home, DATA_ROOT);
    // A session under the default root, so "not installed" below can only mean
    // the store moved: ~/.cursor/projects is on disk the whole time.
    plantTranscript(path.join(home, DEFAULT_ROOT), 'stale', '11111111-2222-3333-4444-555555555555');
    expect(cursorInstalled(repo), 'with nothing recorded, ~/.cursor/projects is the store').toBe(true);

    const init = teamai(
      ['init', '.', '--provider', 'git', '--agent', 'cursor'],
      repo,
      { CURSOR_DATA_DIR: data, CURSOR_CONFIG_DIR: path.join(home, CONFIG_ROOT) },
    );
    expect(init.code, init.output).toBe(0);

    // Neither variable is in this run's environment: only the record can redirect.
    expect(cursorInstalled(repo), 'the recorded root has no projects/ yet, and ~/.cursor is ignored').toBe(false);

    expect(fs.existsSync(plantTranscript(data, 'moved', '99999999-8888-7777-6666-555555555555'))).toBe(true);
    expect(cursorInstalled(repo), 'the recorded root is the store now').toBe(true);
  }, 120_000);

  it('clears the record when the variables go blank, and ~/.cursor comes back', () => {
    const repo = project();
    plantTranscript(path.join(home, DEFAULT_ROOT), 'stale', '11111111-2222-3333-4444-555555555555');

    const recorded = teamai(
      ['init', '.', '--provider', 'git', '--agent', 'cursor'],
      repo,
      { CURSOR_DATA_DIR: path.join(home, DATA_ROOT), CURSOR_CONFIG_DIR: path.join(home, CONFIG_ROOT) },
    );
    expect(recorded.code, recorded.output).toBe(0);
    expect(toolRoots(repo)).toBeDefined();

    // Set-but-blank is the explicit way to say the relocation is over.
    const cleared = teamai(
      ['init', '.', '--provider', 'git', '--agent', 'cursor', '--force'],
      repo,
      { CURSOR_DATA_DIR: '', CURSOR_CONFIG_DIR: '' },
    );

    expect(cleared.code, cleared.output).toBe(0);
    expect(cleared.output).toContain('CURSOR_DATA_DIR is blank');
    expect(cleared.output).toContain('CURSOR_CONFIG_DIR is blank');
    expect(toolRoots(repo)).toBeUndefined();
    expect(cursorInstalled(repo), 'back to ~/.cursor/projects').toBe(true);
  }, 120_000);
});
