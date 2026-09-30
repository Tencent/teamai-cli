import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

// #808: git and self mode share the partition's queue, so a re-init that
// switches the install's kind must not hand the old install's learnings to the
// new one's repository.

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

const { listPendingForInstall, queueLockPath, savePendingLearning, setAsideQueueOnModeSwitch } = await import('../utils/pending-learnings.js');
const { acquireLock, releaseLock } = await import('../update.js');
const { log } = await import('../utils/logger.js');

const noSave = async (): Promise<void> => {};
function switched(result: Awaited<ReturnType<typeof setAsideQueueOnModeSwitch>>): { aside: string | null } {
  if (result.status !== 'switched') throw new Error(`queue lock busy: ${result.lockPath}`);
  return result;
}

describe('setAsideQueueOnModeSwitch (#808)', () => {
  let partition: string;
  let project: string;

  beforeEach(() => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mode-switch-')));
    partition = path.join(root, 'partition');
    project = path.join(root, 'project');
    fs.mkdirSync(partition, { recursive: true });
    fs.mkdirSync(path.join(root, 'home'));
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.mocked(log.warn).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(path.dirname(partition), { recursive: true, force: true });
  });

  const selfConfig = () => ({
    repo: { localPath: path.join(project, '.teamai'), remote: 'https://git.example.com/me/project.git', kind: 'self' as const, businessRepoRoot: project },
    username: 'u',
    scope: 'project' as const,
    projectRoot: project,
    dataHome: partition,
    additionalRoles: [],
  });
  const gitConfig = () => ({
    repo: { localPath: path.join(partition, 'team-repo'), remote: 'https://git.example.com/team/repo.git', kind: 'git' as const },
    username: 'u',
    scope: 'project' as const,
    projectRoot: project,
    additionalRoles: [],
  });
  const queue = () => path.join(partition, 'pending-learnings');
  /** The git install as detection loads it from the partition, and its config file there. */
  const detectedGit = () => ({ ...gitConfig(), dataHome: partition });
  const writeConfig = (config: { repo: object; username: string; scope: string }) =>
    fs.writeFileSync(path.join(partition, 'config.yaml'), YAML.stringify({ repo: config.repo, username: config.username, scope: config.scope }));

  it('keeps a learning queued with the old config out of the new install\'s queue (#823 item 11)', async () => {
    writeConfig(gitConfig());
    fs.mkdirSync(queue(), { recursive: true });
    fs.writeFileSync(path.join(queue(), 'mine-2026-01-01-aaaaaa.md'), '# mine\n');

    // A contribute that loaded the git config queues while init saves the self one.
    let late: { result: ReturnType<typeof savePendingLearning> } | undefined;
    switched(await setAsideQueueOnModeSwitch(detectedGit(), selfConfig(), async () => {
      const result = savePendingLearning(detectedGit(), 'late-2026-01-01-bbbbbb.md', '# late\n');
      await Promise.race([result, new Promise((resolve) => setTimeout(resolve, 300))]);
      late = { result };
      writeConfig(selfConfig());
    }));

    const result = await late?.result;
    expect(fs.existsSync(path.join(queue(), 'late-2026-01-01-bbbbbb.md'))).toBe(false);
    expect(fs.existsSync(path.join(partition, 'pending-learnings.git', 'mine-2026-01-01-aaaaaa.md'))).toBe(true);
    expect(result?.status).toBe('changed');
  });

  it('saves nothing while another command holds the queue lock (#823 item 11)', async () => {
    writeConfig(gitConfig());
    const lock = await queueLockPath(partition);
    expect(await acquireLock(lock)).toBe(true);
    let result;
    try {
      result = await savePendingLearning(detectedGit(), 'held-2026-01-01-cccccc.md', '# held\n');
    } finally {
      await releaseLock(lock);
    }
    expect(fs.existsSync(path.join(queue(), 'held-2026-01-01-cccccc.md'))).toBe(false);
    expect(result).toEqual({ status: 'busy', lockPath: lock });
  });

  it('moves a self install\'s queue aside when init switches it to git mode', async () => {
    fs.mkdirSync(path.join(queue(), 'ns'), { recursive: true });
    fs.writeFileSync(path.join(queue(), 'ns', 'mine-2026-01-01-aaaaaa.md'), '# mine\n');

    const { aside } = switched(await setAsideQueueOnModeSwitch(selfConfig(), gitConfig(), noSave));

    expect(aside).toBe(path.join(partition, 'pending-learnings.self'));
    expect(fs.readFileSync(path.join(partition, 'pending-learnings.self', 'ns', 'mine-2026-01-01-aaaaaa.md'), 'utf8')).toBe('# mine\n');
    expect(fs.existsSync(queue())).toBe(false);
    expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).toContain('Set aside 1 queued learning(s) from the previous self install');
  });

  it('never overwrites an earlier set-aside queue', async () => {
    fs.mkdirSync(path.join(partition, 'pending-learnings.self'), { recursive: true });
    fs.writeFileSync(path.join(partition, 'pending-learnings.self', 'older-2026-01-01-bbbbbb.md'), '# older\n');
    fs.mkdirSync(queue(), { recursive: true });
    fs.writeFileSync(path.join(queue(), 'newer-2026-01-01-cccccc.md'), '# newer\n');

    const { aside } = switched(await setAsideQueueOnModeSwitch(selfConfig(), gitConfig(), noSave));

    expect(aside).toBe(path.join(partition, 'pending-learnings.self.1'));
    expect(fs.existsSync(path.join(partition, 'pending-learnings.self', 'older-2026-01-01-bbbbbb.md'))).toBe(true);
  });

  it('leaves the queue alone when the kind does not change, or nothing is queued', async () => {
    fs.mkdirSync(queue(), { recursive: true });
    fs.writeFileSync(path.join(queue(), 'mine-2026-01-01-aaaaaa.md'), '# mine\n');
    expect(switched(await setAsideQueueOnModeSwitch(gitConfig(), gitConfig(), noSave)).aside).toBeNull();
    expect(switched(await setAsideQueueOnModeSwitch(null, gitConfig(), noSave)).aside).toBeNull();
    fs.rmSync(path.join(queue(), 'mine-2026-01-01-aaaaaa.md'));
    expect(switched(await setAsideQueueOnModeSwitch(selfConfig(), gitConfig(), noSave)).aside).toBeNull();
    expect(fs.existsSync(queue())).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('moves the queue aside under an unknown owner when the previous config exists but cannot be read', async () => {
    fs.writeFileSync(path.join(partition, 'config.yaml'), 'repo: [not a config\n');
    fs.mkdirSync(queue(), { recursive: true });
    fs.writeFileSync(path.join(queue(), 'mine-2026-01-01-aaaaaa.md'), '# mine\n');

    const { aside } = switched(await setAsideQueueOnModeSwitch(null, detectedGit(), noSave));

    expect(aside).toBe(path.join(partition, 'pending-learnings.unknown'));
    expect(fs.readFileSync(path.join(partition, 'pending-learnings.unknown', 'mine-2026-01-01-aaaaaa.md'), 'utf8')).toBe('# mine\n');
    expect(fs.existsSync(queue())).toBe(false);
    expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).toContain(path.join(partition, 'config.yaml'));
  });

  // #823 item 13: a queue belongs to its kind and its team repository.
  const otherTeam = () => ({ ...gitConfig(), repo: { ...gitConfig().repo, remote: 'https://git.example.com/other/team.git' } });
  const sameTeamOtherForm = () => ({ ...gitConfig(), repo: { ...gitConfig().repo, remote: 'git@git.example.com:Team/repo/' } });

  it("moves a git install's queue aside when init points it at another team repo (#823 item 13)", async () => {
    fs.mkdirSync(queue(), { recursive: true });
    fs.writeFileSync(path.join(queue(), 'mine-2026-01-01-aaaaaa.md'), '# mine\n');

    const { aside } = switched(await setAsideQueueOnModeSwitch(gitConfig(), otherTeam(), noSave));

    expect(aside).toBe(path.join(partition, 'pending-learnings.git-git.example.com-team-repo'));
    expect(fs.readFileSync(path.join(aside ?? '', 'mine-2026-01-01-aaaaaa.md'), 'utf8')).toBe('# mine\n');
    expect(fs.existsSync(queue())).toBe(false);
    const warned = vi.mocked(log.warn).mock.calls.flat().join('\n');
    expect(warned).toContain('Set aside 1 queued learning(s) from the previous git install');
    expect(warned).toContain('https://git.example.com/team/repo.git');
  });

  it('leaves the queue alone when init names the same team repo in another form (#823 item 13)', async () => {
    fs.mkdirSync(queue(), { recursive: true });
    fs.writeFileSync(path.join(queue(), 'mine-2026-01-01-aaaaaa.md'), '# mine\n');

    expect(switched(await setAsideQueueOnModeSwitch(gitConfig(), sameTeamOtherForm(), noSave)).aside).toBeNull();

    expect(fs.existsSync(path.join(queue(), 'mine-2026-01-01-aaaaaa.md'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    // A writer that loaded one form finds the other on disk and still saves.
    writeConfig(sameTeamOtherForm());
    expect((await savePendingLearning(detectedGit(), 'form-2026-01-01-dddddd.md', '# form\n')).status).toBe('saved');
  });

  it('saves and lists nothing for an install init pointed at another team repo meanwhile (#823 item 13)', async () => {
    fs.mkdirSync(queue(), { recursive: true });
    fs.writeFileSync(path.join(queue(), 'theirs-2026-01-01-eeeeee.md'), '# theirs\n');
    writeConfig(otherTeam());

    const write = await savePendingLearning(detectedGit(), 'late-2026-01-01-ffffff.md', '# late\n');
    const listed = await listPendingForInstall(detectedGit());

    expect(fs.existsSync(path.join(queue(), 'late-2026-01-01-ffffff.md'))).toBe(false);
    expect(write).toMatchObject({ status: 'changed', configPath: path.join(partition, 'config.yaml') });
    expect(write.status === 'changed' ? write.cause : '').toBe(
      'now names https://git.example.com/other/team.git, not https://git.example.com/team/repo.git',
    );
    expect(listed.status).toBe('changed');
  });
});
