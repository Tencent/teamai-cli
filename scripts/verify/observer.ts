/**
 * Watches the sandboxes a world's command makes while it runs, and judges each one's environment with
 * `judgeSandboxEnv`: containers and sbx sandboxes tied to the world, and on Linux each bwrap whose arguments name a world
 * path. Values are read and compared in memory only; what is written (observed.jsonl, the `[verify] observed` lines)
 * holds names. Loaded only once a sandbox place opens or closes in a HOME of the world during the command (target.ts).
 * A sandbox of the world it lists but cannot read is NOT OBSERVED, never left out; one it never saw, ledger section (f)
 * says is NOT OBSERVED from these records (`attemptsObserved`).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { collectEnvSecrets } from '@teamai/shared/redact';
import type { JsonValue } from '@teamai/shared/json';
import { parseYaml } from '@teamai/shared/yaml';
import { SIGN_INS } from '@teamai/tool-definitions';
import { z } from 'zod';
import { journal } from '../../packages/runtime-sandbox/src/journal.js';
import { sandboxJournalRoot } from '../../packages/runtime-sandbox/src/journal-root.js';
import { CONTAINER_ENGINES } from '../../packages/runtime-sandbox/src/options.js';
import { PROVIDER_COMMANDS } from '../../packages/runtime-sandbox/src/provider-commands.js';
import { journalOfSandboxName, placeKeyOfHandle, placeOfJournalSandbox } from '../../packages/runtime-sandbox/src/provider.js';
import { containerNamed, IDLE } from '../../packages/runtime-sandbox/src/providers/container.js';
import { errnoCode } from '../../src/utils/fs.js';
import { sbxNotSignedIn } from './doctor.js';
import { declaredCredentialNames, judgeSandboxEnv, parseEnviron, type EnvVerdict } from './secrets.js';
import { hostInstalls } from './target.js';
import { CANARY_NAME, quote, worldHomes, type World } from './world.js';

const run = promisify(execFile);

/** What a failed `execFile` adds to its error: the command's stderr, and whether its timeout killed it. */
const ExecFailureSchema = z.looseObject({ stderr: z.string().optional(), killed: z.boolean().optional() });
const POLL_MS = 500;
const OBSERVED_FILE = 'observed.jsonl';

/**
 * The attempt whose step ran in the sandbox an observer record names, `<provider>:<name>`, as `<run>/<attempt>`: by the
 * name the runtime gave it (`handleOf`; sbx's with its journal; bwrap's by the place its arguments name). A step's
 * filter, `<handle>-proxy`, is that attempt's too but runs none of its step, so reading it reads no step: undefined.
 */
function attemptObserved(what: string): string | undefined {
  const at = what.indexOf(':');
  const [provider, name] = [what.slice(0, at), what.slice(at + 1)];
  const named = provider === PROVIDER_COMMANDS.sbx ? placeOfJournalSandbox(name) : containerNamed(name);
  const key = named === undefined || ('kind' in named && named.kind !== 'place') ? undefined : named.key;

  return key === undefined ? undefined : `${key.run}/${key.attempt}`;
}

/**
 * Whether the observer reads a provider's sandboxes: seatbelt has none to list, and vercel runs on another machine. A
 * new provider fails the type check until it has a row.
 */
const OBSERVER_READS = { docker: true, podman: true, sbx: true, bwrap: true, seatbelt: false, vercel: false } satisfies Record<keyof typeof PROVIDER_COMMANDS, boolean>;

/** Whether the observer reads sandboxes of `provider`, as a record names it; one this harness does not know, it may. */
export function observerReads(provider: string): boolean {
  return Object.entries(OBSERVER_READS).find(([name]) => name === provider)?.[1] ?? true;
}

const ObservedRecordSchema = z.looseObject({ what: z.string(), read: z.number() });

/**
 * The attempts, as `<run>/<attempt>`, whose sandbox environment an observer line of `world` read: its records in
 * observed.jsonl with an environment read, or why that file cannot be read. A line this harness cannot parse names none.
 */
