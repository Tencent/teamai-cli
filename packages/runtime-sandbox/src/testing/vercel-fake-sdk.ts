import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signalGroup } from '@teamai/shared/process-group';
import { z } from 'zod';

// ─── A stand-in `@vercel/sandbox`, for tests only ───
//
//  The tests bundle the runtime with `@vercel/sandbox` aliased to this module (vercel.test.ts), so the runtime runs as it
//  ships against a hosted sandbox that is a directory on this machine. It has the subset of the SDK the vercel provider
//  calls: Sandbox.create (from a snapshot too), Sandbox.get, Sandbox.list, runCommand (detached), getCommand, writeFiles,
//  readFileToBuffer, snapshot, delete, a Command's logs, wait and kill, and Snapshot.get.
//
//  A sandbox's filesystem is `<state>/sandboxes/<name>/root`: every absolute path a call names lands under it, so a
//  sandbox never touches the host's own paths. A command runs on the host, in a process group of its own, with its
//  absolute arguments, its working directory and each absolute path in its environment moved under that root, and with
//  only the image's tools (FAKE_VERCEL_IMAGE) and /usr/bin:/bin on its PATH; `sudo` changes nothing. A snapshot is a copy
//  of that root at `<state>/snapshots/<id>/root`, with its `meta.json` ({ expiresAt }): one past its expiresAt is deleted,
//  as Vercel deletes it, and a sandbox created from it starts with that copy.
//
//    FAKE_VERCEL_STATE   its state directory, shared by every runtime process of a test; it logs each call, names only
//                        (an env's names, never a value), to `calls.log`
//    FAKE_VERCEL_IMAGE   the directory holding the image's tools
//
//  A file `down` in the state directory makes every call fail as an API that does not answer, and a file `<call>.fails`
//  makes that call alone fail with its text.
//

const state = process.env.FAKE_VERCEL_STATE ?? '/nonexistent';
const image = process.env.FAKE_VERCEL_IMAGE ?? '/nonexistent';

const SourceSchema = z.object({ type: z.literal('snapshot'), snapshotId: z.string() });

const MetaSchema = z.object({ name: z.string(), persistent: z.boolean().optional(), timeout: z.number().optional(), runtime: z.string().optional(), source: SourceSchema.optional(), tags: z.record(z.string(), z.string()).optional() });

const SnapshotMetaSchema = z.object({ expiresAt: z.number().optional() });

const CommandSchema = z.object({ pid: z.number(), exitCode: z.number().nullable() });

class NotFound extends Error {
  readonly response = { status: 404 };
}

const sandboxDir = (name: string): string => path.join(state, 'sandboxes', name);

const snapshotDir = (id: string): string => path.join(state, 'snapshots', id);

/** `at`, an absolute path inside the sandbox, as the host path it is kept at. */
const inRoot = (name: string, at: string): string => path.join(sandboxDir(name), 'root', at);

/** What a call log line records beside its call: names, paths and settings, never a value of an env or a secret. */
type Logged = Record<string, string | number | boolean | string[] | Record<string, string> | undefined>;

function log(call: string, detail: Logged = {}): void {
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(path.join(state, 'calls.log'), `${JSON.stringify({ call, ...detail })}\n`);

  if (fs.existsSync(path.join(state, 'down'))) throw new Error('Vercel API is not answering (stand-in)');

  if (fs.existsSync(path.join(state, `${call}.fails`))) throw new Error(fs.readFileSync(path.join(state, `${call}.fails`), 'utf8').trim());
}

/** Moves `value` under the sandbox root when it is an absolute path, or `-C /` style root. */
const rooted = (name: string, value: string): string => (path.isAbsolute(value) && !value.startsWith(image) ? inRoot(name, value) : value);

type LogLine = { stream: 'stdout' | 'stderr'; data: string };

export class Command {
  constructor(private readonly sandbox: string, readonly cmdId: string, private readonly lines?: AsyncGenerator<LogLine>, private readonly done?: Promise<number>) {}

  private file(): string {
    return path.join(sandboxDir(this.sandbox), 'commands', `${this.cmdId}.json`);
  }

  async *logs(): AsyncGenerator<LogLine> {
    if (this.lines) yield* this.lines;
  }

