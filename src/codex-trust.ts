import { realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import semver from 'semver';
import { z } from 'zod';
import { getCurrentVersion } from './package-info.js';
import { CODEX_TOOL_ID, type CodexBuild, type CodexBuildSkew } from './types.js';
import { execCommand, probeBinary } from '@teamai/shared/exec';
import { lenientList, type JsonValue, JsonValueSchema, JsonObjectSchema } from '@teamai/shared/json';
import { log } from '@teamai/shared/log';
import { findOnPath } from '@teamai/shared/lookpath';
import { isBareCommandName } from '@teamai/shared/cli-path';

/**
 * Trusting what teamai writes into Codex (#955).
 *
 * The public Codex runs a non-managed hook only when
 * `hooks.state."<key>".trusted_hash` in `$CODEX_HOME/config.toml` matches the
 * hook's current hash, and reads a project's `.codex/` layer only when the
 * project is trusted. An untrusted or modified hook is skipped without a word.
 * teamai asks `codex app-server` — the same JSON-RPC calls the TUI trust prompt
 * makes — so the hash is always Codex's own, never recomputed here.
 */
export type CodexTrust = (
  /** Every hook teamai wrote is trusted (`hooks` is how many this run had to trust). */
  | { kind: 'trusted'; hooks: number; project?: string }
  /** The member keeps Codex's project choice: it is marked untrusted, so teamai left it. */
  | { kind: 'project-untrusted'; hooks: number; project: string }
  /** The member turned it off (`codexTrustEnabled: false`). */
  | { kind: 'disabled' }
  /** No Codex build: no `codex` on PATH and no desktop app. */
  | { kind: 'unavailable'; reason: string }
  /** A team instance of Codex whose command no one accepted here: only that command trusts its hooks, so none ran. */
  | { kind: 'unaccepted'; tool: string }
  /** The app-server failed, timed out, or did not load a requested hook. */
  | { kind: 'failed'; reason: string }
) & CodexBuildComparison;

/**
 * What listing the hooks with every other version of Codex showed: `skew` when
 * one hashes them differently, and `uncompared` naming the builds that could
 * not list them, whose agreement is unknown.
 */
interface CodexBuildComparison {
  skew?: CodexBuildSkew;
  uncompared?: CodexBuild[];
}

/**
 * The Codex an app-server call starts: in `codexHome` (its `CODEX_HOME`), the first of `commands` that is on PATH, or
 * without `commands` the newest of Codex's own builds (`codex` on PATH, then the desktop apps).
 */
export interface CodexAt {
  codexHome: string;
  /** A Codex instance's own accepted command, which hashes the hooks as that build does. */
  commands?: readonly string[];
  /** The Codex instance whose own command runs, which starts in `codexHome` through its own variable too; Codex's builds when absent. */
  tool?: string;
}

export interface CodexHookTrustRequest extends CodexAt {
  /** Directory whose hook layers are listed. */
  cwd: string;
  /** Exact generated entries, with Codex's file/event/position key; Codex on Windows lists an entry by its `commandWindows`. */
  hooks: Array<{ file: string; command: string; commandWindows?: string; key: string }>;
  /** Project to trust first, so Codex reads its `.codex/` layer (realpath). */
  project?: string;
  /** Record ownership only when this pass actually creates project trust. */
  onProjectTrusted?: (project: string) => Promise<void>;
}

/** What Codex says about each hook teamai wrote, for `doctor`. */
export type CodexHookTrustReport = (
  | {
    kind: 'listed';
    /** The teamai hooks Codex will not run: listed but not trusted, or not loaded at all. */
    notTrusted: Array<{ file: string; command: string; status: string }>;
  }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }
) & CodexBuildComparison;

const REQUEST_TIMEOUT_MS = 10_000;

/** One hook as Codex's `hooks/list` reports it. */
const HookInfoSchema = z.object({
  key: z.string(),
  command: z.string(),
  sourcePath: z.string(),
  currentHash: z.string(),
  trustStatus: z.string(),
});

