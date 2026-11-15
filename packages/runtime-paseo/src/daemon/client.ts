import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createPaseoApi } from '@getpaseo/client';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { buildAgentDeepLink } from '@getpaseo/protocol/agent-deep-link';
import { getUserHome } from '@teamai/shared/home';
import { findOnPath } from '@teamai/shared/lookpath';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import { runtimeStateRoot } from '@teamai/runtime-protocol/state-root';
import type WebSocket from 'ws';
import { z } from 'zod';
import { clientInApp } from './app-client.js';
import { PASEO_COMMAND } from '../host-commands.js';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// ─── The Paseo client ────────────────────────────────────
//
//  Paseo is a prerequisite the member installs, and teamai ships none of its code: this runtime loads @getpaseo/client
//  from the installed Paseo when it starts, so the client always matches the member's daemon.
//
//    PASEO_CLIENT_PATH          the directory of an @getpaseo/client package, when set
//    else `paseo` on PATH       its real path, then the CLI package that holds it, whose dependencies hold the client;
//    or ~/.local/bin/paseo      or, for the Paseo app's CLI script, the client inside the app, unpacked into
//                               ~/.teamai/runtime-state/paseo-client (app-client.ts), or, for a check, which writes
//                               nothing of teamai's, into a directory it removes; ~/.local/bin is where the app's
//                               install-CLI action links the script, which PATH may not hold
//
//  The client's own dependencies, @getpaseo/protocol and ws, resolve from the client's directory, as its code does.
//

/** The oldest Paseo this runtime runs against, its client and its daemon alike: the version it is tested against. */
export const OLDEST_PASEO = '0.14.0';

/** Whether `version` is `floor` or later, comparing major, minor and patch. */
export function atLeast(version: string, floor: string): boolean {
  const parts = (text: string): number[] => text.split(/[.-]/).slice(0, 3).map(Number);
  const [have, need] = [parts(version), parts(floor)];

  for (let index = 0; index < 3; index += 1) {
    if ((have[index] ?? 0) !== (need[index] ?? 0)) return (have[index] ?? 0) > (need[index] ?? 0);
  }

  return true;
}

/** What this runtime uses of the installed client. Typed by the version it is tested against, the oldest it loads. */
export interface PaseoClient {
  createPaseoApi: typeof createPaseoApi;
  DaemonClient: typeof DaemonClient;
  buildAgentDeepLink: typeof buildAgentDeepLink;
  WebSocket: typeof WebSocket;
}

const ManifestSchema = z.object({ name: z.string(), version: z.string().optional() });

/** The package.json of the package in `dir`, or undefined when it holds none that parses. */
function manifestOf(dir: string): z.infer<typeof ManifestSchema> | undefined {
  try {
    return ManifestSchema.safeParse(JSON.parse(readRegularFileSync(path.join(dir, 'package.json'), 'utf8'))).data;
  } catch {
    return undefined;
  }
}

/** The nearest directory at or above `start` that holds the package named `name`. */
function packageDir(start: string, name: string): string | undefined {
  for (let at = start; ; at = path.dirname(at)) {
    if (manifestOf(at)?.name === name) return at;

    if (path.dirname(at) === at) return undefined;
  }
}

/** The directory of the client package of the `paseo` on PATH, or undefined when that install holds none. */
function clientBeside(cli: string): string | undefined {
  const cliDir = packageDir(path.dirname(fs.realpathSync(cli)), '@getpaseo/cli');

  if (!cliDir) return undefined;

  try {
    return packageDir(path.dirname(createRequire(path.join(cliDir, 'package.json')).resolve('@getpaseo/client')), '@getpaseo/client');
  } catch {
    return undefined;
  }
}

/**
 * The directory of the client package and its version, or why none can be used. `unpackInto`: where a client inside the
 * Paseo app that teamai has not kept yet is unpacked, instead of teamai's runtime state.
 */
