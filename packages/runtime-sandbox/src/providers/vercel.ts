import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Command, Sandbox } from '@vercel/sandbox';
import { z } from 'zod';
import { PlaceViewSchema, type Can, type PlaceView, type RuntimeFailure } from '@teamai/runtime-protocol';
import { mayBeRunning } from '@teamai/shared/process-group';
import { readRegularFileSync, writeRegularFile } from '@teamai/shared/regular-file';
import { boundedTail, STDERR_CHARS } from '../bounded-tail.js';
import type { JournalId } from '../journal.js';
import type { ProfileOption, VercelOptions } from '../options.js';
import { COMMAND_MS, journalPrefixOf, journalSandboxName, placeOfJournalSandbox, type ExecEnd, type PlaceKey, type Provider } from '../provider.js';
import { offerSignedIn } from '../sign-in.js';
import { oneBuildPerKey, planWarm, warmFailed, type WarmPlan } from '../warm.js';
import { WORKSPACES } from './cli.js';
import { applyTar, fingerprintsOf, readTar } from './vercel-copy.js';

// ─── vercel: a hosted sandbox per attempt (Vercel Sandbox), the copy family ───
//
//  The place cannot be mounted from this machine, so it is recreated at the same absolute paths inside and copied back:
//
//    open     Sandbox.create({ name: teamai-<journal>-<run>-<attempt>, persistent: false, timeout, runtime or the warm source })
//             mkdir -p the view's paths (sudo), chown the writable ones to the sandbox's user
//             the worktree, run directory and tool homes in, as that user; the git paths in as root, read only
//             view.json kept on this machine last: a sandbox found without it was never fully copied in, and goes
//    exec     runCommand({ cmd, args, cwd, env: the exec's names, detached }), its output streamed
//    collect  tar of the worktree, result, tool homes and run directory, read back and applied by vercel-copy.ts; of the
//             run directory, which other steps write too, nothing is deleted
//    close    delete(), never stop(): nothing of an attempt is kept as a snapshot
//    sweep    Sandbox.list({ namePrefix: teamai-<journal>- }): one whose attempt this machine no longer records goes
//
//  With `warm`, each attempt's sandbox starts from a snapshot (warm.ts, base vercel:<runtime>), made once per key, its id
//  kept at <state>/warm/<key>.json and looked up with Snapshot.get; a missing or expired one is made again:
//
//    Sandbox.create({ name: teamai-<journal>-warm-<pid>-<random>, persistent: false, runtime })       no credential
//    writeFiles(the cache files, under /tmp/teamai-warm); sh -c <prepare> there; rm -rf /tmp/teamai-warm
//    snapshot({ expiration }), then delete()                               the snapshot outlives its scratch sandbox
//
//  The provider's own sign-in (VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, or VERCEL_OIDC_TOKEN) stays with this
//  runtime: it reaches the SDK only, never a sandbox's environment. Each exec's credentials go in that command's env, by
//  name, never in its argv. The sandbox is found again by its name after a restart (Sandbox.get), and the commands an
//  exec started by their ids, kept on this machine, so a cancel from another runtime process stops them.
//

/** The variables a Vercel sign-in is read from, as `provider_auth` may name them. */
export const VERCEL_AUTH = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN'] as const;

/** The longest lifetime Vercel gives a sandbox. */
export const LONGEST_MS = 5 * 3_600_000;

/** The lifetime when neither `timeout` nor a deadline sets it. */
const DEFAULT_MS = 45 * 60_000;

/** How long past the attempt's deadline a sandbox lives, so teamai's cancel and collect come first. */
const MARGIN_MS = 5 * 60_000;

const NO_SIGN_IN = 'Vercel Sandbox needs a sign-in on this machine: set VERCEL_TOKEN (a token from https://vercel.com/account/tokens), VERCEL_TEAM_ID and VERCEL_PROJECT_ID, or VERCEL_OIDC_TOKEN (`vercel link`, then `vercel env pull`), or name where to read them in the definition\'s provider_auth, such as VERCEL_TOKEN: file:~/.config/vercel-token';