type HookInfo = z.infer<typeof HookInfoSchema>;

function canonical(file: string): string {
  try { return realpathSync.native(file); } catch { return path.resolve(file); }
}

/** A Codex binary that exists, with the command that starts it and its stat identity. */
interface CodexCandidate {
  /** Bare `codex` for the PATH hit, so cross-spawn resolves the Windows `codex.cmd` shim. */
  command: string;
  path: string;
  identity: string;
}

/** `commands`, else `codex` on PATH first (it wins a version tie), then the desktop builds. Stat only, no spawn. */
async function codexBuildCandidates(commands?: readonly string[]): Promise<CodexCandidate[]> {
  // The launch registry loads every family's launch profiles: here, where first used, not in every command that imports this module.
  const { executablesOf } = await import('./tool-launch/tools.js');

  const found = (commands ?? executablesOf('codex')).flatMap((command) => {
    if (!isBareCommandName(command)) return [{ command, path: command }];
    const onPath = findOnPath(command);

    return onPath ? [{ command, path: onPath }] : [];
  });

  const seen = new Set<string>();

  return found.flatMap((candidate) => {
    try {
      const real = realpathSync.native(candidate.path);
      const { mtimeMs, size } = statSync(real);

      if (seen.has(real)) return [];
      seen.add(real);

      return [{ ...candidate, identity: `${candidate.path}\0${real}\0${mtimeMs}\0${size}` }];
    } catch {
      return [];
    }
  });
}

/**
 * Which Codex binaries exist and what they are, for the trust-cache
 * fingerprint: an added, removed, or updated build can change which one
 * answers and how it hashes a hook. Stat only, so a cached pull runs no binary.
 */
export async function codexBuildsIdentity(commands?: readonly string[]): Promise<string> {
  return (await codexBuildCandidates(commands)).map((c) => c.identity).join('\0\0');
}

