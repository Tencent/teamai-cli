import type { Command } from 'commander';
import { vi } from 'vitest';

/**
 * The CLI's command table, loaded from the entry without running the CLI
 * (TEAMAI_COMMAND_TABLE_ONLY). Fails with the reason when the entry yields no
 * table, instead of letting the caller hit a TypeError on `undefined`.
 */
export async function loadCommandTable(): Promise<Command> {
  vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
  const entry: { program?: Command } = await import('../../index.js');
  const { program } = entry;
  if (!program || !Array.isArray(program.commands)) {
    throw new Error(
      `The CLI entry loaded without its command table (exports: ${JSON.stringify(Object.keys(entry))}). ` +
        'The import must resolve to src/index.ts; a src/index.js left by a test shadows it.',
    );
  }
  return program;
}
