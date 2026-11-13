import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { T3_COMMAND } from './host-commands.js';

// ─── T3 Code on this machine: its data directory and its `t3` command ───
//
//  T3 sets T3CODE_CLI_PATH (<T3 home>/bin/t3) and no T3CODE_HOME in its threads, so a run started from a thread finds
//  the T3 home through the command's path. The runtime runs `t3` as the member, for what needs no wider grant than the
//  member already has: a pairing code, adding a project.
//

/** T3 Code's data directory: T3CODE_HOME; else the one that holds T3CODE_CLI_PATH and its server file; else ~/.t3. */
export function t3HomeOf(env: NodeJS.ProcessEnv, userHome: string): string {
  if (env['T3CODE_HOME']) return env['T3CODE_HOME'];
  const cli = env['T3CODE_CLI_PATH'];

  if (cli) {
    const home = path.dirname(path.dirname(cli));

    if (fs.existsSync(path.join(home, 'userdata', 'server-runtime.json'))) return home;
  }

  return path.join(userHome, '.t3');
}

/**
 * The home of the user T3 Code runs as, where an instance with no `homePath` keeps its tool's sessions: T3 keeps its
 * data directory in `~/.t3` there unless T3CODE_HOME moves it. A data directory elsewhere says nothing of that home,
 * which is then taken to be this process's.
 */
export function t3UserHomeOf(t3Home: string, userHome: string): string {
  return path.basename(t3Home) === '.t3' ? path.dirname(t3Home) : userHome;
}

export interface T3Command {
  /**
   * Runs `t3 <args>` and answers its stdout; `args` name the T3 home with `--base-dir`. Throws with the reason in a few
   * words, the last line of the command's stderr included, and never its stdout, which may hold a pairing code.
   * `name` is the subcommand, as the reason says it.
   */
  run(input: { name: string; args: string[]; signal?: AbortSignal }): Promise<string>;
  /** The first `t3` command `run` would try that exists and may be run, without running it; none when there is none. */
  locate(): string | undefined;
}

/** The `t3` command: `$T3CODE_CLI_PATH`, then `t3` on PATH, then `<T3 home>/bin/t3`, the first one there is. */
export function t3Command(env: NodeJS.ProcessEnv, t3Home: string): T3Command {
  const atHome = path.join(t3Home, 'bin', T3_COMMAND);
  const candidates = [...(env['T3CODE_CLI_PATH'] ? [env['T3CODE_CLI_PATH']] : []), T3_COMMAND, atHome];

  const missing = env['T3CODE_CLI_PATH']
    ? `found no t3 command at $T3CODE_CLI_PATH, on PATH, or at ${atHome}`
    : `found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ${atHome}`;

  const runOne = ({ command, name, args, signal }: { command: string; name: string; args: string[]; signal: AbortSignal | undefined }): Promise<{ ran: true; stdout: string } | { ran: false }> => new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', ...(signal && { signal }) }, (error, stdout, stderr) => {
      if (!error) return resolve({ ran: true, stdout });

      if ('code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')) return resolve({ ran: false });
      const said = stderr.trim().split('\n').at(-1)?.slice(0, 200).replace(/\.$/, '');

      reject(new Error(`t3 ${name} exited with status ${String(error.code)}${said ? `: ${said}` : ''}`));
    });
  });

  const runnable = (file: string): boolean => {
    try {
      fs.accessSync(file, fs.constants.X_OK);

      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };

  const onPath = (env['PATH'] ?? '').split(path.delimiter).filter((dir) => dir !== '').map((dir) => path.join(dir, 't3'));

  return {
    locate: () => [...(env['T3CODE_CLI_PATH'] ? [env['T3CODE_CLI_PATH']] : []), ...onPath, atHome].find(runnable),
    async run({ name, args, signal }) {
      for (const command of candidates) {
        const ran = await runOne({ command, name, args, signal });

        if (ran.ran) return ran.stdout;
      }

      throw new Error(missing);
    },
  };
}