async function probeCodexVersion(command: string): Promise<string | null> {
  // `codex --version` first sets up its arg0 helpers under $CODEX_HOME/tmp; a throwaway home keeps the member's as it was.
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'teamai-codex-version-'));
  const { toolCommandEnv } = await import('./tool-launch/tools.js');
  const env = { ...process.env, ...toolCommandEnv(CODEX_TOOL_ID, { kind: 'at', dir: codexHome }) };

  try {
    const printed = /codex-cli\s+(\S+)/.exec(await probeBinary(command, ['--version'], (binary, args, options) => execCommand(binary, args, { ...options, env })))?.[1];

    return printed ? semver.valid(printed) : null;
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

const probedVersions = new Map<string, Promise<string | null>>();

/** One `--version` per build identity in a process: the hook form and the trust pass ask the same builds. */
function codexVersionOf(candidate: CodexCandidate): Promise<string | null> {
  let version = probedVersions.get(candidate.identity);

  if (!version) {
    version = probeCodexVersion(candidate.command);
    probedVersions.set(candidate.identity, version);
  }

  return version;
}

/**
 * The lowest version among the Codex builds that read the member's Codex hook file, or
 * null when none is found or any build's version cannot be read, so a caller
 * gating on a floor never guesses for an unknown build.
 */
export async function oldestCodexBuildVersion(): Promise<string | null> {
  const builds = await Promise.all((await codexBuildCandidates()).map(async (c) => ({ path: c.path, version: await codexVersionOf(c) })));

  log.debug(`Codex builds for the hook form: ${builds.map((b) => `${b.path} → "${b.version ?? ''}"`).join(', ') || 'none'}`);
  const known = builds.flatMap((b) => (b.version === null ? [] : [b.version]));

  if (known.length === 0 || known.length !== builds.length) return null;

  return [...known].sort(semver.compare)[0] ?? null;
}

type ResolvedCodexBuild = {
  command: string;
  otherVersions?: { chosen: CodexBuild; others: Array<CodexBuild & { command: string }> };
};

let resolved: { identity: string; build: Promise<ResolvedCodexBuild | null> } | null = null;

/**
 * The Codex build every app-server call uses: the newest by `--version`, an
 * unparseable version ranking lowest and a tie keeping candidate order. A lone
 * candidate is used without a probe. Memoized while the candidates are unchanged.
 */
async function resolveCodexBuild(commands?: readonly string[]): Promise<ResolvedCodexBuild | null> {
  const candidates = await codexBuildCandidates(commands);
  const identity = candidates.map((c) => c.identity).join('\0\0');

  if (resolved?.identity !== identity) resolved = { identity, build: pickCodexBuild(candidates) };

  return resolved.build;
}

async function pickCodexBuild(candidates: CodexCandidate[]): Promise<ResolvedCodexBuild | null> {
  if (candidates.length <= 1) return candidates[0] ? { command: candidates[0].command } : null;
  const probed = await Promise.all(candidates.map(async (c) => ({ ...c, version: await codexVersionOf(c) })));

  const [chosen, ...rest] = [...probed].sort((a, b) => {
    if (a.version === null || b.version === null) return Number(a.version === null) - Number(b.version === null);

    return semver.rcompare(a.version, b.version);
  });

  const others = rest.filter((c) => c.version !== chosen.version).map((c) => ({ path: c.path, version: c.version, command: c.command }));

  return others.length > 0
    ? { command: chosen.command, otherVersions: { chosen: { path: chosen.path, version: chosen.version }, others } }
    : { command: chosen.command };
}

async function compareCodexBuilds(
  req: Pick<CodexHookTrustRequest, 'codexHome' | 'cwd' | 'hooks'>,
  listed: HookInfo[],
  build: ResolvedCodexBuild,
): Promise<CodexBuildComparison> {
  const hashes = (hooks: HookInfo[]) => new Map(hooks.map((h) => [hookId(h.sourcePath, h.command, h.key), h.currentHash]));
  const chosen = hashes(listed);
  const ids = req.hooks.flatMap(hookIds).filter((id) => chosen.has(id));
  const versions = build.otherVersions;

  if (!versions || ids.length === 0) return {};

  const compared = await Promise.all(versions.others.map(async (other) => ({
    codex: { path: other.path, version: other.version },
    theirs: await withCodexBuild({ codexHome: req.codexHome, command: other.command }, async (server) => hashes(await listHooks(server, req.cwd))),
  })));

  const others = compared.flatMap(({ codex, theirs }) =>
    theirs instanceof Map && ids.some((id) => theirs.has(id) && theirs.get(id) !== chosen.get(id)) ? [codex] : []);

  const uncompared = compared.flatMap(({ codex, theirs }) => {
    if (theirs instanceof Map) return [];
    log.debug(`Codex: could not compare ${codexBuildLabel(codex)} with ${codexBuildLabel(versions.chosen)}: ${theirs.reason}`);

    return [codex];
  });

  const comparison: CodexBuildComparison = {};

  if (others.length > 0) comparison.skew = { chosen: versions.chosen, others };

  if (uncompared.length > 0) comparison.uncompared = uncompared;

  return comparison;
}

function codexBuildLabel(b: CodexBuild): string {
  return `${b.path} (${b.version === null ? 'unknown version' : `codex-cli ${b.version}`})`;
}

/** Shared by pull (`reportCodexTrust`) and `doctor` so the wording stays identical. */
export function codexBuildSkewMessage(skew: CodexBuildSkew): string {
  return `Codex builds disagree: teamai trusts its hooks with ${codexBuildLabel(skew.chosen)}. `
    + skew.others.map((b) => `${codexBuildLabel(b)} hashes some of them differently and skips those. `).join('')
    + 'Update or remove the older build, then run `teamai pull`.';
}

/** One `codex app-server` process speaking line-delimited JSON-RPC over stdio. */
interface AppServer {
  /** The request's `result`, undefined when the reply carries none. */
  request(method: string, params: JsonValue): Promise<JsonValue | undefined>;
  close(): void;
}

/** A JSON-RPC reply to one of teamai's requests; a line without a numeric id is a notification. */
const RpcReplySchema = z.object({ id: z.number(), result: JsonValueSchema.optional(), error: JsonValueSchema.optional() });

/** A JSON-RPC error's message, when the error carries one. */
const RpcErrorSchema = z.object({ message: JsonValueSchema.optional() });

class AppServerError extends Error {
  constructor(message: string, readonly unavailable = false) {
    super(message);
  }
}

async function openAppServer(codexHome: string, command: string, tool: string): Promise<AppServer> {
  const { toolCommandEnv } = await import('./tool-launch/tools.js');

  const child = crossSpawn(command, ['app-server'], {
    env: { ...process.env, ...toolCommandEnv(tool, { kind: 'at', dir: codexHome }) },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });

  const pending = new Map<number, { method: string; resolve: (v: JsonValue | undefined) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let ended: AppServerError | null = null;

  const fail = (error: AppServerError): void => {
    if (ended) return;
    ended = error;

    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  child.on('error', (e: NodeJS.ErrnoException) => {
    fail(e.code === 'ENOENT'
      ? new AppServerError('codex is not on PATH', true)
      : new AppServerError(`could not start codex app-server: ${e.message}`));
  });
  child.on('exit', (code, signal) => {
    fail(new AppServerError(`codex app-server exited (${signal ?? `code ${code}`})`));
  });
  child.stdin?.on('error', () => { /* reported by 'exit' / 'error' */ });

  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;

    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);

      if (!line) continue;
      let parsed: unknown;

      try { parsed = JSON.parse(line); } catch { continue; }

      const reply = RpcReplySchema.safeParse(parsed);

      if (!reply.success) continue; // a notification
      const message = reply.data;
      const waiter = pending.get(message.id);

      if (!waiter) continue;
      pending.delete(message.id);

      if (message.error) {
        const detail = RpcErrorSchema.safeParse(message.error);
        waiter.reject(new AppServerError(`${waiter.method}: ${(detail.success ? detail.data.message : undefined) ?? 'unknown error'}`));
      } else waiter.resolve(message.result);
    }
  });

  const send = (message: JsonValue): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  const server: AppServer = {
    request(method, params) {
      if (ended) return Promise.reject(ended);
      const id = nextId++;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new AppServerError(`codex app-server did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000}s`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, {
          method,
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        send({ id, method, params });
      });
    },
    close() {
      fail(new AppServerError('closed'));
      child.stdin?.end();
      child.kill();
    },
  };

  try {
    await server.request('initialize', { clientInfo: { name: 'teamai', version: getCurrentVersion() } });
    send({ method: 'initialized' });

    return server;
  } catch (e) {
    server.close();
    throw e;
  }
}

