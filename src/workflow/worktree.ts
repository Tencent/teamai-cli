/**
 * Git worktrees for workflow steps. They live under `<main>/.teamai/workflow-worktrees`,
 * which the post-checkout hook already skips, and `core.hooksPath` points at an empty directory
 * so a hook committed on a branch does not run.
 */
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { stopProcess } from '@teamai/shared/process-group';
import { TeamaiConfigBaseSchema } from '../types.js';
import { pathExists, symlinkTarget, writeJsonAtomic } from '../utils/fs.js';
import { MAX_TIMER_MS } from '@teamai/shared/timer';
import { appendRegularFile, readRegularFile, writeRegularFile } from '@teamai/shared/regular-file';

/** Agent configuration a workspace step reads from the run's base rather than from its branch. */
export const AGENT_PATHS: readonly string[] = agentConfigPaths();

function agentConfigPaths(): string[] {
  const paths = new Set(['AGENTS.md', 'CLAUDE.md', '.agents', '.githooks']);

  for (const tool of Object.values(TeamaiConfigBaseSchema.shape.toolPaths.parse(undefined))) {
    for (const field of ['skills', 'rules', 'settings', 'hooks', 'claudemd', 'agents', 'mcpProject'] as const) {
      const relative = tool[field];

      if (!relative) continue;
      const root = field === 'hooks' ? path.posix.dirname(relative) : relative;
      // A hooks file at the repository root has dirname `.`, which would reset the whole worktree.
      paths.add(configRoot(root === '.' ? relative : root));
    }
  }

  return [...paths];
}

/** A tool's own directory is reset whole. `.github` also holds workflows and code owners, so only its agent paths are. */
function configRoot(relative: string): string {
  const first = relative.split('/')[0] ?? relative;

  return first !== relative && first.startsWith('.') && first !== '.github' ? first : relative;
}

/** Paths a delivered branch may not change beyond AGENT_PATHS: CI and hooks, which run with someone's credentials. */
export const DELIVERY_ONLY_PATHS: readonly string[] = [
  '.github/workflows', '.github/actions', '.github/CODEOWNERS', '.gitlab-ci.yml', '.gitlab', '.coding-ci.yaml', '.cnb.yml', '.cnb',
  '.circleci', '.buildkite', '.husky', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.pre-commit-config.yaml',
];

/**
 * The files among `changed` that no pull request TeamAI delivers may change: AGENT_PATHS, DELIVERY_ONLY_PATHS, and
 * AGENTS.md or CLAUDE.md at any depth. Case-insensitive, as a checkout on a case-insensitive file system reads them.
 */
export function protectedPaths(changed: readonly string[]): string[] {
  const roots = [...AGENT_PATHS, ...DELIVERY_ONLY_PATHS].map((root) => root.toLowerCase());

  return changed.filter((file) => {
    const lower = file.toLowerCase();

    return /(^|\/)(agents|claude)\.md$/.test(lower) || roots.some((root) => lower === root || lower.startsWith(`${root}/`));
  });
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The exit code of a git that did not start (not installed, not executable), as a shell reports a command it cannot run.
 * No git command exits with it, so it is never read as the 0 or the 1 a git question answers with.
 */
export const GIT_NOT_STARTED = 127;

/** The exit code of a git stopped before it exited, at its deadline or by a signal, as `timeout(1)` reports one. */
export const GIT_STOPPED = 124;

/**
 * What git said to a question it answers with its exit code (`merge-base --is-ancestor`, `cat-file -e`, `diff --quiet`,
 * `show-ref --quiet`, `check-ignore -q`, `rev-parse --verify --quiet`, `symbolic-ref --quiet`): yes at exit 0, with what
 * it printed; no at any other exit of a git that ran, whose code tells a plain no (1) from a git that failed (128); and
 * nothing when git did not start, or the macOS stub ran in its place, which is no answer, never a no.
 */
export type GitAnswer = { readonly said: 'yes' | 'no' | 'nothing'; readonly result: GitResult };

/**
 * What a git whose process could not start returns, by `error`, the spawn's: in a `cwd` that is not a directory, the
 * failure `git -C` exits 128 with, since Node reports it as a missing git; otherwise GIT_NOT_STARTED.
 */
export function unstartedGit({ cwd, error, isCwdThere }: { cwd: string; error: Error; isCwdThere: boolean }): GitResult {
  if (!isCwdThere) return { code: 128, stdout: '', stderr: `fatal: cannot change to '${cwd}': No such directory` };

  const missing = 'code' in error && error.code === 'ENOENT' ? '; check that git is installed and on PATH' : '';

  return { code: GIT_NOT_STARTED, stdout: '', stderr: `git did not start: ${error.message}${missing}` };
}

/** What a git stopped before it exited returns, `why` naming what stopped it, with whatever it printed by then. */
export function stoppedGit(why: string, stderr: string): GitResult {
  return { code: GIT_STOPPED, stdout: '', stderr: `git was stopped before it answered: ${why}.${stderr.trim() ? ` ${stderr.trim()}` : ''}` };
}

// On macOS without the Command Line Tools, /usr/bin/git is a stub that runs no git: it says why on stderr and exits 1.
const GIT_STUB_REFUSAL = /^(xcode-select: note: |xcrun: error: )/m;

/** Reads `result`, git's exit to a question it answers with its exit code, as its answer (`GitAnswer`). */
export function gitAnswer(result: GitResult): GitAnswer {
  if (result.code === 0) return { said: 'yes', result };
  const isUnanswered = result.code === GIT_NOT_STARTED || result.code === GIT_STOPPED || GIT_STUB_REFUSAL.test(result.stderr);

  return { said: isUnanswered ? 'nothing' : 'no', result };
}

/** The error a caller raises when git did not answer `question`, with the cause git gave. */
export function unansweredGit(question: string, result: GitResult): Error {
  return new Error(`Could not tell ${question}: ${result.stderr.trim()}. Then try again.`);
}

/** Whether git said yes to `question`. Throws when git did not start, which is neither a yes nor a no. */
export function saidYes(answer: GitAnswer, question: string): boolean {
  if (answer.said === 'nothing') throw unansweredGit(question, answer.result);

  return answer.said === 'yes';
}

/** What git printed with its yes to `question`, trimmed; '' for a no. Throws when git did not start. */
export function yesOutput(answer: GitAnswer, question: string): string {
  if (answer.said === 'nothing') throw unansweredGit(question, answer.result);

  return answer.said === 'yes' ? answer.result.stdout.trim() : '';
}

type GitOptions = { input: string; timeoutMs?: number } | { timeoutMs: number; env?: NodeJS.ProcessEnv };

export type Git = (cwd: string, args: string[], options?: GitOptions) => Promise<GitResult>;

const UNTRUSTED = Symbol('untrusted git');

/** git that runs nothing the config of the checkout it runs in names: only `untrustedGit` makes one. */
export type UntrustedGit = Git & { readonly [UNTRUSTED]: true };

// `git worktree add` writes a new worktree's entry under `.git/worktrees/` one file at a time and takes no lock, so a
// command that reads every worktree (`fetch`, `branch`, `worktree add`, `worktree list`) dies on an entry it finds half
// written (#1526). Each dies before it changes anything, all but `worktree add -b`, and git finishes the entry within a
// write, so the command runs again. The path is matched, not git's message, which git translates.
const HALF_WRITTEN_WORKTREE = /[\\/]worktrees[\\/][^\\/\r\n]+[\\/]commondir\b/;

// Five seconds: a loaded runner can stall the writer that long. An add that died there leaves the entry half written for good.
const HALF_WRITTEN_RETRY = { forMs: 5_000, everyMs: 50 };

/**
 * Runs git in `cwd`, writing `input` to its stdin, and stopping it once `timeoutMs` passed. Waits out a worktree entry
 * another `git worktree add` in the repository is still writing.
 */
export function git(cwd: string, args: string[], options?: GitOptions): Promise<GitResult> {
  return gitWith(process.env, cwd, args, options);
}

/** `git` with `base` instead of this process's environment. */
async function gitWith(base: NodeJS.ProcessEnv, cwd: string, args: string[], options: GitOptions | undefined): Promise<GitResult> {
  const deadline = Date.now() + HALF_WRITTEN_RETRY.forMs;

  for (;;) {
    const result = await spawnGit(cwd, args, options, base);

    if (result.code === 0 || !HALF_WRITTEN_WORKTREE.test(result.stderr) || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, HALF_WRITTEN_RETRY.everyMs));
  }
}

/** `git`, stopped past `expiresAt` with every process it started, as `untrustedGit` is, with `env` instead of this process's environment. */
export function boundedGit(expiresAt: string | undefined, env: NodeJS.ProcessEnv = process.env): Git {
  return (cwd, args, options) => gitWith(env, cwd, args, boundedBy(options, expiresAt));
}

/**
 * The settings git starts with in a checkout another process controls. `-c` outranks every config file that process can
 * edit, so no hook and no fsmonitor it names runs, an object id means that object, never a replacement it set, and no
 * fetch or push reaches a submodule's remote, which its config names.
 */
export const UNTRUSTED_CONFIG: readonly string[] = [
  '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', '-c', 'core.useReplaceRefs=false',
  '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'push.recurseSubmodules=no',
];

/**
 * git in a checkout another process controls, such as a benchmark trial's clone after its tool ran: `UNTRUSTED_CONFIG`
 * first, then every program its config names turned off or replaced by the member's own (`plantedOff`), and `env`
 * instead of this process's environment, for git and for whatever the member's config starts, such as a filter, `kept`
 * among it. Past `expiresAt`, each git it started is stopped, so a filter that never returns holds its caller no longer
 * than that.
 */
export function untrustedGit(env: NodeJS.ProcessEnv, expiresAt?: string, kept: MemberConfig = NO_MEMBER_CONFIG): UntrustedGit {
  const run: Git = async (cwd, args, options) => {
    // Read before every call, never once for several: a process a step left running can write the copy's config between two calls.
    const off = await plantedOff({ cwd, env, expiresAt, kept });

    if ('error' in off) return off.error;

    return spawnGit(cwd, [...UNTRUSTED_CONFIG, ...off.args, ...withPackPrograms(args, off.hasPackPrograms)], boundedBy(options, expiresAt), { ...env, ...off.env, [HOOK_OFF]: 'false' });
  };

  return Object.assign(run, { [UNTRUSTED]: true as const });
}

/**
 * The program keys a checkout's local and worktree config named before any step of a run could write it, each as
 * `key LF value`: the member's own setup, such as a git-crypt filter or a per-repository `core.sshCommand`, which
 * `untrustedGit` keeps as the member's system and global config. A worktree shares its local config with the checkout
 * it was made from, so the member's own git runs these there anyway.
 */
export type MemberConfig = ReadonlySet<string>;

const NO_MEMBER_CONFIG: MemberConfig = new Set();

/**
 * Where a copy's remote work goes, as the member's checkout said before a run's first step: what it kept
 * (`readMemberConfig`), origin's URL among it, and the environment git runs with there.
 */
export interface MemberRemote {
  kept: MemberConfig;
  env: NodeJS.ProcessEnv;
}

/** Every value `kept` holds for config key `key`, in the order git lists them. */
function keptValues(kept: MemberConfig, key: string): string[] {
  return [...kept].flatMap((entry) => (entry.startsWith(`${key}\n`) ? [entry.slice(key.length + 1)] : []));
}

/** The URL `kept` names for fetching from origin, as `git remote get-url origin` answers in the checkout. */
export function keptOriginUrl(kept: MemberConfig): string | undefined {
  return keptValues(kept, 'remote.origin.url')[0];
}

/**
 * Where `git push origin` pushes in a checkout whose kept config is `kept`, each with the kept config to push with:
 * every push URL it names, none of them rewritten by a `pushInsteadOf`, or else origin's URL, which one rewrites. None
 * when it names no origin.
 */
export function pushTargets(kept: MemberConfig): { url: string; kept: MemberConfig }[] {
  const pushUrls = keptValues(kept, 'remote.origin.pushurl');

  if (pushUrls.length > 0) {
    const unrewritten: MemberConfig = new Set([...kept].filter((entry) => !/^url\..*\.pushinsteadof\n/.test(entry)));

    return pushUrls.map((url) => ({ url, kept: unrewritten }));
  }

  const url = keptOriginUrl(kept);

  return url === undefined ? [] : [{ url, kept }];
}

/** Reads `MemberConfig` in checkout `dir`, for a run to keep before its first step. */
export async function readMemberConfig(dir: string): Promise<string[] | { error: string }> {
  const listed = await spawnGit(dir, ['config', '--null', '--show-scope', '--get-regexp', KEPT], undefined, hostGitEnv());

  if (listed.code === 1) return [];

  if (listed.code !== 0) return { error: listed.stderr.trim() || `git config exited with ${listed.code}` };

  return configEntries(listed.stdout).filter((entry) => !TRUSTED_SCOPES.has(entry.scope)).map((entry) => `${entry.key}\n${entry.value}`);
}

