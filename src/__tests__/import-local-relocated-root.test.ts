import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('teamai import scan-rules with a relocated Claude Code root', () => {
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

  it('scans the rules under the recorded toolRoots.claude, not ~/.claude, beside the other tools\' rules', async () => {
    await fse.outputFile(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: path.join(home, '.teamai', 'team-repo'), remote: 'https://example.test/t/r.git' },
      username: 'u',
      scope: 'user',
      additionalRoles: [],
      toolRoots: { claude: path.join(home, '.claude-work') },
    }));
    await fse.outputFile(path.join(home, '.claude-work', 'rules', 'relocated.md'), '# relocated rule');
    await fse.outputFile(path.join(home, '.claude', 'rules', 'stale.md'), '# stale rule');

    await fse.outputFile(path.join(home, '.codebuddy', 'rules', 'retry.md'), '# retry');

    const { ImportLearnings } = await import('../import-local.js');
    const found = (await ImportLearnings.scanRules()).candidates.map((candidate) => candidate.path);

    expect(found).toContain(path.join(home, '.claude-work', 'rules', 'relocated.md'));
    expect(found).not.toContain(path.join(home, '.claude', 'rules', 'stale.md'));
    expect(found).toContain(path.join(home, '.codebuddy', 'rules', 'retry.md'));
  });
});