type AppServerFailure = { kind: 'unavailable'; reason: string } | { kind: 'failed'; reason: string };

async function withAppServer<T>(
  { codexHome, commands, tool }: CodexAt,
  run: (server: AppServer, build: ResolvedCodexBuild) => Promise<T>,
): Promise<T | AppServerFailure> {
  const build = await resolveCodexBuild(commands);

  if (!build) {
    return { kind: 'unavailable', reason: commands === undefined ? 'codex is not on PATH and no Codex desktop app is installed' : `${commands.join(', ') || 'no command'} is not on PATH` };
  }

  return withCodexBuild({ codexHome, command: build.command, tool }, (server) => run(server, build));
}

async function withCodexBuild<T>(
  { codexHome, command, tool = CODEX_TOOL_ID }: { codexHome: string; command: string; tool?: string },
  run: (server: AppServer) => Promise<T>,
): Promise<T | AppServerFailure> {
  let server: AppServer | null = null;

  try {
    server = await openAppServer(codexHome, command, tool);

    return await run(server);
  } catch (e) {
    if (e instanceof AppServerError && e.unavailable) return { kind: 'unavailable', reason: e.message };

    return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
  } finally {
    server?.close();
  }
}

/** A `config/batchWrite` reply's `status`; a reply that is not an object has none. */
const BatchWriteReplySchema = z.object({ status: JsonValueSchema.optional() }).catch({});

