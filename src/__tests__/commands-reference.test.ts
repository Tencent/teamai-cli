import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCommandsReference, COMMANDS_REFERENCE_PATH } from '../commands-reference.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('generated command reference', () => {
  it('matches the CLI command table', async () => {
    // Guard the CLI entry so importing it yields the command table instead of
    // parsing this test run's argv.
    vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
    const { program } = await import('../index.js');

    // Regenerate with `npx vitest run commands-reference -u` when a command,
    // subcommand or flag changes — the skill must not document a CLI that no
    // longer exists.
    await expect(renderCommandsReference(program)).toMatchFileSnapshot(
      path.join(ROOT, COMMANDS_REFERENCE_PATH),
    );
  });
});
