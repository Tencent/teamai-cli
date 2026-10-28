import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const autoDetectInit = vi.fn();
const findUnreadableProjectConfig = vi.fn();
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit,
  findUnreadableProjectConfig,
}));

// `skill list` prints the team listing first; it is not under test here.
vi.mock('../status.js', () => ({ list: vi.fn() }));

import { BLOCK_NOTES, blockMessage, blockNote, resolveServableSkill, skillCatalog, skillGet, skillPath } from '../skill-content.js';
import { skillList } from '../skill-cmd.js';

/**
 * Recall used to be decided when deploying: the share skill simply was not
 * copied into the agent. One deployed stub routes to every workflow, so the
 * decision moved to the moment the agent asks for the content (#678).
 */
describe('recall gate on served skills', () => {
  let stderr: string;
  let stdout: string;
  const restore: Array<() => void> = [];

  beforeEach(() => {
    stderr = '';
    stdout = '';
    process.exitCode = undefined;
    autoDetectInit.mockReset();
    findUnreadableProjectConfig.mockReset();
    findUnreadableProjectConfig.mockResolvedValue(null);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout += args.join(' ') + '\n';
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.join(' ') + '\n';
    });
    restore.push(() => writeSpy.mockRestore(), () => logSpy.mockRestore(), () => errorSpy.mockRestore());
  });

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
    process.exitCode = undefined;
  });

  const withRecall = (enabled: boolean): void => {
    autoDetectInit.mockResolvedValue({
      localConfig: { recallEnabled: enabled },
      teamConfig: { sharing: { recall: { enabled } } },
    });
  };

  it('blocks share when recall is disabled, and says what to turn on', async () => {
    withRecall(false);

    expect(await resolveServableSkill('share')).toEqual({ kind: 'blocked', name: 'share', reason: 'recall' });
    // Aliases land on the same gate: the name in the refusal is the canonical one.
    expect(await resolveServableSkill('teamai-share-learnings')).toMatchObject({ kind: 'blocked', name: 'share' });

    await skillGet(['share']);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('share needs recall');
    expect(stderr).toContain('teamai recall enable');
  });

  it('blocks share when TEAMAI_RECALL_DISABLED=1, even with recall on (#1457)', async () => {
    withRecall(true);
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '1');
    try {
      expect(await resolveServableSkill('share')).toEqual({ kind: 'blocked', name: 'share', reason: 'recall' });

      // `teamai recall enable` would succeed and leave share blocked, so the
      // refusal names the variable instead of sending the member there.
      await skillGet(['share']);
      expect(process.exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('share needs recall, which TEAMAI_RECALL_DISABLED=1 turns off');
      expect(stderr).toContain('Unset TEAMAI_RECALL_DISABLED');
      expect(stderr).not.toContain('Turn it on with');
      expect(stderr).not.toContain('disabled for this team');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names TEAMAI_RECALL_DISABLED when --all skips share because of it (#1457)', async () => {
    withRecall(true);
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '1');
    try {
      await skillGet([], { all: true });
      expect(process.exitCode).toBeUndefined();
      expect(stdout).not.toContain('name: share');
      expect(stderr).toContain('Skipped share');
      expect(stderr).toContain('Unset TEAMAI_RECALL_DISABLED');
      expect(stderr).not.toContain('Turn it on with');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the recall-enable hint when the variable is not what turns recall off (#1457)', () => {
    const configOff = {
      headline: 'share needs recall, which is disabled for this team.',
      hint: 'Turn it on with `teamai recall enable`, or ask your team admin to enable sharing.',
    };
    for (const env of [{}, { TEAMAI_RECALL_DISABLED: '0' }, { TEAMAI_RECALL_DISABLED: '' }, { TEAMAI_RECALL_DISABLED: 'true' }] as NodeJS.ProcessEnv[]) {
      expect(blockMessage('share', { reason: 'recall' }, env)).toEqual(configOff);
    }
    const envOff = blockMessage('share', { reason: 'recall' }, { TEAMAI_RECALL_DISABLED: '1' });
    expect(envOff.headline).toContain('TEAMAI_RECALL_DISABLED=1');
    expect(envOff.hint).toContain('Unset TEAMAI_RECALL_DISABLED');
    // The other reasons never mention the variable, even while it is set.
    expect(blockMessage('share', { reason: 'read-only' }, { TEAMAI_RECALL_DISABLED: '1' }).hint).not.toContain('TEAMAI_RECALL_DISABLED');
  });

  it('names TEAMAI_RECALL_DISABLED in the skill list note only when it is the cause (#1457)', () => {
    for (const env of [{}, { TEAMAI_RECALL_DISABLED: '0' }, { TEAMAI_RECALL_DISABLED: 'true' }] as NodeJS.ProcessEnv[]) {
      expect(blockNote('recall', env)).toBe(BLOCK_NOTES.recall);
    }
    expect(blockNote('recall', { TEAMAI_RECALL_DISABLED: '1' })).toBe('needs recall — unset TEAMAI_RECALL_DISABLED');
    expect(blockNote('read-only', { TEAMAI_RECALL_DISABLED: '1' })).toBe(BLOCK_NOTES['read-only']);
  });

  it('tells the member to unset TEAMAI_RECALL_DISABLED in skill list when it blocks share (#1457)', async () => {
    withRecall(true);
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '1');
    try {
      await skillList({});
    } finally {
      vi.unstubAllEnvs();
    }
    expect(stdout).toContain('share  (needs recall — unset TEAMAI_RECALL_DISABLED)');
    expect(stdout).not.toContain('teamai recall enable');
  });

  it('serves share when recall is enabled', async () => {
    withRecall(true);

    expect(await resolveServableSkill('share')).toMatchObject({ kind: 'found', skill: { name: 'share' } });

    await skillGet(['share']);
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toContain('name: share');
  });

  it('leaves share out of --all when recall is disabled, and says so on stderr', async () => {
    withRecall(false);

    await skillGet([], { all: true });
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toContain('name: core');
    expect(stdout).toContain('name: wiki');
    expect(stdout).not.toContain('name: share');
    expect(stderr).toContain('Skipped share');
    expect(stderr).toContain('teamai recall enable');
  });

  it('withholds the share directory from skill path and the catalog when recall is disabled', async () => {
    withRecall(false);

    await skillPath('share');
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('share needs recall');

    const share = (await skillCatalog()).find((entry) => entry.name === 'share');
    expect(share).toMatchObject({ blockedBy: 'recall', path: null });
  });

  it('serves the share directory through skill path and the catalog when recall is enabled', async () => {
    withRecall(true);

    await skillPath('share');
    expect(process.exitCode).toBeUndefined();
    expect(stdout.trim()).toMatch(/skill-data[\\/]share$/);

    const share = (await skillCatalog()).find((entry) => entry.name === 'share');
    expect(share).toMatchObject({ blockedBy: null, path: stdout.trim() });
  });

  it('withholds share from a read-only HTTP team, whose `teamai contribute` always refuses', async () => {
    // Recall on, so only the source decides: the workflow's last step would fail
    // after the agent had written the whole learning.
    autoDetectInit.mockResolvedValue({
      localConfig: { recallEnabled: true, repo: { kind: 'http', localPath: '/tmp', remote: '' } },
      teamConfig: { sharing: { recall: { enabled: true } } },
    });

    expect(await resolveServableSkill('share')).toEqual({ kind: 'blocked', name: 'share', reason: 'read-only' });
    await skillGet(['share']);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('read-only HTTP source');
    expect(stderr).not.toContain('teamai recall enable');
    expect((await skillCatalog()).find((entry) => entry.name === 'share')).toMatchObject({ blockedBy: 'read-only', path: null });
  });

  it('keeps a config-migration line off stdout, so the content and the JSON stay exact', async () => {
    // Loading an upgraded config can migrate it and say so with log.info.
    autoDetectInit.mockImplementation(async () => {
      const { log } = await import('../utils/logger.js');
      log.info('Migrated legacy teamai config to default role profile: hai');
      return { localConfig: { recallEnabled: true }, teamConfig: { sharing: { recall: { enabled: true } } } };
    });

    await skillGet(['share']);
    expect(stdout.startsWith('---\nname: share')).toBe(true);
    expect(stdout).not.toContain('Migrated legacy');
    expect(stderr).toContain('Migrated legacy');

    stdout = '';
    await skillList({ json: true });
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('never gates the skills that do not depend on recall', async () => {
    withRecall(false);

    for (const name of ['core', 'setup', 'wiki']) {
      expect((await resolveServableSkill(name)).kind, name).toBe('found');
    }
  });

  it('fails open when there is no team config to consult', async () => {
    const { NotInitializedError } = await import('../config.js');
    autoDetectInit.mockRejectedValue(new NotInitializedError('teamai is not initialized. Run `teamai init` first.'));

    // A fresh machine reading the docs gets the content, not a refusal it
    // cannot act on.
    expect((await resolveServableSkill('share')).kind).toBe('found');
  });

  it('blocks share when a config exists but cannot be loaded, since recall and the source are then unknown', async () => {
    autoDetectInit.mockRejectedValue(new Error('Team config (teamai.yaml) not found. Check your repo path.'));

    expect(await resolveServableSkill('share')).toEqual({
      kind: 'blocked', name: 'share', reason: 'config',
      detail: 'Team config (teamai.yaml) not found. Check your repo path.',
    });
    await skillGet(['share']);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('config on this machine could not be loaded');
    // The refusal names what failed: `teamai doctor` cannot see a broken config.
    expect(stderr).toContain('Team config (teamai.yaml) not found. Check your repo path.');
    expect(stderr).not.toContain('teamai doctor');
    expect((await skillCatalog()).find((entry) => entry.name === 'share')).toMatchObject({ blockedBy: 'config', path: null });
    // Only share depends on the config; the rest is still served.
    expect((await resolveServableSkill('core')).kind).toBe('found');
  });

  it('blocks share when the project config is unreadable, instead of answering with the user config', async () => {
    // Detection skips the broken project config; the user config it falls back
    // to belongs to another team, with its own recall and source.
    findUnreadableProjectConfig.mockResolvedValue('/work/proj/.teamai/config.yaml: bad indentation');
    withRecall(true);

    expect(await resolveServableSkill('share')).toEqual({
      kind: 'blocked', name: 'share', reason: 'config',
      detail: '/work/proj/.teamai/config.yaml: bad indentation. '
        + 'Fix the file, or move it aside and run `teamai init` to write a new one.',
    });
    expect(autoDetectInit).not.toHaveBeenCalled();

    await skillGet(['share']);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('/work/proj/.teamai/config.yaml: bad indentation');
    expect(stderr).toContain('move it aside');
  });

  it('keeps only the first line of a multi-line parse error, which names the file and the position', async () => {
    // YAML errors end in a code frame and a newline; appended as-is, the
    // advice would start a line of its own with a stray ". ".
    findUnreadableProjectConfig.mockResolvedValue(
      '/work/proj/.teamai/config.yaml: Unexpected flow-seq-end at line 1, column 7:\n\nrepo: [unclosed\n      ^\n',
    );

    expect(await resolveServableSkill('share')).toMatchObject({
      reason: 'config',
      detail: '/work/proj/.teamai/config.yaml: Unexpected flow-seq-end at line 1, column 7. '
        + 'Fix the file, or move it aside and run `teamai init` to write a new one.',
    });
  });

  it('lets a fault in the gate itself propagate instead of reporting it as a broken config', async () => {
    // Only loading the config means "cannot be loaded"; anything else would
    // print "the teamai config could not be loaded" over an unrelated bug.
    const fault = new TypeError('a bug past the config load');
    autoDetectInit.mockResolvedValue({
      localConfig: { get repo(): never { throw fault; } },
      teamConfig: { sharing: { recall: { enabled: true } } },
    });

    await expect(resolveServableSkill('share')).rejects.toBe(fault);
  });
});