  async wait(): Promise<{ exitCode: number }> {
    if (this.done) return { exitCode: await this.done };

    // Another process's command: its end, once its record has one, or once its process is gone (the API tracks it, not
    // the runtime process that started it).
    for (;;) {
      const { pid, exitCode } = CommandSchema.parse(JSON.parse(fs.readFileSync(this.file(), 'utf8')));

      if (exitCode !== null) return { exitCode };
      const probe = signalGroup(pid, 0);

      if (probe !== 'sent' && probe !== 'denied') return { exitCode: 143 };

      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    log('kill', { sandbox: this.sandbox, cmdId: this.cmdId, signal });
    const { pid, exitCode } = CommandSchema.parse(JSON.parse(fs.readFileSync(this.file(), 'utf8')));

    // A command whose spawn has not failed yet records no process: 0, which signalGroup refuses.
    if (exitCode === null) signalGroup(pid, signal);
  }
}

export class Snapshot {
  constructor(readonly snapshotId: string, readonly status: 'created' | 'deleted', readonly expiresAt: Date | undefined) {}

  /** The snapshot `id` as Vercel keeps it: `deleted` once past its expiresAt. */
  static of(id: string): Snapshot | undefined {
    const meta = path.join(snapshotDir(id), 'meta.json');

    if (!fs.existsSync(meta)) return undefined;
    const { expiresAt } = SnapshotMetaSchema.parse(JSON.parse(fs.readFileSync(meta, 'utf8')));

    return new Snapshot(id, expiresAt !== undefined && expiresAt <= Date.now() ? 'deleted' : 'created', expiresAt === undefined ? undefined : new Date(expiresAt));
  }

  static async get(params: { snapshotId: string }): Promise<Snapshot> {
    log('getSnapshot', { snapshotId: params.snapshotId });
    const found = Snapshot.of(params.snapshotId);

    if (found === undefined) throw new NotFound(`Snapshot ${params.snapshotId} not found`);

    return found;
  }
}

export class Sandbox {
  private constructor(readonly name: string) {}

  get status(): string {
    return fs.existsSync(sandboxDir(this.name)) ? 'running' : 'stopped';
  }

  static async create(params: { name?: string; persistent?: boolean; timeout?: number; runtime?: string; source?: z.infer<typeof SourceSchema>; tags?: Record<string, string>; token?: string; teamId?: string; projectId?: string }): Promise<Sandbox> {
    const name = params.name ?? `sbx_${crypto.randomBytes(6).toString('hex')}`;
    // The SDK signs in with VERCEL_OIDC_TOKEN from its own process's environment when no token is passed.
    log('create', { name, persistent: params.persistent, timeout: params.timeout, runtime: params.runtime, source: params.source, tags: params.tags, auth: ['token', 'teamId', 'projectId'].filter((key) => key in params), oidc: process.env.VERCEL_OIDC_TOKEN !== undefined });

    if (fs.existsSync(sandboxDir(name))) throw Object.assign(new Error(`A sandbox named ${name} exists`), { response: { status: 409 } });

    if (params.source !== undefined) {
      if (Snapshot.of(params.source.snapshotId)?.status !== 'created') throw new NotFound(`Snapshot ${params.source.snapshotId} not found`);
      fs.cpSync(path.join(snapshotDir(params.source.snapshotId), 'root'), path.join(sandboxDir(name), 'root'), { recursive: true, verbatimSymlinks: true });
    }

    fs.mkdirSync(path.join(sandboxDir(name), 'root', 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(sandboxDir(name), 'commands'), { recursive: true });
    fs.writeFileSync(path.join(sandboxDir(name), 'meta.json'), JSON.stringify(MetaSchema.parse({ ...params, name })));

    return new Sandbox(name);
  }

  static async get(params: { name: string }): Promise<Sandbox> {
    log('get', { name: params.name });

    if (!fs.existsSync(sandboxDir(params.name))) throw new NotFound(`Sandbox ${params.name} not found`);

    return new Sandbox(params.name);
  }

  static async list(params: { namePrefix?: string }): Promise<{ toArray(): Promise<Array<{ name: string }>> }> {
    log('list', { namePrefix: params.namePrefix });
    const root = path.join(state, 'sandboxes');
    const names = (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((name) => name.startsWith(params.namePrefix ?? ''));

    return { toArray: async () => names.map((name) => ({ name })) };
  }

  async writeFiles(files: Array<{ path: string; content: string | Uint8Array; mode?: number }>): Promise<void> {
    log('writeFiles', { sandbox: this.name, paths: files.map((file) => file.path) });

    for (const file of files) {
      const at = inRoot(this.name, file.path);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, file.content, { mode: file.mode });
    }
  }

  async readFileToBuffer(file: { path: string }): Promise<Buffer | null> {
    log('readFileToBuffer', { sandbox: this.name, path: file.path });
    const at = inRoot(this.name, file.path);

    return fs.existsSync(at) ? fs.readFileSync(at) : null;
  }

  async getCommand(cmdId: string): Promise<Command> {
    log('getCommand', { sandbox: this.name, cmdId });

    if (!fs.existsSync(path.join(sandboxDir(this.name), 'commands', `${cmdId}.json`))) throw new NotFound(`Command ${cmdId} not found`);

    return new Command(this.name, cmdId);
  }

  async runCommand(params: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string>; sudo?: boolean; detached?: boolean }): Promise<Command> {
    const args = params.args ?? [];
    log('runCommand', { sandbox: this.name, cmd: params.cmd, args, cwd: params.cwd, env: Object.keys(params.env ?? {}), sudo: params.sudo === true });

    const env = Object.fromEntries(Object.entries(params.env ?? {}).map(([key, value]) => [key, rooted(this.name, value)]));
    const cmdId = `cmd_${crypto.randomBytes(6).toString('hex')}`;
    const cwd = inRoot(this.name, params.cwd ?? '/');
    fs.mkdirSync(cwd, { recursive: true });

    const child = spawn(params.cmd, args.map((arg) => rooted(this.name, arg)), {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: [image, '/usr/bin', '/bin', '/usr/sbin'].join(path.delimiter), HOME: inRoot(this.name, '/home/vercel-sandbox'), ...env },
    });

