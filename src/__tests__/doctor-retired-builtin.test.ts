import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('@teamai/shared/log', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

import { retiredBuiltinOverrideNotes } from '../doctor-delivery.js';
import type { DoctorContext } from '../doctor.js';

/** The TodoWrite hint has no entry of its own since #1788, so a timeout the team sets for that entry has nothing to apply to. */
describe('doctor — a builtin override for the retired TodoWrite entry', () => {
  let repoPath: string;

  const ctx = (): DoctorContext => ({
    localConfig: { repo: { localPath: repoPath, remote: 'owner/repo' }, username: 't', scope: 'user', additionalRoles: [] },
    teamConfig: null, toolPaths: {}, hookToolPaths: {}, baseDir: repoPath,
  });

  const hooksYaml = (text: string) => fse.outputFile(path.join(repoPath, 'hooks', 'hooks.yaml'), text);

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-doctor-retired-builtin-'));
  });

  afterEach(async () => {
    await fse.remove(repoPath);
  });

  // A note, not a check: the override does nothing, so it must not turn a team's `teamai doctor` red.
  it('notes the timeout is ignored and where the hint runs now', async () => {
    await hooksYaml('builtin:\n  overrides:\n    Hook dispatch post-tool-use TodoWrite: { timeout: 5 }\n');

    expect(await retiredBuiltinOverrideNotes(ctx())).toEqual([
      'hooks/hooks.yaml sets a timeout under `builtin.overrides` for `Hook dispatch post-tool-use TodoWrite`, an entry teamai no longer installs: '
      + 'the TodoWrite hint runs in `Hook dispatch post-tool-use wildcard`, so this timeout is ignored. '
      + 'Remove it from hooks/hooks.yaml; a timeout for `Hook dispatch post-tool-use wildcard` applies to every tool call.',
    ]);
  });

  it.each([
    ['no hooks file', null],
    ['a timeout for a current built-in', 'builtin:\n  overrides:\n    Hook dispatch stop: { timeout: 99 }\n'],
    // Disabling the retired key still turns the hint off, so it is no mistake to report.
    ['the retired key under builtin.disabled', 'builtin:\n  disabled: [Hook dispatch post-tool-use TodoWrite]\n'],
  ])('adds no note for %s', async (_case, text) => {
    if (text !== null) await hooksYaml(text);

    expect(await retiredBuiltinOverrideNotes(ctx())).toEqual([]);
  });
});