type ConfigEntry = { scope: string; key: string; value: string };

/** The entries of `git config --null --show-scope`, which writes each as scope NUL key LF value NUL. */
function configEntries(stdout: string): ConfigEntry[] {
  const fields = stdout.split('\0');
  const entries: ConfigEntry[] = [];

  for (let at = 0; at + 1 < fields.length; at += 2) {
    const entry = fields[at + 1] ?? '';
    const newline = entry.indexOf('\n');
    entries.push({ scope: fields[at] ?? '', key: newline === -1 ? entry : entry.slice(0, newline), value: newline === -1 ? '' : entry.slice(newline + 1) });
  }

  return entries;
}

/**
 * The variables of this process that git and the member's own git setup need: where git and its config are, the
 * locale, the SSH agent and askpass a push signs in through, proxies and certificates. Nothing else, so a program the
 * member's own config starts in a copy, such as a filter, reads no token or key of the host.
 */
export function hostGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => HOST_GIT_ENV.has(name) || HOST_GIT_ENV.has(name.toUpperCase()) || /^LC_[A-Z]+$/.test(name)));
}

const HOST_GIT_ENV: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ', 'TERM',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  // oxlint-disable-next-line teamai/tool-home-env -- the host variables a git command keeps, where git finds its own config; it starts no tool
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'GIT_EXEC_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

/** `options` with its timeout cut to the time left before `expiresAt`, at least 1 ms: a timeout of 0 never stops git. */
function boundedBy(options: GitOptions | undefined, expiresAt: string | undefined): GitOptions | undefined {
  if (expiresAt === undefined) return options;
  const left = Math.max(1, Date.parse(expiresAt) - Date.now());
  const timeoutMs = options?.timeoutMs === undefined ? left : Math.min(options.timeoutMs, left);

  return { ...options, timeoutMs };
}

/** What each `--config-env` that turns a configured hook off reads. */
const HOOK_OFF = 'TEAMAI_GIT_HOOK_ENABLED';

/** The config scopes a step cannot write: the member's own files, and what this process sets for git. */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);

/** What each `--config-env` that gives a key the member's own value, or a neutral one, reads: one variable per value, numbered. */
const TRUSTED_VALUE = 'TEAMAI_GIT_TRUSTED_VALUE_';

/**
 * The keys whose value git runs as a program, as `git config --show-scope` spells them (section and name lower case),
 * each with what git gets in its place when only a config a step could write sets it: an empty filter is off, and an
 * empty diff or merge driver, editor or askpass makes git fail or go on without running anything.
 */
const PROGRAM_KEYS: ReadonlyArray<{ key: RegExp; neutral: (env: NodeJS.ProcessEnv) => string }> = [
  { key: /^gpg\.(?:openpgp\.)?program$/, neutral: () => 'gpg' },
  { key: /^gpg\.x509\.program$/, neutral: () => 'gpgsm' },
  { key: /^gpg\.ssh\.program$/, neutral: () => 'ssh-keygen' },
  { key: /^gpg\.ssh\.defaultkeycommand$/, neutral: () => '' },
  // GIT_SSH_COMMAND outranks the key; GIT_SSH runs only where the key is unset, so it takes the key's place.
  { key: /^core\.sshcommand$/, neutral: (env) => (env.GIT_SSH ? `'${env.GIT_SSH.replaceAll("'", `'\\''`)}'` : 'ssh') },
  { key: /^core\.askpass$/, neutral: () => '' },
  { key: /^core\.editor$|^sequence\.editor$/, neutral: () => ':' },
  { key: /^core\.pager$/, neutral: () => 'cat' },
  { key: /^pager\..+$/, neutral: () => 'false' },
  { key: /^filter\..+\.(?:clean|smudge|process)$/, neutral: () => '' },
  { key: /^diff\.external$|^diff\..+\.(?:command|textconv)$/, neutral: () => '' },
  { key: /^merge\..+\.driver$/, neutral: () => '' },
  // `protocol.allow` lets in `ext::`, whose URL is a command, unless `protocol.ext.allow` says otherwise; never is git's default.
  { key: /^protocol\.ext\.allow$/, neutral: () => 'never' },
];

/** A remote's `uploadpack` and `receivepack` add a value per `-c`, so only the command's own option replaces them. */
const PACK_PROGRAM = /^remote\..+\.(uploadpack|receivepack)$/;

/** The keys `plantedOff` reads, as one `git config --get-regexp` pattern. */
const PLANTABLE = '^hook\\..*\\.|^credential\\..*helper$|^gpg\\.|^core\\.(sshcommand|askpass|editor|pager|gitproxy)$|^sequence\\.editor$|^pager\\.|^filter\\.|^diff\\.|^merge\\..*\\.driver$|^protocol\\.|^remote\\..*\\.(uploadpack|receivepack)$';

/** What `readMemberConfig` keeps besides `PLANTABLE`: where origin is, and the URL rewrites, which `remoteGit` takes from it. */
const KEPT = `${PLANTABLE}|^remote\\.origin\\.(url|pushurl)$|^url\\..*\\.(insteadof|pushinsteadof)$`;

/** The kept keys `remoteGit` gives the git it runs: how the member signs in and reaches a host, never a hook or a filter. */
const REMOTE_KEYS = /^credential\.|^core\.(sshcommand|askpass|gitproxy)$|^url\..*\.(insteadof|pushinsteadof)$|^protocol\./;

/**
 * Runs git `args`, which reach a remote by its URL, from a bare repository of teamai's own that reads the objects of
 * checkout `dir` through its alternates. Nothing the config of `dir` names takes part, as a step in `dir` could have
 * written it: no remote, so a URL that names one is still that URL, no URL rewrite, no hook and no program. Only the
 * member's system and global config, and `member.kept`'s keys for signing in and reaching a host, apply.
 */
export async function remoteGit(dir: string, member: MemberRemote, args: string[], runGit: Git, options?: GitOptions): Promise<GitResult> {
  const common = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

  if (common.code !== 0) return common;
  const neutral = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-remote-'));

  try {
    const made = await spawnGit(neutral, ['init', '-q', '--bare', '--template=', neutral], undefined, member.env);

    if (made.code !== 0) return made;
    await writeRegularFile(path.join(neutral, 'objects', 'info', 'alternates'), `${path.join(common.stdout.trim(), 'objects')}\n`);
    const values: Record<string, string> = {};

    const given = [...member.kept].flatMap((entry) => {
      const key = entry.slice(0, entry.indexOf('\n'));

      if (!REMOTE_KEYS.test(key)) return [];
      const name = `${TRUSTED_VALUE}${Object.keys(values).length}`;
      values[name] = entry.slice(key.length + 1);

      return [`--config-env=${key}=${name}`];
    });

    return await spawnGit(neutral, ['--git-dir', neutral, ...UNTRUSTED_CONFIG, ...given, ...args], options, { ...member.env, ...values });
  } finally {
    await fs.rm(neutral, { recursive: true, force: true });
  }
}

/**
 * The options that keep what the config in `cwd` and its submodules names from running (`plantableIn`):
 * - each hook it names, `hook.<name>.command` (Git 2.54 and later), which runs beside the script hooks
 *   `core.hooksPath` turns off. `--config-env` reads the key up to its last `=`, which `-c` does not, so a hook whose
 *   name holds one is turned off too;
 * - a credential helper the checkout's own config names (`credential.helper` and `credential.<url>.helper` in its local
 *   or worktree file, which a step could write), while every helper the member's system and global config name still
 *   runs, in their order: each such key is reset, then given again the member's own values. A push that needs
 *   credentials then asks the member's helpers only;
 * - each `PROGRAM_KEYS` key such a file sets, given the member's own value last, else its neutral one. `protocol.allow`
 *   set there gives `protocol.ext.allow` the same treatment;
 * - `hasPackPrograms` when such a file sets a remote's `uploadpack` or `receivepack`, for `withPackPrograms`;
 * - `GIT_PROXY_COMMAND`, the member's own or empty, when such a file sets `core.gitProxy`.
 *
 * An entry `kept` holds counts as the member's own, as one in their global config does; a hook it names is still off.
 */
async function plantedOff(input: { cwd: string; env: NodeJS.ProcessEnv; expiresAt: string | undefined; kept: MemberConfig }): Promise<{ args: string[]; env: Record<string, string>; hasPackPrograms: boolean } | { error: GitResult }> {
  const { cwd, env, expiresAt, kept } = input;
  // Bounded too: a config can include a file that never ends, such as a pipe no one writes.
  const listed = await plantableIn({ cwd, env, expiresAt });

  if ('error' in listed) return listed;
  const hooks = new Set<string>();
  const helpers = new Map<string, Array<{ trusted: boolean; value: string }>>();
  const programs = new Map<string, Array<{ trusted: boolean; value: string }>>();
  let hasPackPrograms = false;
  let gitProxy = false;

  for (const { scope, key, value } of listed.entries) {
    const trusted = TRUSTED_SCOPES.has(scope) || kept.has(`${key}\n${value}`);
    const hook = /^hook\.(.+)\.[^.]+$/.exec(key)?.[1];

    if (key === 'core.gitproxy') gitProxy ||= !trusted;
    else if (key.startsWith('hook.')) {
      if (hook !== undefined) hooks.add(hook);
    } else if (key.startsWith('credential.')) helpers.set(key, [...helpers.get(key) ?? [], { trusted, value }]);
    else if (PACK_PROGRAM.test(key)) hasPackPrograms ||= !trusted;
    else {
      const program = key === 'protocol.allow' ? 'protocol.ext.allow' : key;

      if (PROGRAM_KEYS.some((known) => known.key.test(program))) programs.set(program, [...programs.get(program) ?? [], { trusted: trusted && key === program, value }]);
    }
  }

  const args = [...hooks].map((name) => `--config-env=hook.${name}.enabled=${HOOK_OFF}`);
  const values: Record<string, string> = {};

  const give = (key: string, value: string): void => {
    const name = `${TRUSTED_VALUE}${Object.keys(values).length}`;
    values[name] = value;
    args.push(`--config-env=${key}=${name}`);
  };

  for (const [key, entries] of helpers) {
    if (entries.every((entry) => entry.trusted)) continue;

    for (const value of ['', ...entries.filter((entry) => entry.trusted).map((entry) => entry.value)]) give(key, value);
  }

  for (const [key, entries] of programs) {
    if (entries.every((entry) => entry.trusted)) continue;
    const own = entries.findLast((entry) => entry.trusted);
    give(key, own?.value ?? PROGRAM_KEYS.find((known) => known.key.test(key))?.neutral(env) ?? '');
  }

  // The first `core.gitProxy` that matches a host wins, so no `-c` replaces one; the variable outranks every one.
  if (gitProxy) values.GIT_PROXY_COMMAND = env.GIT_PROXY_COMMAND ?? '';

  return { args, env: values, hasPackPrograms };
}

/**
 * The `PLANTABLE` entries of the config in `cwd`, then the local and worktree ones of each submodule checked out
 * under it, at any depth: git runs in a submodule for a command such as `status`, with what `-c` gives the
 * superproject, so the keys a submodule's config sets are turned off there too.
 */
async function plantableIn(input: { cwd: string; env: NodeJS.ProcessEnv; expiresAt: string | undefined; nested?: true }): Promise<{ entries: ConfigEntry[] } | { error: GitResult }> {
  const { cwd, env, expiresAt, nested } = input;
  // Bounded too: a config can include a file that never ends, such as a pipe no one writes.
  const listed = await spawnGit(cwd, ['config', '--null', '--show-scope', '--get-regexp', PLANTABLE], boundedBy(undefined, expiresAt), env);

  // git config exits 1 when no key matches.
  if (listed.code !== 0 && listed.code !== 1) return { error: listed };
  const own = configEntries(listed.stdout).filter((entry) => !nested || !TRUSTED_SCOPES.has(entry.scope));
  // Reading the index starts the fsmonitor its config names.
  const staged = await spawnGit(cwd, [...UNTRUSTED_CONFIG, 'ls-files', '--stage', '-z'], boundedBy(undefined, expiresAt), env);

  // An index git cannot read lists no submodule, and fails the command itself where it would reach one: that command
  // says what is wrong with it.
  if (staged.code !== 0) return { entries: own };
  const entries = [own];

  for (const line of gitlinkLines(staged.stdout)) {
    const sub = path.join(cwd, line.slice(line.indexOf('\t') + 1));

    if (!(await fs.stat(path.join(sub, '.git')).then(() => true, () => false))) continue;
    const inner = await plantableIn({ cwd: sub, env, expiresAt, nested: true });

    if ('error' in inner) return inner;
    entries.push(inner.entries);
  }

  return { entries: entries.flat() };
}

/** The subcommands that start a remote's `upload-pack` or `receive-pack`, with the option that names it. */
const PACK_OPTIONS = new Map([
  ['push', '--receive-pack=git-receive-pack'], ['fetch', '--upload-pack=git-upload-pack'], ['pull', '--upload-pack=git-upload-pack'], ['ls-remote', '--upload-pack=git-upload-pack'],
]);

/** `args` with git's own pack program named after its subcommand, when the copy's config names another. */
function withPackPrograms(args: string[], hasPackPrograms: boolean): string[] {
  if (!hasPackPrograms) return args;
  let at = 0;

  // Global options before the subcommand; `-c` and `-C` take the next argument.
  while (at < args.length && (args[at] ?? '').startsWith('-')) at += args[at] === '-c' || args[at] === '-C' ? 2 : 1;
  const option = PACK_OPTIONS.get(args[at] ?? '');

  return option === undefined ? args : [...args.slice(0, at + 1), option, ...args.slice(at + 1)];
}

/**
 * Settles a git that a signal stopped, such as at its timeout, once it exits: a filter it started that is still exiting,
 * or that left its tree, holds its output open, so waiting for that output to close would wait on the filter.
 */
function settleOnSignal(child: ChildProcess): void {
  child.once('exit', (_code, signal) => {
    if (signal === null) return;
    child.stdout?.destroy();
    child.stderr?.destroy();
  });
}

function isDirectory(dir: string): Promise<boolean> {
  return fs.stat(dir).then((stats) => stats.isDirectory(), () => false);
}

function spawnGit(cwd: string, args: string[], options: GitOptions | undefined, base: NodeJS.ProcessEnv): Promise<GitResult> {
  if (options === undefined) {
    return new Promise((resolve) => {
      const child = execFile('git', args, { cwd, env: base, windowsHide: true }, (error, stdout, stderr) => {
        const exit = z.number().safeParse(error?.code);

        // A git with no pid never started (ENOENT, EACCES), so it answered nothing.
        if (error && child.pid === undefined) {
          resolve(isDirectory(cwd).then((isCwdThere) => unstartedGit({ cwd, error, isCwdThere })));

          return;
        }

        if (error?.signal) {
          resolve(stoppedGit(`it got ${error.signal}`, String(stderr)));

          return;
        }

        const code = exit.success ? exit.data : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  const child = spawn('git', args, { cwd, env: 'env' in options ? { ...base, ...options.env } : base, windowsHide: true });
  settleOnSignal(child);
  let stdout = '';
  let stderr = '';
  let notStarted: Error | undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  let stoppedBy: string | undefined;

  const exited = new Promise<number>((resolve) => {
    child.on('error', (error) => {
      // A git with no pid never started (ENOENT, EACCES), so it answered nothing.
      if (child.pid === undefined) notStarted = error;
      resolve(notStarted === undefined ? 1 : GIT_NOT_STARTED);
    });
    child.on('close', (code, signal) => {
      if (code === null) stoppedBy ??= `it got ${signal ?? 'a signal'}`;
      resolve(code ?? GIT_STOPPED);
    });
  });

  // At its timeout git stops with every process it started, such as a filter that never returns. A timeout longer than a
  // timer can wait is none: Node would fire the timer at once.
  const timer = options.timeoutMs === undefined || options.timeoutMs > MAX_TIMER_MS ? undefined : setTimeout(() => {
    stoppedBy = `its deadline passed after ${options.timeoutMs} ms`;
    void stopProcess(child, exited, false)();
  }, options.timeoutMs);

  child.stdin.on('error', () => {});
  child.stdin.end('input' in options ? options.input : undefined);

  return exited.then(async (code) => {
    clearTimeout(timer);

    if (notStarted !== undefined) return unstartedGit({ cwd, error: notStarted, isCwdThere: await isDirectory(cwd) });

    // A git that exited 0 as its deadline passed answered before it was stopped.
    return stoppedBy === undefined || code === 0 ? { code, stdout, stderr } : stoppedGit(stoppedBy, stderr);
  });
}

export function worktreePath(main: string, branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step';
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 12);

  return path.join(main, '.teamai', 'workflow-worktrees', `${safe}-${hash}`);
}

export function stepCheckout(active: string, branch: string | undefined): string {
  return branch === undefined ? active : worktreePath(active, branch);
}

/** The checkout `dir` is in a step worktree of (see worktreePath), whether or not that worktree still exists. */
export function worktreeCheckout(dir: string): string | undefined {
  const parts = path.resolve(dir).split(path.sep);
  const at = parts.lastIndexOf('workflow-worktrees');

  if (at < 2 || parts[at - 1] !== '.teamai' || at === parts.length - 1) return undefined;

  return parts.slice(0, at - 1).join(path.sep) || path.sep;
}

/** A path git keeps for this checkout. A linked worktree's `.git` is a file, so the path is not `<checkout>/.git`. */
export async function gitPath(cwd: string, name: string, runGit: Git = git): Promise<string | undefined> {
  const result = await runGit(cwd, ['rev-parse', '--git-path', name]);
  const printed = result.code === 0 ? result.stdout.trim() : '';

  return printed === '' ? undefined : path.resolve(cwd, printed);
}

const EXCLUDE_MARKER = '# teamai workflow worktrees';
const EXCLUDE_BLOCK = `${EXCLUDE_MARKER}\n.teamai/workflow-worktrees/\n.teamai/workflow-hooks/\n`;

/** Keeps TeamAI worktrees out of `git status` in the active checkout. */
async function hideTeamaiWorktrees(main: string): Promise<void> {
  const excludePath = await gitPath(main, 'info/exclude');

  if (!excludePath) return;
  // The member's own file, which a dotfile manager may link: edit the file it leads to, as `writeFileAtomic` does.
  const exclude = await symlinkTarget(excludePath);
  const current = await readRegularFile(exclude, 'utf8').catch(() => '');

  if (current.includes(EXCLUDE_MARKER)) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await appendRegularFile(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}${EXCLUDE_BLOCK}`);
}

/** Removes `dir` when empty; a dry run counts it empty when it holds only the worktrees in `gone`, which go first. */
async function removeEmptyDir(dir: string, dryRun: boolean, gone: readonly string[] = []): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => null);

  if (entries === null || entries.some((name) => !(dryRun && gone.includes(path.join(dir, name))))) return false;

  if (!dryRun) await fs.rmdir(dir);

  return true;
}

