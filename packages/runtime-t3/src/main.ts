import path from 'node:path';
import type { RuntimeFailure, RuntimeMessage } from '@teamai/runtime-protocol';
import { runtimeStateRoot } from '@teamai/runtime-protocol/state-root';
import { getUserHome } from '@teamai/shared/home';
import { z } from 'zod';
import { addedProjects } from './added-projects.js';
import { attendedSignIn, signInOf, signInSilently, unattendedAuth, validToken } from './auth.js';
import { journal } from './journal.js';
import { serve, type ServeOptions } from './runtime.js';
import { connectT3 } from './t3.js';
import { t3Command, t3HomeOf, t3UserHomeOf } from './t3-command.js';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// teamai-runtime-t3: teamai spawns it for a driver definition that uses runtime `t3` (`--driver t3`), and speaks
// runtime protocol 1 to it over stdio. Its stdout carries only protocol lines, a line for the person as a `notice`;
// stderr carries what only helps to debug it.

// When teamai is gone, a line it would have read goes nowhere: a thread still running keeps going and records its end.
// So does a note on stderr, which the runtime writes for a dropped line or a thread it could not stop.
let stdoutOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

process.stderr.on('error', () => {});

const state = path.join(runtimeStateRoot(getUserHome()), 't3');

/** T3 Code's data directory on this machine, where its server says where it listens. */
const t3Home = t3HomeOf(process.env, getUserHome());

const t3Cli = t3Command(process.env, t3Home);

/** How long T3 Code's server gets to answer at all before the run counts it as not running. */
const REACH_MS = 3_000;

/** The MCP endpoint of the T3 Code server on this machine, from the file the server writes while it runs. */
function localEndpoint(): URL | undefined {
  try {
    const { origin } = z.object({ origin: z.string().url() }).parse(JSON.parse(readRegularFileSync(path.join(t3Home, 'userdata', 'server-runtime.json'), 'utf8')));

    return new URL('/mcp', origin);
  } catch {
    return undefined;
  }
}

const write = (message: RuntimeMessage): void => {
  if (stdoutOpen) process.stdout.write(`${JSON.stringify(message)}\n`);
};

/** The MCP endpoint of the T3 Code server on this machine when it answers at all, else why it is not reached. */
async function reach(): Promise<{ ok: true; resource: URL } | { ok: false; error: RuntimeFailure }> {
  const resource = localEndpoint();

  if (!resource) return { ok: false, error: { code: 't3_unavailable', message: 'T3 Code is not running on this machine. Open T3 Code, or run `t3 serve`, then start the workflow again.' } };

  // A server file outlives a server that crashed, or one that is stopping: any answer at all means it listens.
  try {
    await fetch(resource, { method: 'HEAD', signal: AbortSignal.timeout(REACH_MS) });
  } catch {
    return { ok: false, error: { code: 't3_unavailable', message: `T3 Code at ${resource.origin} does not answer. Open T3 Code, or run \`t3 serve\`, then start the workflow again.` } };
  }

  return { ok: true, resource };
}

const canStart: ServeOptions['canStart'] = async ({ access }) => {
  const reached = await reach();

  if (!reached.ok) return reached;
  const { resource } = reached;

  // An unattended run signs in through the t3 command when it keeps no sign-in; the check only looks for that command.
  if (validToken(state, resource.href, access) || t3Cli.locate() !== undefined) return { ok: true };

  return {
    ok: false,
    error: { code: 'login_required', message: `teamai has no valid T3 Code sign-in for ${resource.origin} and found no t3 command to sign in through. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again.` },
  };
};

const connect: ServeOptions['connect'] = async (how) => {
  const reached = await reach();

  if (!reached.ok) return reached;
  const { resource } = reached;

  // A run signs in again when its kept sign-in does not grant the access it needs.
  const { access } = how;
  const silent = how.mode !== 'recover' && !validToken(state, resource.href, access) ? await signInSilently({ stateDir: state, resource, t3Home, t3Cli, access }) : undefined;
  const silentFailure = silent?.ok === false ? silent.reason : undefined;

  if (how.mode !== 'attended' && !validToken(state, resource.href, access)) {
    const message = silentFailure === undefined
      ? `teamai has no valid T3 Code sign-in for ${resource.origin}, and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again.`
      : `teamai has no valid T3 Code sign-in for ${resource.origin} and could not sign in through the t3 command (${silentFailure}), and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again.`;

    return { ok: false, error: { code: 'login_required', message } };
  }

  const signIn = how.mode === 'attended' ? await attendedSignIn({ stateDir: state, resource: resource.href, access, silentFailure, say: (message) => write({ event: 'notice', message }) }) : undefined;

  try {
    const t3 = await connectT3(resource, signIn?.provider ?? unattendedAuth(state, resource.href, access), () => signIn?.code() ?? Promise.reject(new Error('No sign-in.')));
    const signedInAs = signInOf(state, resource.href);

    if (signedInAs === undefined) {
      await t3.close();

      return { ok: false, error: { code: 't3_unavailable', message: `teamai connected to T3 Code at ${resource.origin} but kept no sign-in for it. Start the workflow again.` } };
    }

    return { ok: true, t3, signIn: signedInAs };
  } catch (error) {
    // T3's page grants the access the person picked there, which may be narrower than the run's.
    if (access === 'full-access' && validToken(state, resource.href, 'auto') && !validToken(state, resource.href, access)) {
      return { ok: false, error: { code: 'sign_in_too_narrow', message: 'teamai\'s T3 Code sign-in was approved without Full access, which runtime_mode full-access needs. Start the workflow again and pick Full access in the page T3 Code opens, or remove runtime_mode: full-access.' } };
    }

    const detail = error instanceof Error ? error.message : String(error);

    return { ok: false, error: { code: 't3_unavailable', message: `Could not connect to T3 Code at ${resource.origin} (${detail.replace(/\.$/, '')}). Open T3 Code, or run \`t3 serve\`, then start the workflow again.` } };
  } finally {
    signIn?.close();
  }
};

const startedFrom = process.env['T3CODE_THREAD_ID'];

const status = await serve({
  write,
  journal: journal(state),
  connect,
  canStart,
  t3Home,
  t3UserHome: t3UserHomeOf(t3Home, getUserHome()),
  home: getUserHome(),
  env: process.env,
  settingsLock: path.join(state, 'settings.lock'),
  t3Cli,
  added: addedProjects(path.join(state, 'added-projects.json')),
  cwd: process.cwd(),
  ...(startedFrom && { startedFrom }),
});

process.exit(status);
