import { spawn } from 'node:child_process';
import { askSocket } from './attempt-socket.js';
import type { Journal } from './journal.js';
import { LAUNCHABLE } from './providers/cli.js';
import { isWithin, realOf } from './providers/native.js';
import { signalChild } from '@teamai/shared/process-group';

// ─── The sandbox wrapper: `teamai-sandbox-<tool>` ────────
//
//  The binary an app (T3 Code, Paseo) runs in place of a tool, so a step that lives in the member's app runs its tool
//  in the attempt's sandbox. It is this executable called by another name (a `bin` per shipped tool, or a link named
//  after a team instance), and knows no provider: the attempt's sandbox runtime grants it the command line.
//
//    teamai-sandbox-<name> --version         the host tool's own version, no attempt, no sandbox
//    teamai-sandbox-<name> <args…>           in an attempt's worktree: ask its socket, then run the grant with <args…>
//    teamai-sandbox-codex app-server         under a Paseo daemon, no agent, no attempt: the host's (its model listing)
//    anything else                           exits 2 and runs nothing
//

/** How the wrapper ended: the tool's exit status or the signal that ended it, or its own refusal (status 2). */
export type WrapperEnd = { code: number } | { signal: NodeJS.Signals };

const REFUSED = 2;

/**
 * Runs `argv` with stdio, exit status and the signals this process gets passed through: to the process it starts, and,
 * through `signalling` (the grant's `signal`), to the tool in the sandbox when that process does not pass them on.
 */
function passThrough({ argv, env, signalling }: { argv: readonly string[]; env: NodeJS.ProcessEnv; signalling?: readonly string[] }): Promise<WrapperEnd> {
  const [command = '', ...rest] = argv;

  return new Promise((resolve) => {
    const child = spawn(command, rest, { env, stdio: 'inherit' });
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    const forward = (received: NodeJS.Signals): void => {
      if (signalling === undefined) {
        signalChild(child, received);

        return;
      }

      const [sender = '', ...senderArgs] = signalling;

      // A signal the tool cannot get yet (it has not started) still ends the client.
      spawn(sender, [...senderArgs, received.replace(/^SIG/, '')], { env, stdio: 'ignore' }).on('error', () => signalChild(child, received)).on('exit', (code) => {
        if (code !== 0) signalChild(child, received);
      });
    };

    for (const each of signals) process.on(each, forward);

    const done = (end: WrapperEnd): void => {
      for (const each of signals) process.off(each, forward);
      resolve(end);
    };

    child.on('error', (error) => {
      process.stderr.write(`teamai-sandbox: ${command} could not be started: ${error.message}\n`);
      done({ code: 127 });
    });
    child.on('exit', (code, signal) => done(signal === null ? { code: code ?? 1 } : { signal }));
  });
}

function refuse(line: string): WrapperEnd {
  process.stderr.write(`${line}\n`);

  return { code: REFUSED };
}

/**
 * Runs `teamai-sandbox-<name> <args>` as the member's app called it, from `cwd` with the app's `env`, which never
 * reaches the tool: a grant's command line runs with the grant's environment alone.
 */
export async function toolExec({ name, args, env, cwd, journal }: { name: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string; journal: Journal }): Promise<WrapperEnd> {
  let known: ReturnType<Journal['instances']>;

  try {
    known = journal.instances();
  } catch (error) {
    return refuse(`teamai-sandbox-${name}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const instance = known[name];
  const shipped = LAUNCHABLE.some((tool) => tool === name);

  if (instance === undefined && !shipped) return refuse(`teamai-sandbox: unknown tool ${name}`);
  const tool = instance?.tool ?? name;
  const command = instance?.command ?? tool;

  // Both apps probe the binary for its version: the host tool's, with nothing of teamai's.
  if (args.length === 1 && args[0] === '--version') return passThrough({ argv: [command, '--version'], env });
  const agent = env.PASEO_AGENT_ID === undefined || env.PASEO_AGENT_ID === '' ? null : env.PASEO_AGENT_ID;
  const at = realOf(env.PASEO_AGENT_CWD ?? cwd);

  let outerPlaces: ReturnType<Journal['outerPlaces']>;

  try {
    outerPlaces = journal.outerPlaces();
  } catch (error) {
    return refuse(`teamai-sandbox-${name}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const attempt = outerPlaces.map((place) => ({ ...place, root: realOf(place.outer.worktree) })).filter(({ root }) => isWithin(at, root)).sort((a, b) => b.root.length - a.root.length)[0];

  if (attempt === undefined) {
    // Paseo lists Codex's models with no agent, outside any step: without it no Codex agent can be made there.
    if (agent === null && tool === 'codex' && args[0] === 'app-server' && env.PASEO_HOME !== undefined && env.PASEO_HOME !== '') return passThrough({ argv: [command, ...args], env });

    return refuse(`teamai-sandbox-${name} runs only inside a teamai attempt; use the plain tool or instance`);
  }

  const answer = await askSocket(attempt.outer.socket, { tool: name, agent, cwd: at });

  if ('unreachable' in answer) {
    return refuse(`teamai-sandbox-${name}: the sandbox runtime of attempt ${attempt.attempt} does not answer on ${attempt.outer.socket} (${answer.unreachable}), so nothing runs. Its teamai run may have stopped: run \`teamai workflow resume ${attempt.run}\`.`);
  }

  if ('refused' in answer) return refuse(`teamai-sandbox-${name} (${answer.refused.code}): ${answer.refused.message}`);

  if ('unsafe' in answer) return refuse(`teamai-sandbox-${name}: the attempt socket is not safe to ask, so nothing runs: ${answer.unsafe}. Remove that directory, and run \`teamai workflow resume ${attempt.run}\`.`);

  if ('unreadable' in answer) return refuse(`teamai-sandbox-${name}: the sandbox runtime of attempt ${attempt.attempt} answered what this wrapper cannot read (${answer.unreadable}), so nothing runs. Install the same teamai-cli version as the run's.`);

  if ('connected' in answer) return refuse(`teamai-sandbox-${name}: the attempt socket answered an ask as a registration, so nothing runs.`);

  if ('grant' in answer) return passThrough({ argv: [...answer.grant.argv, ...args], env: answer.grant.env, signalling: answer.grant.signal });
  const unhandled: never = answer;

  return unhandled;
}