/** `config/read`'s `config.projects`, by project path; a reply without them has none. */
const ProjectsReadSchema = z
  .object({ config: z.object({ projects: JsonObjectSchema }) })
  .transform(({ config }) => config.projects)
  .catch(() => ({}));

/** A project entry's trust level, when it is a string. */
const ProjectTrustSchema = z.object({ trust_level: z.string() });

/** A project entry that holds exactly what teamai writes. */
const OwnedProjectTrustSchema = z.strictObject({ trust_level: z.literal('trusted') });

async function batchWrite(server: AppServer, keyPath: string, value: Record<string, JsonValue>): Promise<void> {
  const result = BatchWriteReplySchema.parse(await server.request('config/batchWrite', {
    edits: [{ keyPath, value, mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  }));

  if (result.status !== 'ok') {
    throw new AppServerError(`config/batchWrite ${keyPath}: status ${result.status ?? 'missing'}`);
  }
}

/**
 * Trust `project` unless the member already decided. Returns its trust level
 * after the call: `trusted`, or `untrusted` when the member marked it so in
 * Codex — that choice is theirs and is never overwritten.
 */
async function ensureProjectTrusted(server: AppServer, project: string, onWritten?: (project: string) => Promise<void>): Promise<'trusted' | 'untrusted'> {
  const projects = ProjectsReadSchema.parse(await server.request('config/read', {}));
  const entry = ProjectTrustSchema.safeParse(projects[project]);
  const level = entry.success ? entry.data.trust_level : undefined;

  if (level === 'trusted') return 'trusted';

  if (level === 'untrusted') return 'untrusted';
  await batchWrite(server, 'projects', { [project]: { trust_level: 'trusted' } });
  await onWritten?.(project);

  return 'trusted';
}

/**
 * Mark a project trusted in Codex, the TUI's "trust this folder" answer, so
 * Codex reads its `.codex/` layer (hooks, MCP servers). A project the member
 * marked untrusted is left as it is.
 */
export async function trustCodexProject(req: CodexAt & { project: string }): Promise<CodexTrust> {
  const project = canonical(req.project);

  return withAppServer(req, async (server): Promise<CodexTrust> => {
    const level = await ensureProjectTrusted(server, project);

    return level === 'trusted'
      ? { kind: 'trusted', hooks: 0, project }
      : { kind: 'project-untrusted', hooks: 0, project };
  });
}

/** Remove a recorded trust grant only while it still contains exactly what teamai wrote. */
export async function removeOwnedCodexProjectTrust(req: CodexAt & { project: string }): Promise<
  { kind: 'removed' | 'kept' } | AppServerFailure
> {
  const project = canonical(req.project);

  return withAppServer(req, async (server) => {
    const projects = ProjectsReadSchema.parse(await server.request('config/read', {}));

    if (!OwnedProjectTrustSchema.safeParse(projects[project]).success) return { kind: 'kept' as const };

    const result = BatchWriteReplySchema.parse(await server.request('config/batchWrite', {
      edits: [{ keyPath: `projects.${JSON.stringify(project)}`, value: null, mergeStrategy: 'replace' }],
      reloadUserConfig: true,
    }));

    if (result.status !== 'ok') throw new AppServerError(`could not remove recorded project trust for ${project}`);

    return { kind: 'removed' as const };
  });
}

function hookId(file: string, command: string, key: string): string {
  return `${canonical(file)}\0${key}\0${command}`;
}

/** The ids Codex may list a written entry under: by its command, and on Windows by its `commandWindows`. */
function hookIds(hook: CodexHookTrustRequest['hooks'][number]): string[] {
  const ids = [hookId(hook.file, hook.command, hook.key)];

  if (hook.commandWindows !== undefined) ids.push(hookId(hook.file, hook.commandWindows, hook.key));

  return ids;
}

/** Where `hooks/list` puts the first cwd's hooks; a reply without them lists none. */
const HooksListReplySchema = z.object({
  data: z.tuple([z.object({ hooks: JsonValueSchema, errors: JsonValueSchema.optional() })], JsonValueSchema),
});

/** The messages of the config errors `hooks/list` reports for a cwd; entries without a string message are skipped. */
const ListErrorMessagesSchema = z
  .array(z.object({ message: z.string() }).transform((e) => e.message).catch(''))
  .catch([])
  .transform((messages) => messages.filter((m) => m !== ''));

async function listHooks(server: AppServer, cwd: string): Promise<HookInfo[]> {
  const listed = HooksListReplySchema.safeParse(await server.request('hooks/list', { cwds: [canonical(cwd)] }));

  if (!listed.success) return [];

  // Codex answers with no hooks and `errors` when it cannot load its config for the cwd. That says nothing
  // about trust, so report the Codex error instead of letting every hook read as "not loaded".
  const errors = ListErrorMessagesSchema.parse(listed.data.data[0].errors);

  if (errors.length > 0) throw new AppServerError(`Codex could not load its config for ${cwd}: ${errors.join('; ')}`);

  if (listed.data.data[0].hooks === null) return [];
  // A hook with another handler, such as `mcp_tool`, is listed without a command; teamai writes none of those.
  const hooks = lenientList(HookInfoSchema).safeParse(listed.data.data[0].hooks);

  if (!hooks.success) throw new AppServerError('hooks/list: the hooks of the cwd are not a list');

  return hooks.data;
}

/**
 * Trust exactly the hooks teamai wrote: those Codex lists for `cwd` whose key,
 * file and command are in `hooks`. Trusts the project first when one is given,
 * since an untrusted project's hook layer is not read.
 */
export async function trustCodexHooks(req: CodexHookTrustRequest): Promise<CodexTrust> {
  const wanted = new Set(req.hooks.flatMap(hookIds));
  const project = req.project ? canonical(req.project) : undefined;

  return withAppServer(req, async (server, build): Promise<CodexTrust> => {
    const level = project ? await ensureProjectTrusted(server, project, req.onProjectTrusted) : undefined;
    const listed = await listHooks(server, req.cwd);
    const builds = await compareCodexBuilds(req, listed, build);
    const loaded = new Set(listed.map((h) => hookId(h.sourcePath, h.command, h.key)));
    const missing = req.hooks.filter((h) => !hookIds(h).some((id) => loaded.has(id)));

    if (missing.length > 0 && level !== 'untrusted') {
      return {
        kind: 'failed',
        reason: `hooks/list: ${missing.map((h) => `${h.command} in ${h.file}`).join('; ')} not loaded for ${req.cwd}. Check that Codex loads these hook files, then run teamai pull again.`,
        ...builds,
      };
    }

    const toTrust = listed.filter((h) =>
      h.trustStatus !== 'trusted' && wanted.has(hookId(h.sourcePath, h.command, h.key)));

    if (toTrust.length > 0) {
      await batchWrite(
        server,
        'hooks.state',
        Object.fromEntries(toTrust.map((h) => [h.key, { trusted_hash: h.currentHash }])),
      );
    }

    if (project && level === 'untrusted') return { kind: 'project-untrusted', hooks: toTrust.length, project, ...builds };

    const trusted: CodexTrust = { kind: 'trusted', hooks: toTrust.length };

    if (project) trusted.project = project;

    return { ...trusted, ...builds };
  });
}

function hooksByKey(hooks: HookInfo[], file: string): Map<string, HookInfo> {
  return new Map(hooks.flatMap((h) => (canonical(h.sourcePath) === file ? [[h.key, h] as const] : [])));
}

function hasApprovalState(hook: HookInfo): boolean {
  return hook.trustStatus === 'trusted' || hook.trustStatus === 'modified';
}

/**
 * Keep approvals for the exact handlers `write` retains: `retained` maps each
 * one's new key to its original key. Equal hashes alone do not establish
 * identity. A key a handler left loses its state unless the handler now there
 * carries its own approval, so no group shows an approval it was never given.
 * `write` runs even when Codex cannot be asked.
 */
export async function keepCodexHookTrust(
  req: CodexAt & { cwd: string; file: string },
  retained: ReadonlyMap<string, string>,
  write: () => Promise<void>,
): Promise<CodexTrust> {
  const file = canonical(req.file);
  const before = await withAppServer(req, async (server) => hooksByKey(await listHooks(server, req.cwd), file));
  await write();

  if (!(before instanceof Map)) return before;

  if (![...before.values()].some(hasApprovalState)) return { kind: 'trusted', hooks: 0 };

  return withAppServer(req, async (server): Promise<CodexTrust> => {
    const toTrust: HookInfo[] = [];
    const edits: Array<{ keyPath: string; value: JsonValue; mergeStrategy: 'upsert' | 'replace' }> = [];
    const after = hooksByKey(await listHooks(server, req.cwd), file);

    for (const hook of after.values()) {
      const originalKey = retained.get(hook.key);
      const original = originalKey === undefined ? undefined : before.get(originalKey);

      if (original?.trustStatus === 'trusted' && original.currentHash === hook.currentHash) {
        if (hook.trustStatus !== 'trusted') {
          toTrust.push(hook);
        }
      } else if (originalKey !== hook.key && hasApprovalState(hook)) {
        edits.push({
          keyPath: `hooks.state.${JSON.stringify(hook.key)}`,
          value: null,
          mergeStrategy: 'replace',
        });
      }
    }

    for (const hook of before.values()) {
      if (hasApprovalState(hook) && !after.has(hook.key)) {
        edits.push({
          keyPath: `hooks.state.${JSON.stringify(hook.key)}`,
          value: null,
          mergeStrategy: 'replace',
        });
      }
    }

    if (toTrust.length > 0) {
      edits.push({
        keyPath: 'hooks.state',
        value: Object.fromEntries(toTrust.map((h) => [h.key, { trusted_hash: h.currentHash }])),
        mergeStrategy: 'upsert',
      });
    }

    if (edits.length > 0) {
      const result = BatchWriteReplySchema.parse(await server.request('config/batchWrite', {
        edits,
        reloadUserConfig: true,
      }));

      if (result.status !== 'ok') {
        throw new AppServerError(`config/batchWrite hooks.state: status ${result?.status ?? 'missing'}`);
      }
    }

    return { kind: 'trusted', hooks: toTrust.length };
  });
}

/**
 * Read-only: which of the hooks teamai wrote Codex will not run for `cwd` —
 * listed as untrusted or modified, or not loaded at all (an untrusted project,
 * a worktree whose `.codex/` does not exist yet). Writes nothing.
 */
export async function readCodexHookTrust(req: Omit<CodexHookTrustRequest, 'project'>): Promise<CodexHookTrustReport> {
  return withAppServer(req, async (server, build): Promise<CodexHookTrustReport> => {
    const listed = await listHooks(server, req.cwd);
    const statuses = new Map(listed.map((h) => [hookId(h.sourcePath, h.command, h.key), h.trustStatus]));

    return {
      kind: 'listed',
      notTrusted: req.hooks
        .map((h) => ({
          file: h.file,
          command: h.command,
          status: hookIds(h).map((id) => statuses.get(id)).find((status) => status !== undefined) ?? 'not loaded',
        }))
        .filter((h) => h.status !== 'trusted'),
      ...await compareCodexBuilds(req, listed, build),
    };
  });
}