// The SDK loads on a vercel sandbox's first call, never at start: evaluating it costs every other provider ~95 ms.
const sdk = () => import('@vercel/sandbox');

const NotFoundSchema = z.object({ response: z.object({ status: z.literal(404) }) });

/** How long Vercel keeps a warm snapshot after its last use when `warm.expiration` is unset: 30 days. */
const KEPT_MS = 30 * 24 * 3_600_000;

/** Where a warm snapshot's prepare runs, on copies of the `cache` files; deleted, with what prepare left there, before the snapshot. */
const WARM_DIR = '/tmp/teamai-warm';

const WarmRecordSchema = z.object({ snapshotId: z.string().min(1) });

/** The sign-in the SDK calls carry: a token and its team and project, or none when the SDK reads the OIDC token itself. */
type Auth = { ok: true; credentials: { token: string; teamId: string; projectId: string } | undefined } | { ok: false; message: string };

/** Reads the Vercel sign-in: each name from where `provider_auth` says, else from this runtime's own environment. */
function authOf(providerAuth: VercelOptions['provider_auth'], env: NodeJS.ProcessEnv, home: string): Auth {
  const values: Partial<Record<(typeof VERCEL_AUTH)[number], string>> = {};

  for (const name of VERCEL_AUTH) {
    const from = providerAuth?.[name];

    if (from === undefined) {
      if (env[name]) values[name] = env[name];
      continue;
    }

    if (from.startsWith('env:')) {
      const value = env[from.slice('env:'.length)];

      if (!value) return { ok: false, message: `provider_auth reads ${name} from ${from.slice('env:'.length)}, which is not set where teamai runs. Set it, and start again` };
      values[name] = value;
      continue;
    }

    const file = from.slice('file:'.length).replace(/^~(?=\/|$)/, home);

    try {
      values[name] = readRegularFileSync(file, 'utf8').trim();
    } catch (error) {
      return { ok: false, message: `provider_auth reads ${name} from ${file}, which cannot be read (${(error instanceof Error ? error.message : String(error))}). Fix the path, and start again` };
    }
  }

  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId, VERCEL_OIDC_TOKEN: oidc } = values;

  if (token && teamId && projectId) return { ok: true, credentials: { token, teamId, projectId } };

  if (oidc) {
    // The SDK reads the OIDC token from this process's own environment; no sandbox ever gets this environment.
    process.env.VERCEL_OIDC_TOKEN = oidc;

    return { ok: true, credentials: undefined };
  }

  if (token) {
    const lacking = (['VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] as const).filter((name) => !values[name]);

    return { ok: false, message: `VERCEL_TOKEN is set, but not ${lacking.join(' and ')}, which a token signs in with. Set the missing ids (Vercel's team and project settings show both), or name where to read them in the definition's provider_auth, and start again` };
  }

  return { ok: false, message: NO_SIGN_IN };
}

/** A path as tar names it under `-C /`. */
const relative = (at: string): string => path.relative('/', at);

/**
 * The sandbox's lifetime for an attempt: `timeout`, else the deadline plus a margin, else DEFAULT_MS; or why it would end
 * before the attempt's work is copied back: teamai cancels at the deadline and collects after, so a lifetime reaches
 * MARGIN_MS past it.
 */
export function lifetimeOf(timeoutMs: number | undefined, deadline: string | undefined, now: number): { ok: true; ms: number } | { ok: false; failure: RuntimeFailure } {
  if (deadline === undefined) return { ok: true, ms: timeoutMs ?? DEFAULT_MS };
  const needed = Date.parse(deadline) - now + MARGIN_MS;
  const ms = timeoutMs ?? Math.max(60_000, needed);

  if (ms >= needed && ms <= LONGEST_MS) return { ok: true, ms };
  const minutes = Math.ceil(needed / 60_000);

  return {
    ok: false,
    failure: {
      code: 'bad_option',
      key: 'timeout',
      message: timeoutMs === undefined
        ? `This attempt may run until ${deadline}, and a Vercel sandbox lives at most 5h, ending at ${new Date(now + LONGEST_MS).toISOString()}, before its work is copied back. Lower the step's limits under 5h`
        : `The Vercel sandbox would end at ${new Date(now + timeoutMs).toISOString()}, its timeout from now, before ${deadline}, the latest time this attempt's limits allow, and the ${MARGIN_MS / 60_000}m after it its work is copied back in. Raise timeout to at least ${minutes}m (Vercel takes up to 5h), or lower the step's limits`,
    },
  };
}

export function vercelProvider({ options, owner, state, env, home }: { options: VercelOptions & { readonly profile?: ProfileOption }; owner: JournalId; state: string; env: NodeJS.ProcessEnv; home: string }): Provider {
  const nameOf = (key: PlaceKey): string => journalSandboxName(owner, key);
  const dirOf = (id: string): string => path.join(state, id);
  const commandsOf = (id: string): string => path.join(dirOf(id), 'commands');
  const failed = (message: string) => ({ ok: false, failure: { code: 'sandbox_failed', message } }) satisfies { ok: false; failure: RuntimeFailure };
  const removeBy = (id: string): string => `delete sandbox ${id} in the Vercel dashboard (Sandboxes), or wait for its timeout to end it`;
  const warmFile = (key: string): string => path.join(state, 'warm', `${key}.json`);

  /** The sign-in, read when a call needs it: a runtime started again to close an attempt gets no init's offer first. */
  const signedIn = (): Auth => authOf(options.provider_auth, env, home);

  /** The sandbox named `id`: it, undefined once Vercel says there is none, or what went wrong. */
  const sandboxOf = async (id: string): Promise<{ ok: true; sandbox: Sandbox | undefined } | { ok: false; message: string }> => {
    const auth = signedIn();

    if (!auth.ok) return auth;

    try {
      return { ok: true, sandbox: await (await sdk()).Sandbox.get({ name: id, ...auth.credentials }) };
    } catch (error) {
      return NotFoundSchema.safeParse(error).success ? { ok: true, sandbox: undefined } : { ok: false, message: (error instanceof Error ? error.message : String(error)) };
    }
  };

  /** Runs a command to its end in `sandbox`, in `cwd` when given: its exit code, stdout and stderr. */
  const run = async (sandbox: Sandbox, cmd: string, args: string[], sudo = false, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    const command = await sandbox.runCommand({ cmd, args, sudo, detached: true, ...(cwd !== undefined && { cwd }) });
    // A warm snapshot's prepare may print without end: only the end of what it printed is kept.
    const stdout = boundedTail();
    const stderr = boundedTail(STDERR_CHARS);

    for await (const line of command.logs()) {
      if (line.stream === 'stdout') stdout.push(line.data);
      else stderr.push(line.data);
    }

    return { code: (await command.wait()).exitCode, stdout: stdout.text(), stderr: stderr.text() };
  };

  /** Runs `args` and says why when it does not exit 0. */
  const must = async (sandbox: Sandbox, what: string, cmd: string, args: string[], sudo = false): Promise<string | undefined> => {
    const ran = await run(sandbox, cmd, args, sudo);

    return ran.code === 0 ? undefined : `${what} failed in Vercel sandbox ${sandbox.name} (exit ${ran.code}): ${ran.stderr.trim().split('\n').at(-1) || 'it printed nothing'}`;
  };

  /** A tar archive of `paths` on this machine, as `tar -C /` names them, or why it could not be made. */
  const archive = (paths: string[]): Promise<{ ok: true; data: Buffer } | { ok: false; message: string }> => new Promise((resolve) => {
    const child = spawn('tar', ['-cf', '-', '--no-xattrs', '-C', '/', ...paths.map(relative)], { env: { ...env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const stderr = boundedTail(STDERR_CHARS);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr.push(data); });
    child.on('error', (error) => resolve({ ok: false, message: error.message }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true, data: Buffer.concat(chunks) } : { ok: false, message: stderr.text().trim().split('\n').at(-1) || `tar exited ${code}` }));
  });

  /** Puts the archive of `paths` in `sandbox` at their own paths: as its user, or as root (`asRoot`). */
  const copyIn = async (sandbox: Sandbox, paths: string[], asRoot: boolean): Promise<string | undefined> => {
    const existing = paths.filter((at) => fs.existsSync(at));

    if (existing.length === 0) return undefined;
    const made = await archive(existing);

    if (!made.ok) return `teamai could not pack ${existing.join(', ')} for Vercel sandbox ${sandbox.name}: ${made.message}`;
    const file = `/tmp/teamai-in-${asRoot ? 'root' : 'user'}.tar`;
    await sandbox.writeFiles([{ path: file, content: made.data }]);

    return await must(sandbox, 'Unpacking the place', 'tar', ['-xf', file, '-C', '/', '--no-same-owner', '--no-xattrs'], asRoot) ?? await must(sandbox, 'Removing the packed place', 'rm', ['-f', file], asRoot);
  };

  /**
   * What `create` kept of a place whose copy-in ended: its view, and the run directory's files as they went in, so
   * collect brings back only those the step changed there and never an old copy over another step's write.
   */
  const keptOf = (id: string): { view: PlaceView; runFiles: Record<string, string> } | undefined => {
    const file = path.join(dirOf(id), 'view.json');

    return fs.existsSync(file) ? z.object({ view: PlaceViewSchema, runFiles: z.record(z.string(), z.string()).default({}) }).parse(JSON.parse(readRegularFileSync(file, 'utf8'))) : undefined;
  };

  const viewOf = (id: string): PlaceView | undefined => keptOf(id)?.view;

  /** Deletes `sandbox` and its place on this machine: undefined once gone, else why it stays. */
  const discard = async (sandbox: Sandbox): Promise<string | undefined> => {
    try {
      await sandbox.delete();
    } catch (error) {
      if (!NotFoundSchema.safeParse(error).success) return `Vercel could not delete sandbox ${sandbox.name}: ${(error instanceof Error ? error.message : String(error))}`;
    }

    fs.rmSync(dirOf(sandbox.name), { recursive: true, force: true });

    return undefined;
  };

  /** What became of a sandbox `create` could not prepare, for its failure message. */
  const discarded = async (sandbox: Sandbox): Promise<string> => {
    const why = await discard(sandbox);

    return why === undefined ? 'The sandbox was deleted.' : `${why}; ${removeBy(sandbox.name)}.`;
  };

  type Credentials = Extract<Auth, { ok: true }>['credentials'];

  /** The warm snapshot kept for `plan`'s key while Vercel has it ready: its id, undefined when not, or why Vercel could not say. */
  const keptSnapshot = async (plan: WarmPlan, credentials: Credentials): Promise<{ ok: true; snapshotId: string | undefined } | { ok: false; message: string }> => {
    let kept: z.infer<typeof WarmRecordSchema> | undefined;

    try {
      // A record that cannot be read is taken as none: the snapshot is made again, and the record written anew.
      kept = WarmRecordSchema.parse(JSON.parse(readRegularFileSync(warmFile(plan.key), 'utf8')));
    } catch {
      return { ok: true, snapshotId: undefined };
    }

    try {
      const snapshot = await (await sdk()).Snapshot.get({ snapshotId: kept.snapshotId, ...credentials });
      const isReady = snapshot.status === 'created' && (snapshot.expiresAt === undefined || snapshot.expiresAt.getTime() > Date.now());

      return { ok: true, snapshotId: isReady ? kept.snapshotId : undefined };
    } catch (error) {
      return NotFoundSchema.safeParse(error).success ? { ok: true, snapshotId: undefined } : { ok: false, message: (error instanceof Error ? error.message : String(error)) };
    }
  };

  /** Makes the warm snapshot of `plan`: `prepare` run in a scratch sandbox on copies of its `cache` files, which go first. */
  const makeWarm = async (plan: WarmPlan, warm: NonNullable<VercelOptions['warm']>, credentials: Credentials): Promise<{ ok: true; snapshotId: string } | { ok: false; failure: RuntimeFailure }> => {
    const name = `${journalPrefixOf(owner)}warm-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    let sandbox: Sandbox;

    try {
      sandbox = await (await sdk()).Sandbox.create({ name, persistent: false, timeout: DEFAULT_MS, ...(options.runtime !== undefined && { runtime: options.runtime }), ...credentials });
    } catch (error) {
      return failed(`Vercel could not create a sandbox to prepare the warm snapshot ${plan.key}: ${(error instanceof Error ? error.message : String(error))}. No step ran; start again.`);
    }

    try {
      await sandbox.writeFiles(plan.cache.map(({ file, from }) => ({ path: `${WARM_DIR}/${file}`, content: readRegularFileSync(from) })));
      const prepared = await run(sandbox, 'sh', ['-c', warm.prepare], false, WARM_DIR);

      if (prepared.code !== 0) return warmFailed(`The warm snapshot's prepare, \`${warm.prepare}\`, failed in Vercel sandbox ${name}`, { kind: 'ran', ...prepared });
      // The copies of the cache files and the node_modules prepare made beside them never go into the snapshot.
      const why = await must(sandbox, 'Removing the cache files and node_modules', 'rm', ['-rf', WARM_DIR], true);

      if (why !== undefined) return failed(`${why}. No step ran; start again.`);
      const { snapshotId } = await sandbox.snapshot({ expiration: warm.expiration ?? KEPT_MS });
      fs.mkdirSync(path.dirname(warmFile(plan.key)), { recursive: true, mode: 0o700 });
      await writeRegularFile(warmFile(plan.key), JSON.stringify({ snapshotId } satisfies z.infer<typeof WarmRecordSchema>), { mode: 0o600 });

      return { ok: true, snapshotId };
    } catch (error) {
      return failed(`Vercel could not make the warm snapshot ${plan.key} in sandbox ${name}: ${(error instanceof Error ? error.message : String(error))}. No step ran; start again.`);
    } finally {
      // One left behind ends at its timeout, or a later open's sweep deletes it once this process is gone.
      await discard(sandbox);
    }
  };

  const once = oneBuildPerKey<{ ok: true; snapshotId: string } | { ok: false; failure: RuntimeFailure }>();

  /** The warm snapshot an attempt in `checkout` starts from, made first when Vercel has none ready; undefined without `warm`. */
  const snapshotFor = async (checkout: string, credentials: Credentials): Promise<{ ok: true; snapshotId: string | undefined } | { ok: false; failure: RuntimeFailure }> => {
    const { warm } = options;

    if (warm === undefined) return { ok: true, snapshotId: undefined };
    // The default image is keyed by its name only: teamai cannot tell when Vercel changes it.
    const planned = planWarm({ base: `vercel:${options.runtime ?? 'default'}`, recipe: { prepare: warm.prepare, cache: warm.cache }, checkout, ...(options.profile && { profile: options.profile }) });

    if (!planned.ok) return planned;
    const { plan } = planned;

    return once(plan.key, async () => {
      const kept = await keptSnapshot(plan, credentials);

      if (!kept.ok) return failed(`Vercel could not look up the warm snapshot ${plan.key}: ${kept.message}. No step ran; start again.`);

      return kept.snapshotId === undefined ? makeWarm(plan, warm, credentials) : { ok: true, snapshotId: kept.snapshotId };
    });
  };

  /** The commands an exec of `id` started that may still run, by their ids. */
  const runningCommands = (id: string): string[] => (fs.existsSync(commandsOf(id)) ? fs.readdirSync(commandsOf(id)) : []);

  /** Waits for `command` to end, up to `ms`: whether it ended. */
  const ended = async (command: Command, ms: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });

    try {
      return await Promise.race([command.wait().then(() => true), late]);
    } catch {
      return true;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    family: 'copy',
    async reachable() {
      const auth = signedIn();

      return auth.ok ? { ok: true } : { ok: false, failure: { code: 'sandbox_unavailable', message: auth.message } };
    },
    async offer(credentials, instances) {
      const auth = signedIn();

      if (!auth.ok) return { ok: false, failure: { code: 'sandbox_unavailable', message: auth.message } };

      // Vercel's image ships Claude; nothing else a step runtime launches is known to be there.
      const { tools, unavailable } = offerSignedIn({
        tools: ['claude'], provider: 'vercel', credentials, stored: new Set(), env, instances,
        missing: (command) => (command === 'claude' ? undefined : { holder: "Vercel's sandbox image", fix: 'run that step on a provider whose image holds it' }),
      });

      const can: Can = { workspace: WORKSPACES, isolation: 'sandbox', env: true, tokens: true, max_turns: true, setup: true, tools, end_turn: true, unattended: true, role: true };

      return { ok: true, can, host: { ok: false, refusal: 'A Vercel sandbox runs on Vercel, which has no way back to this machine.' }, unavailable, ownLogins: [], unusedGateways: {} };
    },

    async owned() {
      const auth = signedIn();

      if (!auth.ok) return { ok: false, failure: { code: 'sandbox_failed', message: auth.message } };
      const prefix = journalPrefixOf(owner);

      try {
        const listed = await (await (await sdk()).Sandbox.list({ namePrefix: prefix, ...auth.credentials })).toArray();

        return {
          ok: true,
          sandboxes: listed.flatMap(({ name }) => {
            const place = placeOfJournalSandbox(name);

            return place?.owner === owner ? [{ id: name, ...place.key }] : [];
          }),
          // A scratch sandbox's name carries this journal, so its pid is of this machine.
          leftWarm: listed.flatMap(({ name }) => {
            const pid = name.startsWith(prefix) ? /^warm-(\d+)-[0-9a-f]+$/.exec(name.slice(prefix.length))?.[1] : undefined;

            return pid !== undefined && !mayBeRunning(Number(pid)) ? [name] : [];
          }),
        };
      } catch (error) {
        return failed(`Vercel could not list the sandboxes this runtime's journal owns: ${(error instanceof Error ? error.message : String(error))}`);
      }
    },

    async find(key) {
      const found = await sandboxOf(nameOf(key));

      // A sandbox whose place was never fully copied in (its runtime stopped, or a copy failed) is not this attempt's
      // place: collect would delete from the host every file it lacks. It goes, and the open creates a new one.
      if (found.ok && found.sandbox !== undefined && viewOf(nameOf(key)) === undefined) {
        const why = await discard(found.sandbox);

        return why === undefined ? { ok: true, id: undefined } : failed(`Vercel sandbox ${nameOf(key)} was left half prepared, and ${why}. ${removeBy(nameOf(key))}.`);
      }

      if (found.ok) return { ok: true, id: found.sandbox?.name };

      return failed(`Vercel could not look up sandbox ${nameOf(key)}: ${found.message}. It stays this attempt's until Vercel answers; to remove it now, ${removeBy(nameOf(key))}.`);
    },

    async warm(view, _tool, deadline) {
      const lifetime = lifetimeOf(options.timeout, deadline, Date.now());

      if (!lifetime.ok) return lifetime;
      const auth = signedIn();

      if (!auth.ok) return { ok: false, failure: { code: 'sandbox_unavailable', message: auth.message } };
      const from = await snapshotFor(view.worktree, auth.credentials);

      return from.ok ? { ok: true } : from;
    },

    async create(key, { view, deadline }) {
      const lifetime = lifetimeOf(options.timeout, deadline, Date.now());

      if (!lifetime.ok) return lifetime;
      const auth = signedIn();

      if (!auth.ok) return { ok: false, failure: { code: 'sandbox_unavailable', message: auth.message } };
      const from = await snapshotFor(view.worktree, auth.credentials);

      if (!from.ok) return from;
      const id = nameOf(key);
      // A snapshot holds its image: a sandbox from one takes no runtime.
      const base = from.snapshotId === undefined ? { ...(options.runtime !== undefined && { runtime: options.runtime }) } : { source: { type: 'snapshot' as const, snapshotId: from.snapshotId } };
      let sandbox: Sandbox;

      try {
        sandbox = await (await sdk()).Sandbox.create({ name: id, persistent: false, timeout: lifetime.ms, ...base, tags: { 'teamai-run': key.run, 'teamai-attempt': key.attempt }, ...auth.credentials });
      } catch (error) {
        // Another open of the same attempt created it first: that sandbox is this attempt's.
        const raced = await sandboxOf(id);

        if (!raced.ok || raced.sandbox === undefined || viewOf(id) === undefined) return failed(`Vercel could not create a sandbox for attempt ${key.attempt}: ${(error instanceof Error ? error.message : String(error))}`);

        return { ok: true, id };
      }

      fs.mkdirSync(commandsOf(id), { recursive: true, mode: 0o700 });
      const writable = [view.worktree, view.result, view.runDir, ...Object.values(view.toolHome)];
      // Taken before the copy-in: a file another step changes meanwhile goes in changed, and comes back as it went.
      const runFiles = fingerprintsOf(view.runDir);

      try {
        const ids = await run(sandbox, 'sh', ['-c', 'id -u; id -g']);
        const [uid, gid] = ids.stdout.trim().split('\n');

        const why = await must(sandbox, 'Making the place', 'mkdir', ['-p', ...writable, ...view.readonly.map((at) => path.dirname(at))], true)
          ?? await must(sandbox, 'Handing the place to the sandbox\'s user', 'chown', [`${uid}:${gid}`, ...writable], true)
          ?? await copyIn(sandbox, [view.worktree, view.runDir, ...Object.values(view.toolHome)], false)
          ?? await copyIn(sandbox, view.readonly, true)
          ?? (view.readonly.length > 0 ? await must(sandbox, 'Making the git paths read-only', 'chmod', ['-R', 'a-w', ...view.readonly], true) : undefined);

        if (why !== undefined) return failed(`${why}. ${await discarded(sandbox)}`);
      } catch (error) {
        return failed(`Vercel could not prepare sandbox ${id}: ${(error instanceof Error ? error.message : String(error))}. ${await discarded(sandbox)}`);
      }

      // Written last: a place with a view is one whose copy-in ended.
      await writeRegularFile(path.join(dirOf(id), 'view.json'), JSON.stringify({ view, runFiles }), { mode: 0o600 });

      return { ok: true, id };
    },

    async exec(id, spec, onOutput): Promise<ExecEnd> {
      const found = await sandboxOf(id);

      if (!found.ok) return { kind: 'failed', failure: { code: 'sandbox_failed', message: `Vercel could not reach sandbox ${id}: ${found.message}` } };

      if (found.sandbox === undefined) return { kind: 'failed', failure: { code: 'runtime_gone', message: `Vercel sandbox ${id} is gone: its timeout may have ended it.` } };
      const [cmd = '', ...args] = spec.unset.length > 0 ? ['env', ...spec.unset.flatMap((name) => ['-u', name]), '--', ...spec.argv] : spec.argv;

      try {
        const command = await found.sandbox.runCommand({ cmd, args, cwd: spec.cwd, env: spec.env, detached: true });
        const record = path.join(commandsOf(id), command.cmdId);
        fs.mkdirSync(commandsOf(id), { recursive: true });
        await writeRegularFile(record, '');

        try {
          for await (const line of command.logs()) onOutput(line.stream, line.data);

          return { kind: 'exited', code: (await command.wait()).exitCode };
        } finally {
          fs.rmSync(record, { force: true });
        }
      } catch (error) {
        return { kind: 'failed', failure: { code: 'exec_failed', message: `Vercel sandbox ${id} could not run ${spec.argv[0]}: ${(error instanceof Error ? error.message : String(error))}` } };
      }
    },

    async stop(id) {
      const found = await sandboxOf(id);

      if (!found.ok) return failed(`Vercel could not reach sandbox ${id} to stop what runs there: ${found.message}. It may still run; ${removeBy(id)}.`);
      const { sandbox } = found;

      if (sandbox === undefined) return { ok: true };

      const commands = (await Promise.all(runningCommands(id).map(async (cmdId) => {
        try {
          return [await sandbox.getCommand(cmdId)];
        } catch {
          fs.rmSync(path.join(commandsOf(id), cmdId), { force: true });

          return [];
        }
      }))).flat();

      await Promise.all(commands.map((command) => command.kill('SIGTERM').catch(() => undefined)));
      const deadline = Date.now() + COMMAND_MS;
      const endedAll = async (ms: number): Promise<boolean> => (await Promise.all(commands.map((command) => ended(command, ms)))).every(Boolean);

      if (await endedAll(2_000)) return { ok: true };
      await Promise.all(commands.map((command) => command.kill('SIGKILL').catch(() => undefined)));

      if (await endedAll(Math.max(0, deadline - Date.now()))) return { ok: true };

      return failed(`Vercel did not stop what runs in sandbox ${id} within ${COMMAND_MS / 1000} s. ${removeBy(id)}.`);
    },

    async destroy(id) {
      const found = await sandboxOf(id);

      if (!found.ok) return failed(`Vercel could not reach sandbox ${id} to delete it: ${found.message}. ${removeBy(id)}.`);

      const why = found.sandbox === undefined ? undefined : await discard(found.sandbox);

      if (why !== undefined) return failed(`${why}. ${removeBy(id)}.`);
      fs.rmSync(dirOf(id), { recursive: true, force: true });

      return { ok: true };
    },

    async collect(id) {
      const kept = keptOf(id);
      const found = await sandboxOf(id);

      if (kept === undefined || !found.ok || found.sandbox === undefined) {
        return failed(`The work of Vercel sandbox ${id} cannot be copied back: ${!found.ok ? found.message : 'the sandbox or its place on this machine is gone'}.`);
      }

      const { sandbox } = found;
      const { view, runFiles } = kept;
      const roots = [view.worktree, view.result, ...Object.values(view.toolHome)];
      const file = '/tmp/teamai-work.tar';

      try {
        const why = await must(sandbox, 'Packing the work', 'tar', ['-cf', file, '--no-xattrs', '-C', '/', ...[...roots, view.runDir].map(relative)]);

        if (why !== undefined) return failed(`${why}. Nothing was copied back.`);
        const data = await sandbox.readFileToBuffer({ path: file });
        await run(sandbox, 'rm', ['-f', file]);

        if (data === null) return failed(`Vercel sandbox ${id} lost the packed work before it was read. Nothing was copied back.`);
        applyTar(readTar(data), { roots, added: { roots: [view.runDir], wentIn: runFiles }, kept: view.readonly });

        return { ok: true };
      } catch (error) {
        return failed(`Vercel could not copy the work of sandbox ${id} back: ${(error instanceof Error ? error.message : String(error))}`);
      }
    },

    name: nameOf,
    display: (key, warmed) => ({ label: `${nameOf(key)} (vercel)`, fields: { sandbox: nameOf(key), ...(options.runtime !== undefined && { runtime: options.runtime }), ...(warmed && { snapshot: warmed.image }) } }),

    removal: (place) => removeBy(nameOf(place)),
  };
}