    const file = path.join(sandboxDir(this.name), 'commands', `${cmdId}.json`);
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid ?? 0, exitCode: null }));

    const queue: LogLine[] = [];
    let wake: (() => void) | undefined;
    let isClosed = false;
    const push = (line: LogLine): void => { queue.push(line); wake?.(); };

    child.stdout.setEncoding('utf8').on('data', (data: string) => push({ stream: 'stdout', data }));
    child.stderr.setEncoding('utf8').on('data', (data: string) => push({ stream: 'stderr', data }));

    const done = new Promise<number>((resolve) => {
      child.on('error', () => { isClosed = true; wake?.(); fs.writeFileSync(file, JSON.stringify({ pid: 0, exitCode: 127 })); resolve(127); });
      child.on('close', (code, signal) => {
        // A spawn that failed closes after its error, which recorded its end already.
        if (isClosed) return;
        const exitCode = code ?? (signal === 'SIGKILL' ? 137 : 143);
        isClosed = true;
        wake?.();
        fs.writeFileSync(file, JSON.stringify({ pid: child.pid ?? 0, exitCode }));
        resolve(exitCode);
      });
    });

    async function* lines(): AsyncGenerator<LogLine> {
      for (;;) {
        const next = queue.shift();

        if (next) yield next;
        else if (isClosed) return;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    }

    return new Command(this.name, cmdId, lines(), done);
  }

  async snapshot(params: { expiration?: number } = {}): Promise<Snapshot> {
    log('snapshot', { sandbox: this.name, expiration: params.expiration });
    const id = `snap_${crypto.randomBytes(6).toString('hex')}`;
    fs.cpSync(path.join(sandboxDir(this.name), 'root'), path.join(snapshotDir(id), 'root'), { recursive: true, verbatimSymlinks: true });
    const expiresAt = params.expiration ? Date.now() + params.expiration : undefined;
    fs.writeFileSync(path.join(snapshotDir(id), 'meta.json'), JSON.stringify({ expiresAt }));

    return new Snapshot(id, 'created', expiresAt === undefined ? undefined : new Date(expiresAt));
  }

  async delete(): Promise<void> {
    log('delete', { sandbox: this.name });

    for (const name of fs.existsSync(path.join(sandboxDir(this.name), 'commands')) ? fs.readdirSync(path.join(sandboxDir(this.name), 'commands')) : []) {
      const { pid, exitCode } = CommandSchema.parse(JSON.parse(fs.readFileSync(path.join(sandboxDir(this.name), 'commands', name), 'utf8')));

      if (exitCode === null) signalGroup(pid, 'SIGKILL');
    }

    // The git paths were made read-only inside; a hosted sandbox's deletion ignores modes.
    execFileSync('chmod', ['-R', 'u+w', sandboxDir(this.name)]);
    fs.rmSync(sandboxDir(this.name), { recursive: true, force: true });
  }
}