export function attemptsObserved(world: Pick<World, 'dir'>): { kind: 'read'; attempts: Set<string> } | { kind: 'unreadable'; why: string } {
  let text: string;

  try {
    text = fs.readFileSync(path.join(world.dir, OBSERVED_FILE), 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { kind: 'read', attempts: new Set() };

    return { kind: 'unreadable', why: error instanceof Error ? error.message : String(error) };
  }

  const attempts = new Set(text.split('\n').flatMap((line) => {
    let record: z.infer<typeof ObservedRecordSchema>;

    try {
      record = ObservedRecordSchema.parse(JSON.parse(line));
    } catch {
      return [];
    }

    const attempt = attemptObserved(record.what);

    return attempt === undefined || record.read === 0 ? [] : [attempt];
  }));

  return { kind: 'read', attempts };
}

/** What the observer's own shell in a sandbox carries, so that no observer, this command's or another's, reads it as a step's. */
const OBSERVER_MARK = 'VERIFY_OBSERVER_SHELL=1';

/**
 * The environment of each process a step runs inside a sandbox, one block per process, blocks split by an empty entry.
 * Never printed. Not the first process: in a container, the loop it idles in until teamai execs a step (`IDLE`) or a
 * filter. Where that first process is `IDLE`, nor a child of it whose environment is its own but for what a shell adds
 * (its sleep); a step's process it took over carries the step's. Nor an observer's shell: an environment read is a step's.
 */
const ENVIRONS = [
  `n() { tr '\\0' '\\n' < "$1" 2>/dev/null | grep -v -E '^(PWD|OLDPWD|SHLVL|_)=' | sort; }; idle=$(n /proc/1/environ)`,
  `[ "$(tr '\\0' '\\n' < /proc/1/cmdline 2>/dev/null | sed -n 3p)" = ${quote(IDLE)} ] && idles=1 || idles=0`,
  'for d in /proc/[0-9]*; do p=${d#/proc/}; s=$(cat "$d/stat" 2>/dev/null) || continue; s=${s##*) }; set -- $s',
  '[ "$p" = 1 ] && continue',
  '[ "$idles" = 1 ] && [ "$2" = 1 ] && [ "$(n "$d/environ")" = "$idle" ] && continue',
  `case "$(cat "$d/environ" 2>/dev/null)" in *${OBSERVER_MARK}*) continue ;; esac`,
  'cat "$d/environ" 2>/dev/null && printf "\\0\\0"; done',
].join('; ');

/** The command that prints `ENVIRONS` in a sandbox, after the engine's own `exec <sandbox>`. */
const READ_ENVIRONS = ['env', OBSERVER_MARK, 'sh', '-c', ENVIRONS];

/** What one sandbox showed over a command: how many environments were read, and every leaking name among them. */
interface Seen {
  readonly what: string;
  read: number;
  names: Set<string>;
  /** Why the last look failed to read its environments, while no look has read one. */
  failed?: string;
}

/**
 * The credential names a step of the world may carry: every `credentials` mapping in the YAML under each HOME's and
 * project's `.teamai` (driver definitions, a member's driver settings), and the tools' sign-in variables, which teamai
 * gives a runtime entry that declares none. Each file that is not YAML is named: what only it declares counts as undeclared.
 */
function declaredCredentials(world: World) {
  const declared = new Set<string>(Object.values(SIGN_INS).flatMap((signIn) => [...signIn.variables, ...('alongside' in signIn ? signIn.alongside : [])]));
  const unreadable: string[] = [];

  const walk = (dir: string, depth: number): void => {
    for (const entry of depth > 8 || !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') walk(full, depth + 1);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
        let text: JsonValue;

        try {
          text = parseYaml(fs.readFileSync(full, 'utf8'));
        } catch {
          unreadable.push(path.relative(world.dir, full));
          continue;
        }

        for (const name of declaredCredentialNames(text)) declared.add(name);
      }
    }
  };

  for (const root of [...worldHomes(world), world.project, ...(world.members ?? []).map((member) => member.project)]) walk(path.join(root, '.teamai'), 0);

  return { declared, unreadable };
}

