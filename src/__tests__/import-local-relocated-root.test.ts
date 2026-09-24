import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('import --from-claude with a relocated Claude Code root', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-import-root-'));
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fse.remove(home);
  });

  it('scans the rules under the recorded toolRoots.claude, not ~/.claude', async () => {
    await fse.outputFile(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: path.join(home, '.teamai', 'team-repo'), remote: 'https://example.test/t/r.git' },
      username: 'u',
      scope: 'user',
      additionalRoles: [],
      toolRoots: { claude: path.join(home, '.claude-work') },
    }));
    await fse.outputFile(path.join(home, '.claude-work', 'rules', 'relocated.md'), '# relocated rule');
    await fse.outputFile(path.join(home, '.claude', 'rules', 'stale.md'), '# stale rule');

    const { scanCandidates } = await import('../import-local.js');
    const found = (await scanCandidates({ fromClaude: true })).map((c) => c.path);

    expect(found).toContain(path.join(home, '.claude-work', 'rules', 'relocated.md'));
    expect(found).not.toContain(path.join(home, '.claude', 'rules', 'stale.md'));
  });
});
