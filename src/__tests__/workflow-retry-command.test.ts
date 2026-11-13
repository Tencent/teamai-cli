import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { retryCommand } from '../workflow/runtimes/retry-command.js';

/** The words a POSIX shell splits `command` into, globbing included, as a person who pastes it runs it. */
function wordsOf(command: string): string[] {
  const shell = spawnSync('sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8' });

  return shell.stdout.split('\n').slice(0, -1);
}

it.each(['build', 'items[0].ask', 'items[1].ask me', "the user's step"])('gives a retry command of step %s that a shell runs as written', (step) => {
  expect(wordsOf(retryCommand({ run: 'run-1', step }))).toEqual(['teamai', 'workflow', 'retry', 'run-1', step]);
});