function findClient(env: NodeJS.ProcessEnv, unpackInto: string | undefined): { dir: string; version: string } | RuntimeFailure {
  const given = env.PASEO_CLIENT_PATH;
  let dir: string | undefined;

  if (given) {
    dir = path.resolve(given);

    if (manifestOf(dir)?.name !== '@getpaseo/client') {
      return {
        code: 'client_missing',
        message: `teamai-runtime-paseo found no Paseo client in ${given}, which PASEO_CLIENT_PATH names. Install the Paseo CLI from the Paseo desktop app's settings, or with npm install -g @getpaseo/cli, or set PASEO_CLIENT_PATH to the directory of its @getpaseo/client package.`,
      };
    }
  } else {
    const linked = path.join(getUserHome(), '.local', 'bin', PASEO_COMMAND);
    const cli = findOnPath(PASEO_COMMAND, { pathEnv: env.PATH }) ?? (fs.existsSync(linked) ? linked : undefined);

    if (!cli) {
      return {
        code: 'client_missing',
        message: 'teamai-runtime-paseo found no `paseo` on PATH, or in ~/.local/bin where the Paseo desktop app installs its CLI, to load the Paseo client from. Install the Paseo CLI from the Paseo desktop app\'s settings, or with npm install -g @getpaseo/cli, or set PASEO_CLIENT_PATH to the directory of its @getpaseo/client package.',
      };
    }

    const beside = clientBeside(cli);
    const located = beside === undefined ? clientInApp(cli, { keep: path.join(runtimeStateRoot(getUserHome()), 'paseo-client'), ...(unpackInto !== undefined && { unpackInto }) }) : { dir: beside };

    if (located && 'code' in located) return located;
    dir = located?.dir;

    if (!dir) {
      return {
        code: 'client_missing',
        message: `teamai-runtime-paseo found no Paseo client in the Paseo install ${cli} links to. Reinstall Paseo (npm install -g @getpaseo/cli), or set PASEO_CLIENT_PATH to the directory of its @getpaseo/client package.`,
      };
    }
  }

  const version = manifestOf(dir)?.version ?? 'unknown';

  if (!atLeast(version, OLDEST_PASEO)) {
    return {
      code: 'client_version',
      message: `The Paseo client in ${dir} is version ${version}; teamai-runtime-paseo needs Paseo ${OLDEST_PASEO} or later. Update Paseo, or set PASEO_CLIENT_PATH to a newer @getpaseo/client package.`,
    };
  }

  return { dir, version };
}

/** A module export this runtime calls or constructs. */
// oxlint-disable-next-line teamai/no-runtime-typeof -- an export is code, not data: being a function is all there is to check before calling it
const ExportedFunctionSchema = z.custom<object>((exported) => typeof exported === 'function', 'not a function');

/** Export `name` of the module `specifier` resolves to from the client's directory, once it is checked to be a function. */
async function loadExport<TExport extends object>(from: string, specifier: string, name: string): Promise<TExport> {
  // oxlint-disable-next-line teamai/package-boundaries -- the Paseo client resolves from the member's Paseo install, outside the repository
  const loaded: unknown = await import(pathToFileURL(createRequire(path.join(from, 'package.json')).resolve(specifier)).href);
  const parsed = z.object({ [name]: ExportedFunctionSchema }).safeParse(loaded);

  if (!parsed.success) throw new Error(`${specifier} exports no function ${name}`);

  // SAFETY: the export is a function of the installed client, which findClient checked is OLDEST_PASEO or later, the
  // version whose types it has here.
  return parsed.data[name] as TExport;
}

/**
 * Loads the installed Paseo client, or says what is missing and how to install it. `unpackInto`: a directory of the
 * caller's, which it removes, for a client inside the Paseo app that teamai has not kept yet, so loading writes nothing
 * of teamai's.
 */
export async function loadClient(env: NodeJS.ProcessEnv, { unpackInto }: { unpackInto?: string } = {}): Promise<PaseoClient | RuntimeFailure> {
  const found = findClient(env, unpackInto);

  if ('code' in found) return found;

  try {
    const [api, daemon, link, socket] = await Promise.all([
      loadExport<typeof createPaseoApi>(found.dir, '@getpaseo/client', 'createPaseoApi'),
      loadExport<typeof DaemonClient>(found.dir, '@getpaseo/client/internal/daemon-client', 'DaemonClient'),
      loadExport<typeof buildAgentDeepLink>(found.dir, '@getpaseo/protocol/agent-deep-link', 'buildAgentDeepLink'),
      loadExport<typeof WebSocket>(found.dir, 'ws', 'default'),
    ]);

    return { createPaseoApi: api, DaemonClient: daemon, buildAgentDeepLink: link, WebSocket: socket };
  } catch (error) {
    return {
      code: 'client_missing',
      message: `teamai-runtime-paseo could not load the Paseo client ${found.version} in ${found.dir}: ${error instanceof Error ? error.message : String(error)}. Reinstall Paseo, or set PASEO_CLIENT_PATH to the directory of a working @getpaseo/client package.`,
    };
  }
}