/** Marks `extensions.worktreeConfig` as one teamai turned on, holding the member's value before (`unset` when none). */
const WORKTREE_CONFIG_OWNED = 'teamai.worktreeconfig';

/**
 * Undoes in `checkout` what its workflow worktrees set up: the directories that held them, the exclude block that hid
 * them, and `extensions.worktreeConfig` when teamai turned it on and no worktree has a configuration of its own. Nothing while a TeamAI worktree
 * of the repository is left, since it still needs them. Returns what it removed, or with `dryRun` what it would.
 */
export async function removeWorktreeSetup(checkout: string, { dryRun = false, gone = [] }: { dryRun?: boolean; gone?: readonly string[] } = {}): Promise<string[]> {
  const listed = await git(checkout, ['worktree', 'list', '--porcelain']);

  if (listed.code !== 0) return [];
  // `gone`: the worktrees a dry run counts as removed already, as the removal before it will have removed them.
  const worktrees = listed.stdout.split('\n').flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : [])).filter((dir) => !gone.includes(dir));

  if (worktrees.some((dir) => worktreeCheckout(dir) !== undefined)) return [];

  // git's records of gone worktrees go with the setup: Docker makes a missing bind mount source, such as a sandbox's
  // mount of a step worktree's git directory, as an empty directory when a container starts after the worktree went.
  if (!dryRun) {
    const forgot = await forgetGoneWorktrees(checkout);

    if (!forgot.ok) throw new Error(forgot.reason);
  }

  const removed: string[] = [];

  for (const dir of [path.join(checkout, '.teamai', 'workflow-worktrees'), hooksPath(checkout)]) {
    if (await removeEmptyDir(dir, dryRun, gone)) removed.push(dir);
  }

  const excludePath = await gitPath(checkout, 'info/exclude');
  const exclude = excludePath === undefined ? undefined : await symlinkTarget(excludePath);
  const current = exclude === undefined ? '' : await readRegularFile(exclude, 'utf8').catch(() => '');

  if (exclude !== undefined && current.includes(EXCLUDE_BLOCK)) {
    if (!dryRun) await writeRegularFile(exclude, current.replace(EXCLUDE_BLOCK, ''));
    removed.push(`${exclude} (${EXCLUDE_MARKER.slice(2)})`);
  }

  const had = (await git(checkout, ['config', '--local', '--get', WORKTREE_CONFIG_OWNED])).stdout.trim();

  if (had !== '') {
    const ownConfigs = await Promise.all(worktrees.map(async (dir) => {
      const file = await gitPath(dir, 'config.worktree');

      return file !== undefined && await pathExists(file);
    }));

    if (!dryRun) {
      await git(checkout, ['config', '--local', '--unset', WORKTREE_CONFIG_OWNED]);

      if (!ownConfigs.includes(true)) {
        await git(checkout, had === 'unset' ? ['config', '--local', '--unset', 'extensions.worktreeConfig'] : ['config', '--local', 'extensions.worktreeConfig', had]);
      }
    }

    removed.push(ownConfigs.includes(true) ? `${WORKTREE_CONFIG_OWNED} in the git config` : 'extensions.worktreeConfig in the git config');
  }

  // The upstream each run branch's push recorded, which the branch, the member's to keep, no longer needs teamai for.
  const upstreams = await git(checkout, ['config', '--local', '--name-only', '--get-regexp', String.raw`^branch\.teamai/.*\.remote$`]);

  for (const key of upstreams.code === 0 ? upstreams.stdout.split('\n').filter(Boolean) : []) {
    const branch = key.slice('branch.'.length, -'.remote'.length);

    if (await isRunBranch(branch)) removed.push(...(await forgetUpstream(checkout, branch, { dryRun })).map((name) => `${name} in the git config`));
  }

  if (removed.length > 0) await removeEmptyDir(path.join(checkout, '.teamai'), dryRun);

  return removed;
}

/**
 * A worktree teamai made for a workflow run (see `worktreePath`), as an uninstall finds it: `removable` when nothing in it
 * is lost with it (its commits are on `branch`, which stays, or git's record outlived the directory), else `kept` with why.
 */
export type RunWorktree =
  | { kind: 'removable'; dir: string; branch?: string }
  | { kind: 'kept'; dir: string; why: string; isLocked: boolean };

/** Every worktree of the repository of `checkout`, each with the lines `git worktree list --porcelain` gave it. */
async function listedWorktrees(checkout: string): Promise<{ dir: string; lines: string[] }[] | { error: string }> {
  const listed = await git(checkout, ['worktree', 'list', '--porcelain']);

  if (listed.code !== 0) return { error: listed.stderr.trim() || 'git worktree list failed' };

  return listed.stdout.split('\n\n').flatMap((entry) => {
    const lines = entry.split('\n');
    const dir = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);

    return dir === undefined ? [] : [{ dir, lines }];
  });
}

/** Whether `other` is a worktree inside `dir`, which removing `dir` deletes with it. git spells a path with `/` on Windows too. */
function holds(dir: string, other: string): boolean {
  return path.resolve(other).startsWith(path.resolve(dir) + path.sep);
}

/**
 * The first of the `listed` worktrees inside `dir`, which removing `dir` deletes with it; links resolved on both sides,
 * since git records a worktree by its real path and a caller may name it through a link, such as macOS's `/var`.
 */
async function worktreeInside(dir: string, listed: ReadonlyArray<{ dir: string }>): Promise<string | undefined> {
  const real = (at: string): Promise<string> => fs.realpath(at).catch(() => path.resolve(at));
  const [outer, others] = await Promise.all([real(dir), Promise.all(listed.map((other) => real(other.dir)))]);
  const at = others.findIndex((other) => holds(outer, other));

  return at === -1 ? undefined : listed[at]?.dir;
}

/**
 * Each worktree teamai made for a workflow run in the repositories of `checkouts`, each with the first of them in its
 * repository and innermost first, the order they can be removed in; and each checkout whose worktrees git could not list.
 * A repository is read once, however many of its checkouts are named. One holding a worktree that stays stays too: a
 * run started in a run's worktree puts its own inside, where teamai's exclude block hides it from the outer one's status.
 */
