import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrWithFallback } from '../push.js';
import { getDefaultBranch } from '../utils/git.js';
import { log } from '../utils/logger.js';

const { fail, succeed } = vi.hoisted(() => ({ fail: vi.fn(), succeed: vi.fn() }));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
}));

vi.mock('@teamai/shared/log', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnValue({ fail, succeed }) })),
}));

const REMOTE = 'https://private-code.example.test/team/project.git';
const BRANCH = 'teamai/push/member/review';
const UNSUPPORTED_PR = 'Failed to create PR: Automatic pull/merge request creation is not supported for generic Git hosts.';
const localConfig = { repo: { remote: REMOTE, localPath: '/tmp/unused-teamai-guidance-repo' } };

describe('GitLab guidance after generic Git PR creation fails', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GITLAB_URL', '');
    vi.stubEnv('TEAMAI_GITLAB_HOST', '');
    vi.stubEnv('GITLAB_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('diagnoses the valid remote used when a nonempty team repo input cannot be parsed', async () => {
    const teamConfig = { repo: 'team/project', provider: 'git' };
    const originalConfig = structuredClone(teamConfig);
    fetchMock.mockResolvedValue(new Response(null, {
      status: 200,
      headers: { 'x-gitlab-meta': '{"correlation_id":"guidance-test","version":"1"}' },
    }));

    await expect(createPrWithFallback(teamConfig, localConfig, BRANCH, 'Title', 'Body')).resolves.toBeNull();

    expect(getDefaultBranch).toHaveBeenCalledWith(localConfig.repo.localPath);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://private-code.example.test/users/sign_in?auto_sign_in=false',
      expect.objectContaining({ credentials: 'omit', redirect: 'manual' }),
    );
    expect(fail).toHaveBeenCalledWith(UNSUPPORTED_PR);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Change it to provider: gitlab'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('set GITLAB_URL to https://private-code.example.test'));
    expect(teamConfig).toEqual(originalConfig);
    expect(process.env.GITLAB_URL).toBe('');
  });

  it('uses an explicitly configured GitLab host to explain a saved git provider without network probing', async () => {
    vi.stubEnv('GITLAB_URL', 'https://private-code.example.test');
    const teamConfig = { repo: REMOTE, provider: 'git' };
    const originalConfig = structuredClone(teamConfig);

    await expect(createPrWithFallback(teamConfig, localConfig, BRANCH, 'Title', 'Body')).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(UNSUPPORTED_PR);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('teamai.yaml has provider: git. Change it to provider: gitlab'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('configure GITLAB_TOKEN with api scope'));
    expect(succeed).not.toHaveBeenCalled();
    expect(teamConfig).toEqual(originalConfig);
    expect(process.env.GITLAB_URL).toBe('https://private-code.example.test');
  });

  // #789: the member chose plain git with `init --provider git`; the team's
  // teamai.yaml still says gitlab and must not be used for the PR step.
  it('uses the member\'s git provider over the team\'s gitlab and asks for no token', async () => {
    vi.stubEnv('GITLAB_URL', 'https://private-code.example.test');
    const teamConfig = { repo: REMOTE, provider: 'gitlab' };
    const memberConfig = { ...localConfig, provider: 'git' };

    await expect(createPrWithFallback(teamConfig, memberConfig, BRANCH, 'Title', 'Body')).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(UNSUPPORTED_PR);
    expect(log.info).toHaveBeenCalledWith(`Branch ${BRANCH} has been pushed. You can create a PR manually.`);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('teamai init --provider git'));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('GITLAB_TOKEN'));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Change it to provider: gitlab'));
  });

  it('preserves the original failure and manual PR guidance when an unknown host is not GitLab', async () => {
    const teamConfig = { repo: REMOTE, provider: 'git' };
    const originalConfig = structuredClone(teamConfig);
    fetchMock.mockResolvedValue(new Response('<h1>Company Git hosting</h1>', {
      headers: { 'content-type': 'text/html' },
    }));

    await expect(createPrWithFallback(teamConfig, localConfig, BRANCH, 'Title', 'Body')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(UNSUPPORTED_PR);
    expect(log.info).toHaveBeenCalledWith(`Branch ${BRANCH} has been pushed. You can create a PR manually.`);
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Detected GitLab'));
    expect(succeed).not.toHaveBeenCalled();
    expect(teamConfig).toEqual(originalConfig);
  });
});