/** Each environment `ENVIRONS` printed. */
function environsOf(stdout: string): Array<Map<string, string>> {
  return stdout.split('\0\0').flatMap((block) => (block === '' ? [] : [parseEnviron(block)]));
}

/** What a command the observer runs answered: what it printed, that it is not installed here, or that it failed, why, and whether its time ran out. */
export type Listed = { kind: 'ran'; stdout: string } | { kind: 'missing' } | { kind: 'failed'; why: string; timedOut: boolean };

/** How the observer asks: with `env`, an install's environment, or else the harness's own. */
type Ask = (argv: readonly string[], options: { env: Readonly<Record<string, string>> | undefined }) => Promise<Listed>;

/** What `argv` answered on this machine, run with `env` when given: the observer's one effect on a sandbox. */
const listedHere: Ask = async (argv, { env }) => {
  const [command = 'true', ...args] = argv;

  try {
    return { kind: 'ran', stdout: (await run(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 ** 2, ...(env !== undefined && { env }) })).stdout };
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { kind: 'missing' };
    const failure = ExecFailureSchema.safeParse(error);
    const said = failure.success ? failure.data.stderr?.trim().split('\n').at(-1) : undefined;

    const timedOut = failure.success && failure.data.killed === true;

    return { kind: 'failed', why: timedOut ? 'it took over 10 s' : said || (error instanceof Error ? error.message : String(error)), timedOut };
  }
};

const SbxListedSchema = z.array(z.looseObject({ name: z.string(), status: z.string().optional() }));

/** A process as /proc lists it: its pid, its parent's, and its arguments. */
export interface ProcEntry {
  readonly pid: string;
  readonly ppid: string;
  readonly args: readonly string[];
}

/**
 * Each bwrap step in `procs` whose arguments name a path under one of `roots`: its outermost bwrap, by the place its
 * arguments name (`teamai-<run>-<attempt>`, the step's own home is bound from there) or else its pid, and the first of
 * its descendants that are not bwrap, whose environment is the step's. A bwrap anywhere below another is that step's own.
 */
export function bwrapSteps(procs: readonly ProcEntry[], roots: readonly string[]): Array<{ bwrap: string; steps: string[] }> {
  const isBwrap = (args: readonly string[]): boolean => path.basename(args[0] ?? '') === 'bwrap';
  const bwrapPids = new Set(procs.flatMap((proc) => (isBwrap(proc.args) ? [proc.pid] : [])));
  const parentOf = new Map(procs.map((proc) => [proc.pid, proc.ppid]));

  // A bwrap with a bwrap anywhere above it is that step's own, as one its tool runs.
  const isUnderBwrap = (pid: string): boolean => {
    const seen = new Set<string>();

    for (let at = parentOf.get(pid); at !== undefined && !seen.has(at); at = parentOf.get(at)) {
      if (bwrapPids.has(at)) return true;
      seen.add(at);
    }

    return false;
  };

  const outermost = procs.filter((proc) => bwrapPids.has(proc.pid) && !isUnderBwrap(proc.pid) && proc.args.some((arg) => roots.some((root) => arg.startsWith(root))));

  return outermost.flatMap((outer) => {
    for (let frontier = [outer.pid]; frontier.length > 0;) {
      const children = procs.filter((proc) => frontier.includes(proc.ppid));
      const first = children.filter((proc) => !isBwrap(proc.args));

      if (first.length > 0) return [{ bwrap: outer.args.flatMap((arg) => arg.split('/')).find((segment) => placeKeyOfHandle(segment) !== undefined) ?? outer.pid, steps: first.map((proc) => proc.pid) }];
      frontier = children.map((proc) => proc.pid);
    }

    return [];
  });
}