export async function runWorktreesOf(checkouts: readonly string[]): Promise<{ worktrees: Array<{ checkout: string; worktree: RunWorktree }>; unread: Array<{ checkout: string; error: string }> }> {
  const worktrees: Array<{ checkout: string; worktree: RunWorktree }> = [];
  const unread: Array<{ checkout: string; error: string }> = [];
  const read = new Set<string>();

  for (const checkout of checkouts) {
    const common = await git(checkout, ['rev-parse', '--git-common-dir']);
    const repository = common.code === 0 ? path.resolve(checkout, common.stdout.trim()) : checkout;

    if (read.has(repository)) continue;
    read.add(repository);
    const listed = await listedWorktrees(checkout);

    if ('error' in listed) {
      unread.push({ checkout, error: listed.error });
      continue;
    }

    const sorted: RunWorktree[] = [];

    for (const { dir, lines } of [...listed].sort((a, b) => b.dir.length - a.dir.length)) {
      if (worktreeCheckout(dir) === undefined) continue;
      const found = await runWorktreeAt(dir, lines);
      // Innermost first, so each worktree inside this one is already sorted; one that is no run worktree stays.
      const staying = listed.find((other) => holds(dir, other.dir) && !sorted.some((done) => done.dir === other.dir && done.kind === 'removable'));

      if (found.kind === 'removable' && staying !== undefined) {
        const why = sorted.find((done) => done.dir === staying.dir && done.kind === 'kept');
        sorted.push({ kind: 'kept', dir, why: `it holds the worktree ${staying.dir}, which stays${why?.kind === 'kept' ? ` (${why.why})` : ''}`, isLocked: false });
      } else sorted.push(found);
    }

    worktrees.push(...sorted.map((worktree) => ({ checkout, worktree })));
  }

  return { worktrees, unread };
}

/** Whether removing the run worktree `dir`, which `git worktree list --porcelain` described with `lines`, loses anything. */
async function runWorktreeAt(dir: string, lines: readonly string[]): Promise<RunWorktree> {
  const branch = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);

  const locked = lines.find((line) => line === 'locked' || line.startsWith('locked '));

  // Before the directory: git keeps a locked one's record whose directory is gone, such as one on a disk not plugged in.
  if (locked !== undefined) return { kind: 'kept', dir, why: `git keeps it locked${locked === 'locked' ? '' : ` (${locked.slice('locked '.length)})`}`, isLocked: true };

  if (!await pathExists(dir)) return { kind: 'removable', dir, ...branch !== undefined && { branch } };
  const kept = (why: string): RunWorktree => ({ kind: 'kept', dir, why, isLocked: false });

  if (branch === undefined) return kept('its HEAD is detached, so no branch holds its commits');
  // A step may have planted a program in its worktree's config: read it as `unrestoredCopy` does.
  const runGit = untrustedGit(hostGitEnv());
  const status = await copyStatus(dir, runGit);

  if ('error' in status) return kept(`git could not tell what changed in it (${status.error})`);

  if (status.lines.length > 0) return kept(`it has changes no commit holds: ${listedPaths(status.lines)}`);
  // Files git ignores are in no commit either, such as an .env the member copied in. `traditional` names an ignored
  // directory once, rather than each file in a node_modules. teamai's own .teamai/ in it is not the member's.
  const ignored = await runGit(dir, ['status', '--porcelain', '--ignored=traditional', '--untracked-files=normal', '--ignore-submodules=none']);

  if (ignored.code !== 0) return kept(`git could not tell which files it ignores in it (${ignored.stderr.trim() || 'git status failed'})`);
  const theirs = ignored.stdout.split('\n').filter((line) => line.startsWith('!! ') && !line.startsWith('!! .teamai/'));

  if (theirs.length > 0) return kept(`it holds files git ignores, which no commit holds: ${listedPaths(theirs)}`);

  return { kind: 'removable', dir, branch };
}

/** The first five of `git status --porcelain` `lines`, for a message. */
function listedPaths(lines: readonly string[]): string {
  return `${lines.slice(0, 5).map((line) => line.trim()).join(', ')}${lines.length > 5 ? `, and ${lines.length - 5} more` : ''}`;
}

/**
 * Removes the run worktree `worktree` of `checkout`'s repository with git's own records of it, once it is read again as
 * `runWorktreesOf` reads it: one that gained a change since stays, with why, and so does one holding another worktree
 * (`removeWorktree`). One whose directory is gone loses only git's record. Forced, since git's own check would run a status in the worktree, and with it a program a step planted
 * in the worktree's config; the read before it is the check, through untrusted git.
 */
export async function removeRunWorktree(checkout: string, worktree: Extract<RunWorktree, { kind: 'removable' }>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const listed = await listedWorktrees(checkout);

  if ('error' in listed) return { ok: false, reason: `git could not list the worktrees (${listed.error})` };
  const entry = listed.find(({ dir }) => dir === worktree.dir);
  const now = entry === undefined ? undefined : await runWorktreeAt(entry.dir, entry.lines);

  if (now?.kind === 'kept') return { ok: false, reason: now.why };

  return now !== undefined && await pathExists(worktree.dir) ? removeWorktree(checkout, worktree.dir) : forgetGoneWorktrees(checkout);
}

export function hooksPath(main: string): string {
  return path.join(main, '.teamai', 'workflow-hooks');
}

/** The commit HEAD points to, and the branch when HEAD is not detached. */
export async function headCommit(cwd: string): Promise<{ ref?: string; commit: string } | undefined> {
  const result = await git(cwd, ['rev-parse', 'HEAD']);

  if (result.code !== 0) return undefined;
  const commit = result.stdout.trim();

  if (!commit) return undefined;
  const head = gitAnswer(await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']));

  // A git that did not answer leaves HEAD unread, as one that could not read the commit does.
  if (head.said === 'nothing') return undefined;
  const ref = head.said === 'yes' ? head.result.stdout.trim() : '';

  return ref ? { ref, commit } : { commit };
}

/**
 * Creates the worktree when it is missing. A branch that already exists is checked out as it is. An existing worktree
 * off its branch is refused, so a step never commits on whatever HEAD was left.
 */
export async function ensureWorktree(main: string, branch: string, start: string): Promise<{ dir: string; created: boolean } | { error: string }> {
  const dir = worktreePath(main, branch);
  const hooks = hooksPath(main);
  await fs.mkdir(hooks, { recursive: true });
  await hideTeamaiWorktrees(main);
  const present = await fs.stat(dir).then((stats) => stats.isDirectory(), () => false);

  // A deleted worktree stays registered, and `worktree add` refuses its path until it is pruned.
  if (!present) await forgetGoneWorktrees(main);

  if (present) {
    const prefix = await git(dir, ['rev-parse', '--show-prefix']);

    if (prefix.code !== 0 || prefix.stdout.trim() !== '') {
      return { error: `${dir} is not a workflow worktree, so no step runs there. Move it out of the way, then retry the step.` };
    }

    const on = await offBranch(dir, branch);

    if (on) return { error: `Workspace ${dir} is ${on}, not on branch ${branch}. Check out ${branch} in ${dir}, then retry the step.` };
    await worktreeHooks(dir, hooks);

    return { dir, created: false };
  }

  await fs.mkdir(path.dirname(dir), { recursive: true });
  const config = ['-c', `core.hooksPath=${hooks}`];
  const exists = gitAnswer(await git(main, ['rev-parse', '--verify', '--quiet', branch]));

  if (exists.said === 'nothing') return { error: unansweredGit(`whether branch ${branch} exists in ${main}`, exists.result).message };
  // Not `worktree add -b`: it makes the branch before it reads the worktrees, so when git runs it again after a half
  // written entry (see `git`), it finds the branch it made.
  const branched = exists.said === 'yes' ? exists.result : await git(main, [...config, 'branch', branch, start]);
  const created = branched.code === 0 ? await git(main, [...config, 'worktree', 'add', dir, branch]) : branched;

  if (created.code !== 0) return { error: created.stderr.trim() || created.stdout.trim() || 'git worktree add failed' };
  await worktreeHooks(dir, hooks);

  return { dir, created: true };
}

/** In the worktree's own git dir from its creation until its setup finished, so one whose setup never finished is made again. */
const SETUP_UNFINISHED = 'teamai-setup-unfinished';

export async function setupUnfinished(dir: string): Promise<boolean> {
  const marker = await gitPath(dir, SETUP_UNFINISHED);

  return marker !== undefined && await fs.stat(marker).then(() => true, () => false);
}

export async function markSetup(dir: string, state: 'unfinished' | 'finished'): Promise<void> {
  const marker = await gitPath(dir, SETUP_UNFINISHED);

  if (!marker) return;

  if (state === 'unfinished') await writeRegularFile(marker, '');
  else await fs.rm(marker, { force: true });
}

/**
 * Where HEAD is, such as `on refs/heads/other` or `detached at <commit>`, when it is not on `branch`. Undefined when it
 * is. `runGit` runs each git call.
 */
export async function offBranch(dir: string, branch: string, runGit: Git = git): Promise<string | undefined> {
  const onBranch = gitAnswer(await runGit(dir, ['symbolic-ref', '--quiet', 'HEAD']));

  // A git that did not answer is never on the branch, so every caller refuses the checkout with git's cause.
  if (onBranch.said === 'nothing') return `where git cannot tell (${onBranch.result.stderr.trim()})`;
  const head = onBranch.said === 'yes' ? onBranch.result.stdout.trim() : '';

  if (head === `refs/heads/${branch}`) return undefined;

  return head ? `on ${head}` : `detached at ${(await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()}`;
}

/**
 * Brings local branch `branch` to `expected`, the commit a run this machine took over recorded for it, by fast-forward
 * only. A branch ahead of it or apart from it, or its worktree with changes, a reader's mark, or HEAD elsewhere, stays
 * as it is, and the answer says why, even when the branch is already at `expected`. A branch this checkout does not have
 * is left to the lease that opens it.
 */
export async function reconcileCopy(main: string, branch: string, expected: string): Promise<{ error: string } | undefined> {
  const ref = `refs/heads/${branch}`;
  const local = gitAnswer(await git(main, ['rev-parse', '--verify', '--quiet', ref]));

  if (local.said === 'nothing') return { error: unansweredGit(`whether branch ${branch} is here`, local.result).message };

  if (local.said === 'no') return undefined;
  const tip = local.result.stdout.trim();

  const behind = tip === expected ? undefined : gitAnswer(await git(main, ['merge-base', '--is-ancestor', tip, expected]));

  if (behind?.said === 'nothing') return { error: unansweredGit(`whether branch ${branch} here at ${tip} is behind ${expected}`, behind.result).message };

  if (behind?.said === 'no') {
    return { error: `Branch ${branch} here is at ${tip}, which is not behind ${expected}, the commit the run recorded for it, so it holds work the run does not know about. teamai moves neither: keep that work elsewhere, delete or reset ${branch}, then resume the run.` };
  }

  const own = worktreePath(main, branch);
  // An earlier step ran in the branch's copy, so its config may start anything.
  const copyGit = untrustedGit(hostGitEnv());

  if (await fs.stat(own).then((stats) => stats.isDirectory(), () => false)) {
    const on = await offBranch(own, branch, copyGit);

    if (on) return { error: `Workspace ${own} is ${on}, not on branch ${branch}, so the run does not continue there. Check out ${branch} in ${own}, then resume the run.` };
  }

  const listed = await git(main, ['worktree', 'list', '--porcelain']);

  const dir = listed.stdout.split('\n\n').map((entry) => entry.split('\n'))
    .find((lines) => lines.includes(`branch ${ref}`))?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);

  if (dir !== undefined) {
    if (await unrestoredCopy(dir)) {
      return { error: `Workspace ${dir} was left by a reader and is not back, so the run does not continue there. Put it back as the step found it, then resume the run.` };
    }

    const status = await copyStatus(dir, copyGit);

    if ('error' in status) return status;

    if (status.lines.length > 0) {
      return { error: `Workspace ${dir} on ${branch} has changes the run did not record, so the run does not continue there. Move them elsewhere or remove them, then resume the run.` };
    }
  }

  if (tip === expected) return undefined;

  if (dir === undefined) {
    const moved = await git(main, ['update-ref', ref, expected, tip]);

    return moved.code === 0 ? undefined : { error: `Branch ${branch} could not be moved from ${tip} to ${expected}: ${moved.stderr.trim()}` };
  }

  const merged = await copyGit(dir, ['merge', '--ff-only', '--quiet', expected]);

  return merged.code === 0 ? undefined : { error: `Workspace ${dir} could not be moved to ${expected}: ${merged.stderr.trim()}` };
}

/**
 * Points the hooks of worktree `dir` at `hooks`, an empty directory, so no hook of the repository runs in a step's git,
 * without changing the hooks of any other worktree.
 */
export async function worktreeHooks(dir: string, hooks: string): Promise<void> {
  // Set in the configuration every worktree of the repository shares. Off, `--worktree` writes there too, over the
  // member's hooks. The mark keeps what the member had, so taking it back restores that.
  const had = (await git(dir, ['config', '--local', '--type=bool', '--get', 'extensions.worktreeConfig'])).stdout.trim();

  if (had !== 'true') {
    await git(dir, ['config', WORKTREE_CONFIG_OWNED, had === '' ? 'unset' : had]);
    await git(dir, ['config', 'extensions.worktreeConfig', 'true']);
  }

  await git(dir, ['config', '--worktree', 'core.hooksPath', hooks]);
}

/** Drops what `worktreeHooks` set in worktree `dir`, so the repository's own hooks run there again. */
export async function clearWorktreeHooks(dir: string): Promise<void> {
  await git(dir, ['config', '--worktree', '--unset', 'core.hooksPath']);
}

