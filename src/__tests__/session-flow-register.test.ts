import { describe, expect, it } from 'vitest';
import { shouldRegisterSessionFlowCommands } from '../session-flow/register-gate.js';

describe('shouldRegisterSessionFlowCommands', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('registers for a bare session command', () => {
    expect(shouldRegisterSessionFlowCommands(['node', 'teamai', 'session', 'migrate'], env)).toBe(true);
  });

  it('registers when a global option precedes session', () => {
    expect(
      shouldRegisterSessionFlowCommands(['node', 'teamai', '--dry-run', 'session', 'migrate'], env),
    ).toBe(true);
    expect(shouldRegisterSessionFlowCommands(['node', 'teamai', '-v', 'session', 'push'], env)).toBe(true);
    expect(shouldRegisterSessionFlowCommands(['node', 'teamai', 'help', 'session'], env)).toBe(true);
  });

  it('skips unrelated commands', () => {
    expect(shouldRegisterSessionFlowCommands(['node', 'teamai', 'digest'], env)).toBe(false);
    expect(shouldRegisterSessionFlowCommands(['node', 'teamai', 'push'], env)).toBe(false);
  });

  it('registers when only the command table is being read', () => {
    expect(
      shouldRegisterSessionFlowCommands(['node', 'vitest'], {
        TEAMAI_COMMAND_TABLE_ONLY: '1',
      }),
    ).toBe(true);
  });
});
