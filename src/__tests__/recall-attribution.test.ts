/**
 * Recall attribution acceptance harness (#884). Each row drives `recall()` and
 * the real hook dispatcher (`hookDispatchCli`, the real handler registry) with
 * the payloads an agent sends, then asserts on the votes the scope holds.
 *
 * Every row of the spec's acceptance contract is listed here, named after the
 * ticket that shipped it.
 * Paths are whatever recall printed, so the rows hold on every OS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { LocalConfig } from '../types.js';
import type { ExtensionContext } from './helpers/pi-extensions.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  // The dispatcher's detached background pass: nothing under test runs there.
  // A foreground dispatch with a background handler still spawns the detached
  // child for real (spawnBackground): on win32 that goes through the WMI
  // escape first, whose promise only settles via the process's own
  // 'close'/'error' event. A bare `on: vi.fn()` never fires it, hanging every
  // such test until timeout -- so this fires 'close' with a success code,
  // same as hook-dispatch-cli.test.ts's fakePowerShell helper.
  spawn: vi.fn(() => {
    const child = {
      stdin: { on: vi.fn(), end: vi.fn((_: string, done: () => void) => done()) },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'close') setTimeout(() => cb(0), 0);
        return child;
      },
      unref: vi.fn(),
    };
    return child;
  }),
}));
vi.mock('../pull.js', () => ({ pull: vi.fn(async () => undefined), settleLateUsageReport: vi.fn(async () => undefined) }));
vi.mock('../update.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../update.js')>()),
  doUpdate: vi.fn(async () => undefined),
}));
vi.mock('../local-agent.js', () => ({ reportAndSyncFromHook: vi.fn(async () => null) }));
vi.mock('../code-knowledge-recall.js', () => ({ queryCodeKnowledge: vi.fn(async () => []) }));
// The opt-in judge's local-CLI verdict: every candidate it is sent was used.
const { judgeAdoption } = vi.hoisted(() => ({ judgeAdoption: vi.fn(async (_reply: string, ids: string[]) => ids) }));
vi.mock('../votes-judge.js', () => ({ judgeAdoption }));
// A vote sync lands in a reports checkout beside the clone instead of being
// pushed. The mock publishes immediately: the write lands, `onDelivered` hooks
// run, and "origin" is that same directory's current content.
vi.mock('../utils/reports-branch.js', async () => {
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  // Beside the data home, never beside a Windows row's `C:\kb` (data, not a place to write).
  const checkout = (config: LocalConfig): string => {
    const dir = nodePath.join(config.dataHome ?? nodePath.dirname(config.repo.localPath), 'reports-wt');
    nodeFs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    updateReports: vi.fn(async (
      config: LocalConfig,
      write: (wt: string, ctx: { onDelivered: (fn: () => Promise<void>) => void }) => Promise<unknown>,
    ) => {
      const delivered: (() => Promise<void>)[] = [];
      const change = await write(checkout(config), { onDelivered: (fn) => { delivered.push(fn); } });
      if (change != null) for (const fn of delivered) await fn();
      return { status: change != null ? 'published' : 'already-present' };
    }),
    readReportsOriginFile: vi.fn(async (wt: string, relPath: string) => {
      try { return nodeFs.readFileSync(nodePath.join(wt, relPath), 'utf8'); } catch { return null; }
    }),
    ensureReportsWorktree: vi.fn(async (config: LocalConfig) => checkout(config)),
    readableReportsWorktree: vi.fn(async (config: LocalConfig) => checkout(config)),
    indexableVotesDir: vi.fn(async (config: LocalConfig) => nodePath.join(checkout(config), 'votes')),
  };
});

const { hookDispatchCli } = await import('../hook-dispatch-cli.js');
const { resolveProjectDataHome, saveLocalConfigForScope } = await import('../config.js');
const { recall } = await import('../recall.js');
const { buildIndex } = await import('../utils/search-index.js');
const { loadUserVotes } = await import('../votes.js');
const { getProjectSearchIndexPath, getUserLearningsDir, getUserSearchIndexPath, getVotesDir } = await import('../types.js');
const { readRecallLog, recallLogPath } = await import('../recall-log.js');
const { drainRecallLog } = await import('../recall-adoption.js');
const { acquireLock, releaseLock } = await import('../update.js');
const { parseTranscriptForVotes } = await import('../transcript-parser.js');
const { loadOpencodePlugin } = await import('./helpers/opencode-plugin.js');
const { loadOmpExtension, loadPiExtension } = await import('./helpers/pi-extensions.js');
const { showStats } = await import('../stats.js');
const { setStderrOnly } = await import('../utils/logger.js');
const { reconcileHooks } = await import('../hooks.js');

const SESSION = 'sess-main';
/** A Codex session started from the main session's shell, which also sees CLAUDE_CODE_SESSION_ID. */
const CODEX = 'sess-codex';
/** Both session variables a `codex exec` run from Claude's shell sees: two candidates, so the run is ambiguous. */
const NESTED_ENV = { CLAUDE_CODE_SESSION_ID: SESSION, CODEX_SESSION_ID: CODEX };
const T0 = Date.parse('2026-09-01T09:00:00.000Z');
/** Where a Windows member's team repo is, as data: see Harness.windowsTeamRepo. */
const WINDOWS_REPO = 'C:\\kb';
const WINDOWS_DOC = 'C:\\kb\\learnings\\redis-timeout.md';
/** Where a Linux or macOS member's team repo is, as data: see Harness.posixTeamRepo. */
const POSIX_REPO = '/posix/kb';
const POSIX_DOC = '/posix/kb/learnings/redis-timeout.md';
/** A Cursor conversation, and a subagent's own conversation (Cursor runs each subagent under a fresh one). */
const CURSOR = 'conv-main';
const CURSOR_CHILD = 'conv-child';
/** A Copilot CLI session, and a subagent's own session. */
const COPILOT = '5f0c9d2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const COPILOT_CHILD = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
/** An OpenCode session, and the child session its `task` tool runs a subagent in. */
const OPENCODE = 'ses_parent';
const OPENCODE_CHILD = 'ses_child';
/** A Pi session (its bash tool's PI_SESSION_ID). */
const PI = 'pi-sess';
/** An OMP session, and the recall subagent's own session, with the ctx.agent OMP >= 18.3.2 gives each. */
const OMP = 'omp-main';
const OMP_SUB = 'omp-sub';
const OMP_MAIN_AGENT: OmpAgent = { kind: 'main', id: 'Main', name: 'main', depth: 0 };
const OMP_RECALL_AGENT: OmpAgent = { kind: 'sub', id: '0-TeamaiRecall', name: 'teamai-recall', depth: 1, parentId: 'Main' };

/** Cursor's `tool_output`: the tool's result as a JSON string. */
function cursorOutput(result: Record<string, unknown>): Record<string, unknown> {
  return { tool_output: JSON.stringify(result) };
}

/** Copilot's `tool_result` (snake_case, as TeamAI's PascalCase events get it) for a call that completed. */
function copilotResult(text: string): Record<string, unknown> {
  return { tool_result: { result_type: 'success', text_result_for_llm: text } };
}

function doc(title: string, tags: string[], body: string): string {
  return `---\ntitle: "${title}"\nauthor: tester\ndate: 2026-05-01\ntags: [${tags.join(', ')}]\n---\n\n${body}\n`;
}

/** The subagent a Claude hook fires in: its payloads carry `agent_id`, and `agent_type` when the agent has one. */
interface Subagent {
  id: string;
  type?: string;
}

/** The recall subagent as Claude Code reports it: `agent_type` is the agent file's `name`. */
const RECALL_SUBAGENT: Subagent = { id: 'agent-recall', type: 'teamai-recall' };
const GENERAL_SUBAGENT: Subagent = { id: 'agent-general', type: 'general-purpose' };

/** OMP's `ctx.agent` (ExtensionAgentIdentity). */
type OmpAgent = NonNullable<ExtensionContext['agent']>;

interface RecallRun {
  /** recall's stdout. */
  output: string;
  /** The `File:` paths it printed, in order. */
  files: string[];
  /** The run id on the region's start line, or on the no-hit line, if any. */
  run?: string;
}

/** One agent session against a project scope and the user scope it may inherit. */
class Harness {
  readonly tmp: string;
  readonly root: string;
  project!: LocalConfig;
  user!: LocalConfig;
  teamRepo!: string;
  /** The project's recalled docs, by name. */
  readonly docs: Record<string, string> = {};

  constructor() {
    this.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-attr-')));
    this.root = path.join(this.tmp, 'proj');
  }

  async setUp(options: { inheritUserScope?: boolean } = {}): Promise<void> {
    process.env.HOME = path.join(this.tmp, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    // Copilot runs the built-ins it has installed.
    await reconcileHooks(path.join(process.env.HOME, '.copilot', 'hooks', 'teamai.json'), 'copilot');

    // User scope: one learning in the machine-local mirror, which is a knowledge root.
    const userRepo = path.join(process.env.HOME, '.teamai', 'team-repo');
    fs.mkdirSync(userRepo, { recursive: true });
    fs.writeFileSync(path.join(userRepo, 'teamai.yaml'), 'team: user-team\nrepo: https://example.test/acme/user-team.git\n');
    this.user = { repo: { localPath: userRepo, remote: 'https://example.test/acme/user-team.git' }, username: 'tester', scope: 'user', additionalRoles: [] };
    fs.writeFileSync(path.join(process.env.HOME, '.teamai', 'config.yaml'), YAML.stringify(this.user));
    fs.mkdirSync(getUserLearningsDir(), { recursive: true });
    fs.writeFileSync(path.join(getUserLearningsDir(), 'cache-warmup.md'), doc('Cache warmup', ['cache', 'warmup'], 'Warm the cache first.'));
    await buildIndex({ learningsDir: getUserLearningsDir(), indexPath: getUserSearchIndexPath() });

    // Project scope.
    fs.mkdirSync(this.root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: this.root });
    const dataHome = await resolveProjectDataHome(this.root);
    this.teamRepo = path.join(dataHome, 'team-repo');
    const learnings = path.join(this.teamRepo, 'learnings');
    const docsDir = path.join(this.teamRepo, 'docs');
    fs.mkdirSync(learnings, { recursive: true });
    fs.mkdirSync(path.join(docsDir, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(this.teamRepo, 'teamai.yaml'), 'team: team-a\nrepo: https://example.test/acme/team-a.git\n');
    fs.writeFileSync(path.join(learnings, 'redis-timeout.md'), doc('Redis timeout fix', ['redis', 'timeout'], 'Raise the pool size SNIPPETMARK.'));
    fs.writeFileSync(path.join(learnings, 'setup.md'), doc('Setup guide', ['setup'], 'Run the installer.'));
    // A doc that shares the `learnings/setup.md` suffix with the learning above.
    fs.writeFileSync(path.join(docsDir, 'learnings', 'setup.md'), doc('Setup reference', ['setup'], 'Installer flags.'));
    // A same-named file under the knowledge roots that no recall returns.
    fs.mkdirSync(path.join(this.teamRepo, 'team-B', 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(this.teamRepo, 'team-B', 'learnings', 'setup.md'), doc('Other setup', ['setup'], 'Another checkout.'));
    this.docs['redis-timeout'] = path.join(learnings, 'redis-timeout.md');
    this.docs.setup = path.join(learnings, 'setup.md');
    this.docs['team-B/setup'] = path.join(this.teamRepo, 'team-B', 'learnings', 'setup.md');
    this.docs['cache-warmup'] = path.join(getUserLearningsDir(), 'cache-warmup.md');

    this.project = {
      repo: { localPath: this.teamRepo, remote: 'https://example.test/acme/team-a.git' },
      username: 'tester', scope: 'project', projectRoot: this.root, additionalRoles: [], dataHome,
      ...(options.inheritUserScope ? { inheritUserScope: true } : {}),
    };
    await saveLocalConfigForScope(this.project);
    await buildIndex({ learningsDir: learnings, docsDir, indexPath: getProjectSearchIndexPath(this.project) });
    process.chdir(this.root);
  }

  /** Set (a string) or clear (undefined) environment variables for the steps that follow. */
  env(vars: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  /** Move the clock to `hours` after the start of the trace. */
  at(hours: number): void {
    vi.setSystemTime(T0 + hours * 60 * 60 * 1000);
  }

  /**
   * The main agent, or `options.agent`, runs `teamai recall` from its shell
   * (the session in the environment, as Claude Code sets it for subagents
   * too), then its Bash PostToolUse arrives. `options.env` replaces the
   * session variables the run sees; `claim: false` sends no PostToolUse, as
   * when the call that ran it is another agent's.
   */
  async recall(query: string, options: {
    check?: boolean; dryRun?: boolean; caller?: string; agent?: Subagent;
    env?: Record<string, string | undefined>; claim?: false;
  } = {}): Promise<RecallRun> {
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as never);
    // log.info's lines (the no-hit line) reach stdout through console.log, in
    // a recall process of its own: the dispatcher's stderr-only mode, left on
    // by an earlier hook in this process, is not recall's.
    const print = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output += `${args.map(String).join(' ')}\n`; });
    const stderrOnly = setStderrOnly(false);
    const vars = options.env ?? { CLAUDE_CODE_SESSION_ID: SESSION };
    const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
    this.env(vars);
    try {
      await recall(query, { check: options.check, dryRun: options.dryRun, caller: options.caller });
    } finally {
      write.mockRestore();
      print.mockRestore();
      setStderrOnly(stderrOnly);
      this.env(before);
    }
    const flags = `${options.check ? ' --check' : ''}${options.caller ? ` --caller ${options.caller}` : ''}`;
    if (options.claim !== false) {
      await this.postToolUse('Bash', { command: `teamai recall${flags} "${query}"`, description: 'Search team knowledge' },
        { stdout: output, stderr: '', interrupted: false, isImage: false }, this.root, options.agent);
    }
    return {
      output,
      files: [...output.matchAll(/^File: (.+)$/gm)].map((m) => m[1]),
      run: output.match(/^(?:--- \[teamai:recall:start\] --- \(\d+ results?\)|.*No matching learnings found for ".*"\.) run=(\S+)$/m)?.[1],
    };
  }

