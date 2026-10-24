import { describe, it, expect } from 'vitest';
import { COPILOT_RUNS_ENTRIES_SOURCE, copilotRunsEntries } from '../claude-hook-host.js';

// The shell guard runs COPILOT_RUNS_ENTRIES_SOURCE; the CLI runs copilotRunsEntries.
const guardRuns = new Function(`return ${COPILOT_RUNS_ENTRIES_SOURCE};`)() as (data: unknown) => unknown;

const hook = (fields: Record<string, unknown>) => ({ type: 'command', ...fields });

const FILES: Array<[string, unknown]> = [
  ['null', null],
  ['a non-object', 'hooks'],
  ['version 2', { version: 2, hooks: { sessionStart: [hook({ bash: 'a' })] } }],
  ['a version string', { version: '1', hooks: { sessionStart: [hook({ bash: 'a' })] } }],
  ['disableAllHooks', { version: 1, disableAllHooks: true, hooks: { sessionStart: [hook({ bash: 'a' })] } }],
  ['no hooks', { version: 1 }],
  ['hooks that are not an object', { version: 1, hooks: 'a' }],
  ['an event that is not an array', { version: 1, hooks: { sessionStart: { bash: 'a' } } }],
  ['a hook that is not a command', { version: 1, hooks: { sessionStart: [{ type: 'prompt', bash: 'a' }] } }],
  ['a null hook', { version: 1, hooks: { sessionStart: [null, hook({ bash: 'a' })] } }],
  ['every command field', { version: 1, hooks: { preToolUse: [hook({ bash: 'b', powershell: 'p', command: 'c', matcher: 'Bash' })] } }],
  ['a non-string command', { version: 1, hooks: { sessionStart: [hook({ bash: 1, command: 'c' })] } }],
  ['several events', {
    version: 1,
    hooks: { sessionStart: [hook({ bash: 'a' })], stop: [hook({ command: 'b', matcher: '*' }), hook({ powershell: 'c' })] },
  }],
];

describe('COPILOT_RUNS_ENTRIES_SOURCE', () => {
  it.each(FILES)('reads %s as copilotRunsEntries does', (_name, file) => {
    expect(guardRuns(file)).toEqual(copilotRunsEntries(file));
  });
});