/** Starts watching; `stop` takes a last look and answers the lines to show, and has written them to observed.jsonl. */
export function startObserver(world: World, { pass, label, listed = listedHere }: { pass: ReadonlyMap<string, string>; label: string; listed?: Ask }) {
  const canary = world.env?.[CANARY_NAME] ?? '';
  const secrets = new Map([...Object.entries(collectEnvSecrets(process.env)), ...pass]);
  const { declared, unreadable } = declaredCredentials(world);
  const owners = new Set<string>(worldHomes(world).map((home) => journal(sandboxJournalRoot(home)).owner));
  const seen = new Map<string, Seen>();
  const unobserved = new Set<string>();
  const notRunning = new Map<string, string>();
  let sawSeatbelt = false;
  // An engine down at one look is asked again at the next; one not installed, or whose `info` ran out of time, never again.
  const engines = new Map<(typeof CONTAINER_ENGINES)[number], 'up' | 'missing' | 'hung'>();

  /** Judges `environs`, read from sandbox `what`, into what it showed over the command. */
  const judgeEnvirons = (what: string, environs: ReadonlyArray<ReadonlyMap<string, string>>): Seen => {
    const entry: Seen = seen.get(what) ?? { what, read: 0, names: new Set<string>() };
    seen.set(what, entry);

    for (const env of environs) {
      entry.read += 1;
      const verdict: EnvVerdict = judgeSandboxEnv({ env, canary, secrets, declared });

      if (verdict.kind === 'leak') for (const name of verdict.names) entry.names.add(name);
    }

    return entry;
  };

  /** Judges what `ENVIRONS` answered in sandbox `what`, keeping why it failed while no look has read an environment. */
  const judge = (what: string, read: Listed): void => {
    const entry = judgeEnvirons(what, read.kind === 'ran' ? environsOf(read.stdout) : []);

    if (read.kind === 'ran' || entry.read > 0) delete entry.failed;
    else entry.failed = read.kind === 'failed' ? read.why : 'its command is not installed here';
  };

  const containers = (): Promise<void[]> => Promise.all(CONTAINER_ENGINES.map(async (engine) => {
    const command = PROVIDER_COMMANDS[engine];

    if (engines.get(engine) === 'missing' || engines.get(engine) === 'hung') return;

    if (engines.get(engine) !== 'up') {
      const info = await listed([command, 'info', '--format', '{{.ServerVersion}}'], { env: undefined });

      if (info.kind === 'failed' && info.timedOut) {
        engines.set(engine, 'hung');
        unobserved.add(`${engine} containers, \`${engine} info\` took over 10 s`);
      }

      if (info.kind === 'failed') return;
      engines.set(engine, info.kind === 'missing' ? 'missing' : 'up');

      if (info.kind === 'missing') return;
    }

    const lines = await listed([command, 'ps', '--filter', 'label=teamai.owner', '--format', '{{.ID}}\t{{.Names}}\t{{.Label "teamai.owner"}}'], { env: undefined });

    if (lines.kind !== 'ran') {
      unobserved.add(`${engine} containers, \`${engine} ps\` failed`);

      return;
    }

    for (const line of lines.stdout.split('\n')) {
      const [id = '', name = '', owner = ''] = line.split('\t');

      if (id === '' || !owners.has(owner)) continue;
      const environs = await listed([command, 'exec', id, ...READ_ENVIRONS], { env: undefined });

      judge(`${engine}:${name}`, environs);
    }
  }));

  /** sbx keeps its sandboxes per HOME: each host install's are listed, and asked, in its own, as teamai asks sbx there. */
  const sbx = (): Promise<void[]> => Promise.all(hostInstalls(world).map(async ({ at, home, env }) => {
    const owner = journal(sandboxJournalRoot(home)).owner;
    const out = await listed([PROVIDER_COMMANDS.sbx, 'ls', '--json'], { env });

    if (out.kind === 'missing') return;

    if (out.kind === 'failed') {
      unobserved.add(sbxNotSignedIn(at, out.why) ?? `sbx sandboxes, \`sbx ls\` failed (${out.why})`);

      return;
    }

    let json: unknown;

    try {
      json = JSON.parse(out.stdout);
    } catch {
      json = undefined;
    }

    const parsed = SbxListedSchema.safeParse(json);

    if (!parsed.success) {
      unobserved.add(sbxNotSignedIn(at, out.stdout) ?? 'sbx sandboxes, `sbx ls --json` printed a list this harness cannot read');

      return;
    }

    for (const sandbox of parsed.data) {
      if (journalOfSandboxName(sandbox.name) !== owner) continue;

      // `sbx exec` starts a stopped sandbox: only one listed as running is asked.
      if (sandbox.status !== 'running') {
        notRunning.set(sandbox.name, sandbox.status ?? 'in no state');
        continue;
      }

      const environs = await listed([PROVIDER_COMMANDS.sbx, 'exec', sandbox.name, ...READ_ENVIRONS], { env });

      judge(`sbx:${sandbox.name}`, environs);
    }
  }));

  /** On Linux, each bwrap whose arguments name a world path: the environment of its first descendant that is not bwrap. */
  const bwraps = (): void => {
    if (process.platform !== 'linux') {
      for (const member of world.members ?? []) if (member.machine === 'container') unobserved.add(`bwrap steps in @${member.name}'s container, the observer reads their environment from /proc on Linux only`);

      return;
    }

    const procs = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((pid) => {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        const ppid = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1] ?? '';

        return [{ pid, ppid, args }];
      } catch {
        return [];
      }
    });

    for (const { bwrap, steps } of bwrapSteps(procs, [world.dir, world.tmp])) {
      for (const step of steps) {
        try {
          judgeEnvirons(`bwrap:${bwrap}`, [parseEnviron(fs.readFileSync(`/proc/${step}/environ`, 'utf8'))]);
        } catch {
          unobserved.add(`bwrap:${bwrap}'s environment, /proc/${step}/environ could not be read`);
        }
      }
    }
  };

  let polling: Promise<void> | undefined;

  const look = async (): Promise<void> => {
    try {
      await Promise.all([containers(), sbx()]);
      bwraps();
      // A place's record goes once it closes, so each look notes whether one runs on seatbelt.
      sawSeatbelt ||= worldHomes(world).some(usesSeatbelt);
    } catch (error) {
      unobserved.add(`a look at the sandboxes, ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      polling = undefined;
    }
  };

  const poll = (): Promise<void> => (polling ??= look());

  const timer = setInterval(() => void poll(), POLL_MS);

  return {
    async stop(): Promise<string[]> {
      clearInterval(timer);
      await polling;
      await poll();
      const at = new Date().toISOString();
      const records = [...seen.values()].map((entry) => ({ at, command: label, what: entry.what, read: entry.read, verdict: entry.names.size === 0 ? 'env ok' : 'ENV LEAK', names: [...entry.names].toSorted(), failed: entry.failed }));

      for (const [name, status] of notRunning) if (!seen.has(`sbx:${name}`)) unobserved.add(`sbx:${name}'s environment, sbx listed it as ${status}, and only a running one is asked`);

      if (records.length > 0) fs.appendFileSync(path.join(world.dir, OBSERVED_FILE), records.map((record) => `${JSON.stringify(record)}\n`).join(''));

      return [
        ...records.map((record) => `[verify] observed ${record.what}: ${record.read === 0 ? `NOT OBSERVED, no step's environment could be read${record.failed === undefined ? '' : ` (${record.failed})`}` : record.names.length === 0 ? 'env ok' : `ENV LEAK ${record.names.join(', ')}`}`),
        ...[...unobserved].map((what) => `[verify] NOT OBSERVED: ${what}`),
        ...(sawSeatbelt ? ['[verify] seatbelt has no observer: the env check proves nothing for a seatbelt step'] : []),
        ...unreadable.map((file) => `[verify] ${file} is not YAML: a credential only it declares counts as undeclared`),
      ];
    },
  };
}

const PlaceOptionsSchema = z.looseObject({ options: z.looseObject({ provider: z.string().optional() }).optional() });

/** Whether a place the sandbox runtime recorded under `home` ran on seatbelt. */
function usesSeatbelt(home: string): boolean {
  const places = path.join(sandboxJournalRoot(home), 'places');

  return (fs.existsSync(places) ? fs.readdirSync(places) : []).some((name) => {
    if (!name.endsWith('.json')) return false;

    try {
      return PlaceOptionsSchema.parse(JSON.parse(fs.readFileSync(path.join(places, name), 'utf8'))).options?.provider === 'seatbelt';
    } catch {
      return false;
    }
  });
}