/**
 * The commits among `commits` this checkout still lacks after fetching run `run`'s branches from origin. A fetch whose
 * refspec matches no branch exits 0, so each commit is checked again after it. `fetchError` is git's message when the
 * fetch itself failed. `fetch` bounds the fetch and sets its environment.
 */
export async function fetchMissingCommits(
  dir: string, { run, commits, branch }: { run: string; commits: string[]; branch?: string }, fetch?: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ missing: string[]; fetchError?: string }> {
  const lacking = await lackedCommits(dir, commits);

  if (lacking.length === 0) return { missing: [] };
  // `branch` is fetched too when the run's own refspec does not cover it, as a team repo branch's is not.
  const own = branch === undefined || branch.startsWith(`teamai/${run}/`) ? [] : [`+refs/heads/${branch}:refs/remotes/origin/${branch}`];
  const fetched = await git(dir, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/teamai/${run}/*:refs/remotes/origin/teamai/${run}/*`, ...own], fetch);
  const missing = await lackedCommits(dir, lacking);

  if (fetched.code === 0 || missing.length === 0) return { missing };

  return { missing, fetchError: (fetched.stderr || fetched.stdout).trim() || 'git fetch failed' };
}

async function lackedCommits(dir: string, commits: string[]): Promise<string[]> {
  const lacking: string[] = [];

  for (const commit of new Set(commits)) {
    // Lacking unless git says it has it: the fetch that follows says why when git did not answer.
    if (gitAnswer(await git(dir, ['cat-file', '-e', `${commit}^{commit}`])).said !== 'yes') lacking.push(commit);
  }

  return lacking;
}

/**
 * Merges `commit` unless it is already contained. A conflict leaves the worktree as git stopped. A merge that stopped
 * with no unmerged file and no merge in progress, such as unrelated histories or an untracked file in the way, is
 * `failed` with git's message.
 */
export async function mergeBranch(dir: string, commit: string, runGit: Git): Promise<
  { state: 'merged' } | { state: 'conflict'; files: string[] } | { state: 'failed'; error: string }
> {
  const contained = gitAnswer(await runGit(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']));

  if (contained.said === 'yes') return { state: 'merged' };

  if (contained.said === 'nothing') return { state: 'failed', error: unansweredGit(`whether ${dir} already holds ${commit}`, contained.result).message };

  const merged = await runGit(dir, [
    '-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost',
    'merge', '--no-ff', '--no-edit', commit,
  ]);

  if (merged.code === 0) return { state: 'merged' };
  const unmerged = await gitPaths(dir, ['diff', '--name-only', '--diff-filter=U'], runGit);

  if (unmerged.code !== 0) return { state: 'failed', error: unmerged.stderr.trim() || 'git diff failed' };
  // An earlier attempt that left its merge unfinished resolves it as a conflict, even with every file staged.
  const unfinished = gitAnswer(await runGit(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']));

  if (unfinished.said === 'nothing') return { state: 'failed', error: unansweredGit(`whether a merge is in progress in ${dir}`, unfinished.result).message };

  if (unmerged.paths.length > 0 || unfinished.said === 'yes') return { state: 'conflict', files: unmerged.paths };

  return { state: 'failed', error: (merged.stderr || merged.stdout).trim() || 'git merge failed' };
}

/**
 * Replaces agent configuration with the copy at `commit` and points hooks at an empty directory.
 * `saved`, a directory that does not exist yet, receives the branch's own copy, put back for paths the step does not edit:
 * AGENT_PATHS, or `paths` when the copy's install delivers elsewhere in it too, such as team docs.
 * With `resume`, a `saved` an interrupted run of this left is the branch's copy, and the rest is done again over it.
 */
export async function applyBaseConfig(
  dir: string, commit: string, hooks: string, saved: string, options: { run: Git; resume?: true; paths?: readonly string[] },
): Promise<{ ok: true; saved: string } | { ok: false; message: string }> {
  await options.run(dir, ['config', '--worktree', 'core.hooksPath', hooks]);
  const linked = await symlinkedParent(dir);

  if (linked) {
    // Every run branch starts from the base, so no step can fix a symlink the base has.
    const inBase = (await options.run(dir, ['ls-tree', commit, '--', linked.parent])).stdout.startsWith('120000 ');

    if (inBase) {
      return { ok: false, message: `Agent configuration ${linked.relative} is under the symlink ${linked.parent} in the run's base commit ${commit}, so it was not reset. Commit ${linked.parent} as a directory on the base branch, then start a new run.` };
    }

    const head = gitAnswer(await options.run(dir, ['symbolic-ref', '--quiet', 'HEAD']));
    const branch = head.said === 'yes' ? head.result.stdout.trim().replace(/^refs\/heads\//, '') : 'HEAD';

    return { ok: false, message: `Agent configuration ${linked.relative} is under the symlink ${linked.parent} on branch ${branch}, so it was not reset. Commit ${linked.parent} as a directory on branch ${branch} in ${dir}, then retry the step.` };
  }

  // Listed before anything is removed, so a base git cannot read leaves the branch's agent files in place.
  const present = await gitPaths(dir, ['ls-tree', '--name-only', commit, '--', ...AGENT_PATHS], options.run);

  if (present.code !== 0) return { ok: false, message: unreadBase(dir, commit, present.stderr) };
  // A failed checkout still stages the base copy, so the index is put back with the files.
  const indexFile = await gitPath(dir, 'index', options.run);
  const index = indexFile === undefined ? undefined : await readRegularFile(indexFile).catch(() => undefined);

  if (indexFile === undefined || index === undefined) {
    return { ok: false, message: `Agent configuration in ${dir} could not be reset to the run's base commit ${commit}, because its git index could not be read, so the step did not run. Check that git status works in ${dir}, then retry the step.` };
  }

  await fs.mkdir(path.dirname(saved), { recursive: true });
  // The branch's files are copied aside under another name, and renamed to `saved` once all are there, so a process
  // killed while it copies leaves them in place in the copy, and a `saved` that exists holds every one of them.
  const copying = `${saved}.partial`;
  await fs.rm(copying, { recursive: true, force: true });
  const kept = await pathExists(saved);

  if (kept && !options.resume) {
    return { ok: false, message: `Agent configuration in ${dir} was not reset to the run's base commit ${commit}, because ${saved} already holds the branch's agent files from an earlier attempt to prepare this step, so the step did not run. Copy the files you need from ${saved} into ${dir}, delete ${saved}, then retry the step.` };
  }

  if (!kept) {
    await fs.mkdir(copying);
    await writeRegularFile(path.join(copying, '_conflicts'), (await options.run(dir, ['ls-files', '-u', '-z', '--', ...AGENT_PATHS])).stdout);
    await saveConfig(dir, copying, options.paths);
    await fs.rename(copying, saved);
  }

  // Read back, so a resumed prepare puts back the conflicts the branch had, which the base checkout cleared.
  const conflicts = await readRegularFile(path.join(saved, '_conflicts'), 'utf8');

  for (const relative of AGENT_PATHS) await fs.rm(path.join(dir, relative), { recursive: true, force: true });
  const refused = await checkoutBaseConfig(dir, commit, present.paths, options.run);

  if (refused) {
    await putBackBranchConfig(dir, saved, { indexFile, index });

    return { ok: false, message: refused };
  }

  // The base checkout cleared unmerged agent files. Put the conflict back so the step can see it,
  // and keep the stages in `_conflicts` so an untouched file is not committed as resolved.
  for (const relative of conflictPaths(conflicts)) {
    await fs.rm(path.join(dir, relative), { recursive: true, force: true });

    try {
      await copyEntry(path.join(saved, relative), path.join(dir, relative));
    } catch {
      // One side of the conflict deleted the file.
    }
  }

  return { ok: true, saved };
}

/** Checks out the base's agent paths `paths` over the removed branch copy. Why the step cannot run, when it cannot. */
async function checkoutBaseConfig(dir: string, commit: string, paths: string[], runGit: Git): Promise<string | undefined> {
  if (paths.length > 0) {
    const restored = await runGit(dir, ['checkout', commit, '--', ...paths]);

    if (restored.code !== 0) {
      return `Agent configuration in ${dir} could not be checked out from the run's base commit ${commit}, so the step did not run and the branch's agent files were left as they were. Git said: ${restored.stderr.trim() || 'no message'}. Fix what git reported, then retry the step.`;
    }
  }

  const extra = await gitPaths(dir, ['diff', '--name-only', commit, '--', ...AGENT_PATHS], runGit);

  if (extra.code !== 0) return unreadBase(dir, commit, extra.stderr);

  if (extra.paths.length === 0) return undefined;

  return `Agent configuration in ${dir} does not match the run's base commit ${commit} after checking it out: ${extra.paths.join(', ')}. The step did not run and the branch's agent files were left as they were. A .gitattributes filter or line-ending rule that rewrites these files on checkout usually causes this. Fix that rule and retry the step, or commit the files as they check out on the base branch and start a new run.`;
}

/** Puts the branch's agent files and index back after a reset that failed, and removes the saved copy. */
async function putBackBranchConfig(dir: string, saved: string, { indexFile, index }: { indexFile: string; index: Buffer }): Promise<void> {
  for (const relative of AGENT_PATHS) {
    await fs.rm(path.join(dir, relative), { recursive: true, force: true });

    try {
      await copyEntry(path.join(saved, relative), path.join(dir, relative));
    } catch {
      // The branch does not have this path.
    }
  }

  // Renamed over the index, so git never reads it half written.
  await writeRegularFile(`${indexFile}.teamai`, index);
  await fs.rename(`${indexFile}.teamai`, indexFile);
  await fs.rm(saved, { recursive: true, force: true });
}

function unreadBase(dir: string, commit: string, stderr: string): string {
  return `Agent configuration in ${dir} could not be reset to the run's base commit ${commit}, so the step did not run. Git said: ${stderr.trim() || 'no message'}. Make ${commit} available in this checkout, for example by fetching the branch that has it, then retry the step.`;
}

/** An agent path whose parent is a symlink. Copying or removing it would reach outside the worktree. */
async function symlinkedParent(dir: string): Promise<{ relative: string; parent: string } | undefined> {
  for (const relative of AGENT_PATHS) {
    const parent = await linkedParent(dir, relative);

    if (parent) return { relative, parent };
  }

  return undefined;
}

async function linkedParent(dir: string, relative: string): Promise<string | undefined> {
  const parts = relative.split('/');

  for (let end = 1; end < parts.length; end += 1) {
    const parent = parts.slice(0, end).join('/');

    if (await fs.lstat(path.join(dir, parent)).then((stats) => stats.isSymbolicLink(), () => false)) return parent;
  }

  return undefined;
}

/** Puts saved conflict stages back after the base checkout cleared them, before the step runs. */
export async function reopenConfigConflicts(dir: string, saved: string, runGit: Git): Promise<void> {
  const conflicts = await readRegularFile(path.join(saved, '_conflicts'), 'utf8').catch(() => '');
  const paths = conflictPaths(conflicts);

  if (paths.length > 0) await restoreConflictStages(dir, conflicts, paths, runGit);
}

/** Where a copy saved with paths beyond AGENT_PATHS lists them, so every later step on it covers the same paths. */
const SAVED_PATHS = '_paths.json';

/** The paths `saved` holds the agent configuration of: AGENT_PATHS, unless `saveConfig` was given others. */
export async function savedConfigPaths(saved: string): Promise<readonly string[]> {
  const listed = z.array(z.string().min(1)).safeParse(JSON.parse(await readRegularFile(path.join(saved, SAVED_PATHS), 'utf8').catch(() => 'null')));

  return listed.success ? listed.data : AGENT_PATHS;
}

/**
 * Copies the agent configuration `dir` has into `saved`: the copy `restoreUneditedConfig` puts back. `paths`, relative
 * to `dir`, are AGENT_PATHS unless a copy's install delivers elsewhere in it too; `saved` then lists them.
 */
export async function saveConfig(dir: string, saved: string, paths: readonly string[] = AGENT_PATHS): Promise<void> {
  if (paths !== AGENT_PATHS) await writeRegularFile(path.join(saved, SAVED_PATHS), JSON.stringify(paths));

  for (const relative of paths) {
    try {
      await copyEntry(path.join(dir, relative), path.join(saved, relative));
    } catch {
      // The branch does not have this path.
    }
  }
}

/** Puts the agent configuration `from` holds in place of `dir`'s, path by path. */
export async function replaceConfig(dir: string, from: string): Promise<void> {
  for (const relative of await savedConfigPaths(from)) {
    await fs.rm(path.join(dir, relative), { recursive: true, force: true });

    try {
      await copyEntry(path.join(from, relative), path.join(dir, relative));
    } catch {
      // `from` does not have this path.
    }
  }
}

/**
 * The commit `git add` would record for the gitlink at `relative`, or undefined when that path is not a gitlink.
 * A checkout inside the submodule is that commit. The index commit is the fallback when the checkout cannot be read.
 */
async function gitlinkCommit(dir: string, relative: string, run: Git): Promise<string | undefined> {
  const listed = await run(dir, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', relative]);

  if (listed.code !== 0) return undefined;

  const staged = listed.stdout.split('\0').find((line) => {
    const tab = line.indexOf('\t');

    if (tab < 0 || line.slice(tab + 1) !== relative) return false;
    const [mode, , stage] = line.slice(0, tab).split(' ');

    return mode === '160000' && stage === '0';
  });

  if (staged === undefined) return undefined;
  const indexSha = staged.slice(0, staged.indexOf('\t')).split(' ')[1] ?? '';
  const head = gitAnswer(await run(path.join(dir, relative), ['rev-parse', '--verify', '--quiet', 'HEAD']));
  const checked = head.said === 'yes' ? head.result.stdout.trim() : '';

  return /^[0-9a-f]{40}$/i.test(checked) ? checked : indexSha;
}

/**
 * The content key of `relative` in `dir`, or `absent` when that path is not there. A gitlink is `gitlink:<commit>`, the
 * commit checked out in it. `run` is the git it runs, required so a caller in a place a step controls passes `untrustedGit`.
 */
export async function worktreeContentKey(dir: string, relative: string, run: Git): Promise<string> {
  const gitlink = await gitlinkCommit(dir, relative, run);

  if (gitlink !== undefined && gitlink !== '') return `gitlink:${gitlink}`;
  const files = await fileManifest(dir, [relative]);

  return files[relative] ?? 'absent';
}

/** Records the agent files present after team delivery, so that delivery is not a step edit. */
export async function recordConfigOverlay(dir: string, saved: string): Promise<void> {
  const paths = await savedConfigPaths(saved);
  await writeRegularFile(path.join(saved, '_overlay.json'), JSON.stringify(await fileManifest(dir, paths)));
  await writeRegularFile(path.join(saved, '_dirs.json'), JSON.stringify(await agentDirs(dir, paths)));
}

/**
 * Paths among `dirty` that still match the overlay `saved` recorded after prepare. Prepare checks the base agent
 * files out over the branch, so git lists them when that copy differs, and the host did not write them. A missing
 * overlay matches nothing. `error` is why the record could not be read.
 */
export async function unchangedOverlayPaths(dir: string, saved: string, dirty: readonly string[]): Promise<{ paths: ReadonlySet<string> } | { error: string }> {
  const file = path.join(saved, '_overlay.json');

  if (!await pathExists(file)) return { paths: new Set() };

  let raw: unknown;

  try {
    raw = JSON.parse(await readRegularFile(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { error: `${file} could not be read (${reason})` };
  }

  const parsed = z.record(z.string(), z.string()).safeParse(raw);

  if (!parsed.success) return { error: `${file} is not a record of the base agent files` };
  const roots = await savedConfigPaths(saved);
  const current = await fileManifest(dir, roots);
  const covered = (relative: string): boolean => roots.some((root) => relative === root || relative.startsWith(`${root}/`));
  const paths = new Set<string>();

  for (const relative of dirty) {
    if (covered(relative) && current[relative] === parsed.data[relative]) paths.add(relative);
  }

  return { paths };
}

/**
 * Puts back each branch agent file that the step left unchanged. A file the step edited stays. When git cannot list the
 * worktree's files, nothing is put back, `saved` is kept, and the reason is returned as a clause. `runGit` runs every
 * git call.
 */
export async function restoreUneditedConfig(dir: string, _commit: string, saved: string, runGit: Git): Promise<string | undefined> {
  // Listed before anything changes. The index stays as it is until the files are back.
  const paths = await savedConfigPaths(saved);
  const unmergedListed = await gitPaths(dir, ['diff', '--name-only', '--diff-filter=U'], runGit);
  const indexed = await gitPaths(dir, ['ls-files', '--', ...paths], runGit);
  const unlisted = [unmergedListed, indexed].find((listed) => listed.code !== 0);

  if (unlisted) {
    return `git could not list the files in ${dir} (${unlisted.stderr.trim() || 'no message'}); the branch's agent files are still in ${saved}`;
  }

  const overlay = z.record(z.string(), z.string()).parse(JSON.parse(await readRegularFile(path.join(saved, '_overlay.json'), 'utf8')));
  const current = await fileManifest(dir, paths);
  const branch = await fileManifest(saved, paths);
  const conflicts = await readRegularFile(path.join(saved, '_conflicts'), 'utf8').catch(() => '');
  const dirs = z.array(z.string()).parse(JSON.parse(await readRegularFile(path.join(saved, '_dirs.json'), 'utf8').catch(() => '[]')));
  const marked = await markedConflicts(dir, conflictPaths(conflicts));
  // Staging a conflict without leaving markers is a resolution, even when the text matches the overlay.
  // An unstaged file that still matches the overlay is not.
  const unmerged = new Set(unmergedListed.paths);

  const unresolved = [...new Set([
    ...conflictPaths(conflicts).filter((relative) => current[relative] === overlay[relative] && unmerged.has(relative)),
    ...marked,
  ])];

  // The step replaced a parent of these agent paths with a symlink. That is its edit, and restoring under it would
  // delete or write files outside the worktree.
  const linked: string[] = [];

  for (const root of paths) if (await linkedParent(dir, root)) linked.push(path.join(root));
  const files = new Set([...Object.keys(overlay), ...Object.keys(current), ...Object.keys(branch)]);

  for (const relative of files) {
    if (linked.some((root) => relative === root || relative.startsWith(`${root}${path.sep}`))) continue;

    if (unresolved.includes(relative)) continue;

    if (relative === '_overlay.json' || current[relative] !== overlay[relative]) continue;

    // The step replaced a parent, for example a directory with a symlink. Do not restore through that edit.
    if (ancestorEdited(current, overlay, relative)) continue;

    if (await parentRemoved(dir, dirs, relative)) continue;

    // The step wrote under a directory the branch stores as a symlink. Keep that edit.
    if (descendantEdited(current, overlay, relative)) continue;

    // A branch symlink replaces the directory the base checkout put back. Leave its children alone.
    if (underBranchSymlink(branch, relative)) continue;
    const target = path.join(dir, relative);

    try {
      await fs.rm(target, { recursive: true, force: true });
      await removeBlockingSymlink(dir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await copyEntry(path.join(saved, relative), target);
    } catch {
      // The branch had no file at this path, and the step did not add one.
    }
  }

  await removeEmptiedDirs(dir, dirs, await agentDirs(saved, paths));
  await fs.rm(saved, { recursive: true, force: true });
  // `checkout` of the base copies staged those paths. Put the index back with the files, or a step that
  // edits nothing still looks dirty and the empty commit fails it.
  const present = await presentAgentPaths(dir, indexed.paths, paths);

  if (present.length > 0) await runGit(dir, ['add', '-A', '--', ...present]);

  if (unresolved.length > 0) await restoreConflictStages(dir, conflicts, unresolved, runGit);

  return undefined;
}

/**
 * Removes each directory of the overlay, `overlayDirs`, that the branch's copy does not have and that the restore left
 * empty, deepest first so a parent emptied by its child goes too. A directory the branch has, one the step made, or one
 * under a symlink stays.
 */
async function removeEmptiedDirs(dir: string, overlayDirs: readonly string[], branchDirs: readonly string[]): Promise<void> {
  const branch = new Set(branchDirs);
  const delivered = overlayDirs.filter((relative) => !branch.has(relative)).sort((left, right) => right.length - left.length);

  for (const relative of delivered) {
    if (await linkedParent(dir, relative)) continue;
    const target = path.join(dir, relative);

    try {
      if ((await fs.lstat(target)).isDirectory() && (await fs.readdir(target)).length === 0) await fs.rmdir(target);
    } catch {
      // Gone already, or not readable: it holds nothing of the branch's either way.
    }
  }
}

/**
 * Agent paths in the worktree or among `indexed`, the index's agent files. `git add` stages nothing when one of its paths
 * matches neither.
 */
async function presentAgentPaths(dir: string, indexed: string[], paths: readonly string[]): Promise<string[]> {
  const present: string[] = [];

  for (const relative of paths) {
    const tracked = indexed.some((file) => file === relative || file.startsWith(`${relative}/`));

    if (tracked || await fs.lstat(path.join(dir, relative)).then(() => true, () => false)) present.push(relative);
  }

  return present;
}

async function gitPaths(dir: string, args: string[], runGit: Git = git): Promise<{ code: number; stderr: string; paths: string[] }> {
  const listed = await runGit(dir, [...args.slice(0, 1), '-z', ...args.slice(1)]);

  return { code: listed.code, stderr: listed.stderr, paths: listed.stdout.split('\0').filter((file) => file !== '') };
}

function conflictRecords(conflicts: string): { line: string; path: string }[] {
  return conflicts.split('\0').flatMap((record) => {
    const line = record.endsWith('\n') ? record.slice(0, -1) : record;
    const tab = line.lastIndexOf('\t');

    if (tab < 0 || line.slice(tab + 1) === '') return [];

    return [{ line, path: line.slice(tab + 1) }];
  });
}

function conflictPaths(conflicts: string): string[] {
  return [...new Set(conflictRecords(conflicts).map((record) => record.path))];
}

/** Puts unmerged stages back so `git add` does not publish conflict markers as a resolution. */
async function restoreConflictStages(dir: string, conflicts: string, paths: string[], runGit: Git = git): Promise<void> {
  const wanted = new Set(paths);
  const lines = conflictRecords(conflicts).filter((record) => wanted.has(record.path)).map((record) => record.line);
  // `git rm --cached` leaves stage 0 in place beside the restored stages, and then `git add` cannot clear them.
  const removal = paths.map((relative) => `0 ${'0'.repeat(40)}\t${relative}`);
  const payload = [...removal, ...lines];

  if (payload.length > 0) await runGit(dir, ['update-index', '--index-info'], { input: `${payload.join('\n')}\n` });
}

async function fileManifest(root: string, paths: readonly string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  const walk = async (relative: string): Promise<void> => {
    const current = path.join(root, relative);
    let stats;

    try {
      stats = await fs.lstat(current);
    } catch {
      return;
    }

    // A directory symlink is the link, not the files it points at. Following it would delete those files on restore.
    if (stats.isSymbolicLink()) {
      files[relative] = `link:${await fs.readlink(current)}`;

      return;
    }

    if (stats.isDirectory()) {
      const entries = await fs.readdir(current);

      for (const name of entries.sort((a, b) => a.localeCompare(b))) await walk(path.join(relative, name));

      return;
    }

    if (stats.isFile()) files[relative] = `file:${(stats.mode & 0o777).toString(8)}:${(await readRegularFile(current)).toString('base64')}`;
  };

  for (const relative of paths) await walk(relative);

  return files;
}

/** Stages the paths `args` added, then forces any gitlink among them. `git add -A` skips a submodule whose `ignore` is `all`. Pathspecs are literal, so a reported `app/[id]/page.tsx` does not also match `app/i/page.tsx`. */
async function stageAdded(dir: string, args: string[], runGit: Git, only?: ReadonlySet<string>): Promise<GitResult> {
  const added = await runGit(dir, ['--literal-pathspecs', ...args]);

  if (added.code !== 0) return added;
  const listed = await runGit(dir, only === undefined ? ['ls-files', '-s', '-z'] : ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...only]);

  if (listed.code !== 0) return listed;
  const modules = gitlinkLines(listed.stdout).map((line) => line.slice(line.indexOf('\t') + 1)).filter((module) => only === undefined || only.has(module));

  return modules.length > 0 ? runGit(dir, ['--literal-pathspecs', 'add', '-f', '--', ...modules]) : added;
}

/** Stages every change. `git add -A` skips a submodule whose `ignore` is `all`, so each submodule is also staged by name. */
async function stageAll(dir: string, runGit: Git = git): Promise<GitResult> {
  return stageAdded(dir, ['add', '-A'], runGit);
}

/** A path git can be given to `git add`: it is in the worktree, or still in the index. A staged rename's old path and a staged removal are neither, and `git add` rejects them. */
async function pathCanBeStaged(dir: string, relative: string, runGit: Git): Promise<boolean> {
  try {
    await fs.lstat(path.join(dir, relative));

    return true;
  } catch {
    return (await runGit(dir, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', relative])).code === 0;
  }
}

/** Stages `paths` and nothing else. An empty list stages nothing, so a file written after the caller chose the list stays out. */
async function stagePaths(dir: string, paths: readonly string[], runGit: Git): Promise<GitResult> {
  if (paths.length === 0) return { code: 0, stdout: '', stderr: '' };
  const present = await Promise.all(paths.map(async (relative) => await pathCanBeStaged(dir, relative, runGit) ? relative : undefined));
  const stageable = present.filter((relative): relative is string => relative !== undefined);

  if (stageable.length === 0) return { code: 0, stdout: '', stderr: '' };

  return stageAdded(dir, ['add', '-A', '--', ...stageable], runGit, new Set(stageable));
}

/**
 * Commits changes in `dir`, with `runGit` running every git call: a step ran there, so `untrustedGit`.
 * `paths` stages only those paths. Absent, every change is staged. An empty list stages nothing.
 */
export async function commitWork(
  dir: string, message: string, fromCommit: string | undefined, runGit: UntrustedGit, paths?: readonly string[],
): Promise<{ from: string; to: string; commits: string[] } | { error: string }> {
  const before = fromCommit === undefined ? await runGit(dir, ['rev-parse', 'HEAD']) : { code: 0, stdout: fromCommit, stderr: '' };

  if (before.code !== 0) return { error: before.stderr.trim() || 'HEAD could not be read' };
  const from = before.stdout.trim();
  const merging = gitAnswer(await runGit(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']));

  if (merging.said === 'nothing') return { error: unansweredGit(`whether a merge is in progress in ${dir}`, merging.result).message };
  const added = paths === undefined ? await stageAll(dir, runGit) : await stagePaths(dir, paths, runGit);

  if (added.code !== 0) return { error: added.stderr.trim() || 'git add failed' };
  const staged = gitAnswer(await runGit(dir, ['diff', '--cached', '--quiet', '--ignore-submodules=none', '--no-ext-diff']));

  if (staged.said === 'nothing') return { error: unansweredGit(`whether anything is staged in ${dir}`, staged.result).message };

  if (staged.said === 'no' || merging.said === 'yes') {
    // Older Git also applies diff.ignoreSubmodules to commit's staged-change check.
    // We deliberately staged these gitlinks, so do not hide them again here.
    const committed = await runGit(dir, ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', '-c', 'diff.ignoreSubmodules=none', 'commit', '-m', message]);

    if (committed.code !== 0) return { error: committed.stderr.trim() || committed.stdout.trim() || 'git commit failed' };
  }

  const after = await runGit(dir, ['rev-parse', 'HEAD']);
  const to = after.stdout.trim();
  const listed = to === from ? { stdout: '' } : await runGit(dir, ['rev-list', '--reverse', `${from}..${to}`]);

  return { from, to, commits: listed.stdout.split('\n').map((commit) => commit.trim()).filter((commit) => commit !== '') };
}

/**
 * Pushes when the member's checkout named an origin before the run, and the branch is ahead of the copy `origin` has.
 * It pushes where `git push origin` did there (`pushTargets`, through `remoteGit`), never to one the copy's config
 * names now, and records what `push -u origin` would: the remote-tracking ref and the branch's upstream.
 * A retry that adds no commit still pushes when an earlier attempt left commits unpublished,
 * including a first push that never created the remote branch.
 * No origin is not a failure. `runGit` runs each git call: a step ran in `dir`, so `untrustedGit`.
 */
export async function pushIfOrigin(dir: string, branch: string, commits: string[], runGit: UntrustedGit, member: MemberRemote): Promise<'pushed' | 'no-origin' | 'unchanged' | { error: string }> {
  const targets = pushTargets(member.kept);

  if (targets.length === 0) {
    const origin = await runGit(dir, ['remote', 'get-url', 'origin']);

    if (origin.code !== 0) return commits.length === 0 ? 'unchanged' : 'no-origin';

    return { error: `teamai kept no origin of the checkout this copy was made from before the run's first step (it named none, or an older teamai started the run), so teamai does not push to the one the copy names now. Push ${branch} yourself, or start the run again` };
  }

  if (commits.length === 0 && !await branchNeedsPush(dir, branch, runGit)) return 'unchanged';
  const tip = await runGit(dir, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);

  if (tip.code !== 0) return { error: tip.stderr.trim() || `${branch} has no commit` };
  const commit = tip.stdout.trim();

  for (const target of targets) {
    const pushed = await remoteGit(dir, { ...member, kept: target.kept }, ['push', '--quiet', target.url, `${commit}:refs/heads/${branch}`], runGit);

    if (pushed.code !== 0) return { error: (pushed.stderr || pushed.stdout).trim() || 'git push failed' };
  }

  await runGit(dir, ['update-ref', `refs/remotes/origin/${branch}`, commit]);

  for (const [key, value] of upstreamOf(branch)) await runGit(dir, ['config', key, value]);

  return 'pushed';
}

/** The upstream `pushIfOrigin` records of a branch it pushed, as `git push -u origin` would: each config key and its value. */
function upstreamOf(branch: string): Array<[key: string, value: string]> {
  return [[`branch.${branch}.remote`, 'origin'], [`branch.${branch}.merge`, `refs/heads/${branch}`]];
}

/**
 * Removes from `checkout`'s git config the upstream `pushIfOrigin` recorded for run branch `branch`, each key only while
 * it still says what teamai wrote: one the member changed stays. Answers the keys removed, or with `dryRun` those it would.
 */
export async function forgetUpstream(checkout: string, branch: string, { dryRun = false } = {}): Promise<string[]> {
  const removed: string[] = [];

  for (const [key, value] of upstreamOf(branch)) {
    if ((await git(checkout, ['config', '--local', '--get', key])).stdout.trim() !== value) continue;

    if (!dryRun && (await git(checkout, ['config', '--local', '--unset', key])).code !== 0) continue;
    removed.push(key);
  }

  return removed;
}

/** Whether `branch` is one a run made: `teamai/<run>/…`, or a fleet attempt's `teamai/attempts/<run>/…`. */
async function isRunBranch(branch: string): Promise<boolean> {
  // Imported at call time: a static import of store.js here changes the order its importers' modules load in, and one
  // then reads a schema before it is made.
  const { isRunId } = await import('./store.js');
  const [namespace, first = '', second = ''] = branch.split('/');

  return namespace === 'teamai' && isRunId(first === 'attempts' ? second : first);
}

/**
 * Whether this branch's tip is missing from `origin`.
 * A remote-tracking ref that does not contain the tip needs another push.
 * With no tracking refs at all, push when the tip is not already on another local branch:
 * a first push that never landed leaves commits only on this branch.
 */
async function branchNeedsPush(dir: string, branch: string, runGit: Git): Promise<boolean> {
  // A git that did not answer needs the push: the push says why when git still cannot run.
  const local = gitAnswer(await runGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]));

  if (local.said === 'nothing') return true;

  if (local.said === 'no') return false;
  const tip = local.result.stdout.trim();
  const remote = `refs/remotes/origin/${branch}`;
  const known = gitAnswer(await runGit(dir, ['rev-parse', '--verify', '--quiet', remote]));

  if (known.said === 'nothing') return true;

  if (known.said === 'yes') {
    return gitAnswer(await runGit(dir, ['merge-base', '--is-ancestor', tip, remote])).said !== 'yes';
  }

  const listed = await runGit(dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']);

  if (listed.stdout.trim() === '') return tipIsOnlyOn(dir, branch, tip, runGit);
  const published = await runGit(dir, ['branch', '-r', '--contains', tip]);

  return published.code === 0 && published.stdout.trim() === '';
}

/** True when no other local branch already contains this tip. */
async function tipIsOnlyOn(dir: string, branch: string, tip: string, runGit: Git): Promise<boolean> {
  const holders = await runGit(dir, ['branch', '--no-color', '--contains', tip]);

  if (holders.code !== 0) return true;
  const names = holders.stdout.split('\n').map((line) => line.trim().replace(/^[*+] /, '')).filter((name) => name !== '');

  return names.every((name) => name === branch);
}

function descendantEdited(current: Record<string, string>, overlay: Record<string, string>, relative: string): boolean {
  const prefix = `${relative}${path.sep}`;

  for (const key of new Set([...Object.keys(current), ...Object.keys(overlay)])) {
    if (key.startsWith(prefix) && current[key] !== overlay[key]) return true;
  }

  return false;
}

/**
 * Copies a file, directory, or symlink without rewriting the link or dropping its mode. Anything else, such as a FIFO a
 * step left in its copy, which git ignores too, is not copied: copying one would wait until a writer opens it.
 */
async function copyEntry(from: string, to: string): Promise<void> {
  const stats = await fs.lstat(from);
  // A nested agent path such as .github/copilot-instructions.md has no parent in a fresh copy.
  await fs.mkdir(path.dirname(to), { recursive: true });

  if (stats.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(from), to);

    return;
  }

  if (stats.isDirectory()) {
    await fs.mkdir(to, { recursive: true });

    for (const name of await fs.readdir(from)) await copyEntry(path.join(from, name), path.join(to, name));
    await fs.chmod(to, stats.mode);

    return;
  }

  if (!stats.isFile()) return;
  await writeRegularFile(to, await readRegularFile(from));
  await fs.chmod(to, stats.mode);
}

async function parentRemoved(dir: string, dirs: string[], relative: string): Promise<boolean> {
  const parts = relative.split(path.sep);
  let parent = '';

  for (const part of parts.slice(0, -1)) {
    parent = parent === '' ? part : path.join(parent, part);

    if (!dirs.includes(parent)) continue;

    try {
      if ((await fs.lstat(path.join(dir, parent))).isSymbolicLink()) continue;
    } catch {
      return true;
    }
  }

  return false;
}

async function markedConflicts(dir: string, paths: string[]): Promise<string[]> {
  const marked: string[] = [];

  for (const relative of paths) {
    try {
      if ((await readRegularFile(path.join(dir, relative), 'utf8')).includes('<<<<<<<')) marked.push(relative);
    } catch {
      // The step removed the conflicted file.
    }
  }

  return marked;
}

async function agentDirs(root: string, paths: readonly string[]): Promise<string[]> {
  const dirs: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    let stats;

    try {
      stats = await fs.lstat(path.join(root, relative));
    } catch {
      return;
    }

    if (!stats.isDirectory()) return;
    dirs.push(relative);

    for (const name of await fs.readdir(path.join(root, relative))) await walk(path.join(relative, name));
  };

  for (const relative of paths) await walk(relative);

  return dirs;
}

function ancestorEdited(current: Record<string, string>, overlay: Record<string, string>, relative: string): boolean {
  const parts = relative.split(path.sep);
  let parent = '';

  for (const part of parts.slice(0, -1)) {
    parent = parent === '' ? part : path.join(parent, part);

    if (current[parent] !== overlay[parent]) return true;
  }

  return false;
}

function underBranchSymlink(branch: Record<string, string>, relative: string): boolean {
  const parts = relative.split(path.sep);
  let parent = '';

  for (const part of parts.slice(0, -1)) {
    parent = parent === '' ? part : path.join(parent, part);

    if (branch[parent]?.startsWith('link:')) return true;
  }

  return false;
}

/** Removes a symlink that sits where a restored file needs a real directory, without following it. */
async function removeBlockingSymlink(dir: string, relative: string): Promise<void> {
  const parts = relative.split(path.sep);
  let parent = '';

  for (const part of parts.slice(0, -1)) {
    parent = parent === '' ? part : path.join(parent, part);
    const at = path.join(dir, parent);

    try {
      if ((await fs.lstat(at)).isSymbolicLink()) await fs.rm(at, { force: true });
    } catch {
      // The parent is absent.
    }
  }
}

/**
 * Removes worktree `dir` of `main`'s repository, or says why it stays. One holding another worktree stays: git would
 * delete that one with it, uncommitted changes and all, such as the worktree of a run started inside `dir`, which
 * teamai's exclude block hides from this one's status.
 */
export async function removeWorktree(main: string, dir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  // A record whose directory is gone holds nothing.
  await forgetGoneWorktrees(main);
  const listed = await listedWorktrees(main);

  if ('error' in listed) return { ok: false, reason: `git could not list the worktrees (${listed.error})` };
  const inside = await worktreeInside(dir, listed);

  if (inside !== undefined) return { ok: false, reason: `it holds the worktree ${inside}, which removing it would delete; finish or remove that one first` };
  const removed = await git(main, ['worktree', 'remove', '--force', dir]);

  await forgetGoneWorktrees(main);

  return removed.code === 0 ? { ok: true } : { ok: false, reason: removed.stderr.trim() || 'git worktree remove failed' };
}

/** Forgets git's record of each worktree of `main`'s repository whose directory is gone; a locked one stays. */
export async function forgetGoneWorktrees(main: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pruned = await git(main, ['worktree', 'prune']);

  // prune exits 0 on a record it could not delete, and says so only on stderr.
  return pruned.code === 0 && pruned.stderr.trim() === '' ? { ok: true } : { ok: false, reason: `git did not forget the worktrees whose directory is gone (${pruned.stderr.trim() || 'git worktree prune failed'})` };
}

const UnrestoredMarker = z.object({ branch: z.string(), commit: z.string(), step: z.string(), reason: z.string(), found: z.array(z.string()) });

export type UnrestoredMarker = z.infer<typeof UnrestoredMarker>;

/** In the worktree's own git dir, so the marker never shows in its status. */
const UNRESTORED_MARKER = 'teamai-unrestored';

/** A copy's status, with every untracked file and submodule change whatever the user's status config hides. */
async function copyStatus(dir: string, runGit: Git): Promise<{ lines: string[] } | { error: string }> {
  const status = await runGit(dir, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);

  if (status.code !== 0) return { error: status.stderr.trim() || 'git status failed' };

  return { lines: status.stdout.split('\n').filter((line) => line.trim() !== '') };
}

/** Why `dir` is not on `branch` at `commit` with the status `found`, submodules included. Undefined when it is. */
async function copyLeftOver(dir: string, { branch, commit, found }: { branch: string; commit: string; found: string[] }, runGit: Git): Promise<string | undefined> {
  const onBranch = gitAnswer(await runGit(dir, ['symbolic-ref', '--quiet', 'HEAD']));

  if (onBranch.said === 'nothing') return unansweredGit(`the branch ${dir} is on`, onBranch.result).message;
  const head = onBranch.said === 'yes' ? onBranch.result.stdout.trim() : '';

  if (head !== `refs/heads/${branch}`) return head ? `HEAD is on ${head}` : 'HEAD is detached';
  const at = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim();

  if (at !== commit) return `HEAD is at ${at}`;
  const status = await copyStatus(dir, runGit);

  if ('error' in status) return status.error;
  const was = new Set(found);
  const now = new Set(status.lines);
  const lines = [...status.lines.filter((line) => !was.has(line)), ...found.filter((line) => !now.has(line))];

  if (lines.length === 0) return undefined;

  return `it has changes: ${lines.slice(0, 5).map((line) => line.trim()).join(', ')}${lines.length > 5 ? `, and ${lines.length - 5} more` : ''}`;
}

/**
 * Marks `dir` as left by a reader before the reader changes anything, with the status it has now. Putting the copy back
 * removes the mark, so a driver killed before that leaves the copy refused to later steps until it is back.
 */
export async function markReadCopy(dir: string, { branch, step }: { branch: string; step: string }, runGit: Git): Promise<{ found: string[] } | { error: string }> {
  const status = await copyStatus(dir, runGit);

  if ('error' in status) return status;
  const head = await runGit(dir, ['rev-parse', 'HEAD']);
  const marker = await gitPath(dir, UNRESTORED_MARKER, runGit);

  if (head.code !== 0 || !marker) return { error: head.stderr.trim() || 'its git directory could not be found' };
  const record: UnrestoredMarker = { branch, commit: head.stdout.trim(), step, reason: 'the reader did not finish', found: status.lines };

  try {
    await writeJsonAtomic(marker, record);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  return { found: status.lines };
}

/** Drops the mark a reader left, without putting the worktree back. */
export async function releaseReadCopy(dir: string): Promise<void> {
  await clearReadCopyMark(dir);
}

async function clearReadCopyMark(dir: string, runGit: Git = git): Promise<void> {
  const marker = await gitPath(dir, UNRESTORED_MARKER, runGit);

  if (marker) await fs.rm(marker, { force: true });
}

/**
 * A copy a reader could not put back, while it is still not back. Once a copy that was clean is back, the marker is
 * removed, so the person who put it back only retries the step.
 */
export async function unrestoredCopy(dir: string): Promise<
  { state: 'unrestored'; dir: string; marker: UnrestoredMarker; left: string } | { state: 'unreadable'; dir: string; marker: string } | undefined
> {
  const file = await gitPath(dir, UNRESTORED_MARKER);

  if (!file) return undefined;
  let raw: unknown;

  try {
    raw = JSON.parse(await readRegularFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;

    return { state: 'unreadable', dir, marker: file };
  }

  const parsed = UnrestoredMarker.safeParse(raw);

  if (!parsed.success) return { state: 'unreadable', dir, marker: file };

  // A status line names a path, not its content, so only a copy that was clean can be seen to be back.
  if (parsed.data.found.length > 0) {
    return { state: 'unrestored', dir, marker: parsed.data, left: `it had changes when the step started, so teamai cannot tell when it is back; delete ${file} once it is` };
  }

  const left = await copyLeftOver(dir, parsed.data, untrustedGit(hostGitEnv()));

  if (left) return { state: 'unrestored', dir, marker: parsed.data, left };
  await fs.rm(file, { force: true });

  return undefined;
}

function gitlinkLines(listed: string): string[] {
  return listed.split('\0').filter((line) => line.startsWith('160000 '));
}

/** Each submodule path `commit` records, with the commit it records there. */
async function treeGitlinks(dir: string, commit: string, runGit: Git): Promise<Map<string, string> | { error: string }> {
  const listed = await runGit(dir, ['ls-tree', '-r', '-z', commit]);

  if (listed.code !== 0) return { error: listed.stderr.trim() || `git ls-tree ${commit} failed` };

  return new Map(gitlinkLines(listed.stdout).map((line) => {
    const tab = line.indexOf('\t');

    return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2] ?? ''];
  }));
}

/** Submodule paths whose commit `to` records and `from` does not, at any depth below `prefix`. */
async function movedModules(dir: string, from: string | undefined, to: string, prefix: string, runGit: Git): Promise<{ path: string; dir: string; commit: string }[] | { error: string }> {
  const before = from ? await treeGitlinks(dir, from, runGit) : new Map<string, string>();
  const after = await treeGitlinks(dir, to, runGit);

  if ('error' in before) return before;

  if ('error' in after) return after;
  const moved: { path: string; dir: string; commit: string }[] = [];

  for (const [relative, commit] of after) {
    const was = before.get(relative);

    if (was === commit) continue;
    const sub = path.join(dir, relative);
    moved.push({ path: `${prefix}${relative}`, dir: sub, commit });
    const nested = await movedModules(sub, was, commit, `${prefix}${relative}/`, runGit);

    if ('error' in nested) return nested;
    moved.push(...nested);
  }

  return moved;
}

/**
 * Copies each submodule commit `to` records and `from` does not, at any depth, into this repository's own store. A gitlink
 * does not keep its commit reachable, and removing the copy deletes the submodule's store with it.
 */
async function keepModuleCommits(dir: string, { from, to, attempt }: { from: string; to: string; attempt: string }, runGit: Git): Promise<{ modules?: string } | { error: string }> {
  const moved = await movedModules(dir, from, to, '', runGit);

  if ('error' in moved) return moved;

  if (moved.length === 0) return {};
  const common = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

  if (common.code !== 0) return { error: common.stderr.trim() || 'the git directory could not be found' };
  const modules = `refs/teamai/kept-modules/${attempt}/`;

  for (const module of moved) {
    // Named by commit: a path need not be a valid ref name, and vendor would clash with vendor/inner. This copy stays
    // local, so the user's push policy and hooks do not apply.
    const pushed = await runGit(module.dir, ['push', '-q', '--no-verify', '--no-recurse-submodules', common.stdout.trim(), `${module.commit}:${modules}${module.commit}`]);

    if (pushed.code !== 0) return { error: pushed.stderr.trim() || `the commit in ${module.path} could not be kept` };
  }

  return { modules };
}

/**
 * Repositories among `paths`, submodules and ones the step created, whose changes the kept commit cannot hold: uncommitted
 * or untracked files, or a nested submodule's commit its parent has not recorded. A submodule with no checkout left counts
 * too, since its files may have gone with it.
 */
async function unkeptRepositories(dir: string, { paths, commit }: { paths: string[]; commit: string }, runGit: Git): Promise<{ paths: string[] } | { error: string }> {
  const recorded = await treeGitlinks(dir, commit, runGit);
  const staged = await runGit(dir, ['ls-files', '-s', '-z']);

  if ('error' in recorded || staged.code !== 0) return { error: 'error' in recorded ? recorded.error : staged.stderr.trim() || 'git ls-files failed' };
  const gitlinks = new Set([...recorded.keys(), ...gitlinkLines(staged.stdout).map((line) => line.slice(line.indexOf('\t') + 1))]);
  // Dirty, not all: a nested submodule's new commit shows only as a change in its parent.
  const status = ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=dirty'];
  const unkept: string[] = [];

  for (const relative of paths) {
    // Status lists a repository the step created as its directory with a trailing slash.
    const name = relative.replace(/\/$/, '');

    if (!gitlinks.has(name) && name === relative) continue;
    const repo = path.join(dir, name);
    const top = await runGit(repo, ['rev-parse', '--show-prefix']);

    if (top.code !== 0 || top.stdout.trim() !== '') {
      if (gitlinks.has(name)) unkept.push(name);
      continue;
    }

    for (const args of [status, ['submodule', '--quiet', 'foreach', '--recursive', `test -z "$(git ${status.join(' ')})" || echo "$displaypath"`]]) {
      const listed = await runGit(repo, args);

      if (listed.code !== 0) return { error: listed.stderr.trim() || `git ${args[0]} failed in ${name}` };

      if (listed.stdout.trim() === '') continue;
      unkept.push(name);
      break;
    }
  }

  return { paths: unkept };
}

/** Where a reader's changes were kept: the whole tree on `ref`, and each submodule commit it made under `modules`. */
export type KeptChanges = { ref: string; modules?: string };

export function keptSentence(kept: KeptChanges): string {
  return kept.modules
    ? `Its changes are kept on ${kept.ref}, and the submodule commits it made under ${kept.modules}.`
    : `Its changes are kept on ${kept.ref}.`;
}

/**
 * Puts a copy a reader read back on `branch` at `commit` with the status `found` it had when the reader started, after
 * keeping what it changed on `refs/teamai/kept/<attempt>`. A copy it cannot put back keeps its mark with the reason, so
 * later steps there are refused until it is.
 */
export async function putBackCopy({ dir, branch, commit, found, changed, attempt, step, run }: {
  dir: string; branch: string; commit: string; found: string[]; changed: string[]; attempt: string; step: string; run: Git;
}): Promise<
  { state: 'untouched' } | { state: 'restored'; kept: KeptChanges } | { state: 'unrestored'; reason: string; kept?: KeptChanges }
> {
  if (changed.length === 0) {
    await clearReadCopyMark(dir, run);

    return { state: 'untouched' };
  }

  const unrestored = async (reason: string, kept?: KeptChanges): Promise<{ state: 'unrestored'; reason: string; kept?: KeptChanges }> => {
    const marker = await gitPath(dir, UNRESTORED_MARKER, run);
    const record: UnrestoredMarker = { branch, commit, step, reason, found };

    if (marker) await writeJsonAtomic(marker, record);

    return kept ? { state: 'unrestored', reason, kept } : { state: 'unrestored', reason };
  };

  // The keep below records a submodule only as its commit, so a submodule update would destroy its files.
  const dirty = await unkeptRepositories(dir, { paths: changed, commit }, run);

  if ('error' in dirty) return unrestored(dirty.error);

  if (dirty.paths.length > 0) return unrestored(`submodules have uncommitted or untracked files: ${dirty.paths.join(', ')}`);
  // A commit of the whole tree, not `git stash`: the stash list is shared by every worktree, and a stash leaves out a submodule's commit.
  const ref = `refs/teamai/kept/${attempt}`;
  const added = await stageAll(dir, run);
  const tree = added.code === 0 ? await run(dir, ['write-tree']) : added;

  const committed = tree.code === 0
    ? await run(dir, ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', 'commit-tree', tree.stdout.trim(), '-p', 'HEAD', '-m', `teamai: kept ${step}`])
    : tree;

  if (committed.code !== 0) return unrestored(committed.stderr.trim() || 'its changes could not be kept');
  const modules = await keepModuleCommits(dir, { from: commit, to: committed.stdout.trim(), attempt }, run);

  if ('error' in modules) return unrestored(modules.error);
  const recorded = await run(dir, ['update-ref', ref, committed.stdout.trim()]);

  // Without the ref, a reset would lose the changes.
  if (recorded.code !== 0) return unrestored(recorded.stderr.trim() || 'its changes could not be kept');
  const kept: KeptChanges = { ref, ...modules };
  // Back on the copy's branch first: a reset on a branch the step switched to would leave the copy elsewhere.
  // A superproject reset leaves initialized submodules where the step moved them. It must not recurse into a submodule an
  // earlier step left dirty.
  const noRecurse = ['-c', 'submodule.recurse=false'];
  const gitlinks = await treeGitlinks(dir, commit, run);

  if ('error' in gitlinks) return unrestored(gitlinks.error, kept);
  // Only the submodules the step changed: an update of any other would undo what an earlier step left there.
  const touched = changed.map((relative) => relative.replace(/\/$/, '')).filter((relative) => gitlinks.has(relative));
  const update = touched.length > 0 ? [['submodule', '--quiet', 'update', '--checkout', '--recursive', '--', ...touched]] : [];

  for (const args of [[...noRecurse, 'checkout', '-q', '-f', branch], [...noRecurse, 'reset', '-q', '--hard', commit], ['clean', '-q', '-fd'], ...update]) {
    const restored = await run(dir, args);

    if (restored.code !== 0) return unrestored(restored.stderr.trim() || `git ${args.join(' ')} failed`, kept);
  }

  // Exit codes are not enough: git clean skips a repository the step created, and a later git add -A commits it.
  const left = await copyLeftOver(dir, { branch, commit, found }, run);

  if (left) return unrestored(left, kept);
  await clearReadCopyMark(dir, run);

  return { state: 'restored', kept };
}
