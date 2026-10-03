import { describe, it, expect, vi } from 'vitest';
import type { Command } from 'commander';
import { DRY_RUN_PREVIEW, NO_DRY_RUN_PREVIEW } from '../dry-run-guard.js';

/**
 * Every command path that runs an action. A group without its own action
 * (`hooks`, `mcp`, ...) only prints help, so it never reaches the guard.
 * Commander keeps the action private, so the walk reads `_actionHandler`.
 */
function runnablePaths(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap((sub) => {
    const path = [...prefix, sub.name()];
    const own = (sub as unknown as { _actionHandler: unknown })._actionHandler ? [path.join(' ')] : [];
    return [...own, ...runnablePaths(sub, path)];
  });
}

async function commandTable(): Promise<Command> {
  vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
  return (await import('../index.js')).program;
}

describe('--dry-run guard classification', () => {
  it('classifies every command: a new command must say whether it previews --dry-run', async () => {
    const unclassified = runnablePaths(await commandTable())
      .filter((path) => !DRY_RUN_PREVIEW.has(path) && !(path in NO_DRY_RUN_PREVIEW));
    // Add the path to DRY_RUN_PREVIEW when its action honors --dry-run or only
    // reads; otherwise to NO_DRY_RUN_PREVIEW, which refuses it (#900).
    expect(unclassified).toEqual([]);
  });

  it('lists no command twice and none that no longer exists', async () => {
    const paths = new Set(runnablePaths(await commandTable()));
    const refused = Object.keys(NO_DRY_RUN_PREVIEW);
    expect(refused.filter((path) => DRY_RUN_PREVIEW.has(path))).toEqual([]);
    expect([...DRY_RUN_PREVIEW, ...refused].filter((path) => !paths.has(path))).toEqual([]);
  });
});