  /**
   * Claude's `Read` of `filePath` by the main agent or `options.agent` of
   * `options.session` (default: the main session), from the project root
   * unless `cwd` says otherwise (null: no cwd).
   */
  async read(filePath: string, options: { cwd?: string | null; agent?: Subagent; session?: string } = {}): Promise<void> {
    const content = fs.existsSync(path.resolve(this.root, filePath)) ? fs.readFileSync(path.resolve(this.root, filePath), 'utf-8') : '';
    await this.postToolUse('Read', { file_path: filePath },
      { type: 'text', file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } },
      options.cwd, options.agent, options.session);
  }

  /**
   * A shell call's PostToolUse in `options.session` (default: the main
   * session), from the project root: Claude's Bash, or Codex's, whose
   * `tool_response` is the output string.
   */
  async shell(command: string, stdout: string, options: { session?: string; tool?: 'claude' | 'codex' } = {}): Promise<void> {
    const response = options.tool === 'codex' ? stdout : { stdout, stderr: '', interrupted: false, isImage: false };
    await this.postToolUse('Bash', { command }, response, this.root, undefined, options.session, options.tool);
  }

  /**
   * The team repo as a Windows machine holds it, at `C:\kb`: the scope's
   * config names it, and the index returns its docs there, so recall prints
   * `C:\kb\learnings\redis-timeout.md`. The paths are data, the same on every
   * OS; nothing is on disk at them.
   */
  async windowsTeamRepo(): Promise<void> {
    await this.teamRepoAt(WINDOWS_REPO, path.win32);
  }

  /** The team repo at `/posix/kb`, as windowsTeamRepo places it at `C:\kb`: POSIX paths on every OS, Windows CI too. */
  async posixTeamRepo(): Promise<void> {
    await this.teamRepoAt(POSIX_REPO, path.posix);
  }

  private async teamRepoAt(root: string, paths: typeof path.posix): Promise<void> {
    await saveLocalConfigForScope({ ...this.project, repo: { ...this.project.repo, localPath: root } });
    const indexPath = getProjectSearchIndexPath(this.project);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as { entries: Array<{ path?: string }> };
    for (const entry of index.entries) {
      if (entry.path) entry.path = paths.join(root, ...path.relative(this.teamRepo, entry.path).split(path.sep));
    }
    fs.writeFileSync(indexPath, JSON.stringify(index));
  }

  /** Add a learning to the project's team repo under `name` (which may hold a space), and reindex. */
  async addLearning(name: string, content: string): Promise<string> {
    const file = path.join(this.teamRepo, 'learnings', name);
    fs.writeFileSync(file, content);
    await buildIndex({
      learningsDir: path.join(this.teamRepo, 'learnings'), docsDir: path.join(this.teamRepo, 'docs'),
      indexPath: getProjectSearchIndexPath(this.project),
    });
    return file;
  }

  /** A PowerShell call's PostToolUse (Claude's and CodeBuddy's `PowerShell` tool) from the project root. */
  async powershell(command: string, stdout: string): Promise<void> {
    await this.postToolUse('PowerShell', { command }, { stdout, stderr: '', interrupted: false, isImage: false });
  }

  /** `file` relative to the project root, the cwd every call is made from. */
  rel(file: string): string {
    return path.relative(this.root, file);
  }

  /**
   * A Codex session (the only session in its environment) runs `teamai
   * recall`, and its shell call's PostToolUse claims the run.
   */
  async codexRecall(query: string): Promise<RecallRun> {
    const run = await this.recall(query, { env: { CODEX_SESSION_ID: CODEX }, claim: false });
    await this.shell(`teamai recall "${query}"`, run.output, { session: CODEX, tool: 'codex' });
    return run;
  }

  /** The Codex session's shell call. */
  async codexShell(command: string, stdout = ''): Promise<void> {
    await this.shell(command, stdout, { session: CODEX, tool: 'codex' });
  }

  async postToolUse(
    toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown, cwd: string | null = this.root, agent?: Subagent,
    session?: string, tool?: string,
  ): Promise<void> {
    await this.dispatch('post-tool-use', {
      hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: toolInput, tool_response: toolResponse,
      ...(agent ? { agent_id: agent.id, ...(agent.type ? { agent_type: agent.type } : {}) } : {}),
      ...(session ? { session_id: session } : {}),
    }, cwd, tool);
  }

  /**
   * `tool`'s PostToolUse as that agent sends it (`tool` is the dispatch tool
   * id), from the project root. `fields` carry its session (`session_id`,
   * Cursor's `conversation_id`, a subagent's `agent_id`) and its output
   * (`tool_response`, Cursor's `tool_output`, Copilot's `tool_result`): the
   * main session's `session_id` is sent only when `fields` names it.
   */
  async agentCall(tool: string, toolName: string, toolInput: Record<string, unknown>, fields: Record<string, unknown>): Promise<void> {
    await this.dispatch('post-tool-use', {
      hook_event_name: 'PostToolUse', session_id: undefined, tool_name: toolName, tool_input: toolInput, ...fields,
    }, this.root, tool);
  }

  /** `tool`'s Stop, with the session `fields` name. */
  async agentStop(tool: string, fields: Record<string, unknown>): Promise<string> {
    return this.dispatch('stop', { hook_event_name: 'Stop', session_id: undefined, ...fields }, this.root, tool);
  }

  /**
   * Copilot's SessionEnd of `session`, as its PascalCase hook config sends it:
   * the session's end, after its last turn. Returns the hook's stdout.
   */
  async copilotSessionEnd(session: string): Promise<string> {
    return this.dispatch('session-end', {
      hook_event_name: 'SessionEnd', session_id: session, timestamp: new Date().toISOString(), reason: 'complete',
    }, this.root, 'copilot');
  }

  /** Claude's SubagentStop of `agent` in the main session: it carries the parent's `session_id`. Returns the hook's stdout. */
  async subagentStop(agent: Subagent): Promise<string> {
    return this.dispatch('subagent-stop', {
      hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: agent.id, ...(agent.type ? { agent_type: agent.type } : {}),
    });
  }

  /**
   * Await `step` while the clock moves a second every 25 ms. Only `Date` is
   * faked, and the log's lock wait is timed by it, so a frozen clock would
   * keep a hook waiting for a held lock until its handler times out.
   */
  async ticking<T>(step: Promise<T>): Promise<T> {
    let settled = false;
    const result = step.finally(() => { settled = true; });
    for (let now = Date.now(); !settled; now += 1000) {
      await new Promise((r) => setTimeout(r, 25));
      vi.setSystemTime(now + 1000);
    }
    return result;
  }

  /** What `teamai pull` does with the project scope's recall log. */
  async pull(): Promise<void> {
    await drainRecallLog(this.project);
  }

  /** Lines of other sessions appended to the recall log as they are, `hours` after the start of the trace. */
  fillLog(count: number, hours: number): void {
    const ts = new Date(T0 + hours * 60 * 60 * 1000).toISOString();
    const lines: object[] = [];
    for (let i = 0; i < count; i++) {
      const n = `${hours}-${i}`;
      const other = `sess-other-${n}`;
      lines.push([
        { kind: 'run', ts, run: `run-${n}`, session: other, via: 'env', unambiguous: true, docs: [] },
        { kind: 'claim', ts, run: `run-${n}`, session: other, direct: true },
        { kind: 'evidence', ts, id: `ev-${n}`, session: other, path: '/elsewhere/notes.md', status: 'success', simple: true },
        { kind: 'consumed', ts, evidence: `ev-${hours}-${i - 1}` },
        { kind: 'link', ts, child: `${other}-child`, parent: other },
      ][i % 5]);
    }
    fs.mkdirSync(path.dirname(recallLogPath(this.project)), { recursive: true });
    fs.appendFileSync(recallLogPath(this.project), lines.map((l) => JSON.stringify(l) + '\n').join(''));
  }

  /** The recall log's lines, as the file holds them. */
  logLines(): Array<{ ts: string }> {
    return fs.readFileSync(recallLogPath(this.project), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ts: string });
  }

  /** `session`'s Stop (default: the main session), which carries no `transcript_path` here: the reducer does not need one. Returns the hook's stdout. */
  async stop(session?: string): Promise<string> {
    return this.dispatch('stop', { hook_event_name: 'Stop', stop_hook_active: false, ...(session ? { session_id: session } : {}) });
  }

  /**
   * The main session's Stop with TEAMAI_UPVOTE_JUDGE=1, as its detached pass
   * runs the judge: Claude's transcript holds `entries`, then a final reply.
   */
  async judgeStop(entries: object[], payload: Record<string, unknown> = {}): Promise<void> {
    const transcript = path.join(this.tmp, 'transcript.jsonl');
    const reply = { type: 'assistant', message: { id: 'msg-final', content: [{ type: 'text', text: 'Raised the pool size.' }] } };
    fs.writeFileSync(transcript, [...entries, reply].map((e) => `${JSON.stringify(e)}\n`).join(''));
    this.env({ TEAMAI_UPVOTE_JUDGE: '1' });
    try {
      await this.dispatch('stop', { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript, ...payload },
        this.root, 'claude', { background: true });
    } finally {
      this.env({ TEAMAI_UPVOTE_JUDGE: undefined });
    }
  }

  /** Claude's transcript entries for a Bash call that printed `stdout`: the call, then its result. */
  static bashEntries(id: string, command: string, stdout: string): object[] {
    return [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: stdout }] }, toolUseResult: { stdout, stderr: '' } },
    ];
  }

  /** `background`: run the dispatch's detached pass (its background handlers) instead of its foreground one. */
  async dispatch(
    event: string, payload: Record<string, unknown>, cwd: string | null = this.root, tool = 'claude', options: { background?: boolean } = {},
  ): Promise<string> {
    const stdinFile = path.join(this.tmp, `stdin-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(stdinFile, JSON.stringify({ session_id: SESSION, ...(cwd ? { cwd } : {}), ...payload }));
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, cb?: () => void) => {
      output += chunk.toString();
      if (typeof cb === 'function') cb();
      return true;
    }) as never);
    try {
      await hookDispatchCli(event, tool, '*', { stdinFile, bgOnly: options.background });
      // The real dispatcher runs background handlers in a detached child
      // process; the mocked spawn above does nothing, so simulate that pass
      // here. post-tool-use needs it since recall-attribution and
      // dashboard-report moved to the background (#1216) — without this the
      // attribution these tests assert never runs.
      if (!options.background && event === 'post-tool-use') {
        // readStdinFile removes the file; the real parent hands the child a
        // fresh serialization of the same payload, so rewrite it here.
        fs.writeFileSync(stdinFile, JSON.stringify({ session_id: SESSION, ...(cwd ? { cwd } : {}), ...payload }));
        await hookDispatchCli(event, tool, '*', { stdinFile, bgOnly: true });
      }
    } finally {
      write.mockRestore();
    }
    return output;
  }

  private opencode?: Awaited<ReturnType<typeof loadOpencodePlugin>>;

  /**
   * The host calls `hook` of the generated OpenCode plugin (evaluated in a
   * `vm`, from the project root), and each `teamai hook-dispatch` it spawns
   * goes to the real dispatcher with the payload the plugin wrote.
   */
  async openCode(hook: string, ...args: unknown[]): Promise<void> {
    this.opencode ??= await loadOpencodePlugin({ directory: this.root });
    const { hooks, dispatches } = this.opencode;
    await hooks[hook](...args);
    for (const { args: argv, payload } of dispatches.splice(0)) {
      // The Skill / TodoWrite matcher pass repeats the wildcard pass's payload.
      if (argv.includes('--matcher')) continue;
      await this.dispatch(argv[2], { session_id: undefined, ...payload }, null, 'opencode');
    }
  }

  /**
   * An OpenCode `bash` call in `session` runs `teamai recall`: its environment
   * is what the plugin's `shell.env` sets, in OpenCode's shell (`OPENCODE=1`),
   * plus `env` (variables it inherited). Its `tool.execute.after` claims the
   * run unless `claim: false`.
   */
  async openCodeRecall(query: string, session: string, options: { caller?: string; env?: Record<string, string>; claim?: false } = {}): Promise<RecallRun> {
    const shell = { env: {} as Record<string, string> };
    this.opencode ??= await loadOpencodePlugin({ directory: this.root });
    await this.opencode.hooks['shell.env']({ cwd: this.root, sessionID: session, callID: 'call-env' }, shell);
    const run = await this.recall(query, { env: { OPENCODE: '1', ...options.env, ...shell.env }, caller: options.caller, claim: false });
    if (options.claim !== false) {
      const command = `teamai recall${options.caller ? ` --caller ${options.caller}` : ''} "${query}"`;
      await this.openCodeBash(session, command, run.output);
    }
    return run;
  }

  /** An OpenCode `bash` call in `session` that exits with `exit`. */
  async openCodeBash(session: string, command: string, output: string, exit = 0): Promise<void> {
    await this.openCode('tool.execute.after', { tool: 'bash', sessionID: session, callID: 'call-bash', args: { command } },
      { title: command, output, metadata: { output, exit, truncated: false } });
  }

  /** OpenCode's `read` of `filePath` in `session`. */
  async openCodeRead(session: string, filePath: string): Promise<void> {
    await this.openCode('tool.execute.after', { tool: 'read', sessionID: session, callID: 'call-read', args: { filePath } },
      { title: path.basename(filePath), output: `<path>${filePath}</path>\n<type>file</type>\n<content>\n1: ---`, metadata: { preview: '---' } });
  }

  /** The `task` call in `parent` that ran subagent session `child` completes. */
  async openCodeTask(parent: string, child: string): Promise<void> {
    await this.openCode('tool.execute.after', { tool: 'task', sessionID: parent, callID: 'call-task', args: { description: 'find docs', prompt: 'find docs', subagent_type: 'teamai-recall' } },
      { title: 'find docs', output: `<task id="${child}" state="completed">`, metadata: { parentSessionId: parent, sessionId: child, model: {} } });
  }

  /** `session` goes idle: OpenCode's Stop. */
  async openCodeIdle(session: string): Promise<void> {
    await this.openCode('event', { event: { type: 'session.idle', properties: { sessionID: session } } });
  }

  private piExt?: ReturnType<typeof loadPiExtension>;
  private ompExt?: ReturnType<typeof loadOmpExtension>;
  /** The session file OMP's session manager reports for each session, when one is written. */
  private readonly ompSessionFiles: Record<string, string> = {};

  /**
   * Write OMP's session files as OMP lays them out: `parent` at
   * `<ts>_<id>.jsonl`, headed by its padded title slot and then its session
   * header, and the subagent `agent` ran in session `child` at
   * `<ts>_<id>/<agent id>.jsonl`. With `parentHeader: false` the parent's file
   * is not on disk yet; the returned function writes it.
   */
  ompSessions(parent: string, child: string, agent: OmpAgent, options: { parentHeader?: boolean } = {}): () => void {
    const parentFile = path.join(this.tmp, 'omp-sessions', `2026-09-01T09-00-00-000Z_${parent}.jsonl`);
    const artifactsDir = parentFile.slice(0, -'.jsonl'.length);
    fs.mkdirSync(artifactsDir, { recursive: true });
    const timestamp = new Date(T0).toISOString();
    const header = (id: string) => JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: timestamp, pad: ' '.repeat(128) }) + '\n'
      + JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd: this.root }) + '\n';
    const writeParent = () => fs.writeFileSync(parentFile, header(parent));
    if (options.parentHeader !== false) writeParent();
    const childFile = path.join(artifactsDir, `${agent.id}.jsonl`);
    fs.writeFileSync(childFile, header(child));
    this.ompSessionFiles[parent] = parentFile;
    this.ompSessionFiles[child] = childFile;
    return writeParent;
  }

  /**
   * The host fires `event` at the generated Pi or OMP extension (evaluated in
   * a `vm`) with the context of `session` (and OMP's `agent`), from the
   * project root. Each `teamai hook-dispatch` it runs goes to the real
   * dispatcher with the payload the extension wrote.
   */
  async bridge(tool: 'pi' | 'omp', event: string, payload: Record<string, unknown>, session: string, agent?: OmpAgent): Promise<void> {
    const ext = tool === 'pi' ? (this.piExt ??= loadPiExtension()) : (this.ompExt ??= loadOmpExtension());
    const file = tool === 'omp' ? this.ompSessionFiles[session] : undefined;
    const sessionManager = { getSessionId: () => session, ...(file ? { getSessionFile: () => file } : {}) };
    await ext.on[event](payload, { cwd: this.root, sessionManager, ...(agent ? { agent } : {}) });
    for (const { args: argv, payload: stdin } of ext.dispatches.splice(0)) {
      await this.dispatch(argv[1], { session_id: undefined, ...stdin }, null, tool);
    }
  }

  /** A Pi tool call in `session`: `tool_execution_start` caches its input, `tool_execution_end` carries its text result. */
  async piTool(session: string, toolName: string, args: Record<string, unknown>, text: string, isError = false): Promise<void> {
    await this.bridge('pi', 'tool_execution_start', { toolCallId: `call-${toolName}`, toolName, args }, session);
    await this.bridge('pi', 'tool_execution_end',
      { toolCallId: `call-${toolName}`, toolName, result: { content: [{ type: 'text', text }], details: {} }, isError }, session);
  }

  /** Pi's bash tool in `session` runs `teamai recall`, with PI_SESSION_ID set to that session as Pi sets it. */
  async piRecall(query: string, session: string): Promise<RecallRun> {
    const run = await this.recall(query, { env: { PI_SESSION_ID: session }, claim: false });
    await this.piTool(session, 'bash', { command: `teamai recall "${query}"` }, run.output);
    return run;
  }

  /** An OMP `tool_result` in `session` (by `agent`), with its text content. */
  async ompTool(session: string, toolName: string, input: Record<string, unknown>, text: string, agent?: OmpAgent): Promise<void> {
    await this.bridge('omp', 'tool_result',
      { type: 'tool_result', toolCallId: `call-${toolName}`, toolName, input, content: [{ type: 'text', text }], isError: false },
      session, agent);
  }

  /**
   * OMP's bash tool in `session` (by `agent`) runs `teamai recall`. OMP sets
   * no session variable in its shell, so only the tool result's claim settles it.
   */
  async ompRecall(query: string, session: string, options: { caller?: string; agent?: OmpAgent } = {}): Promise<RecallRun> {
    const run = await this.recall(query, { env: {}, caller: options.caller, claim: false });
    const command = `teamai recall${options.caller ? ` --caller ${options.caller}` : ''} "${query}"`;
    await this.ompTool(session, 'bash', { command }, run.output, options.agent);
    return run;
  }

  /** What `teamai stats` prints in the current directory. */
  async stats(): Promise<string> {
    const lines: string[] = [];
    const print = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await showStats();
    } finally {
      print.mockRestore();
    }
    return lines.join('\n');
  }

  /** Upvotes per doc in a scope's own votes file. */
  async upvotes(config: LocalConfig): Promise<Record<string, number>> {
    const votes = await loadUserVotes(path.join(getVotesDir(config), 'tester.yaml'));
    return Object.fromEntries(Object.entries(votes.votes)
      .filter(([, entry]) => entry.upvoted_count > 0)
      .map(([id, entry]) => [id, entry.upvoted_count]));
  }
}

const RECALL_SECTION = 'Recall (last 10 sessions):';
const RECALL_HEADER = ['session', 'agent', 'runs', 'recalled', 'adopted'];

/** The rows of `stats`' recall section, split into columns, or null when it has none. */
function recallRows(output: string): string[][] | null {
  const lines = output.split('\n');
  const at = lines.indexOf(RECALL_SECTION);
  if (at < 0) return null;
  expect(lines[at + 1]).toBe('');
  expect(lines[at + 2].trim().split(/\s+/)).toEqual(RECALL_HEADER);
  const rows: string[][] = [];
  for (let i = at + 3; i < lines.length && lines[i] !== ''; i++) rows.push(lines[i].trim().split(/\s+/));
  return rows;
}

interface Row {
  name: string;
  inheritUserScope?: boolean;
  trace: (h: Harness) => Promise<void>;
  /** Upvotes the project scope holds afterwards. */
  project: Record<string, number>;
  /** Upvotes the user scope holds afterwards (default: none). */
  user?: Record<string, number>;
}

const ROWS: Row[] = [
  {
    name: '02: recall, then Read of the printed path, then Stop → +1 in project',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '02: Glob that lists the doc → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Glob', { pattern: '**/*.md', path: path.dirname(files[0]) },
        { filenames: [files[0]], durationMs: 3, numFiles: 1, truncated: false });
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: recall prints team-A/learnings/setup.md; Read of team-B/learnings/setup.md → 0',
    trace: async (h) => {
      await h.recall('setup');
      await h.read(h.docs['team-B/setup']);
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: run returns only an inherited user-scope doc; the main agent reads it → 0',
    inheritUserScope: true,
    trace: async (h) => {
      const { files } = await h.recall('cache warmup');
      expect(files).toEqual([h.docs['cache-warmup']]);
      await h.read(files[0]);
      await h.stop();
    },
    project: {},
    user: {},
  },
  {
    name: '02: day 2, the resumed session reads the doc again with no new recall → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
      h.at(25);
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '02: day 2, the resumed session recalls again and reads the doc → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
      h.at(25);
      await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 2 },
  },
  {
    name: '02: a read 24 h after the run is out of its window → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      h.at(24.5);
      await h.read(files[0]);
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: reading the doc twice in the session → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '02: a read before the recall → 0',
    trace: async (h) => {
      await h.read(h.docs['redis-timeout']);
      h.at(1);
      await h.recall('redis timeout');
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: a relative Read with no cwd matches the printed path by its suffix → +1',
    trace: async (h) => {
      await h.recall('redis timeout');
      await h.read(path.join('learnings', 'redis-timeout.md'), { cwd: null });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '02: a relative Read with no cwd whose suffix two printed paths share → 0',
    trace: async (h) => {
      const { files } = await h.recall('setup');
      expect(files).toHaveLength(2);
      await h.read(path.join('learnings', 'setup.md'), { cwd: null });
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: teamai recall --check, then a read → 0',
    trace: async (h) => {
      await h.recall('redis timeout', { check: true });
      await h.read(h.docs['redis-timeout']);
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: TEAMAI_RECALL_DISABLED=1 during recall and read → 0',
    trace: async (h) => {
      h.env({ TEAMAI_RECALL_DISABLED: '1' });
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      h.env({ TEAMAI_RECALL_DISABLED: undefined });
      await h.stop();
    },
    project: {},
  },
  {
    name: '03: the recall subagent runs recall R and reads the doc; the main agent reads the doc; Stop → +1 in project',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { caller: 'teamai-recall', agent: RECALL_SUBAGENT });
      await h.read(files[0], { agent: RECALL_SUBAGENT });
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '03: the same, but only the recall subagent reads the doc → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { caller: 'teamai-recall', agent: RECALL_SUBAGENT });
      await h.read(files[0], { agent: RECALL_SUBAGENT });
      await h.stop();
    },
    project: {},
  },
  {
    name: '03: the recall subagent runs recall R; a general-purpose subagent reads the doc; Stop → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { caller: 'teamai-recall', agent: RECALL_SUBAGENT });
      await h.read(files[0], { agent: GENERAL_SUBAGENT });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '03: recall R in the main agent; a general-purpose subagent reads the doc; Stop → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0], { agent: GENERAL_SUBAGENT });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '03: a run marked only by --caller (no agent_type in the payload) still excludes its actor\'s reads → 0',
    trace: async (h) => {
      const agent = { id: RECALL_SUBAGENT.id };
      const { files } = await h.recall('redis timeout', { caller: 'teamai-recall', agent });
      await h.read(files[0], { agent });
      await h.stop();
    },
    project: {},
  },
  {
    name: '03: a run marked only by agent_type (the model dropped --caller) still excludes its actor\'s reads → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { agent: RECALL_SUBAGENT });
      await h.read(files[0], { agent: RECALL_SUBAGENT });
      await h.stop();
    },
    project: {},
  },
  {
    name: '04 (Dan): codex exec from inside Claude; the Codex hook claims the run → the Codex session owns it; Claude-session reads → 0',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      // Codex's hook fires when its shell call ends, before `codex exec` returns to Claude with the output.
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.shell('codex exec "run teamai recall redis timeout and summarize"', output);
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: an outer shell prints the inner recall\'s stdout, with no direct teamai recall in its command → the claim is ignored, the run owner is unchanged',
    trace: async (h) => {
      // An unambiguous run under Codex, whose own claim never arrives.
      const { output, files } = await h.recall('redis timeout', { env: { CODEX_SESSION_ID: CODEX }, claim: false });
      await h.shell('codex exec "run teamai recall redis timeout"', output);
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: env run under C with 2 candidates; C reads the doc; C Stops; D\'s claim arrives → 0 for C, D owns the run',
    trace: async (h) => {
      // No hook events yet, so the variable order picks C (the main session).
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      h.at(1);
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: an unambiguous env run with no claim (a long-running Codex command); the session reads the doc → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { env: { CODEX_SESSION_ID: CODEX }, claim: false });
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: two runs in one shell call (teamai recall a; teamai recall b) → both claimed',
    trace: async (h) => {
      const a = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      const b = await h.recall('setup', { env: NESTED_ENV, claim: false });
      await h.shell('teamai recall "redis timeout"; teamai recall "setup"', `${a.output}${b.output}`, { session: CODEX, tool: 'codex' });
      await h.read(a.files[0], { session: CODEX });
      await h.read(h.docs.setup, { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1, setup: 1 },
  },
  {
    name: '04: duplicate delivery of the same claim → a single claim effect',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      h.at(1);
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: a later valid claim from another session is kept but not applied → 0 for it',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      h.at(1);
      await h.shell('npx teamai recall "redis timeout"', output);
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05 (Bob): Codex recall; sed -n \'1,80p\' <doc, relative to the cwd>; Stop → +1',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`sed -n '1,80p' '${h.rel(files[0])}'`, fs.readFileSync(files[0], 'utf-8'));
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex claims its run with teamai recall … 2>&1 (a redirect is no & operator) → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.codexShell('teamai recall "redis timeout" 2>&1', output);
      await h.codexShell(`cat '${files[0]}'`, '---');
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex recall; nl -ba <doc> → +1',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`nl -ba '${files[0]}'`, '     1\t---');
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex recall; constructor <doc> (an Object.prototype key, no reader verb) → 0',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`constructor '${files[0]}'`, '');
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Codex recall; learnings/redis-timeout.md relative to a cwd that holds no such doc → 0',
    trace: async (h) => {
      await h.codexRecall('redis timeout');
      await h.codexShell("sed -n '1,80p' learnings/redis-timeout.md", 'sed: learnings/redis-timeout.md: No such file or directory');
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Codex reads of the doc whose output is only the reader\'s error (status unknown) → 0',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`cat '${files[0]}'`, `cat: ${files[0]}: Permission denied\n`);
      await h.codexShell(`cat '${files[0]}'`, `cat: ${files[0]}: No such file or directory`);
      await h.codexShell(`/bin/cat '${files[0]}'`, `/bin/cat: ${files[0]}: No such file or directory\n`);
      await h.codexShell(`sed -n '1,80p' '${files[0]}'`, `sed: can't read ${files[0]}: Permission denied\n`);
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Codex cat notes.md <doc> whose output is notes.md\'s text and cat: <doc>: Permission denied (status unknown) → 0',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`cat notes.md ${files[0]}`, `# Notes\nnothing here\ncat: ${files[0]}: Permission denied\n`);
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Codex cat missing.md <doc> whose output is cat: missing.md: No such file or directory and the doc\'s text (status unknown) → +1',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`cat missing.md ${files[0]}`, `cat: missing.md: No such file or directory\n${fs.readFileSync(files[0], 'utf-8')}`);
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: Codex searches of the doc or its directory whose output is only the search\'s error (status unknown) → 0',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`grep needle '${files[0]}'`, `grep: ${files[0]}: Permission denied\n`);
      await h.codexShell(`rg needle '${files[0]}'`, `rg: ${files[0]}: Permission denied (os error 13)\n`);
      await h.codexShell(`grep -rn needle '${path.dirname(files[0])}'`, `grep: ${files[0]}: Permission denied\n`);
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Claude recall; cat <doc> | head (a pipeline that starts with the reader, status success) → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`cat '${h.rel(files[0])}' | head -n 20`, '---');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex recall; cat <doc> | head (status unknown, not a simple read) → 0',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`cat '${h.rel(files[0])}' | head -n 20`, '---');
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Codex recall; test -e x && cat <doc> || true → 0',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`test -e x && cat '${h.rel(files[0])}' || true`, '---');
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Claude recall; cat <doc>; echo done, or cat <doc> & (any ;, &&, || or & makes the call no read) → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`cat '${files[0]}'; echo done`, '---\ndone');
      await h.shell(`cat '${files[0]}' &`, '');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: Claude recall; pwd; cat <doc> (a read that ends a command list, status success) → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`pwd; cat '${files[0]}'`, '/w\n---');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Claude recall; sed -i \'s/pool/POOL/\' <doc> → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`sed -i 's/pool/POOL/' '${files[0]}'`, '');
      await h.shell(`sed -n -i '1p' '${files[0]}'`, '');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: the doc as a redirect target or a flag value, not a file operand → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`cat notes.txt > '${files[0]}'`, '');
      await h.shell(`cat < '${files[0]}'`, '---');
      await h.shell(`nl -s '${files[0]}' notes.txt`, '');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: the doc only in a shell comment (cat notes.md # <doc>) → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`cat notes.md # ${files[0]}`, 'notes');
      await h.shell(`cat notes.md #${files[0]}`, 'notes');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: Codex recall; cat of a spaced POSIX path written with backslash escapes (…/sentinel\\ failover.md) → +1',
    trace: async (h) => {
      const file = await h.addLearning('sentinel failover.md', doc('Sentinel failover', ['sentinel', 'failover'], 'Promote a replica.'));
      const { files } = await h.codexRecall('sentinel failover');
      expect(files).toEqual([file]);
      await h.codexShell(`cat ${file.replace(/ /g, '\\ ')}`, fs.readFileSync(file, 'utf-8'));
      await h.stop(CODEX);
    },
    project: { 'sentinel failover': 1 },
  },
  {
    name: '05: a read with a trailing comment (cat <doc> # the fix) → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`cat '${files[0]}' # the fix`, '---');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex claims its run with teamai recall "…" # note (a comment after the claim) → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.codexShell('teamai recall "redis timeout" # note', output);
      await h.codexShell(`cat '${files[0]}'`, '---');
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: a read that fails (status failure: CodeBuddy IDE execute_command with exitCode 1) → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('execute_command', { command: `cat '${files[0]}'` },
        { exitCode: 1, stdout: '', stderr: 'cat: permission denied' }, h.root, undefined, undefined, 'codebuddy');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: the same read with exitCode 0 → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('execute_command', { command: `cat '${files[0]}'` },
        { exitCode: 0, stdout: '---', stderr: '' }, h.root, undefined, undefined, 'codebuddy');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: an unknown tool name with the doc path in its input → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('OpenDocument', { file_path: files[0], path: files[0], command: `cat '${files[0]}'` }, { content: '---' });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: grep -rn timeout learnings/ with output line learnings/redis-timeout.md:12: → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`grep -rn timeout '${h.rel(path.dirname(files[0]))}'`, `${h.rel(files[0])}:12:Raise the pool size.\n`);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: Codex rg timeout <dir> with a path:text line (no -n) → +1',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`rg timeout ${h.rel(path.dirname(files[0]))}`, `${h.rel(files[0])}:tags: [redis, timeout]\n`);
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: grep timeout <doc> (a single file operand prints no path prefix) → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`grep timeout '${h.rel(files[0])}'`, 'tags: [redis, timeout]\n');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: grep -l timeout learnings/, grep -l / rg --files / ls / find naming the doc → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      const dir = h.rel(path.dirname(files[0]));
      const doc = h.rel(files[0]);
      await h.shell(`grep -l timeout '${dir}'`, `${doc}\n`);
      await h.shell(`grep -rl timeout '${doc}'`, `${doc}\n`);
      await h.shell(`grep -L pool '${doc}'`, `${doc}\n`);
      await h.shell(`rg --files '${doc}'`, `${doc}\n`);
      await h.shell(`ls '${dir}'`, 'redis-timeout.md\nsetup.md\n');
      await h.shell(`ls -l '${doc}'`, `-rw-r--r-- 1 me staff 120 Sep  1 09:00 ${doc}\n`);
      await h.shell(`find '${dir}' -name '*.md'`, `${doc}\n`);
      await h.shell(`git ls-files '${doc}'`, `${doc}\n`);
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: list tools (glob, list_dir, search_file, list_files) that name the doc → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      for (const name of ['glob', 'list_dir', 'search_file', 'list_files', 'LS']) {
        await h.postToolUse(name, { pattern: '*.md', path: files[0] }, `${files[0]}\n`);
      }
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: grep -c timeout learnings/redis-timeout.md, rg --count, and Grep count mode → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`grep -c timeout '${h.rel(files[0])}'`, '3\n');
      await h.shell(`grep -rnc timeout '${h.rel(path.dirname(files[0]))}'`, `${h.rel(files[0])}:3\n`);
      await h.shell(`rg --count timeout '${h.rel(path.dirname(files[0]))}'`, `${h.rel(files[0])}:3\n`);
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0], output_mode: 'count' },
        { mode: 'count', numFiles: 1, filenames: [], content: `${files[0]}:3`, numMatches: 3 });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: Grep tool with path = the doc, content mode, non-empty output → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0], output_mode: 'content', '-n': true },
        { mode: 'content', numFiles: 1, filenames: [], content: '5:tags: [redis, timeout]', numLines: 1 });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: Grep tool with path = the doc, content mode, empty output → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'kubernetes', path: files[0], output_mode: 'content' },
        { mode: 'content', numFiles: 0, filenames: [], content: '', numLines: 0 });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: Pi-style grep output relative to the searched dir (redis-timeout.md:12:) resolved against the input path → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('grep', { pattern: 'timeout', path: path.dirname(files[0]) },
        'redis-timeout.md:5: tags: [redis, timeout]', h.root, undefined, undefined, 'pi');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: a doc that only links to redis-timeout.md in its text shows up in search output → 0 for redis-timeout',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      const dir = h.rel(path.dirname(files[0]));
      const setup = h.rel(h.docs.setup);
      await h.shell(`grep -rn redis '${dir}'`,
        `${setup}:7:See [redis](redis-timeout.md): raise the pool\n${setup}:8:${h.rel(files[0])}: the fix\n`);
      // One file operand: a line of its text that starts with the doc's path is no path prefix.
      await h.shell(`grep redis '${setup}'`, `${h.rel(files[0])}: the fix\n`);
      await h.postToolUse('Grep', { pattern: 'redis', path: h.docs.setup, output_mode: 'content' },
        { mode: 'content', numFiles: 1, filenames: [], content: `${files[0]}: the fix`, numLines: 1 });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: structured {filenames[]} output (Grep\'s default files_with_matches mode) → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0] }, { mode: 'files_with_matches', filenames: [files[0]], numFiles: 1 });
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0] }, { filenames: [files[0]], numFiles: 1 });
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0], output_mode: 'files_with_matches' }, { results: files[0], matchCount: 1 });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: structured output whose content string has a <doc>: line → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: path.dirname(files[0]), output_mode: 'content' },
        { mode: 'content', numFiles: 1, filenames: [], content: `${files[0]}:5:tags: [redis, timeout]`, numLines: 1 });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: Qoder Grep {results, matchCount} in content mode with a <doc>: line → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: path.dirname(files[0]), output_mode: 'content' },
        { results: `${files[0]}:5:tags: [redis, timeout]`, matchCount: 1 }, h.root, undefined, undefined, 'qoder');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: Pi grep whose path is the doc prints its basename (redis-timeout.md:5:), no path under the doc → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('grep', { pattern: 'timeout', path: files[0] },
        'redis-timeout.md:5: tags: [redis, timeout]', h.root, undefined, undefined, 'pi');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: grep tools whose path is the doc print their no-match text (OpenCode, Pi, CodeBuddy) → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('grep', { pattern: 'zzzz', path: files[0] }, 'No files found', h.root, undefined, undefined, 'opencode');
      await h.postToolUse('grep', { pattern: 'zzzz', path: files[0] }, 'No matches found', h.root, undefined, undefined, 'pi');
      await h.postToolUse('Grep', { pattern: 'zzzz', path: files[0], output_mode: 'content' }, { content: 'No matches found' },
        h.root, undefined, undefined, 'codebuddy');
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: OpenCode grep whose path is the doc, with a match under its header → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('grep', { pattern: 'timeout', path: files[0] },
        `Found 1 matches\n${files[0]}:\n  Line 5: tags: [redis, timeout]`, h.root, undefined, undefined, 'opencode');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  ...[
    `Get-Content -LiteralPath '${WINDOWS_DOC}'`,
    `Get-Content -Path "${WINDOWS_DOC}" -TotalCount 40`,
    `get-content ${WINDOWS_DOC} -Raw`,
    `type ${WINDOWS_DOC}`,
    `gc ${WINDOWS_DOC}`,
    `cat -LiteralPath '${WINDOWS_DOC}'`,
    `Microsoft.PowerShell.Management\\Get-Content -LiteralPath:'${WINDOWS_DOC}' | Select-Object -First 20`,
  ].map((command): Row => ({
    name: `07: Windows PowerShell ${command} after a recall that printed that path → +1`,
    trace: async (h) => {
      await h.windowsTeamRepo();
      const { files } = await h.recall('redis timeout');
      expect(files).toEqual([WINDOWS_DOC]);
      await h.powershell(command, fs.readFileSync(h.docs['redis-timeout'], 'utf-8'));
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  })),
  ...[`type ${WINDOWS_DOC}`, `gc ${WINDOWS_DOC}`].map((command): Row => ({
    name: `07: Codex on Windows ${command} (no status; a Windows path, so PowerShell's alias) → +1`,
    trace: async (h) => {
      await h.windowsTeamRepo();
      await h.codexRecall('redis timeout');
      await h.codexShell(command, fs.readFileSync(h.docs['redis-timeout'], 'utf-8'));
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  })),
  ...[
    [`type ${POSIX_DOC}`, `bash: type: ${POSIX_DOC}: not found`],
    [`type ${POSIX_DOC}`, ''],
    [`gc ${POSIX_DOC}`, `bash: line 1: gc: command not found`],
  ].map(([command, output]): Row => ({
    name: `07: Codex under bash ${command} with output ${JSON.stringify(output)} (bash's type, no PowerShell alias) → 0`,
    trace: async (h) => {
      await h.posixTeamRepo();
      const { files } = await h.codexRecall('redis timeout');
      expect(files).toEqual([POSIX_DOC]);
      await h.codexShell(command, output);
      await h.stop(CODEX);
    },
    project: {},
  })),
  {
    name: '07: Codex under bash, a reader whose output is only the shell\'s own diagnostic (bash: line 1: head: command not found) → 0',
    trace: async (h) => {
      await h.posixTeamRepo();
      await h.codexRecall('redis timeout');
      await h.codexShell(`head -n 40 ${POSIX_DOC}`, 'bash: line 1: head: command not found\n');
      await h.codexShell(`sed -n '1,40p' ${POSIX_DOC}`, 'sh: 1: sed: not found');
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '07: Codex under bash cat of the doc → +1 (the POSIX team repo placement itself counts)',
    trace: async (h) => {
      await h.posixTeamRepo();
      await h.codexRecall('redis timeout');
      await h.codexShell(`cat ${POSIX_DOC}`, fs.readFileSync(h.docs['redis-timeout'], 'utf-8'));
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '07: Windows Git Bash cat /c/kb/learnings/redis-timeout.md against a printed C:\\kb\\… path → +1',
    trace: async (h) => {
      await h.windowsTeamRepo();
      await h.recall('redis timeout');
      await h.shell('cat /c/kb/learnings/redis-timeout.md', fs.readFileSync(h.docs['redis-timeout'], 'utf-8'));
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '07: Windows Read of c:/kb/learnings/redis-timeout.md (other drive-letter case and separators) → +1',
    trace: async (h) => {
      await h.windowsTeamRepo();
      await h.recall('redis timeout');
      await h.read('c:/kb/learnings/redis-timeout.md');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '07: Windows Read of C:\\KB\\Learnings\\Redis-Timeout.md (Windows paths ignore case) → +1',
    trace: async (h) => {
      await h.windowsTeamRepo();
      await h.recall('redis timeout');
      await h.read('C:\\KB\\Learnings\\Redis-Timeout.md');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '07: Windows rg -n timeout C:\\kb\\learnings with an output line C:\\kb\\learnings\\redis-timeout.md:12: → +1',
    trace: async (h) => {
      await h.windowsTeamRepo();
      await h.recall('redis timeout');
      await h.powershell(`rg -n timeout ${WINDOWS_REPO}\\learnings`, `${WINDOWS_DOC}:12:Raise the pool size.\n`);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '07: Windows Grep tool in C:\\kb\\learnings, content mode, with a C:\\kb\\…\\redis-timeout.md:5: line → +1',
    trace: async (h) => {
      await h.windowsTeamRepo();
      await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: `${WINDOWS_REPO}\\learnings`, output_mode: 'content' },
        { mode: 'content', numFiles: 1, filenames: [], content: `${WINDOWS_DOC}:5:tags: [redis, timeout]`, numLines: 1 });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '07: Windows reads of the same path on another drive, and a one-file search whose text starts with the doc\'s path → 0',
    trace: async (h) => {
      await h.windowsTeamRepo();
      await h.recall('redis timeout');
      await h.shell('cat /d/kb/learnings/redis-timeout.md', 'x');
      await h.powershell("Get-Content -LiteralPath 'D:\\kb\\learnings\\redis-timeout.md'", 'x');
      await h.read('d:/kb/learnings/redis-timeout.md');
      await h.powershell(`rg timeout ${WINDOWS_REPO}\\learnings\\setup.md`, `${WINDOWS_DOC}: the fix\n`);
      await h.stop();
    },
    project: {},
  },
  {
    name: '08: a Cursor payload carrying only conversation_id joins the session CURSOR_CONVERSATION_ID named at run time; Read (tool_output holds only metadata) → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { env: { CURSOR_CONVERSATION_ID: CURSOR }, claim: false });
      await h.agentCall('cursor', 'Read', { file_path: files[0] },
        { hook_event_name: 'postToolUse', conversation_id: CURSOR, ...cursorOutput({ file_path: files[0], content_length: 194 }) });
      await h.agentStop('cursor', { hook_event_name: 'stop', conversation_id: CURSOR, status: 'completed' });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Cursor recall claimed by its Shell call; Shell cat <doc>, output in tool_output → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: { CURSOR_CONVERSATION_ID: CURSOR, CLAUDE_CODE_SESSION_ID: SESSION }, claim: false });
      await h.agentCall('cursor', 'Shell', { command: 'teamai recall "redis timeout"' },
        { hook_event_name: 'postToolUse', conversation_id: CURSOR, ...cursorOutput({ exitCode: 0, stdout: output }) });
      await h.agentCall('cursor', 'Shell', { command: `cat '${files[0]}'` },
        { hook_event_name: 'postToolUse', conversation_id: CURSOR, ...cursorOutput({ exitCode: 0, stdout: fs.readFileSync(files[0], 'utf-8') }) });
      await h.agentStop('cursor', { hook_event_name: 'stop', conversation_id: CURSOR, status: 'completed' });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Cursor Shell cat <doc> whose tool_output has a non-zero exitCode → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { env: { CURSOR_CONVERSATION_ID: CURSOR }, claim: false });
      await h.agentCall('cursor', 'Shell', { command: `cat '${files[0]}'` },
        { hook_event_name: 'postToolUse', conversation_id: CURSOR, ...cursorOutput({ exitCode: 1, stdout: '' }) });
      await h.agentStop('cursor', { hook_event_name: 'stop', conversation_id: CURSOR, status: 'completed' });
    },
    project: {},
  },
  {
    name: '08 (Frank): Cursor recall subagent in its own conversation, run with --caller, reads the doc → 0 (and no link credits the parent) [unverified payload: CURSOR_CONVERSATION_ID in a subagent shell]',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: { CURSOR_CONVERSATION_ID: CURSOR_CHILD }, caller: 'teamai-recall', claim: false });
      await h.agentCall('cursor', 'Shell', { command: 'teamai recall --caller teamai-recall "redis timeout"' },
        { hook_event_name: 'postToolUse', conversation_id: CURSOR_CHILD, ...cursorOutput({ exitCode: 0, stdout: output }) });
      await h.agentCall('cursor', 'Read', { file_path: files[0] },
        { hook_event_name: 'postToolUse', conversation_id: CURSOR_CHILD, ...cursorOutput({ file_path: files[0], content_length: 194 }) });
      await h.agentStop('cursor', { hook_event_name: 'stop', conversation_id: CURSOR_CHILD, status: 'completed' });
      await h.agentCall('cursor', 'Read', { file_path: files[0] },
        { hook_event_name: 'postToolUse', conversation_id: CURSOR, ...cursorOutput({ file_path: files[0], content_length: 194 }) });
      await h.agentStop('cursor', { hook_event_name: 'stop', conversation_id: CURSOR, status: 'completed' });
    },
    project: {},
  },
  {
    name: '08: Copilot main agent recalls, claimed by its bash call; view of the doc → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: { COPILOT_AGENT_SESSION_ID: COPILOT, CLAUDE_CODE_SESSION_ID: SESSION }, claim: false });
      await h.agentCall('copilot', 'bash', { command: 'teamai recall "redis timeout"', description: 'Search team knowledge' },
        { session_id: COPILOT, ...copilotResult(output) });
      await h.agentCall('copilot', 'view', { path: files[0] }, { session_id: COPILOT, ...copilotResult(fs.readFileSync(files[0], 'utf-8')) });
      await h.copilotSessionEnd(COPILOT);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Copilot recall; grep in content mode whose output has an abs/path:line:text line → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { env: { COPILOT_AGENT_SESSION_ID: COPILOT }, claim: false });
      await h.agentCall('copilot', 'grep', { pattern: 'timeout', path: path.dirname(files[0]), output_mode: 'content', '-n': true },
        { session_id: COPILOT, ...copilotResult(`${files[0]}:5:tags: [redis, timeout]`) });
      await h.copilotSessionEnd(COPILOT);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Copilot PostToolUse under Claude tool names (Bash claim, Read with path) → +1 [unverified payload]',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: { COPILOT_AGENT_SESSION_ID: COPILOT, CLAUDE_CODE_SESSION_ID: SESSION }, claim: false });
      await h.agentCall('copilot', 'Bash', { command: 'teamai recall "redis timeout"' }, { session_id: COPILOT, ...copilotResult(output) });
      await h.agentCall('copilot', 'Read', { path: files[0] }, { session_id: COPILOT, ...copilotResult('---') });
      await h.copilotSessionEnd(COPILOT);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Copilot recall subagent in its own session, run with --caller, views the doc → 0 [unverified payload: which session a subagent\'s hooks and shell carry]',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: { COPILOT_AGENT_SESSION_ID: COPILOT_CHILD }, caller: 'teamai-recall', claim: false });
      await h.agentCall('copilot', 'bash', { command: 'teamai recall --caller teamai-recall "redis timeout"' },
        { session_id: COPILOT_CHILD, ...copilotResult(output) });
      await h.agentCall('copilot', 'view', { path: files[0] }, { session_id: COPILOT_CHILD, ...copilotResult('---') });
      await h.copilotSessionEnd(COPILOT_CHILD);
    },
    project: {},
  },
  {
    name: '08: Copilot recall settled from its session variable; view of the doc; SessionEnd (no Stop) → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { env: { COPILOT_AGENT_SESSION_ID: COPILOT }, claim: false });
      await h.agentCall('copilot', 'view', { path: files[0] }, { session_id: COPILOT, ...copilotResult('---') });
      await h.copilotSessionEnd(COPILOT);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Copilot fires Stop for the turn, then SessionEnd: the doc counts once → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { env: { COPILOT_AGENT_SESSION_ID: COPILOT }, claim: false });
      await h.agentCall('copilot', 'view', { path: files[0] }, { session_id: COPILOT, ...copilotResult('---') });
      await h.agentStop('copilot', { session_id: COPILOT, transcript_path: '', stop_reason: 'end_turn', stop_hook_active: false });
      await h.copilotSessionEnd(COPILOT);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: CodeBuddy CLI recall claimed by its Bash call; Read of the doc → +1 [unverified payload: Bash tool_response shape]',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: { CODEBUDDY_SESSION_ID: SESSION, CLAUDE_SESSION_ID: SESSION }, claim: false });
      await h.agentCall('codebuddy', 'Bash', { command: 'teamai recall "redis timeout"' },
        { session_id: SESSION, tool_response: { stdout: output, stderr: '' } });
      await h.agentCall('codebuddy', 'Read', { file_path: files[0] }, { session_id: SESSION, tool_response: '---' });
      await h.agentStop('codebuddy', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: CodeBuddy IDE recall claimed by execute_command; read_file of the doc → +1 [unverified payload: read_file path field]',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: { CODEBUDDY_SESSION_ID: SESSION, CLAUDE_CODE_SESSION_ID: 'sess-other' }, claim: false });
      await h.agentCall('codebuddy', 'execute_command', { command: 'teamai recall "redis timeout"' },
        { session_id: SESSION, tool_response: { exitCode: 0, stdout: output, stderr: '' } });
      await h.agentCall('codebuddy', 'read_file', { filePath: files[0] }, { session_id: SESSION, tool_response: '---' });
      await h.agentStop('codebuddy', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: CodeBuddy recall subagent (parent session_id, agent_id/agent_type) runs recall and reads the doc; the main agent reads it → +1',
    trace: async (h) => {
      const subagent = { session_id: SESSION, agent_id: 'task-7', agent_type: 'teamai-recall' };
      const { output, files } = await h.recall('redis timeout', { env: { CODEBUDDY_SESSION_ID: SESSION }, caller: 'teamai-recall', claim: false });
      await h.agentCall('codebuddy', 'Bash', { command: 'teamai recall --caller teamai-recall "redis timeout"' },
        { ...subagent, tool_response: { stdout: output, stderr: '' } });
      await h.agentCall('codebuddy', 'Read', { file_path: files[0] }, { ...subagent, tool_response: '---' });
      await h.agentStop('codebuddy', { session_id: SESSION });
      expect(await h.upvotes(h.project)).toEqual({});
      await h.agentCall('codebuddy', 'Read', { file_path: files[0] }, { session_id: SESSION, tool_response: '---' });
      await h.agentStop('codebuddy', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: WorkBuddy recall, with no session variable, claimed by its Bash call; Read of the doc → +1 [unverified payload: tool names]',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: {}, claim: false });
      await h.agentCall('workbuddy', 'Bash', { command: 'teamai recall "redis timeout"' },
        { session_id: SESSION, tool_response: { stdout: output, stderr: '' } });
      await h.agentCall('workbuddy', 'Read', { file_path: files[0] }, { session_id: SESSION, tool_response: '---' });
      await h.agentStop('workbuddy', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Qoder CLI recall claimed by Bash {stdout, stderr, exitCode}; Read {type, text, file_path} → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: {}, claim: false });
      await h.agentCall('qoder', 'Bash', { command: 'teamai recall "redis timeout"' },
        { session_id: SESSION, tool_response: { stdout: output, stderr: '', exitCode: 0 } });
      await h.agentCall('qoder', 'Read', { file_path: files[0] },
        { session_id: SESSION, tool_response: { type: 'text', text: '---', file_path: files[0] } });
      await h.agentStop('qoder', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Qoder IDE recall claimed by run_in_terminal; read_file of the doc (string tool_response) → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: {}, claim: false });
      await h.agentCall('qoder', 'run_in_terminal', { command: 'teamai recall "redis timeout"' }, { session_id: SESSION, tool_response: output });
      await h.agentCall('qoder', 'read_file', { file_path: files[0] }, { session_id: SESSION, tool_response: '---' });
      await h.agentStop('qoder', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: Qoder recall subagent (agent_id/agent_type, main session_id) reads the doc → 0; the main agent reads it → +1 [unverified payload: session_id inside a subagent]',
    trace: async (h) => {
      const subagent = { session_id: SESSION, agent_id: 'agent-3', agent_type: 'teamai-recall' };
      const { output, files } = await h.recall('redis timeout', { env: {}, caller: 'teamai-recall', claim: false });
      await h.agentCall('qoder', 'Bash', { command: 'teamai recall --caller teamai-recall "redis timeout"' },
        { ...subagent, tool_response: { stdout: output, stderr: '', exitCode: 0 } });
      await h.agentCall('qoder', 'Read', { file_path: files[0] }, { ...subagent, tool_response: { type: 'text', text: '---', file_path: files[0] } });
      await h.agentStop('qoder', { session_id: SESSION });
      expect(await h.upvotes(h.project)).toEqual({});
      await h.agentCall('qoder', 'Read', { file_path: files[0] }, { session_id: SESSION, tool_response: { type: 'text', text: '---', file_path: files[0] } });
      await h.agentStop('qoder', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: ZCode recall claimed by Bash {stdout, stderr, exitCode, status}; Read of the doc → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: {}, claim: false });
      await h.agentCall('zcode', 'Bash', { command: 'teamai recall "redis timeout"' },
        { session_id: SESSION, tool_response: { stdout: output, stderr: '', interrupted: false, status: 'completed', exitCode: 0 } });
      await h.agentCall('zcode', 'Read', { file_path: files[0] }, { session_id: SESSION, tool_response: { type: 'text', file: { filePath: files[0] } } });
      await h.agentStop('zcode', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '08: ZCode recall; Grep in content mode whose content has a <doc>:line: line → +1',
    trace: async (h) => {
      const { output } = await h.recall('redis timeout', { env: {}, claim: false });
      await h.agentCall('zcode', 'Bash', { command: 'teamai recall "redis timeout"' },
        { session_id: SESSION, tool_response: { stdout: output, stderr: '', exitCode: 0 } });
      await h.agentCall('zcode', 'Grep', { pattern: 'timeout', path: path.dirname(h.docs['redis-timeout']), output_mode: 'content' },
        { session_id: SESSION, tool_response: { mode: 'content', numFiles: 1, filenames: [], content: `${h.docs['redis-timeout']}:5:tags: [redis, timeout]`, numLines: 1 } });
      await h.agentStop('zcode', { session_id: SESSION });
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '09: OpenCode recall in a task child; the parent reads the doc; the link arrives after the read; Stop → +1 for the parent',
    trace: async (h) => {
      const { files } = await h.openCodeRecall('redis timeout', OPENCODE_CHILD, { caller: 'teamai-recall' });
      await h.openCodeIdle(OPENCODE_CHILD);
      await h.openCodeRead(OPENCODE, files[0]);
      await h.openCodeIdle(OPENCODE);
      // No link yet: the child's run is not the parent's.
      expect(await h.upvotes(h.project)).toEqual({});
      await h.openCodeTask(OPENCODE, OPENCODE_CHILD);
      await h.openCodeIdle(OPENCODE);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '09: OpenCode recall subagent reads the doc itself in its task child → 0',
    trace: async (h) => {
      const { files } = await h.openCodeRecall('redis timeout', OPENCODE_CHILD, { caller: 'teamai-recall' });
      await h.openCodeRead(OPENCODE_CHILD, files[0]);
      await h.openCodeIdle(OPENCODE_CHILD);
      await h.openCodeTask(OPENCODE, OPENCODE_CHILD);
      await h.openCodeIdle(OPENCODE);
      await h.openCodeIdle(OPENCODE_CHILD);
    },
    project: {},
  },
  {
    name: '09: OpenCode recall in the parent; a general subagent reads the doc in its task child → +1',
    trace: async (h) => {
      const { files } = await h.openCodeRecall('redis timeout', OPENCODE);
      await h.openCodeRead(OPENCODE_CHILD, files[0]);
      await h.openCodeTask(OPENCODE, OPENCODE_CHILD);
      await h.openCodeIdle(OPENCODE);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '09 (Carol): OpenCode recall with no later read → the run is recorded under her session, 0',
    trace: async (h) => {
      await h.openCodeRecall('redis timeout', 'ses_carol');
      await h.openCodeIdle('ses_carol');
      expect((await readRecallLog(h.project)).filter((l) => l.kind === 'run'))
        .toEqual([expect.objectContaining({ session: 'ses_carol', agent: 'opencode', unambiguous: true })]);
    },
    project: {},
  },
  {
    name: '09: a recall from an OpenCode shell, with no hook to claim it, resolves the session from TEAMAI_AGENT_SESSION_ID; read; Stop → +1',
    trace: async (h) => {
      const { files } = await h.openCodeRecall('redis timeout', OPENCODE, { claim: false });
      await h.openCodeRead(OPENCODE, files[0]);
      await h.openCodeIdle(OPENCODE);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '09: OpenCode started from a Claude Code shell: its bash call claims the ambiguous run; a cat of the doc; Stop → +1 for the OpenCode session only',
    trace: async (h) => {
      const { files } = await h.openCodeRecall('redis timeout', OPENCODE, { env: { CLAUDE_CODE_SESSION_ID: SESSION } });
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.openCodeBash(OPENCODE, `cat '${files[0]}'`, fs.readFileSync(files[0], 'utf-8'));
      await h.openCodeIdle(OPENCODE);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '09: OpenCode cat of the doc that exits non-zero → 0',
    trace: async (h) => {
      const { files } = await h.openCodeRecall('redis timeout', OPENCODE);
      await h.openCodeBash(OPENCODE, `cat '${files[0]}'`, `cat: ${files[0]}: Permission denied`, 1);
      await h.openCodeIdle(OPENCODE);
    },
    project: {},
  },
  {
    name: '10: Pi recall with PI_SESSION_ID, then a read of the doc, then Stop → +1',
    trace: async (h) => {
      await h.bridge('pi', 'session_start', {}, PI);
      const { files } = await h.piRecall('redis timeout', PI);
      await h.piTool(PI, 'read', { path: files[0] }, fs.readFileSync(files[0], 'utf-8'));
      await h.bridge('pi', 'agent_settled', {}, PI);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '10: Pi cat of the doc that exits non-zero → 0',
    trace: async (h) => {
      const { files } = await h.piRecall('redis timeout', PI);
      await h.piTool(PI, 'bash', { command: `cat '${files[0]}'` }, `cat: ${files[0]}: Permission denied\n\nCommand exited with code 1`, true);
      await h.bridge('pi', 'agent_settled', {}, PI);
    },
    project: {},
  },
  {
    name: '10: OMP main-agent recall, then a read with a selector suffix (:50-200) → +1',
    trace: async (h) => {
      const { files } = await h.ompRecall('redis timeout', OMP, { agent: OMP_MAIN_AGENT });
      await h.ompTool(OMP, 'read', { path: `${files[0]}:50-200` }, '---', OMP_MAIN_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP, OMP_MAIN_AGENT);
    },
    project: { 'redis-timeout': 1 },
  },
  ...[
    'teamai -v recall "redis timeout"',
    'npx -y teamai-cli@0.22.0 --verbose recall "redis timeout"',
  ].map((command): Row => ({
    name: `10: OMP recall with no session variable (via none) settles through its claim ${command} (a global option before recall), then a read → +1`,
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: {}, claim: false });
      await h.ompTool(OMP, 'bash', { command }, output, OMP_MAIN_AGENT);
      await h.ompTool(OMP, 'read', { path: files[0] }, '---', OMP_MAIN_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP, OMP_MAIN_AGENT);
    },
    project: { 'redis-timeout': 1 },
  })),
  {
    name: '10: OMP recall claimed by teamai --no-such-option recall "…" (not a global option: recall never ran) → 0',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: {}, claim: false });
      await h.ompTool(OMP, 'bash', { command: 'teamai --no-such-option recall "redis timeout"' }, output, OMP_MAIN_AGENT);
      await h.ompTool(OMP, 'read', { path: files[0] }, '---', OMP_MAIN_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP, OMP_MAIN_AGENT);
    },
    project: {},
  },
  {
    name: '10: OMP read of C:\\kb\\learnings\\redis-timeout.md:raw keeps the drive colon → +1',
    trace: async (h) => {
      await h.windowsTeamRepo();
      const { files } = await h.ompRecall('redis timeout', OMP);
      expect(files).toEqual([WINDOWS_DOC]);
      await h.ompTool(OMP, 'read', { path: `${WINDOWS_DOC}:raw` }, '---');
      await h.bridge('omp', 'session_stop', {}, OMP);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '10: OMP recall subagent reads the doc → 0',
    trace: async (h) => {
      const { files } = await h.ompRecall('redis timeout', OMP_SUB, { caller: 'teamai-recall', agent: OMP_RECALL_AGENT });
      await h.ompTool(OMP_SUB, 'read', { path: files[0] }, '---', OMP_RECALL_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP_SUB, OMP_RECALL_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP);
    },
    project: {},
  },
  {
    name: '10: OMP recall subagent recalls and reads, then the main agent reads; the subagent\'s session file sits under its parent\'s → +1',
    trace: async (h) => {
      h.ompSessions(OMP, OMP_SUB, OMP_RECALL_AGENT);
      const { files } = await h.ompRecall('redis timeout', OMP_SUB, { caller: 'teamai-recall', agent: OMP_RECALL_AGENT });
      await h.ompTool(OMP_SUB, 'read', { path: files[0] }, '---', OMP_RECALL_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP_SUB, OMP_RECALL_AGENT);
      await h.ompTool(OMP, 'read', { path: files[0] }, '---', OMP_MAIN_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP, OMP_MAIN_AGENT);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '10: OMP recall subagent linked to its parent reads the doc, and the main agent does not → 0',
    trace: async (h) => {
      h.ompSessions(OMP, OMP_SUB, OMP_RECALL_AGENT);
      const { files } = await h.ompRecall('redis timeout', OMP_SUB, { caller: 'teamai-recall', agent: OMP_RECALL_AGENT });
      await h.ompTool(OMP_SUB, 'read', { path: files[0] }, '---', OMP_RECALL_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP_SUB, OMP_RECALL_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP, OMP_MAIN_AGENT);
    },
    project: {},
  },
  {
    name: '10: OMP parent session file not on disk at the subagent\'s first call, written before its read; then the main agent reads → +1',
    trace: async (h) => {
      const writeParent = h.ompSessions(OMP, OMP_SUB, OMP_RECALL_AGENT, { parentHeader: false });
      const { files } = await h.ompRecall('redis timeout', OMP_SUB, { caller: 'teamai-recall', agent: OMP_RECALL_AGENT });
      writeParent();
      await h.ompTool(OMP_SUB, 'read', { path: files[0] }, '---', OMP_RECALL_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP_SUB, OMP_RECALL_AGENT);
      await h.ompTool(OMP, 'read', { path: files[0] }, '---', OMP_MAIN_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP, OMP_MAIN_AGENT);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '10: OMP recall subagent whose main session has no session file (--no-session: no parent to find), then the main agent reads → 0',
    trace: async (h) => {
      const { files } = await h.ompRecall('redis timeout', OMP_SUB, { caller: 'teamai-recall', agent: OMP_RECALL_AGENT });
      await h.bridge('omp', 'session_stop', {}, OMP_SUB, OMP_RECALL_AGENT);
      await h.ompTool(OMP, 'read', { path: files[0] }, '---', OMP_MAIN_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP, OMP_MAIN_AGENT);
    },
    project: {},
  },
  {
    name: '10: OMP recall subagent without --caller is marked by the agent type ctx.agent names; its own read → 0',
    trace: async (h) => {
      const { files } = await h.ompRecall('redis timeout', OMP_SUB, { agent: OMP_RECALL_AGENT });
      await h.ompTool(OMP_SUB, 'read', { path: files[0] }, '---', OMP_RECALL_AGENT);
      await h.bridge('omp', 'session_stop', {}, OMP_SUB, OMP_RECALL_AGENT);
    },
    project: {},
  },
  {
    name: '11: final Stop; a background worker reads the doc; SubagentStop → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.stop();
      await h.read(files[0], { agent: GENERAL_SUBAGENT });
      // A user-facing summary belongs to the end of a turn, not to a subagent's.
      expect(await h.subagentStop(GENERAL_SUBAGENT)).toBe('');
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '11: final Stop; a background worker reads the doc; no SubagentStop, then teamai pull → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.stop();
      await h.read(files[0], { agent: GENERAL_SUBAGENT });
      await h.pull();
      await h.pull();
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '11: a later read of a doc its run already credited, drained by pull after the ledger window → no second vote',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
      h.at(20);
      // The session ends with no Stop after this read.
      await h.read(files[0]);
      h.at(30);
      await h.pull();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '11: pull prunes lines older than 30 days and keeps the log at 5000 lines, but keeps a 2-hour-old pending read and its run',
    trace: async (h) => {
      h.fillLog(1000, -24 * 40);
      // Two session candidates: the run settles only once its claim arrives, so the read stays pending through the pull.
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.read(files[0]);
      // Newer lines follow them, so the run and the read are the oldest lines the cap would drop.
      h.fillLog(6000, 1);
      h.at(2);
      await h.pull();
      const lines = h.logLines();
      expect(lines.length).toBeLessThanOrEqual(5000);
      expect(Math.min(...lines.map((l) => Date.parse(l.ts)))).toBe(T0);
      await h.shell('teamai recall "redis timeout"', output);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '11: a read appended while the log lock is held, as during a prune, survives the prune → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      h.fillLog(6000, 1);
      const lock = `${recallLogPath(h.project)}.lock`;
      expect(await acquireLock(lock)).toBe(true);
      let pulling: Promise<void>;
      try {
        // The hook gives up on the lock and leaves the read in a side record; the prune then waits for the lock.
        await h.ticking(h.read(files[0]));
        expect(fs.readdirSync(path.dirname(recallLogPath(h.project))).filter((n) => n.startsWith('recall.pending-'))).toHaveLength(1);
        pulling = h.pull();
      } finally {
        await releaseLock(lock);
      }
      await pulling;
      expect(h.logLines().length).toBeLessThanOrEqual(5000);
      await h.shell('teamai recall "redis timeout"', output);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '13: teamai recall --check then a read → no run in stats',
    trace: async (h) => {
      await h.recall('redis timeout', { check: true });
      await h.read(h.docs['redis-timeout']);
      await h.stop();
      expect(recallRows(await h.stats())).toBeNull();
    },
    project: {},
  },
  {
    name: '13: recall with no hits prints its run id on the no-hit line → one run in stats',
    trace: async (h) => {
      const { output, run } = await h.recall('kubernetes');
      expect(output).toMatch(/No matching learnings found for "kubernetes"\. run=[0-9a-f-]{36}\n$/);
      expect(run).toMatch(/^[0-9a-f-]{36}$/);
      await h.stop();
      expect(recallRows(await h.stats())).toEqual([['sess-mai', 'claude', '1', '0', '0']]);
    },
    project: {},
  },
  {
    name: '13: Codex recall with no hits, two session candidates, claimed from output whose logger glyph is colored → one settled run under Codex',
    trace: async (h) => {
      const { output } = await h.recall('kubernetes', { env: NESTED_ENV, claim: false });
      await h.shell('teamai recall "kubernetes"', output.replace('ℹ ', '\u001b[34mℹ\u001b[39m '), { session: CODEX, tool: 'codex' });
      expect(recallRows(await h.stats())).toEqual([[CODEX.slice(0, 8), 'codex', '1', '0', '0']]);
    },
    project: {},
  },
  {
    name: '13: recall --check with no hits prints no run id → no run in stats',
    trace: async (h) => {
      const { output } = await h.recall('kubernetes', { check: true });
      expect(output).not.toContain('run=');
      await h.stop();
      expect(recallRows(await h.stats())).toBeNull();
    },
    project: {},
  },
  {
    name: '13: OMP recall with no hits and no session variable (via none), claimed through its bash tool_result → one settled run, 0 recalled',
    trace: async (h) => {
      const { run } = await h.ompRecall('kubernetes', OMP, { agent: OMP_MAIN_AGENT });
      expect(run).toBeDefined();
      await h.bridge('omp', 'session_stop', {}, OMP, OMP_MAIN_AGENT);
      expect(recallRows(await h.stats())).toEqual([['omp-main', 'omp', '1', '0', '0']]);
    },
    project: {},
  },
];

describe('recall attribution acceptance (#884)', () => {
  let h: Harness;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    judgeAdoption.mockClear();
    h = new Harness();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.chdir(originalCwd);
    delete process.env.TEAMAI_RECALL_DISABLED;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(h.tmp, { recursive: true, force: true });
  });

  it.each(ROWS)('$name', async (row) => {
    await h.setUp({ inheritUserScope: row.inheritUserScope });
    await row.trace(h);
    expect(await h.upvotes(h.project)).toEqual(row.project);
    expect(await h.upvotes(h.user)).toEqual(row.user ?? {});
  });

  // The votes lock is held for real, so the Stop waits out its full lock wait.
  it('11: votes lock contended at Stop → no vote now; the next trigger credits it once', async () => {
    await h.setUp();
    const { files } = await h.recall('redis timeout');
    await h.read(files[0]);
    const lock = `${path.join(getVotesDir(h.project), 'tester.yaml')}.lock`;
    expect(await acquireLock(lock)).toBe(true);
    try {
      await h.stop();
    } finally {
      await releaseLock(lock);
    }
    expect(await h.upvotes(h.project)).toEqual({});

    await h.pull();
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
    await h.stop();
    await h.pull();
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  }, 30_000);

  it('11: SubagentStop credits a read locally and pushes nothing mid-turn; the next Stop pushes it', async () => {
    await h.setUp();
    const { updateReports } = await import('../utils/reports-branch.js');
    const { files } = await h.recall('redis timeout');
    await h.stop();
    vi.mocked(updateReports).mockClear();
    await h.read(files[0], { agent: GENERAL_SUBAGENT });
    expect(await h.subagentStop(GENERAL_SUBAGENT)).toBe('');
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
    expect(updateReports).not.toHaveBeenCalled();
    await h.stop();
    expect(updateReports).toHaveBeenCalledTimes(1);
  });

  it('08: Copilot SessionEnd pushes the votes it credits and prints no adopted summary', async () => {
    await h.setUp();
    const { updateReports } = await import('../utils/reports-branch.js');
    vi.mocked(updateReports).mockClear();
    const { files } = await h.recall('redis timeout', { env: { COPILOT_AGENT_SESSION_ID: COPILOT }, claim: false });
    await h.agentCall('copilot', 'view', { path: files[0] }, { session_id: COPILOT, ...copilotResult('---') });
    expect(await h.copilotSessionEnd(COPILOT)).toBe('');
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
    expect(updateReports).toHaveBeenCalledTimes(1);
  });

  it.each(['codex', 'muse', 'zcode'])('12: %s Stop judges its final reply using settled recall-log candidates without a Claude transcript', async tool => {
    await h.setUp();
    await h.recall('redis timeout');
    h.env({ TEAMAI_UPVOTE_JUDGE: '1' });
    const stop = () => h.dispatch('stop', { hook_event_name: 'Stop', last_assistant_message: 'Raised the pool size.' }, h.root, tool, { background: true });
    await stop();
    expect(judgeAdoption).toHaveBeenCalledWith('Raised the pool size.', ['redis-timeout'], { 'redis-timeout': h.docs['redis-timeout'] }, expect.any(Array));
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
    judgeAdoption.mockClear();
    await stop();
    expect(judgeAdoption).not.toHaveBeenCalled();
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  it('12: a Claude Stop that also carries the final reply is still judged from its transcript', async () => {
    await h.setUp();
    // The recall log has no run of this session; only the transcript shows the recall.
    const { output, files } = await h.recall('redis timeout', { env: { CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000001' }, claim: false });
    await h.judgeStop(Harness.bashEntries('toolu_recall', 'teamai recall "redis timeout"', output), { last_assistant_message: 'Raised the pool size.' });
    expect(judgeAdoption).toHaveBeenCalledWith('Raised the pool size.', ['redis-timeout'], { 'redis-timeout': files[0] }, expect.any(Array));
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  it('12: a Codex Stop whose transcript_path is its own rollout is judged from the recall log', async () => {
    await h.setUp();
    await h.recall('redis timeout');
    const rollout = path.join(h.tmp, 'rollout.jsonl');
    fs.writeFileSync(rollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Raised the pool size.' } })}\n`);
    h.env({ TEAMAI_UPVOTE_JUDGE: '1' });
    await h.dispatch('stop', { hook_event_name: 'Stop', transcript_path: rollout, last_assistant_message: 'Raised the pool size.' }, h.root, 'codex', { background: true });
    expect(judgeAdoption).toHaveBeenCalledWith('Raised the pool size.', ['redis-timeout'], { 'redis-timeout': h.docs['redis-timeout'] }, expect.any(Array));
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  it('12: native Stop keeps inherited user-scope recall read-only in a project', async () => {
    await h.setUp({ inheritUserScope: true });
    await h.recall('cache warmup');
    h.env({ TEAMAI_UPVOTE_JUDGE: '1' });
    await h.dispatch('stop', { last_assistant_message: 'Applied the cache warmup.' }, h.root, 'codex', { background: true });
    expect(judgeAdoption.mock.calls.flatMap(call => call[1])).not.toContain('cache-warmup');
    expect((await h.upvotes(h.project))['cache-warmup']).toBeUndefined();
  });

  it('12: a final reply alone cannot invent recall candidates', async () => {
    await h.setUp();
    h.env({ TEAMAI_UPVOTE_JUDGE: '1' });
    await h.dispatch('stop', { last_assistant_message: '<!-- teamai:recalled-doc-ids: [setup] -->' }, h.root, 'codex', { background: true });
    expect(judgeAdoption).not.toHaveBeenCalled();
    expect(await h.upvotes(h.project)).toEqual({});
  });

  it('12: judge on: a doc the hook path credited is not sent to the judge again', async () => {
    await h.setUp();
    const { output, files } = await h.recall('redis timeout');
    await h.read(files[0]);
    await h.stop();
    await h.judgeStop([
      ...Harness.bashEntries('toolu_recall', 'teamai recall "redis timeout"', output),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: files[0] } }] } },
    ]);
    expect(judgeAdoption).not.toHaveBeenCalled();
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  it('12: judge on: a doc opened in the turn that just ended is credited, not judged, even when the judge runs before votes-sync', async () => {
    await h.setUp();
    const { output, files } = await h.recall('redis timeout');
    await h.read(files[0]);
    await h.judgeStop([
      ...Harness.bashEntries('toolu_recall', 'teamai recall "redis timeout"', output),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: files[0] } }] } },
    ]);
    expect(judgeAdoption).not.toHaveBeenCalled();
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  it('12: judge on: a recalled doc the session never opened is judged → +1', async () => {
    await h.setUp();
    const { output, files } = await h.recall('redis timeout');
    await h.stop();
    expect(await h.upvotes(h.project)).toEqual({});
    await h.judgeStop(Harness.bashEntries('toolu_recall', 'teamai recall "redis timeout"', output));
    expect(judgeAdoption).toHaveBeenCalledWith('Raised the pool size.', ['redis-timeout'], { 'redis-timeout': files[0] }, expect.any(Array));
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  // The recommended path: recall runs inside the teamai-recall subagent, so the
  // main transcript carries only the `recalled-doc-ids` comment, never the
  // `File:` lines. The judge backfills the doc's path from the recall log
  // (recalledPathOf) so the candidate is still grounded and can be judged (#723).
  it('12: judge on: a subagent recall (no File: line in the main transcript) is still grounded from the recall log → +1', async () => {
    await h.setUp();
    // The subagent ran the recall (its Bash claim settles the run + records the path).
    await h.recall('redis timeout', { caller: 'teamai-recall' });
    await h.stop();
    expect(await h.upvotes(h.project)).toEqual({});
    // The main transcript the Stop hook feeds the judge: only the doc-id comment,
    // no recall region and no File: line — exactly what a subagent summary leaves.
    await h.judgeStop([
      { type: 'assistant', message: { id: 'msg-recall', content: [{ type: 'text', text: '<!-- teamai:recalled-doc-ids: [redis-timeout] -->' }] } },
    ]);
    // The path arg is backfilled from the recall log, not the (pathless) transcript.
    expect(judgeAdoption).toHaveBeenCalledWith('Raised the pool size.', ['redis-timeout'], { 'redis-timeout': h.docs['redis-timeout'] }, expect.any(Array));
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  // A `File:` basename the transcript parser gives the judge (`setup`) is NOT
  // unique: this session recalled both `learnings/setup.md` (key `setup`) and
  // `docs/learnings/setup.md` (key `learnings/setup`). The recall-log backfill
  // must refuse to resolve an ambiguous basename, so the judge grounds the
  // candidate against NO file (not the wrong one) and nothing is credited —
  // rather than grounding/crediting the wrong doc (#723).
  it('12: judge on: a subagent recall whose parser basename is ambiguous stays ungrounded, not mis-credited', async () => {
    await h.setUp();
    const { files } = await h.recall('setup installer flags', { caller: 'teamai-recall' });
    // The query returns two docs that share the `setup` basename.
    expect(files.some((f) => f.endsWith(path.join('docs', 'learnings', 'setup.md')))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('team-repo', 'learnings', 'setup.md')))).toBe(true);
    await h.stop();
    await h.judgeStop([
      { type: 'assistant', message: { id: 'msg-recall', content: [{ type: 'text', text: '<!-- teamai:recalled-doc-ids: [setup] -->' }] } },
    ]);
    // The handler refuses to backfill the ambiguous basename, so the judge gets
    // an EMPTY path map for `setup`. In production judgeAdoption then drops it as
    // ungrounded (votes-judge drops a candidate with no readable excerpt — see
    // votes-judge.test.ts); the mock here echoes ids regardless, so this asserts
    // the handler's contribution (no path handed over), which is the fix.
    expect(judgeAdoption).toHaveBeenCalledWith('Raised the pool size.', ['setup'], {}, expect.any(Array));
  });

  it('12: judge on: a doc the transcript shows only in a Glob listing, which the hook path does not credit, is judged → +1', async () => {
    await h.setUp();
    const { output, files } = await h.recall('redis timeout');
    const glob = { pattern: '**/*.md', path: path.dirname(files[0]) };
    await h.postToolUse('Glob', glob, { filenames: [files[0]], durationMs: 3, numFiles: 1, truncated: false });
    await h.stop();
    expect(await h.upvotes(h.project)).toEqual({});
    await h.judgeStop([
      ...Harness.bashEntries('toolu_recall', 'teamai recall "redis timeout"', output),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: glob }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_glob', content: files[0] }] } },
    ]);
    expect(judgeAdoption).toHaveBeenCalledWith('Raised the pool size.', ['redis-timeout'], expect.any(Object), expect.any(Array));
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  // The transcript parser keys a doc on its `File:` basename (`setup`); its vote key is `learnings/setup`.
  it('12: judge on: a nested doc the hook path credited is not judged again under the basename the transcript parser gives it', async () => {
    await h.setUp();
    const { output, files } = await h.recall('setup installer flags');
    const nested = path.join(h.teamRepo, 'docs', 'learnings', 'setup.md');
    expect(files[0]).toBe(nested);
    await h.read(nested);
    await h.stop();
    expect(await h.upvotes(h.project)).toEqual({ 'learnings/setup': 1 });
    await h.judgeStop([
      ...Harness.bashEntries('toolu_recall', 'teamai recall "setup installer flags"', output),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: nested } }] } },
    ]);
    expect(judgeAdoption).not.toHaveBeenCalled();
    expect(await h.upvotes(h.project)).toEqual({ 'learnings/setup': 1 });
  });

  it('12: judge on: a nested doc the session never opened is judged → +1 under its vote key', async () => {
    await h.setUp();
    const { output, files } = await h.recall('setup installer flags');
    expect(files[0]).toBe(path.join(h.teamRepo, 'docs', 'learnings', 'setup.md'));
    await h.stop();
    await h.judgeStop(Harness.bashEntries('toolu_recall', 'teamai recall "setup installer flags"', output));
    expect(judgeAdoption).toHaveBeenCalledWith('Raised the pool size.', ['setup'], expect.any(Object), expect.any(Array));
    expect(await h.upvotes(h.project)).toEqual({ 'learnings/setup': 1 });
  });

  it('prints the run id after the result count on the region start line', async () => {
    await h.setUp();
    const { output, run } = await h.recall('redis timeout');
    expect(output.split('\n')[0]).toMatch(/^--- \[teamai:recall:start\] --- \(1 result\) run=[0-9a-f-]{36}$/);
    expect((await readRecallLog(h.project)).filter((l) => l.kind === 'run').map((l) => l.kind === 'run' && l.run)).toEqual([run]);
  });

  it('Stop tells the user which recalled doc the session adopted', async () => {
    await h.setUp();
    const { files } = await h.recall('redis timeout');
    await h.read(files[0]);
    expect(await h.stop()).toContain('[teamai] Adopted team knowledge this session: redis-timeout');
    expect(await h.stop()).toBe('');
  });

  it('recall with no hits records a run with no docs', async () => {
    await h.setUp();
    await h.recall('kubernetes');
    const runs = (await readRecallLog(h.project)).filter((l) => l.kind === 'run');
    expect(runs).toEqual([expect.objectContaining({ kind: 'run', session: SESSION, agent: 'claude', via: 'env', unambiguous: true, docs: [] })]);
  });

  it('teamai recall --check records no run', async () => {
    await h.setUp();
    const { output } = await h.recall('redis timeout', { check: true });
    expect(output).toMatch(/^RELEVANT /);
    expect(await readRecallLog(h.project)).toEqual([]);
  });

  it('teamai recall --dry-run records no run and prints no run id', async () => {
    await h.setUp();
    const { files, run } = await h.recall('redis timeout', { dryRun: true });
    expect(files).toEqual([h.docs['redis-timeout']]);
    expect(run).toBeUndefined();
    expect(await readRecallLog(h.project)).toEqual([]);
  });

  it('TEAMAI_RECALL_DISABLED=1 leaves nothing in the recall log, from recall or the hook', async () => {
    await h.setUp();
    h.env({ TEAMAI_RECALL_DISABLED: '1' });
    const { output, files } = await h.recall('redis timeout');
    await h.read(files[0]);
    expect(output).not.toContain('run=');
    expect(await readRecallLog(h.project)).toEqual([]);
  });

  it('the recall log never holds the query, prompt, tool output or file content', async () => {
    await h.setUp();
    await h.dispatch('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'why does redis PROMPTMARK time out' });
    const { files } = await h.recall('redis timeout QUERYMARK');
    expect(files).toEqual([h.docs['redis-timeout']]);
    await h.read(files[0]);
    await h.shell(`sed -n '1,80p' '${h.rel(files[0])}'`, fs.readFileSync(files[0], 'utf-8'), { tool: 'codex' });
    await h.shell(`grep -rn GREPMARK '${h.rel(path.dirname(files[0]))}'`, `${h.rel(files[0])}:12:Raise the pool size SNIPPETMARK.\n`);
    await h.stop();

    const raw = fs.readFileSync(recallLogPath(h.project), 'utf-8');
    expect(raw.match(/"kind":"evidence"/g)).toHaveLength(3);
    for (const secret of ['QUERYMARK', 'PROMPTMARK', 'SNIPPETMARK', 'GREPMARK', 'Raise the pool size', 'Author:', 'teamai recall', 'sed -n', '1,80p', ':12:']) {
      expect(raw).not.toContain(secret);
    }
    if (process.platform !== 'win32') {
      expect(fs.statSync(recallLogPath(h.project)).mode & 0o077).toBe(0);
    }
  });

  it('the recall log never holds a search\'s text when its lines carry no path', async () => {
    await h.setUp();
    const { files } = await h.recall('redis timeout');
    // One file searched with -n false: the bare line, its text before a colon.
    await h.postToolUse('Grep', { pattern: 'pool', path: files[0], output_mode: 'content', '-n': false },
      { mode: 'content', numFiles: 1, filenames: [], content: 'Raise the pool size SNIPPETMARK: now', numLines: 1 });
    // A directory searched with -h, from inside the team repo.
    await h.postToolUse('Bash', { command: 'grep -rh pool .' },
      { stdout: 'Raise the pool size SNIPPETMARK: now\n', stderr: '', interrupted: false, isImage: false }, path.dirname(files[0]));
    await h.stop();

    const raw = fs.readFileSync(recallLogPath(h.project), 'utf-8');
    for (const secret of ['SNIPPETMARK', 'Raise the pool size']) expect(raw).not.toContain(secret);
    expect(await h.upvotes(h.project)).toEqual({ 'redis-timeout': 1 });
  });

  it('an older CLI still finds the recalled doc in the new output', async () => {
    await h.setUp();
    const { output, run } = await h.recall('redis timeout');
    expect(run).toBeDefined();
    const transcript = path.join(h.tmp, 'transcript.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: output }] } })}\n`);
    expect((await parseTranscriptForVotes(transcript)).recalledDocIds).toEqual(['redis-timeout']);
  });

  it('the recall log sits in the data home of the scope that ran the recall', async () => {
    await h.setUp();
    await h.recall('redis timeout');
    expect(recallLogPath(h.project)).toBe(path.join(h.project.dataHome!, 'dashboard', 'recall.jsonl'));
    expect(fs.existsSync(recallLogPath(h.project))).toBe(true);
    expect(fs.existsSync(recallLogPath(h.user))).toBe(false);
  });

  describe('13: the recall section of teamai stats', () => {
    it('lists each session with settled runs, newest first: its agent, runs, distinct docs recalled and docs credited', async () => {
      await h.setUp();
      const first = await h.recall('redis timeout');
      await h.read(first.files[0]);
      await h.stop();
      h.at(1);
      const second = await h.recall('setup');
      h.at(2);
      const codex = await h.codexRecall('setup');
      h.at(3);
      // A run with no hits is a run, and makes the session the newest.
      await h.recall('kubernetes');
      const recalled = new Set([...first.files, ...second.files]).size;
      expect(recallRows(await h.stats())).toEqual([
        ['sess-mai', 'claude', '3', String(recalled), '1'],
        ['sess-cod', 'codex', '1', String(codex.files.length), '0'],
      ]);
    });

    it('shows at most the 10 sessions with the newest runs', async () => {
      await h.setUp();
      for (let i = 0; i < 12; i++) {
        h.at(i);
        await h.recall('redis timeout', { env: { CLAUDE_CODE_SESSION_ID: `s-${String(i).padStart(2, '0')}` }, claim: false });
      }
      const rows = recallRows(await h.stats())!;
      expect(rows.map((r) => r[0])).toEqual(['s-11', 's-10', 's-09', 's-08', 's-07', 's-06', 's-05', 's-04', 's-03', 's-02']);
    });

    it('counts no unsettled run, and a read counts as adopted only once credited, once per doc', async () => {
      await h.setUp();
      // Two session candidates and no claim: the run never settles.
      await h.recall('setup', { env: NESTED_ENV, claim: false });
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      expect(recallRows(await h.stats())).toEqual([['sess-mai', 'claude', '1', String(files.length), '0']]);
      await h.stop();
      await h.read(files[0]);
      await h.stop();
      expect(recallRows(await h.stats())).toEqual([['sess-mai', 'claude', '1', String(files.length), '1']]);
    });

    it('shows a linked child session\'s runs under its root session only', async () => {
      await h.setUp();
      const { files } = await h.openCodeRecall('redis timeout', OPENCODE_CHILD, { caller: 'teamai-recall' });
      await h.openCodeTask(OPENCODE, OPENCODE_CHILD);
      await h.openCodeRead(OPENCODE, files[0]);
      await h.openCodeIdle(OPENCODE);
      expect(recallRows(await h.stats())).toEqual([['ses_pare', 'opencode', '1', String(files.length), '1']]);
    });

    it('names the agent whose hook claimed the run, even when the environment named another (Dan)', async () => {
      await h.setUp();
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
      expect(recallRows(await h.stats())).toEqual([[CODEX.slice(0, 8), 'codex', '1', String(files.length), '1']]);
    });

    it('prints the same output with a missing log, an empty one, and one without settled runs', async () => {
      await h.setUp();
      await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.read(h.docs['redis-timeout']);
      await h.stop();
      const unsettled = await h.stats();
      fs.rmSync(recallLogPath(h.project));
      const missing = await h.stats();
      fs.writeFileSync(recallLogPath(h.project), '');
      const empty = await h.stats();
      expect(missing).not.toContain('Recall');
      expect(empty).toBe(missing);
      expect(unsettled).toBe(missing);
    });

    it('shows only the active scope\'s log: a project\'s runs not in the user scope, and the reverse', async () => {
      await h.setUp();
      await h.recall('redis timeout');
      process.chdir(process.env.HOME!);
      expect(recallRows(await h.stats())).toBeNull();
      await h.recall('cache warmup', { env: { CLAUDE_CODE_SESSION_ID: 'sess-user' }, claim: false });
      expect(recallRows(await h.stats())).toEqual([['sess-use', 'claude', '1', '1', '0']]);
      process.chdir(h.root);
      expect(recallRows(await h.stats())).toEqual([['sess-mai', 'claude', '1', '1', '0']]);
    });
  });
});
