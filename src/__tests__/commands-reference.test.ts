import { afterEach, describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCommandsReference, COMMANDS_REFERENCE_PATH } from '../commands-reference.js';
import { loadCommandTable } from './helpers/command-table.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generated command reference', () => {
  it('matches the CLI command table', async () => {
    const program = await loadCommandTable();

    // Regenerate with `npx vitest run commands-reference -u` when a command,
    // subcommand or flag changes — the skill must not document a CLI that no
    // longer exists.
    await expect(renderCommandsReference(program)).toMatchFileSnapshot(
      path.join(ROOT, COMMANDS_REFERENCE_PATH),
    );
  });
});
